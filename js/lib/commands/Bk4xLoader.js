const fs = require('fs');
const NetworkDiscovery = require('../network/NetworkDiscovery');
const TcpClient = require('../network/TcpClient');
const { createCommandBuffer, padBuffer } = require('../network/ProtocolUtils');

/**
 * Bk4xLoader handles BK31/BK32 launcher ROM file uploads to the SVI-3x8 PicoExpander
 */
class Bk4xLoader {
    /**
     * Load a BK4X launcher ROM file to the device
     * @param {string} filename - Path to ROM file
     * @param {Object} picoAddress - Optional. If provided, uses existing connection instead of UDP discovery
     * @param {Function} onComplete - Optional callback when operation completes
     * @param {Function} onError - Optional callback on error
     */
    static async load(filename, picoAddress = null, onComplete = null, onError = null) {
        let romData = fs.readFileSync(filename);
        
        if (romData.length > 65536) {
            console.error(`ROM file size must be max 65536 bytes, now ${romData.length} bytes`);
            if (picoAddress) {
                // Interactive mode - don't exit
                if (onError) onError(new Error('Invalid ROM size'));
                return;
            }
            process.exit(1);
        }
        
        // Pad to 64KB if needed (use 0xFF as that's the empty ROM state)
        romData = padBuffer(romData, 65536, 0xFF);
        
        let remote = picoAddress;
        if (!remote) {
            const discovery = new NetworkDiscovery();
            remote = await discovery.waitForHandshake();
        }
        
        const client = new TcpClient(remote);
        await client.connect();
        
        console.log("Connected. Sending BK4X upload command...");
        client.write(createCommandBuffer("LL", romData.length, romData.length));

        client.onData(() => {
            try {
                const response = client.readCommand();
                if (!response) return;

                if (response.cmd === 'OK') {
                    console.log("Received OK. Sending ROM data...");
                    client.write(romData);
                    console.log("ROM image sent");
                    client.end();
                } else if (response.cmd === 'EC') {
                    console.error("Bk4x load failed - another command is in progress. Please try again.");
                    client.end();
                    reject(new Error('Command in progress'));
                } else if (response.cmd === 'ER') {
                    console.error("Error response received, aborting...");
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

module.exports = Bk4xLoader;
