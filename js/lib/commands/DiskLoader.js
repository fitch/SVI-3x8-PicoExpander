const fs = require('fs');
const NetworkDiscovery = require('../network/NetworkDiscovery');
const TcpClient = require('../network/TcpClient');
const { createCommandBuffer, padToChunks } = require('../network/ProtocolUtils');
const { CHUNK_SIZE } = require('../utils/networkConstants');

/**
 * DiskLoader handles disk image uploads to the SVI-3x8 PicoExpander
 */
class DiskLoader {
    /**
     * Load a disk image file to the device
     * @param {string} filename - Path to disk image file
     * @param {Object} picoAddress - Optional. If provided, uses existing connection instead of UDP discovery
     * @param {Function} onComplete - Optional callback when operation completes
     * @param {Function} onError - Optional callback on error
     */
    static async load(filename, picoAddress = null, onComplete = null, onError = null) {
        let diskData = fs.readFileSync(filename);
        
        if (diskData.length !== 172032 && diskData.length !== 346112) {
            console.error("Disk image file must be exactly 172032 or 346112 bytes");
            if (picoAddress) {
                // Interactive mode - don't exit
                if (onError) onError(new Error('Invalid disk size'));
                return;
            }
            process.exit(1);
        }
        
        let remote = picoAddress;
        if (!remote) {
            const discovery = new NetworkDiscovery();
            remote = await discovery.waitForHandshake();
        }
        
        const client = new TcpClient(remote);
        await client.connect();
        
        console.log("Connected. Sending disk upload command...");
        client.write(createCommandBuffer("LD", diskData.length, CHUNK_SIZE));

        // Pad to chunk boundaries
        diskData = padToChunks(diskData, CHUNK_SIZE);

        let offset = 0;
        let state = 'waiting_for_OK';

        client.onData(() => {
            try {
                const response = client.readCommand();
                if (!response) return;

                if (state === 'waiting_for_OK' && response.cmd === 'OK') {
                    console.log("Received OK. Sending first chunk...");
                    const chunk = diskData.subarray(offset, offset + CHUNK_SIZE);
                    client.write(chunk);
                    console.log(`Sent chunk at offset ${offset}`);
                    offset += CHUNK_SIZE;
                    state = 'waiting_for_RD';
                } else if (state === 'waiting_for_OK' && response.cmd === 'EC') {
                    console.error("Disk load failed - another command is in progress. Please try again.");
                    client.end();
                    if (onError) onError(new Error('Command in progress'));
                } else if (state === 'waiting_for_RD' && response.cmd === 'RD') {
                    const chunk = diskData.subarray(offset, offset + CHUNK_SIZE);
                    client.write(chunk);
                    console.log(`Sent chunk at offset ${offset}`);
                    offset += CHUNK_SIZE;
                    if (offset >= diskData.length) {
                        state = 'waiting_for_FI';
                    }
                } else if (state === 'waiting_for_FI' && response.cmd === 'FI') {
                    console.log("Upload finished successfully. Closing.");
                    client.end();
                } else {
                    console.error(`Unexpected command '${response.cmd}' in state '${state}'`);
                    client.end();
                }
            } catch (err) {
                console.error(err.message);
                client.end();
            }
        });

        client.onClose(() => {
            console.log('TCP connection closed');
            if (onComplete) onComplete();
        });

        client.onError((err) => {
            console.error(`TCP Error: ${err.message}`);
            if (onError) onError(err);
        });
    }
}

module.exports = DiskLoader;
