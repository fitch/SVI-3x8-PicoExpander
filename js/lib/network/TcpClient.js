const net = require('net');
const { TCP_PORT } = require('../utils/networkConstants');

/**
 * TcpClient handles TCP communication with the SVI-3x8 PicoExpander
 */
class TcpClient {
    constructor(remoteAddress) {
        this.remoteAddress = remoteAddress;
        this.client = new net.Socket();
        this.buffer = Buffer.alloc(0);
    }

    /**
     * Connect to the remote device
     * @returns {Promise<void>}
     */
    connect() {
        return new Promise((resolve, reject) => {
            this.client.once('connect', () => {
                this.client.setNoDelay(true);  // Disable Nagle's algorithm
                try {
                    this.client.setKeepAlive(true, 1000);
                } catch (e) {
                    // Ignore if not supported
                }
                resolve();
            });
            this.client.once('error', reject);
            this.client.connect(TCP_PORT, this.remoteAddress.address);
        });
    }

    /**
     * Send data over TCP
     * @param {Buffer} data - Data to send
     */
    write(data) {
        this.client.write(data);
    }

    /**
     * Set up a data handler
     * @param {Function} handler - Handler function
     */
    onData(handler) {
        this.client.removeAllListeners('data');
        this.client.on('data', (data) => {
            this.buffer = Buffer.concat([this.buffer, data]);
            handler(this.buffer);
        });
    }

    /**
     * Get the current buffer
     * @returns {Buffer}
     */
    getBuffer() {
        return this.buffer;
    }

    /**
     * Update the buffer (typically after consuming data)
     * @param {Buffer} newBuffer
     */
    setBuffer(newBuffer) {
        this.buffer = newBuffer;
    }

    /**
     * Read and remove a protocol command from the buffer
     * @returns {Object|null} Command object with {cmd, pad} or null if not enough data
     */
    readCommand() {
        if (this.buffer.length < 10) {
            return null;
        }

        const cmd = this.buffer.subarray(0, 2).toString('ascii');
        const pad = this.buffer.subarray(2, 10);

        this.buffer = this.buffer.subarray(10);
        return { cmd, pad };
    }

    /**
     * Read and remove a specified number of bytes from the buffer
     * @param {number} length - Number of bytes to read
     * @returns {Buffer|null} Buffer with the requested bytes or null if not enough data
     */
    readBytes(length) {
        if (this.buffer.length < length) {
            return null;
        }

        const data = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        return data;
    }

    /**
     * Set up close handler
     * @param {Function} handler
     */
    onClose(handler) {
        this.client.on('close', handler);
    }

    /**
     * Set up error handler
     * @param {Function} handler
     */
    onError(handler) {
        this.client.on('error', handler);
    }

    /**
     * Close the connection
     */
    end() {
        this.client.end();
    }

    /**
     * Forcefully destroy the connection (no lingering timeouts)
     */
    destroy() {
        this.client.removeAllListeners();
        this.client.destroy();
    }
}

module.exports = TcpClient;
