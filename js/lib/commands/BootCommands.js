const NetworkDiscovery = require('../network/NetworkDiscovery');
const TcpClient = require('../network/TcpClient');
const { createCommandBuffer } = require('../network/ProtocolUtils');

/**
 * BootCommands handles various boot-related commands for the SVI-3x8 PicoExpander
 */
class BootCommands {
    /**
     * Boot back to launcher
     * @param {Object} picoAddress - Optional. If provided, uses existing connection instead of UDP discovery
     * @param {Function} onComplete - Optional callback when operation completes
     * @param {Function} onError - Optional callback on error
     */
    static async bootToLauncher(picoAddress = null, onComplete = null, onError = null) {
        let remote = picoAddress;
        
        if (!remote) {
            const discovery = new NetworkDiscovery();
            remote = await discovery.waitForHandshake();
        }
        
        const client = new TcpClient(remote);
        await client.connect();
        
        console.log("Connected. Sending request to boot back to launcher...");
        client.write(createCommandBuffer("BL", 0, 0));

        client.onData(() => {
            try {
                const response = client.readCommand();
                if (!response) return;

                if (response.cmd === 'OK') {
                    console.log("Boot was successful.");
                    client.end();
                } else if (response.cmd === 'EC') {
                    console.error("Boot failed - another command is in progress. Please try again.");
                    client.end();
                } else if (response.cmd === 'ER') {
                    console.error("Boot was unsuccessful, aborting...");
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

module.exports = BootCommands;
