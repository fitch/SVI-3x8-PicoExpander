const fs = require('fs');
const path = require('path');
const NetworkDiscovery = require('../network/NetworkDiscovery');
const TcpClient = require('../network/TcpClient');
const { createCommandBuffer } = require('../network/ProtocolUtils');
const ProgressBar = require('../utils/ProgressBar');

class DiskSaver {
    /**
     * Convert 40-track double-sided disk layout from sequential back to interleaved
     * Reverses the conversion done by PicoConnection._convertDisk40dsLayout
     * Input (Pico format): All Side 0 tracks (0-39), then all Side 1 tracks (0-39)
     * Output (.dsk format): Track 0 Side 0, Track 0 Side 1, Track 1 Side 0, Track 1 Side 1, ...
     * @private
     * @param {Buffer} data - Sequential disk image data from Pico
     * @returns {Buffer} - Interleaved disk image data for .dsk file
     */
    static _convertDisk40dsToInterleaved(data) {
        const TRACK_0_SIDE_0_SIZE = 18 * 128; // 2,304 bytes
        const STANDARD_TRACK_SIZE = 17 * 256;  // 4,352 bytes
        const NUM_TRACKS = 40;
        const EXPECTED_SIZE = 346112;

        if (data.length !== EXPECTED_SIZE) {
            return data;
        }

        const interleaved = Buffer.alloc(data.length);
        let writeOffset = 0;

        // Side 0 starts at offset 0 in sequential data
        // Side 1 starts after all Side 0 tracks: 2304 + 39*4352 = 172032
        const side0Start = 0;
        const side1Start = TRACK_0_SIDE_0_SIZE + (NUM_TRACKS - 1) * STANDARD_TRACK_SIZE; // 172032

        // Track 0 Side 0 (2,304 bytes)
        data.copy(interleaved, writeOffset, side0Start, side0Start + TRACK_0_SIDE_0_SIZE);
        writeOffset += TRACK_0_SIDE_0_SIZE;

        // Track 0 Side 1 (4,352 bytes)
        data.copy(interleaved, writeOffset, side1Start, side1Start + STANDARD_TRACK_SIZE);
        writeOffset += STANDARD_TRACK_SIZE;

        // Tracks 1-39: Side 0 then Side 1 for each track
        for (let track = 1; track < NUM_TRACKS; track++) {
            // Side 0 track location in sequential data
            const side0Offset = TRACK_0_SIDE_0_SIZE + (track - 1) * STANDARD_TRACK_SIZE;
            data.copy(interleaved, writeOffset, side0Offset, side0Offset + STANDARD_TRACK_SIZE);
            writeOffset += STANDARD_TRACK_SIZE;

            // Side 1 track location in sequential data
            const side1Offset = side1Start + track * STANDARD_TRACK_SIZE;
            data.copy(interleaved, writeOffset, side1Offset, side1Offset + STANDARD_TRACK_SIZE);
            writeOffset += STANDARD_TRACK_SIZE;
        }

        return interleaved;
    }

    static async save(filename = null, picoAddress = null, onComplete = null, onError = null) {
        if (!filename) {
            filename = path.join(process.cwd(), 'saved_disk.dsk');
        }
        
        if (!filename.endsWith('.dsk')) {
            filename += '.dsk';
        }

        let receivedData = Buffer.alloc(0);
        
        let remote = picoAddress;
        if (!remote) {
            const discovery = new NetworkDiscovery();
            remote = await discovery.waitForHandshake();
        }
        
        const client = new TcpClient(remote);
        await client.connect();
        
        let waitingForOK = true;
        let expectedSize = 0;
        let chunks = [];
        let progressBar = null;

        client.client.on('data', (chunk) => {
            chunks.push(chunk);
            const totalReceived = chunks.reduce((sum, c) => sum + c.length, 0);
            
            try {
                if (waitingForOK) {
                    const currentBuffer = Buffer.concat(chunks);
                    
                    if (currentBuffer.length < 10) {
                        return;
                    }
                    
                    const cmd = currentBuffer.subarray(0, 2).toString('ascii');

                    if (cmd === 'OK') {
                        // Disk size is encoded in bytes 2-5 (big-endian)
                        expectedSize = currentBuffer.readUInt32BE(2);
                        
                        if (expectedSize === 0) {
                            console.error("No disk image available on device. Dump a disk first.");
                            client.end();
                            if (onError) onError(new Error('No disk image available'));
                            return;
                        }
                        
                        console.log(`Disk image size: ${expectedSize} bytes`);
                        waitingForOK = false;
                        const afterOK = currentBuffer.subarray(10);
                        chunks = afterOK.length > 0 ? [afterOK] : [];
                        progressBar = new ProgressBar(expectedSize, 'Receiving');
                        progressBar.update(afterOK.length);
                    } else if (cmd === 'EC') {
                        console.error("Disk save failed - another command is in progress. Please try again.");
                        client.end();
                        if (onError) onError(new Error('Another command in progress'));
                    } else if (cmd === 'ER') {
                        console.error("Error response from device");
                        client.end();
                        if (onError) onError(new Error('Device returned error'));
                    }
                } else {
                    if (progressBar) progressBar.update(totalReceived);
                    
                    if (totalReceived >= expectedSize) {
                        if (progressBar) progressBar.complete();
                        receivedData = Buffer.concat(chunks);
                        let finalData = receivedData.subarray(0, expectedSize);
                        
                        // Convert 40ds layout from sequential (Pico) back to interleaved (.dsk)
                        if (finalData.length === 346112) {
                            finalData = DiskSaver._convertDisk40dsToInterleaved(finalData);
                        }
                        
                        try {
                            fs.writeFileSync(filename, finalData);
                            console.log(`\nDisk image saved to: ${filename}`);
                        } catch (writeErr) {
                            console.error(`Error writing file: ${writeErr.message}`);
                            if (onError) onError(writeErr);
                        }
                        
                        client.end();
                    }
                }
            } catch (err) {
                console.error(`Error: ${err.message}`);
                client.end();
                if (onError) onError(err);
            }
        });

        client.onClose(() => {
            const totalReceived = chunks.reduce((sum, c) => sum + c.length, 0);
            
            if (totalReceived < expectedSize && !waitingForOK) {
                console.error(`Warning: Only received ${totalReceived} bytes, expected ${expectedSize}`);
                if (chunks.length > 0) {
                    try {
                        receivedData = Buffer.concat(chunks);
                        fs.writeFileSync(filename, receivedData);
                        console.log(`\nPartial disk image saved to: ${filename} (${receivedData.length} bytes)`);
                    } catch (writeErr) {
                        console.error(`Error writing file: ${writeErr.message}`);
                    }
                }
            }
            
            if (onComplete) onComplete();
        });

        client.onError((err) => {
            console.error(`TCP Error: ${err.message}`);
            if (onError) onError(err);
        });

        client.write(createCommandBuffer("SD", 0, 0)); // SD = Save Disk
    }
}

module.exports = DiskSaver;
