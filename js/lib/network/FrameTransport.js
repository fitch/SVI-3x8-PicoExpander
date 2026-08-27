const net = require('net');
const { EventEmitter } = require('events');
const msgpack = require('./msgpack');

/**
 * v2 protocol framing + command layer
 *
 * Frame format on the wire:
 *   [0xE5] [pri:1] [len:3 BE] [payload: msgpack bytes]
 *
 * Priority queues:
 *   4 outbound queues (pri 0-3), drained in priority order.
 *   Each queue entry is a wire-ready Buffer (header + payload).
 *
 * Command layer:
 *   Every cmd message carries a sequence number (s).
 *   The corresponding ack/err echoes it back.
 *   sendCommand() returns a Promise that resolves on matching ack.
 *
 * Emits:
 *   'message' (msg, priority)  — decoded MessagePack object
 *   'connect'                  — TCP connection established
 *   'close'                    — TCP connection closed
 *   'error' (err)              — TCP error
 */

const FRAME_MAGIC = 0xe5;
const FRAME_HEADER_SIZE = 5;
const FRAME_PORT = 4244;

const PRI_CRITICAL = 0;
const PRI_HIGH = 1;
const PRI_NORMAL = 2;
const PRI_BULK = 3;

const HIGH_WATER_MARK = 16384;

class FrameTransport extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.connected = false;

        // Priority queues: arrays of wire-ready Buffers
        this.queues = [[], [], [], []];

        // Command layer: sequence number counter and pending responses
        this._nextSeq = 0;
        this._pending = new Map(); // seq -> { resolve, reject, timeout }

        // Timestamp (ms) of the last inbound bytes from the Pico. Used by the
        // heartbeat to tell "connection alive but socket busy with a bulk
        // upload" apart from "connection actually dead".
        this._lastRecvMs = 0;
    }

    /**
     * Milliseconds since the last byte was received from the Pico.
     * @returns {number} Infinity if nothing has ever been received.
     */
    msSinceRecv() {
        return this._lastRecvMs ? (Date.now() - this._lastRecvMs) : Infinity;
    }

    /**
     * Connect to the Pico's v2 protocol port
     * @param {string} address - IP address
     * @param {number} [port] - Port number (default: 4244)
     * @returns {Promise<void>}
     */
    connect(address, port = FRAME_PORT) {
        return new Promise((resolve, reject) => {
            this.socket = new net.Socket();

            this.socket.once('connect', () => {
                this.socket.setNoDelay(true);
                try { this.socket.setKeepAlive(true, 1000); } catch (e) {}
                this.connected = true;
                this.emit('connect');
                resolve();
            });

            this.socket.on('error', (err) => {
                if (!this.connected) {
                    reject(err);
                } else {
                    this.emit('error', err);
                }
            });

            this.socket.on('data', (data) => {
                this._lastRecvMs = Date.now();
                this.buffer = Buffer.concat([this.buffer, data]);
                this._parse();
            });

            this.socket.on('close', () => {
                this.connected = false;
                this._rejectAllPending('Connection closed');
                this.emit('close');
            });

            this.socket.on('drain', () => {
                this._drain();
            });

            this.socket.connect(port, address);
        });
    }

    /**
     * Enqueue a message at the given priority.
     * The message is encoded to msgpack, wrapped in a frame, and placed
     * in the appropriate priority queue. Drain happens automatically.
     *
     * @param {object} msg - Object to encode as MessagePack
     * @param {number} [priority] - Priority level (default: PRI_NORMAL)
     */
    send(msg, priority = PRI_NORMAL) {
        if (!this.connected || !this.socket) {
            throw new Error('FrameTransport: not connected');
        }

        const frame = this._buildFrame(msg, priority);
        this.queues[priority].push(frame);
        this._drain();
    }

    /**
     * Send a command and wait for the matching ack/err response.
     *
     * @param {string} cmd - Command name (e.g., 'ping')
     * @param {object} [fields] - Additional fields to include in the message
     * @param {number} [priority] - Priority level (default: PRI_NORMAL)
     * @param {number} [timeoutMs] - Timeout in milliseconds (default: 5000)
     * @returns {Promise<object>} The ack message
     */
    sendCommand(cmd, fields = {}, priority = PRI_NORMAL, timeoutMs = 5000) {
        const seq = this._nextSeq++;
        if (this._nextSeq > 0xffff) this._nextSeq = 0;

        const msg = { t: 'cmd', c: cmd, s: seq, ...fields };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._pending.delete(seq);
                reject(new Error(`Command '${cmd}' (seq=${seq}) timed out`));
            }, timeoutMs);

            this._pending.set(seq, { resolve, reject, timeout });
            this.send(msg, priority);
        });
    }

    /**
     * Send a data block and wait for the matching ack.
     * Allocates its own sequence number.
     *
     * @param {number} block - Block number
     * @param {Buffer} data - Block data
     * @param {number} [priority] - Priority level (default: PRI_BULK)
     * @param {number} [timeoutMs] - Timeout in milliseconds (default: 10000)
     * @returns {Promise<object>} The ack message
     */
    sendData(block, data, priority = PRI_BULK, timeoutMs = 10000) {
        const seq = this._nextSeq++;
        if (this._nextSeq > 0xffff) this._nextSeq = 0;

        const msg = { t: 'data', s: seq, block, d: data };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._pending.delete(seq);
                reject(new Error(`Data block ${block} (seq=${seq}) timed out`));
            }, timeoutMs);

            this._pending.set(seq, { resolve, reject, timeout });
            this.send(msg, priority);
        });
    }

    /**
     * Send a ping command and wait for ack
     * @param {number} [timeoutMs] - Timeout in milliseconds (default: 5000)
     * @returns {Promise<object>} The ack message
     */
    ping(timeoutMs = 5000) {
        return this.sendCommand('ping', {}, PRI_NORMAL, timeoutMs);
    }

    /**
     * Close the connection
     */
    close() {
        this._rejectAllPending('Connection closed');
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
            this.connected = false;
            this.buffer = Buffer.alloc(0);
            this.queues = [[], [], [], []];
        }
        // Emit close after cleanup so listeners (e.g. PicoConnection) can react
        this.emit('close');
    }

    // -----------------------------------------------------------------------
    // Private: frame building
    // -----------------------------------------------------------------------

    _buildFrame(msg, priority) {
        const payload = msgpack.encode(msg);
        const frame = Buffer.alloc(FRAME_HEADER_SIZE + payload.length);
        frame[0] = FRAME_MAGIC;
        frame[1] = priority;
        frame[2] = (payload.length >> 16) & 0xff;
        frame[3] = (payload.length >> 8) & 0xff;
        frame[4] = payload.length & 0xff;
        payload.copy(frame, FRAME_HEADER_SIZE);
        return frame;
    }

    // -----------------------------------------------------------------------
    // Private: priority queue drain
    // -----------------------------------------------------------------------

    _drain() {
        if (!this.connected || !this.socket) return;

        while (this.socket.writableLength < HIGH_WATER_MARK) {
            const frame = this.queues[0].shift()
                       || this.queues[1].shift()
                       || this.queues[2].shift()
                       || this.queues[3].shift();
            if (!frame) break;
            this.socket.write(frame);
        }
    }

    // -----------------------------------------------------------------------
    // Private: frame parsing
    // -----------------------------------------------------------------------

    _parse() {
        while (this.buffer.length >= FRAME_HEADER_SIZE) {
            // Scan for magic byte
            const magicIdx = this.buffer.indexOf(FRAME_MAGIC);
            if (magicIdx === -1) {
                this.buffer = Buffer.alloc(0);
                return;
            }
            if (magicIdx > 0) {
                this.buffer = this.buffer.subarray(magicIdx);
            }

            if (this.buffer.length < FRAME_HEADER_SIZE) return;

            const priority = this.buffer[1];
            const payloadLen = (this.buffer[2] << 16)
                             | (this.buffer[3] << 8)
                             | this.buffer[4];

            const frameLen = FRAME_HEADER_SIZE + payloadLen;
            if (this.buffer.length < frameLen) return;

            const payload = this.buffer.subarray(FRAME_HEADER_SIZE, frameLen);
            this.buffer = this.buffer.subarray(frameLen);

            try {
                const msg = msgpack.decode(payload);
                this._handleMessage(msg, priority);
            } catch (err) {
                this.emit('error', new Error(`Frame decode error: ${err.message}`));
            }
        }
    }

    // -----------------------------------------------------------------------
    // Private: message dispatch
    // -----------------------------------------------------------------------

    _handleMessage(msg, priority) {
        // Check if this is a response to a pending command
        if ((msg.t === 'ack' || msg.t === 'err') && msg.s !== undefined) {
            const pending = this._pending.get(msg.s);
            if (pending) {
                clearTimeout(pending.timeout);
                this._pending.delete(msg.s);
                if (msg.t === 'ack') {
                    pending.resolve(msg);
                } else {
                    pending.reject(new Error(msg.msg || `Command error (seq=${msg.s})`));
                }
                return;
            }
        }

        // Not a response — emit as a general message
        this.emit('message', msg, priority);
    }

    _rejectAllPending(reason) {
        for (const [, pending] of this._pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(reason));
        }
        this._pending.clear();
    }
}

module.exports = FrameTransport;
module.exports.FRAME_PORT = FRAME_PORT;
module.exports.PRI_CRITICAL = PRI_CRITICAL;
module.exports.PRI_HIGH = PRI_HIGH;
module.exports.PRI_NORMAL = PRI_NORMAL;
module.exports.PRI_BULK = PRI_BULK;
