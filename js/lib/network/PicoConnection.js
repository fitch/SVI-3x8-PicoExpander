const path = require('path');
const fs = require('fs');
const NetworkDiscovery = require('./NetworkDiscovery');
const TcpClient = require('./TcpClient');
const FrameTransport = require('./FrameTransport');
const Prompt = require('../ui/Prompt');
const { createCommandBuffer } = require('./ProtocolUtils');
const SaveStateSaver = require('../commands/SaveStateSaver');
const ProgressBar = require('../utils/ProgressBar');

// Filter type constants (matching Pico's file_type_filter values)
const FILTER_NONE = 0;        // 0b00000000 - No filter (default)
const FILTER_TAPE = 1;        // 0b00000001 - Filter only tape images
const FILTER_ROM = 2;         // 0b00000010 - Filter only ROM images
const FILTER_DISK = 3;        // 0b00000011 - Filter only disk images
const FILTER_SAVE_STATE = 4;  // 0b00000100 - Filter only save states
const FILTER_HDD = 5;        // 0b00000101 - Filter only HDD images

/**
 * Manages persistent connection to SVI-3x8 PicoExpander
 * Handles UDP discovery and maintains a persistent TCP connection
 */
class PicoConnection {
    constructor() {
        this.picoAddress = null;
        this.isConnected = false;
        this.isReconnecting = false;
        this.discovery = null;
        this.tcpClient = null;
        this.reconnectCallback = null;
        this.fileTypeFilter = FILTER_NONE;  // Current file type filter
        this.targetIdentifier = null;  // Identifier of the Pico we want to reconnect to
        this.frameTransport = null;    // v2 protocol connection (port 4244)
        this.logHistory = [];          // Accumulated log events from v2 protocol
        this._logNotified = false;     // Whether we've shown the "press T to view" hint
    }

    /**
     * Discover and connect to the PicoExpander
     * Performs UDP discovery then establishes persistent TCP connection
     * @param {Function} onReconnectNeeded - Callback when reconnection is needed
     * @returns {Promise<Object>} Remote address information
     */
    async connect(onReconnectNeeded = null) {
        if (this.isReconnecting) {
            throw new Error('Already reconnecting');
        }

        if (this.isConnected && this.tcpClient) {
            return this.picoAddress;
        }

        this.reconnectCallback = onReconnectNeeded;

        try {
            if (!this.picoAddress) {
                this.discovery = new NetworkDiscovery();
                this.picoAddress = await this.discovery.waitForHandshake();
                this.discovery = null;
            }
            
            Prompt.print(`Connecting to ${this.picoAddress.address}...`);

            const identifier = this.picoAddress.identifier ? ` [${this.picoAddress.identifier}]` : '';

            this.isConnected = true;
            this.isReconnecting = false;
            this.targetIdentifier = this.picoAddress.identifier;

            await this._connectV2(this.picoAddress.address);
            this._sendInitialFileChunk();
            this._syncHddState();  // fresh start → tell the Pico "no HDD mounted"

            Prompt.printFinal(`Connected to SVI-3x8 PicoExpander${identifier}`);

            return this.picoAddress;
        } catch (err) {
            this.isConnected = false;
            this.isReconnecting = false;
            this.tcpClient = null;
            throw err;
        }
    }

    /**
     * Attempt to connect to the v2 protocol on port 4244.
     * Non-blocking — if the Pico doesn't support v2 yet, we silently continue with v1.
     * @private
     * @param {string} address - IP address of the Pico
     */
    async _connectV2(address) {
        // Close any existing v2 connection
        if (this.frameTransport) {
            this.frameTransport.close();
            this.frameTransport = null;
        }

        try {
            this.frameTransport = new FrameTransport();

            this.frameTransport.on('close', () => {
                if (this.frameTransport) {
                    if (this._heartbeatInterval) {
                        clearInterval(this._heartbeatInterval);
                        this._heartbeatInterval = null;
                    }
                    this.frameTransport = null;
                    this.isConnected = false;
                    Prompt.print('Connection lost.');
                    if (this.targetIdentifier) {
                        Prompt.print('Reconnecting...');
                        this._reconnectToSamePico();
                    }
                }
            });

            this.frameTransport.on('error', (err) => {
                // Errors are handled by the close event
            });

            this.frameTransport.on('message', (msg) => {
                if (msg.t === 'event' && msg.c === 'log') {
                    if (!this._logNotified) {
                        Prompt.print('Receiving log from Pico (press T to view)');
                        this._logNotified = true;
                    }
                    this.logHistory.push(msg);
                } else if (msg.t === 'cmd') {
                    this._handleV2Command(msg);
                } else if (msg.t === 'data' && msg.c === 'state_save') {
                    this._handleV2SaveStateData(msg);
                }
            });

            await this.frameTransport.connect(address);
            await this.frameTransport.ping();

            // Heartbeat: ping every 1s with a 2s per-ping timeout, one ping at a
            // time (never overlap). Close after 3 consecutive misses.
            this._missedPings = 0;
            this._pingInFlight = false;
            this._heartbeatInterval = setInterval(() => {
                // Skip if there's no connection or a ping is still outstanding —
                // overlapping pings (1s interval vs 2s timeout) would pile up and,
                // on close, reject together and log spurious extra misses.
                if (!this.frameTransport || this._pingInFlight) return;
                this._pingInFlight = true;
                this.frameTransport.ping(2000).then(() => {
                    this._pingInFlight = false;
                    if (!this.frameTransport) return; // settled after close — ignore
                    if (this._missedPings > 0) {
                        Prompt.print(`Heartbeat recovered after ${this._missedPings} missed ping(s)`);
                    }
                    this._missedPings = 0;
                }).catch(() => {
                    this._pingInFlight = false;
                    if (!this.frameTransport) return; // settled after close — ignore
                    // A ping can time out simply because the socket is saturated
                    // with a bulk upload (16 KB blocks) over a slow link — the
                    // ping sits queued past its timeout while the connection is
                    // perfectly alive. If we've heard from the Pico recently
                    // (e.g. block acks), treat the connection as healthy and
                    // don't count this as a miss.
                    if (this.frameTransport.msSinceRecv() < 2000) {
                        this._missedPings = 0;
                        return;
                    }
                    this._missedPings++;
                    Prompt.print(`Heartbeat ping missed (${this._missedPings}/3)`);
                    if (this._missedPings >= 3) {
                        Prompt.print('Heartbeat lost — closing connection');
                        this.frameTransport.close();
                    }
                });
            }, 1000);
        } catch (err) {
            // Detach our listeners before closing. Otherwise close() synchronously
            // fires the 'close' handler above, which starts an independent
            // _reconnectToSamePico() loop — while this same error also propagates
            // to our caller (connect() → server.js retry). Two reconnect loops then
            // race to bind UDP 4243 and one loses with EADDRINUSE. The caller owns
            // the retry; this failure must not also spawn a background one.
            if (this.frameTransport) {
                this.frameTransport.removeAllListeners();
                this.frameTransport.close();
                this.frameTransport = null;
            }
            throw err;
        }
    }

    /**
     * Handle v2 commands from Pico
     * @private
     */
    _handleV2Command(msg) {
        if (msg.c === 'catalog_get') {
            const offset = msg.offset || 0;
            this._sendFileChunk(offset);
        } else if (msg.c === 'catalog_filter') {
            this.fileTypeFilter = msg.filter || 0;
            this._sendFileChunk(0);
        } else if (msg.c === 'state_save') {
            this._handleV2SaveStateBegin(msg);
        } else if (msg.c === 'hdd_read') {
            this._handleHddRead(msg);
        } else if (msg.c === 'hdd_write') {
            this._handleHddWrite(msg);
        } else if (msg.c === 'file_get') {
            const fileIndex = msg.index || 0;
            const fileList = this._getSortedFileList();
            if (fileIndex < fileList.length) {
                const fileInfo = fileList[fileIndex];
                const displayName = fileInfo.metadata && fileInfo.metadata.name ? fileInfo.metadata.name : fileInfo.name;
                const fileType = fileInfo.type || 'unknown';
                Prompt.print(`Sending "${displayName}" (${fileType})`);
                const fullFilePath = fileInfo.relativePath.startsWith('/')
                    ? fileInfo.relativePath
                    : require('path').join(this.server.directory, fileInfo.relativePath);
                this._sendFileV2(fullFilePath, fileType);
            } else {
                Prompt.print(`File index ${fileIndex} out of range (${fileList.length} files)`);
            }
        }
    }

    /**
     * Handle v2 save state begin command from Pico
     * @private
     */
    _handleV2SaveStateBegin(msg) {
        const bankConfig = msg.bank_config || 0;
        const totalSize = msg.size || 0;
        const filename = msg.filename || 'saved_state';

        Prompt.print(`Receiving save state (bank_config=0x${bankConfig.toString(16).padStart(2, '0')}, ${totalSize} bytes)`);

        this._saveStateReceive = {
            bankConfig,
            totalSize,
            filename: filename.endsWith('.sta') ? filename : filename + '.sta',
            received: 0,
            chunks: [],
            progressBar: new ProgressBar(totalSize, 'Receiving')
        };
    }

    /**
     * Handle v2 save state data block from Pico
     * @private
     */
    _handleV2SaveStateData(msg) {
        const rx = this._saveStateReceive;
        if (!rx) {
            Prompt.print('Save state data received with no active transfer');
            return;
        }

        if (msg.d && Buffer.isBuffer(msg.d)) {
            rx.chunks.push(msg.d);
            rx.received += msg.d.length;
            rx.progressBar.update(rx.received);
        }

        if (rx.received >= rx.totalSize) {
            rx.progressBar.complete();

            const receivedData = Buffer.concat(rx.chunks);

            // Data format: bank_config (1 byte) + RAM4 + banks
            // Strip the bank_config byte prefix for the file
            const dataAfterConfig = receivedData.subarray(1, rx.totalSize);

            // Create .sta file with header
            const header = Buffer.alloc(SaveStateSaver.HEADER_SIZE, 0x00);
            header.write(SaveStateSaver.HEADER_MAGIC, 0, 'ascii');
            header.writeUInt8(SaveStateSaver.HEADER_VERSION, 21);
            header.writeUInt8(rx.bankConfig, 23);

            const saveStateFile = Buffer.concat([header, dataAfterConfig]);

            const fullPath = this.server
                ? path.join(this.server.directory, rx.filename)
                : path.join(process.cwd(), rx.filename);

            try {
                fs.writeFileSync(fullPath, saveStateFile);
                Prompt.print(`Save state saved to: ${rx.filename} (${saveStateFile.length} bytes)`);
            } catch (err) {
                Prompt.print(`Error writing save state: ${err.message}`);
            }

            this._saveStateReceive = null;

            // File watcher will detect the new .sta file and update catalog automatically
        }
    }

    /**
     * Handle HDD read request from Pico via v2
     * @private
     */
    _handleHddRead(msg) {
        const lba = msg.lba || 0;
        const seq = msg.s;
        const byteOffset = lba * 256;

        if (!this.hddImage || byteOffset + 256 > this.hddImage.length) {
            // Send error ack
            if (this.frameTransport) {
                this.frameTransport.send({
                    t: 'ack', s: seq, lba, d: Buffer.alloc(256, 0xFF)
                }, FrameTransport.PRI_CRITICAL);
            }
            return;
        }

        const sector = this.hddImage.subarray(byteOffset, byteOffset + 256);
        if (this.frameTransport) {
            this.frameTransport.send({
                t: 'ack', s: seq, lba, d: sector
            }, FrameTransport.PRI_CRITICAL);
        }
    }

    /**
     * Handle HDD write request from Pico via v2
     * @private
     */
    _handleHddWrite(msg) {
        const lba = msg.lba || 0;
        const seq = msg.s;
        const byteOffset = lba * 256;
        const payload = msg.d;

        if (this.hddImage && payload && Buffer.isBuffer(payload) && byteOffset + 256 <= this.hddImage.length) {
            payload.copy(this.hddImage, byteOffset, 0, 256);
            // Write-through to disk
            if (this.hddFd !== null && this.hddFd !== undefined) {
                fs.writeSync(this.hddFd, this.hddImage.subarray(byteOffset, byteOffset + 256), 0, 256, byteOffset);
            }
        }

        // Send ack
        if (this.frameTransport) {
            this.frameTransport.send({
                t: 'ack', s: seq
            }, FrameTransport.PRI_CRITICAL);
        }
    }

    /**
     * Load an HDD image and notify the Pico via v2
     * @param {string} filePath - Full path to the .hdd file
     */
    async loadHddImage(filePath) {
        if (!this.frameTransport) {
            throw new Error('v2 protocol not connected');
        }

        const hddImage = fs.readFileSync(filePath);
        this.hddImage = hddImage;
        this.hddFd = fs.openSync(filePath, 'r+');
        const totalLBAs = Math.floor(hddImage.length / 256);

        // Send hdd_load command with sector 0 data
        const sector0 = hddImage.subarray(0, 256);
        await this.frameTransport.sendCommand('hdd_load', {
            lbas: totalLBAs,
            d: sector0
        }, FrameTransport.PRI_NORMAL, 5000);

        Prompt.print(`HDD: Loaded ${path.basename(filePath)} (${totalLBAs} sectors)`);
    }

    /**
     * Unload HDD image and notify Pico via v2
     */
    async unloadHddImage() {
        if (this.hddFd !== null && this.hddFd !== undefined) {
            try { fs.closeSync(this.hddFd); } catch (e) { /* ignore */ }
            this.hddFd = null;
        }
        this.hddImage = null;

        if (this.frameTransport) {
            await this.frameTransport.sendCommand('hdd_unload', {}, FrameTransport.PRI_NORMAL, 5000);
        }
    }

    /**
     * Sync the Pico's HDD state to ours after a (re)connection.
     * The Pico keeps its HDD state until told otherwise, so a stale "mounted"
     * state can survive a previous server exiting. On a fresh start we have no
     * image, so we explicitly tell the Pico "no HDD"; after a reconnect where we
     * still hold an image, we re-mount it. Fire-and-forget — failures are non-fatal.
     * @private
     */
    _syncHddState() {
        if (!this.frameTransport) return;
        if (this.hddImage) {
            const totalLBAs = Math.floor(this.hddImage.length / 256);
            const sector0 = this.hddImage.subarray(0, 256);
            this.frameTransport.sendCommand('hdd_load', { lbas: totalLBAs, d: sector0 },
                FrameTransport.PRI_NORMAL, 5000).catch(() => {});
        } else {
            this.frameTransport.sendCommand('hdd_unload', {},
                FrameTransport.PRI_NORMAL, 5000).catch(() => {});
        }
    }

    /**
     * Tell the Pico the HDD is gone. Used on server shutdown so the PicoExpander
     * doesn't keep showing a mounted HDD it can no longer reach. Short timeout so
     * a dead link doesn't stall shutdown.
     * @param {number} [timeoutMs]
     */
    async notifyHddUnmounted(timeoutMs = 1500) {
        if (!this.frameTransport) return;
        await this.frameTransport.sendCommand('hdd_unload', {}, FrameTransport.PRI_NORMAL, timeoutMs);
    }

    /**
     * Graceful shutdown: best-effort tell the Pico the HDD is gone, then disconnect.
     * Safe to call from any exit path (signal handler, Ctrl+C, quit command).
     */
    async shutdown() {
        try {
            if (this.connected) {
                await this.notifyHddUnmounted();
            }
        } catch (e) { /* best effort — going away regardless */ }
        this.disconnect();
    }

    /**
     * Handle requests from Pico (v1 protocol)
     * @private
     */
    _handlePicoRequest() {
        try {
            const response = this.tcpClient.readCommand();
            if (!response) return;

            if (response.cmd === 'FR') {
                // File Read request: header already consumed, pad contains offset + file_number + length
                const header = Buffer.alloc(10);
                header.write('FR');
                response.pad.copy(header, 2, 0, 8);
                this._handleFR(header);
                return;
            } else if (response.cmd === 'FW') {
                // File Write request: header + 256 bytes payload
                const header = Buffer.alloc(10);
                header.write('FW');
                response.pad.copy(header, 2, 0, 8);
                const length = header.readUInt16BE(8);
                const payload = this.tcpClient.readBytes(length);
                if (payload) {
                    this._handleFW(header, payload);
                }
                return;
            } else if (response.cmd === 'GF') {
                // Read the file index from the padding bytes (bytes 2-3 of the command)
                const fileIndex = (response.pad[0] << 8) | response.pad[1];
                
                const fileList = this._getSortedFileList();
                if (fileIndex < fileList.length) {
                    const fileInfo = fileList[fileIndex];
                    const displayName = fileInfo.metadata && fileInfo.metadata.name ? fileInfo.metadata.name : fileInfo.name;
                    const fileType = fileInfo.type || 'unknown';
                    const typeCode = fileInfo.typeCode || 0;
                    
                    Prompt.print(`Received request to send file "${displayName}" (type: ${fileType})`);
                    
                    const fullFilePath = fileInfo.relativePath.startsWith('/') 
                        ? fileInfo.relativePath 
                        : require('path').join(this.server.directory, fileInfo.relativePath);
                    
                    this._sendFileToSVI(fullFilePath, fileType);
                } else {
                    Prompt.print(`Received request to send file at index ${fileIndex} (out of range, only ${fileList.length} files available)`);
                }
            } else if (response.cmd === 'SS') {
                // Save State request from Pico
                // Command format:
                //   Bytes 0-1: 'SS' command
                //   Followed by 256 bytes of filename (null-terminated, null-padded)
                // Note: Pico always sends all banks, no size type needed
                
                const filenameBuffer = this.tcpClient.readBytes(256);
                let filename = '';
                if (filenameBuffer) {
                    for (let i = 0; i < filenameBuffer.length; i++) {
                        if (filenameBuffer[i] === 0) break;
                        filename += String.fromCharCode(filenameBuffer[i]);
                    }
                }
                
                if (!filename) {
                    filename = 'saved_state';
                }
                
                if (!filename.endsWith('.sta')) {
                    filename += '.sta';
                }
                
                const fullPath = this.server ? 
                    path.join(this.server.directory, filename) : 
                    path.join(process.cwd(), filename);
                
                Prompt.print(`Saving machine state to: ${filename}`);
                
                this._captureSaveState(fullPath);
            } else if (response.cmd === 'GX') {
                // Pico is requesting specific file chunk by index
                // Read the file index from the padding bytes (bytes 2-3 of the command)
                const fileIndex = (response.pad[0] << 8) | response.pad[1];
                Prompt.print(`Received request for file chunk containing index ${fileIndex}`);
                this._sendFileChunk(fileIndex);
            } else if (response.cmd === 'SF') {
                const filterValue = response.pad[0];
                this.fileTypeFilter = filterValue;
                const filterNames = ['None', 'Tape', 'ROM', 'Disk', 'Save State', 'HDD'];
                const filterName = filterNames[filterValue] || `Unknown (${filterValue})`;
                // Prompt.print(`File type filter set to: ${filterName}`);
                
                // Send updated file chunk (which includes file count in the header)
                this._sendFileChunk(0);
            }
        } catch (err) {
            Prompt.print(`Error handling Pico request: ${err.message}`);
        }
    }

    /**
     * Attempt to reconnect to the same Pico by identifier
     * @private
     */
    async _reconnectToSamePico() {
        if (this.isReconnecting) {
            return;
        }

        // Don't attempt if targetIdentifier was cleared (e.g., by abortAndRescan)
        if (!this.targetIdentifier) {
            return;
        }

        this.isReconnecting = true;
        this.picoAddress = null;  // Clear current address - Pico may have a new IP

        const attemptReconnect = async () => {
            if (!this.targetIdentifier) {
                this.isReconnecting = false;
                return;
            }

            try {
                this.discovery = new NetworkDiscovery();
                const device = await this.discovery.waitForHandshakeByIdentifier(this.targetIdentifier, 30000);
                this.discovery = null;

                if (!this.targetIdentifier) {
                    this.isReconnecting = false;
                    return;
                }

                if (!device) {
                    Prompt.print(`Still scanning for Pico [${this.targetIdentifier}]...`);
                    this.isReconnecting = false;
                    this._reconnectToSamePico();
                    return;
                }

                this.picoAddress = device;

                await this._connectV2(this.picoAddress.address);
                this._sendInitialFileChunk();
                this._syncHddState();  // re-mount our HDD (or confirm none) after reconnect

                const identifier = this.picoAddress.identifier ? ` [${this.picoAddress.identifier}]` : '';
                Prompt.printFinal(`Reconnected to SVI-3x8 PicoExpander${identifier}`);

                this.isConnected = true;
                this.isReconnecting = false;
            } catch (err) {
                // Release any discovery socket from this failed attempt before
                // retrying. Otherwise the next attempt reassigns this.discovery
                // and leaks a socket still bound to UDP 4243, and every rebind
                // after that fails with EADDRINUSE.
                if (this.discovery) {
                    this.discovery.close();
                    this.discovery = null;
                }

                if (!this.targetIdentifier) {
                    this.isReconnecting = false;
                    return;
                }

                Prompt.print(`Still scanning for Pico [${this.targetIdentifier}]...`);
                setTimeout(() => {
                    if (!this.isConnected && this.targetIdentifier) {
                        this.isReconnecting = false;
                        this._reconnectToSamePico();
                    }
                }, 1000);
            }
        };

        attemptReconnect();
    }

    /**
     * Send initial file catalog to Pico via v2
     * @private
     */
    _sendInitialFileChunk() {
        if (!this.frameTransport) return;
        this._sendFileChunk(0);
    }

    /**
     * Send file catalog chunk to Pico via v2 catalog_update command.
     * @private
     * @param {number} fileIndex - File index to center the chunk around
     */
    _sendFileChunk(fileIndex) {
        if (!this.frameTransport) return;

        try {
            const fileList = this._getSortedFileList();
            const fileCount = fileList.length;

            const chunkStartIndex = Math.floor(fileIndex / 256) * 256;
            const chunkEndIndex = Math.min(chunkStartIndex + 256, fileList.length);
            const chunkBuffer = Buffer.alloc(256 * 32, 0x00);

            for (let i = chunkStartIndex; i < chunkEndIndex; i++) {
                const fileInfo = fileList[i];
                const offset = (i - chunkStartIndex) * 32;

                chunkBuffer.writeUInt8(0x00, offset);
                chunkBuffer.writeUInt8(fileInfo.typeCode || 0x00, offset + 1);

                const displayName = fileInfo.metadata && fileInfo.metadata.name ? fileInfo.metadata.name : fileInfo.name;
                const filename = displayName.substring(0, 30);
                chunkBuffer.write(filename, offset + 2, 30, 'ascii');
            }

            this.frameTransport.send({
                t: 'cmd',
                c: 'catalog_update',
                s: 0,  // no response needed
                offset: chunkStartIndex,
                total: fileCount,
                filter: this.fileTypeFilter,
                d: chunkBuffer
            }, FrameTransport.PRI_NORMAL);
        } catch (err) {
            Prompt.print(`Error sending file chunk: ${err.message}`);
        }
    }

    /**
     * Get sorted file list from server (respecting current filter)
     * @private
     * @returns {Array}
     */
    _getSortedFileList() {
        if (!this.server || !this.server.files) {
            return [];
        }

        let fileArray = Array.from(this.server.files.values());
        
        // Apply filter based on fileTypeFilter
        if (this.fileTypeFilter !== FILTER_NONE) {
            fileArray = fileArray.filter(file => {
                const typeCode = file.typeCode || 0;
                const mainType = typeCode & 0x0F;  // Lower 4 bits = main type
                
                switch (this.fileTypeFilter) {
                    case FILTER_TAPE:
                        return mainType === 1;  // Tape files have main type 1
                    case FILTER_ROM:
                        return mainType === 2;  // ROM files have main type 2
                    case FILTER_DISK:
                        return mainType === 3;  // Disk files have main type 3
                    case FILTER_SAVE_STATE:
                        return mainType === 4;  // Savestate files have main type 4
                    case FILTER_HDD:
                        return mainType === 5;  // HDD image files have main type 5
                    default:
                        return true;
                }
            });
        }
        
        fileArray.sort((a, b) => {
            const nameA = a.metadata && a.metadata.name ? a.metadata.name : a.name;
            const nameB = b.metadata && b.metadata.name ? b.metadata.name : b.name;
            return nameA.localeCompare(nameB);
        });
        
        return fileArray;
    }

    /**
     * Reconnect to the PicoExpander
     * @returns {Promise<Object>} Remote address information
     */
    async reconnect() {
        if (this.isReconnecting) {
            return;
        }
        
        this.isReconnecting = true;
        this.isConnected = false;
        Prompt.print("Attempting to reconnect...");
        
        if (this.tcpClient) {
            try {
                this.tcpClient.end();
            } catch (e) {
                // Ignore errors on cleanup
            }
            this.tcpClient = null;
        }
        
        this.picoAddress = null;
        
        try {
            return await this.connect(this.reconnectCallback);
        } catch (err) {
            Prompt.print(`Reconnection failed: ${err.message}`);
            this.isReconnecting = false;
            
            setTimeout(() => {
                if (!this.isConnected && this.reconnectCallback) {
                    this.reconnect();
                }
            }, 3000);
            
            throw err;
        }
    }

    /**
     * Disconnect from the PicoExpander
     */
    disconnect() {
        // Close HDD image file descriptor if open
        if (this.hddFd !== null && this.hddFd !== undefined) {
            try { fs.closeSync(this.hddFd); } catch (e) { /* ignore */ }
            this.hddFd = null;
        }
        this.hddImage = null;

        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
        if (this.frameTransport) {
            this.frameTransport.close();
            this.frameTransport = null;
        }
        if (this.tcpClient) {
            this.tcpClient.end();
            this.tcpClient = null;
        }
        if (this.discovery) {
            this.discovery.close();
            this.discovery = null;
        }
        this.isConnected = false;
        this.picoAddress = null;
        this.reconnectCallback = null;
        this.targetIdentifier = null;
        this.isReconnecting = false;
    }

    /**
     * Abort current connection/reconnection and start fresh discovery
     * This clears the target identifier so we scan for ALL Picos
     */
    abortAndRescan() {
        Prompt.print('Aborting connection and starting fresh scan...');
        this.disconnect();
        
        // Start fresh connection if callback is available
        if (this.startFreshConnection) {
            this.startFreshConnection();
        }
    }

    /**
     * Notify Pico that the file list has changed
     * Sends updated file chunk to refresh the file list on Pico
     */
    notifyFileListChanged() {
        if (this.isConnected && this.frameTransport) {
            this._sendFileChunk(0);
        }
    }

    /**
     * Get the TCP client for sending commands
     * @returns {TcpClient|null}
     */
    getClient() {
        return this.tcpClient;
    }

    /**
     * Print accumulated log history and clear it
     */
    /**
     * Request hardware log from Pico via v2 protocol
     * @returns {Promise<object>} The ack message with hw log data
     */
    async requestHwLog() {
        if (!this.frameTransport) {
            throw new Error('v2 protocol not connected');
        }
        return this.frameTransport.sendCommand('hw_log');
    }

    /**
     * Boot Pico back to launcher via v2 protocol
     * @returns {Promise<object>} The ack message with ok:true/false
     */
    async bootToLauncher() {
        if (!this.frameTransport) {
            throw new Error('v2 protocol not connected');
        }
        return this.frameTransport.sendCommand('boot', {}, FrameTransport.PRI_NORMAL, 10000);
    }

    /**
     * Request a memory dump from Pico via v2 protocol.
     * Sends the command, then collects data blocks until complete.
     * @param {string} type - Dump type: 'dump_bk4x', 'dump_bios', 'dump_disk'
     * @param {Function} [onProgress] - Optional progress callback(received, total)
     * @returns {Promise<Buffer>} The received data
     */
    async requestDump(type, onProgress = null) {
        if (!this.frameTransport) {
            throw new Error('v2 protocol not connected');
        }

        return new Promise((resolve, reject) => {
            let totalSize = 0;
            let received = 0;
            const chunks = [];
            let handler = null;
            let timeout = null;

            const cleanup = () => {
                if (handler) this.frameTransport.removeListener('message', handler);
                if (timeout) clearTimeout(timeout);
            };

            handler = (msg) => {
                if (msg.t === 'cmd' && msg.c === type) {
                    // Initial response with size info
                    totalSize = msg.size || 0;
                    if (onProgress) onProgress(0, totalSize);
                } else if (msg.t === 'data' && msg.c === type) {
                    if (msg.d && Buffer.isBuffer(msg.d)) {
                        chunks.push(msg.d);
                        received += msg.d.length;
                        if (onProgress) onProgress(received, totalSize);
                    }
                    if (totalSize > 0 && received >= totalSize) {
                        cleanup();
                        resolve(Buffer.concat(chunks).subarray(0, totalSize));
                    }
                    // Reset timeout on each block
                    if (timeout) clearTimeout(timeout);
                    timeout = setTimeout(() => {
                        cleanup();
                        reject(new Error(`${type} timed out after receiving ${received}/${totalSize} bytes`));
                    }, 10000);
                }
            };

            this.frameTransport.on('message', handler);

            // Send the command — sendCommand expects an ack but dump commands
            // don't send a standard ack, they stream data instead.
            // So we send it as a raw message, not via sendCommand.
            this.frameTransport.send({
                t: 'cmd',
                c: type,
                s: 0
            }, FrameTransport.PRI_NORMAL);

            // Overall timeout
            timeout = setTimeout(() => {
                cleanup();
                reject(new Error(`${type} timed out`));
            }, 30000);
        });
    }

    printLog() {
        if (this.logHistory.length === 0) {
            console.log('No log entries.');
        } else {
            for (const entry of this.logHistory) {
                const ts = entry.ts !== undefined ? `[${String(entry.ts).padStart(10, '0')}] ` : '';
                console.log(`${ts}${entry.msg}`);
            }
            console.log(`--- ${this.logHistory.length} log entries ---`);
            this.logHistory = [];
        }
        Prompt.show();
    }

    /**
     * Get the current connection status
     * @returns {boolean}
     */
    get connected() {
        return this.isConnected && this.frameTransport !== null;
    }

    /**
     * Get the PicoExpander address
     * @returns {Object|null}
     */
    get address() {
        return this.picoAddress;
    }

    /**
     * Convert 40-track double-sided disk layout from interleaved to sequential
     * Applies to both disk-basic-40ds and disk-cpm-40ds formats
     * Input: Track 0 Side 0, Track 0 Side 1, Track 1 Side 0, Track 1 Side 1, ...
     * Output: All Side 0 tracks (0-39), then all Side 1 tracks (0-39)
     * @private
     * @param {Buffer} data - Original disk image data
     * @returns {Buffer} - Converted disk image data
     */
    _convertDisk40dsLayout(data) {
        // Track 0 Side 0: 18 sectors × 128 bytes = 2,304 bytes
        // All other tracks: 17 sectors × 256 bytes = 4,352 bytes
        const TRACK_0_SIDE_0_SIZE = 18 * 128; // 2,304 bytes
        const STANDARD_TRACK_SIZE = 17 * 256;  // 4,352 bytes
        const NUM_TRACKS = 40;
        
        // Expected size:
        // Side 0: 2,304 + 39 × 4,352 = 172,032 bytes
        // Side 1: 40 × 4,352 = 174,080 bytes
        // Total: 346,112 bytes
        const expectedSize = 346112;
        
        if (data.length !== expectedSize) {
            Prompt.print(`Warning: Expected ${expectedSize} bytes for 40ds disk, got ${data.length}`);
            return data;
        }
        
        const converted = Buffer.alloc(data.length);
        let readOffset = 0;
        let writeOffset = 0;
        
        // First pass: Copy all Side 0 tracks
        // Track 0 Side 0 (special: 2,304 bytes)
        data.copy(converted, writeOffset, readOffset, readOffset + TRACK_0_SIDE_0_SIZE);
        writeOffset += TRACK_0_SIDE_0_SIZE;
        readOffset += TRACK_0_SIDE_0_SIZE;
        
        // Track 0 Side 1 (skip for now, will copy in second pass)
        readOffset += STANDARD_TRACK_SIZE;
        
        // Tracks 1-39 Side 0 (each 4,352 bytes)
        for (let track = 1; track < NUM_TRACKS; track++) {
            data.copy(converted, writeOffset, readOffset, readOffset + STANDARD_TRACK_SIZE);
            writeOffset += STANDARD_TRACK_SIZE;
            readOffset += STANDARD_TRACK_SIZE;
            
            // Skip the corresponding Side 1 track
            readOffset += STANDARD_TRACK_SIZE;
        }
        
        // Second pass: Copy all Side 1 tracks (all 40 tracks are 4,352 bytes)
        readOffset = TRACK_0_SIDE_0_SIZE; // Position at Track 0 Side 1
        
        for (let track = 0; track < NUM_TRACKS; track++) {
            data.copy(converted, writeOffset, readOffset, readOffset + STANDARD_TRACK_SIZE);
            writeOffset += STANDARD_TRACK_SIZE;
            
            // Move to next Side 1 track
            if (track === 0) {
                // After Track 0 Side 1, next is Track 1 Side 0 then Track 1 Side 1
                readOffset += STANDARD_TRACK_SIZE + STANDARD_TRACK_SIZE;
            } else {
                // Skip over the Side 0 track to get to next Side 1 track
                readOffset += STANDARD_TRACK_SIZE + STANDARD_TRACK_SIZE;
            }
        }
        
        return converted;
    }

    /**
     * Send a file to the SVI based on file type
     * @private
     * @param {string} filePath - Full path to the file
     * @param {string} fileType - Type of file (rom, disk, cas, savestate)
     */
    async _sendFileV2(filePath, fileType) {
        const RomLoader = require('../commands/RomLoader');
        const DiskLoader = require('../commands/DiskLoader');
        const CasLoader = require('../commands/CasLoader');
        const SaveStateLoader = require('../commands/SaveStateLoader');
        if (!this.frameTransport) return;

        const normalizedType = fileType.startsWith('disk') ? 'disk' : fileType;

        // Convert double-sided 40-track disk layouts from interleaved to sequential
        if (fileType === 'disk-basic-40ds' || fileType === 'disk-cpm-40ds') {
            const fs = require('fs');
            const data = this._convertDisk40dsLayout(fs.readFileSync(filePath));
            const tmpPath = filePath + '.tmp';
            fs.writeFileSync(tmpPath, data);
            filePath = tmpPath;
        }

        try {
            if (normalizedType === 'rom') {
                await RomLoader.load(filePath, this.frameTransport,
                    () => Prompt.print('ROM load complete'),
                    (err) => Prompt.print(`ROM load error: ${err.message}`)
                );
            } else if (normalizedType === 'disk') {
                await DiskLoader.load(filePath, this.frameTransport,
                    () => Prompt.print('Disk load complete'),
                    (err) => Prompt.print(`Disk load error: ${err.message}`)
                );
            } else if (normalizedType === 'cassette') {
                await CasLoader.load(filePath, this.frameTransport,
                    () => Prompt.print('Tape load complete'),
                    (err) => Prompt.print(`Tape load error: ${err.message}`)
                );
            } else if (normalizedType === 'savestate') {
                await SaveStateLoader.load(filePath, this.frameTransport,
                    () => Prompt.print('Save state load complete'),
                    (err) => Prompt.print(`Save state load error: ${err.message}`)
                );
            } else if (normalizedType === 'hdd') {
                await this.loadHddImage(filePath);
            } else {
                Prompt.print(`File type "${fileType}" not yet supported on v2`);
            }
        } catch (err) {
            Prompt.print(`Error sending file: ${err.message}`);
        }
    }

    /**
     * Send a file to the SVI based on file type (v1 protocol)
     * @private
     * @param {string} filePath - Full path to the file
     * @param {string} fileType - Type of file (rom, disk, cas, savestate)
     */
    async _sendFileToSVI(filePath, fileType) {
        try {
            const fs = require('fs');
            const { padToChunks, padBuffer } = require('./ProtocolUtils');
            const { CHUNK_SIZE } = require('../utils/networkConstants');
            
            let data = fs.readFileSync(filePath);
            let command, chunkSize;
            let saveStateType = 0;  // For save state files
            
            // Convert double-sided 40-track disk layouts from interleaved to sequential
            if (fileType === 'disk-basic-40ds' || fileType === 'disk-cpm-40ds') {
                data = this._convertDisk40dsLayout(data);
            }
            
            // HDD images are loaded into server memory, not streamed to Pico
            if (fileType === 'hdd') {
                this._loadHddImage(filePath);
                return;
            }

            const normalizedType = fileType.startsWith('disk') ? 'disk' : fileType;
            
            switch (normalizedType) {
                case 'rom':
                    if (data.length < 2048 || data.length > 65536) {
                        Prompt.print(`ROM file size must be 2048-65536 bytes, got ${data.length}`);
                        return;
                    }
                    // Pad to 64KB
                    data = padBuffer(data, 65536);
                    command = 'LR';
                    chunkSize = 65536; // ROM is sent in one chunk
                    break;
                    
                case 'disk':
                    if (data.length !== 172032 && data.length !== 346112) {
                        Prompt.print(`Disk image must be exactly 172032 or 346112 bytes, got ${data.length}`);
                        return;
                    }
                    command = 'LD';
                    chunkSize = CHUNK_SIZE; // Disk uses standard chunk size
                    break;
                    
                case 'cassette':
                    if (data.length > 524288) {
                        Prompt.print(`Max supported CAS size is 524288 bytes, got ${data.length}`);
                        return;
                    }
                    command = 'LT';
                    chunkSize = CHUNK_SIZE; // Cassette uses standard chunk size
                    break;
                    
                case 'savestate':
                    // Save state files have a 32-byte header (version 0x01)
                    if (data.length < 32 + 1024) {
                        Prompt.print(`Save state file too small: ${data.length} bytes`);
                        return;
                    }
                    // Verify header magic
                    const magic = data.subarray(0, 21).toString('ascii');
                    if (magic !== 'PicoExpanderSaveState') {
                        Prompt.print(`Invalid save state header`);
                        return;
                    }
                    // Check version - must be 0x01
                    const version = data.readUInt8(21);
                    if (version !== 0x01) {
                        Prompt.print(`Unsupported save state version: 0x${version.toString(16).padStart(2, '0')}`);
                        return;
                    }
                    // Get bank config from header byte 23
                    saveStateType = data.readUInt8(23);  // Bank config byte
                    // Strip the 32-byte header, but prepend the bank config byte
                    // Data format: bank_config (1 byte) + RAM4 + banks
                    const bankConfigByte = Buffer.alloc(1);
                    bankConfigByte.writeUInt8(saveStateType, 0);
                    data = Buffer.concat([bankConfigByte, data.subarray(32)]);
                    command = 'LS';
                    chunkSize = data.length;  // Send data size in chunk_size field
                    Prompt.print(`Save state bank config: 0x${saveStateType.toString(16).padStart(2, '0')}`);
                    break;
                    
                default:
                    Prompt.print(`Unknown file type: ${fileType}, cannot send`);
                    return;
            }
            
            Prompt.print(`Sending ${fileType} upload command...`);
            // For save state, total_size contains the bank config, chunk_size contains data length
            if (normalizedType === 'savestate') {
                this.tcpClient.write(createCommandBuffer(command, saveStateType, data.length));
            } else {
                this.tcpClient.write(createCommandBuffer(command, data.length, chunkSize));
            }
            
            // Pad to chunk boundaries (for disk/cassette, ROM is already padded)
            // Save state is sent as-is (no padding needed)
            if (normalizedType !== 'rom' && normalizedType !== 'savestate') {
                data = padToChunks(data, chunkSize);
            }
            
            let offset = 0;
            let state = 'waiting_for_OK';
            let sendInProgress = true;
            
            // For savestate, send entire data at once after OK
            const sendChunkSize = (normalizedType === 'savestate') ? data.length : chunkSize;
            
            // Create progress bar for upload
            const progressBar = new ProgressBar(data.length, 'Sending');
            
            const originalHandler = this.tcpClient.onData;
            
            this.tcpClient.onData(() => {
                if (!sendInProgress) return;
                
                try {
                    const response = this.tcpClient.readCommand();
                    if (!response) return;

                    if (state === 'waiting_for_OK' && response.cmd === 'OK') {
                        progressBar.update(0);
                        const chunk = data.subarray(offset, offset + sendChunkSize);
                        this.tcpClient.write(chunk);
                        offset += sendChunkSize;
                        progressBar.update(offset);
                        if (offset >= data.length) {
                            state = 'waiting_for_FI';
                        } else {
                            state = 'waiting_for_RD';
                        }
                    } else if (state === 'waiting_for_OK' && response.cmd === 'EC') {
                        progressBar.clear();
                        Prompt.print(`Upload failed - another command is in progress. Please try again.`);
                        sendInProgress = false;
                        this.tcpClient.onData(() => { this._handlePicoRequest(); });
                    } else if (state === 'waiting_for_RD' && response.cmd === 'RD') {
                        const chunk = data.subarray(offset, offset + sendChunkSize);
                        this.tcpClient.write(chunk);
                        offset += sendChunkSize;
                        progressBar.update(offset);
                        if (offset >= data.length) {
                            state = 'waiting_for_FI';
                        }
                    } else if (state === 'waiting_for_FI' && response.cmd === 'FI') {
                        progressBar.complete();
                        Prompt.print(`Upload finished successfully.`);
                        sendInProgress = false;
                        this.tcpClient.onData(() => { this._handlePicoRequest(); });
                    } else {
                        progressBar.clear();
                        Prompt.print(`Unexpected command '${response.cmd}' in state '${state}'`);
                        sendInProgress = false;
                        this.tcpClient.onData(() => { this._handlePicoRequest(); });
                    }
                } catch (err) {
                    progressBar.clear();
                    Prompt.print(`Error during file transfer: ${err.message}`);
                    sendInProgress = false;
                    this.tcpClient.onData(() => { this._handlePicoRequest(); });
                }
            });
            
        } catch (err) {
            Prompt.print(`Failed to send file: ${err.message}`);
        }
    }

    /**
     * Load an HDD image into server memory and notify the Pico
     * @private
     * @param {string} filePath - Full path to the .hdd file
     */
    _loadHddImage(filePath) {
        try {
            const hddImage = fs.readFileSync(filePath);
            this.hddImage = hddImage;
            this.hddFd = fs.openSync(filePath, 'r+');
            const totalLBAs = Math.floor(hddImage.length / 256);

            // Send HI notification (geometry)
            this.tcpClient.write(createCommandBuffer('HI', totalLBAs, 0));

            // Immediately push sector 0 (boot sector) so Pico is boot-ready
            const sector0 = Buffer.alloc(10 + 256);
            sector0.write('FS');
            sector0.writeUInt32BE(0, 2);     // offset 0 (LBA 0)
            sector0.writeUInt16BE(0, 6);     // file_number 0 (HDD)
            sector0.writeUInt16BE(256, 8);   // length 256
            hddImage.copy(sector0, 10, 0, 256);
            this.tcpClient.write(sector0);

            Prompt.print(`HDD: Loaded ${path.basename(filePath)} (${totalLBAs} sectors, sector 0 pushed)`);
        } catch (err) {
            Prompt.print(`Failed to load HDD image: ${err.message}`);
        }
    }

    /**
     * Handle FR (File Read) request from Pico
     * @private
     * @param {Buffer} header - 10-byte command header
     */
    _handleFR(header) {
        const offset = header.readUInt32BE(2);
        const fileNumber = header.readUInt16BE(6);
        const length = header.readUInt16BE(8);
        const byteOffset = offset * length;

        const resp = Buffer.alloc(10 + length);
        resp.write('FS');
        resp.writeUInt32BE(offset, 2);
        resp.writeUInt16BE(fileNumber, 6);
        resp.writeUInt16BE(length, 8);

        if (this.hddImage && byteOffset + length <= this.hddImage.length) {
            this.hddImage.copy(resp, 10, byteOffset, byteOffset + length);
        }
        this.tcpClient.write(resp);
    }

    /**
     * Handle FW (File Write) request from Pico
     * @private
     * @param {Buffer} header - 10-byte command header
     * @param {Buffer} payload - sector data
     */
    _handleFW(header, payload) {
        const offset = header.readUInt32BE(2);
        const fileNumber = header.readUInt16BE(6);
        const length = header.readUInt16BE(8);
        const byteOffset = offset * length;

        if (this.hddImage && byteOffset + length <= this.hddImage.length) {
            payload.copy(this.hddImage, byteOffset, 0, length);
            // Write-through: persist to .hdd file on disk
            if (this.hddFd !== null && this.hddFd !== undefined) {
                fs.writeSync(this.hddFd, this.hddImage.subarray(byteOffset, byteOffset + length), 0, length, byteOffset);
            }
        }

        // Send ACK (header only, no payload)
        const ack = Buffer.alloc(10);
        ack.write('FS');
        ack.writeUInt32BE(offset, 2);
        ack.writeUInt16BE(fileNumber, 6);
        ack.writeUInt16BE(length, 8);
        this.tcpClient.write(ack);
    }

    /**
     * Capture save state from Pico using existing connection
     * Pico scans banks and sends only non-empty ones
     * Protocol: OK (10 bytes) + bank_config (1 byte) + RAM4 + banks
     * @param {string} filename - Full path to save the file
     * @private
     */
    _captureSaveState(filename) {
        console.log('Waiting for Pico to scan banks and send data...');
        
        let captureInProgress = true;
        let state = 'waiting_for_ok';
        let bankConfig = null;
        let expectedDataSize = null;
        let chunks = [];
        let progressBar = null;
        
        this.tcpClient.setBuffer(Buffer.alloc(0));
        
        this.tcpClient.onData(() => {
            if (!captureInProgress) return;
            
            const buffer = this.tcpClient.getBuffer();
            
            try {
                if (state === 'waiting_for_ok') {
                    if (buffer.length < 10) {
                        return;
                    }
                    
                    const cmd = buffer.subarray(0, 2).toString('ascii');
                    
                    if (cmd === 'OK') {
                        state = 'waiting_for_bank_config';
                        const afterOK = buffer.subarray(10);
                        this.tcpClient.setBuffer(Buffer.alloc(0));
                        if (afterOK.length > 0) {
                            chunks.push(afterOK);
                        }
                        
                        // Check if we already have the bank config byte
                        const currentBuffer = Buffer.concat(chunks);
                        if (currentBuffer.length >= 1) {
                            bankConfig = currentBuffer.readUInt8(0);
                            expectedDataSize = SaveStateSaver.calculateExpectedDataSize(bankConfig);
                            console.log(`Bank config received: 0x${bankConfig.toString(16).padStart(2, '0')} (${SaveStateSaver.getBankConfigDescription(bankConfig)})`);
                            console.log(`Expected data size: ${expectedDataSize} bytes`);
                            state = 'receiving_data';
                            progressBar = new ProgressBar(expectedDataSize, 'Receiving');
                            progressBar.update(currentBuffer.length);
                        }
                    } else if (cmd === 'EC') {
                        Prompt.print("Save state failed - another command is in progress.");
                        captureInProgress = false;
                        this.tcpClient.setBuffer(Buffer.alloc(0));
                        this.tcpClient.onData(() => { this._handlePicoRequest(); });
                        return;
                    } else if (cmd === 'ER') {
                        Prompt.print("Save state failed - error response from device.");
                        captureInProgress = false;
                        this.tcpClient.setBuffer(Buffer.alloc(0));
                        this.tcpClient.onData(() => { this._handlePicoRequest(); });
                        return;
                    }
                } else if (state === 'waiting_for_bank_config') {
                    if (buffer.length > 0) {
                        chunks.push(buffer);
                        this.tcpClient.setBuffer(Buffer.alloc(0));
                    }
                    
                    const currentBuffer = Buffer.concat(chunks);
                    if (currentBuffer.length >= 1) {
                        bankConfig = currentBuffer.readUInt8(0);
                        expectedDataSize = SaveStateSaver.calculateExpectedDataSize(bankConfig);
                        console.log(`Bank config received: 0x${bankConfig.toString(16).padStart(2, '0')} (${SaveStateSaver.getBankConfigDescription(bankConfig)})`);
                        console.log(`Expected data size: ${expectedDataSize} bytes`);
                        state = 'receiving_data';
                        progressBar = new ProgressBar(expectedDataSize, 'Receiving');
                        progressBar.update(currentBuffer.length);
                    }
                } else if (state === 'receiving_data') {
                    if (buffer.length > 0) {
                        chunks.push(buffer);
                        this.tcpClient.setBuffer(Buffer.alloc(0));
                    }
                    
                    const totalReceived = chunks.reduce((sum, c) => sum + c.length, 0);
                    if (progressBar) progressBar.update(totalReceived);
                    
                    if (totalReceived >= expectedDataSize) {
                        if (progressBar) progressBar.complete();
                        
                        const receivedData = Buffer.concat(chunks);
                        
                        // Extract data: skip first byte (bank config), then RAM4, then banks
                        const dataAfterConfig = receivedData.subarray(1, expectedDataSize);
                        
                        // Create version 0x01 header with received bank configuration
                        const header = Buffer.alloc(SaveStateSaver.HEADER_SIZE, 0x00);
                        header.write(SaveStateSaver.HEADER_MAGIC, 0, 'ascii');
                        header.writeUInt8(SaveStateSaver.HEADER_VERSION, 21); // Version 0x01
                        // Byte 22 is reserved (0x00)
                        header.writeUInt8(bankConfig, 23); // Bank config from Pico
                        
                        const saveStateFile = Buffer.concat([header, dataAfterConfig]);
                        
                        console.log(`\nBank configuration: 0x${bankConfig.toString(16).padStart(2, '0')} (${SaveStateSaver.getBankConfigDescription(bankConfig)})`);
                        
                        try {
                            fs.writeFileSync(filename, saveStateFile);
                            console.log(`Save state saved to: ${filename}`);
                            console.log(`Total file size: ${saveStateFile.length} bytes`);
                            Prompt.print('Save state capture complete');
                        } catch (writeErr) {
                            Prompt.print(`Error writing file: ${writeErr.message}`);
                        }
                        
                        const extraData = receivedData.subarray(expectedDataSize);
                        this.tcpClient.setBuffer(extraData);
                        
                        captureInProgress = false;
                        this.tcpClient.onData(() => { this._handlePicoRequest(); });
                    }
                }
            } catch (err) {
                Prompt.print(`Error during save state capture: ${err.message}`);
                captureInProgress = false;
                this.tcpClient.setBuffer(Buffer.alloc(0));
                this.tcpClient.onData(() => { this._handlePicoRequest(); });
            }
        });
        
        const cmdBuffer = createCommandBuffer("SV", 0, 0);
        this.tcpClient.write(cmdBuffer);
    }
}

module.exports = PicoConnection;
