const dgram = require('dgram');
const readline = require('readline');
const { UDP_PORT, HANDSHAKE_MESSAGE } = require('../utils/networkConstants');
const Prompt = require('../ui/Prompt');

/**
 * NetworkDiscovery handles UDP-based device discovery
 */
class NetworkDiscovery {
    constructor() {
        this.udpServer = null;
    }

    selectDevice(devices) {
        const CommandHandler = require('../ui/CommandHandler');
        
        return new Promise((resolve) => {
            CommandHandler.disable();
            Prompt.setActive(false);
            
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            const askSelection = () => {
                rl.question(`Select device (1-${devices.length}): `, (answer) => {
                    const selection = parseInt(answer.trim(), 10);
                    if (selection >= 1 && selection <= devices.length) {
                        rl.close();
                        CommandHandler.enable();
                        Prompt.setActive(true);
                        resolve(devices[selection - 1]);
                    } else {
                        console.log(`Invalid selection. Enter a number between 1 and ${devices.length}.`);
                        askSelection();
                    }
                });
            };

            askSelection();
        });
    }

    async waitForHandshake() {
        const discoveredDevices = await this.discoverDevices();
        
        if (discoveredDevices.length === 1) {
            return discoveredDevices[0];
        } else {
            Prompt.print(`\nFound ${discoveredDevices.length} PicoExpander devices:`);
            discoveredDevices.forEach((dev, index) => {
                Prompt.print(`  ${index + 1}. [${dev.identifier}] ${dev.address}`);
            });
            return await this.selectDevice(discoveredDevices);
        }
    }

    /**
     * Wait for a specific PicoExpander by identifier
     * Used for reconnection to ensure we reconnect to the same device
     * @param {string} targetIdentifier - The identifier of the Pico to find
     * @param {number} timeout - Timeout in milliseconds (default: 10000)
     * @returns {Promise<Object|null>} The device object or null if not found
     */
    async waitForHandshakeByIdentifier(targetIdentifier, timeout = 10000) {
        return new Promise((resolve, reject) => {
            this.udpServer = dgram.createSocket('udp4');
            let timeoutHandle = null;
            let resolved = false;

            this.udpServer.on('listening', () => {
                Prompt.print(`Scanning for PicoExpander [${targetIdentifier}]...`);
            });

            this.udpServer.on('error', (err) => {
                if (resolved) return;
                resolved = true;
                if (timeoutHandle) clearTimeout(timeoutHandle);
                // Don't reject on close error - just resolve null
                if (err.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') {
                    resolve(null);
                } else {
                    reject(err);
                }
            });

            this.udpServer.on('close', () => {
                if (resolved) return;
                resolved = true;
                if (timeoutHandle) clearTimeout(timeoutHandle);
                resolve(null);  // Socket was closed externally (abort)
            });

            this.udpServer.bind(UDP_PORT, () => {
                this.udpServer.setBroadcast(true);
            });

            // Set overall timeout for finding the specific device
            timeoutHandle = setTimeout(() => {
                if (resolved) return;
                resolved = true;
                this.udpServer.close();
                resolve(null);  // Return null if not found within timeout
            }, timeout);

            this.udpServer.on('message', (message, remote) => {
                if (resolved) return;
                
                const msgString = message.toString().trim();
                let identifier = null;

                if (msgString.startsWith(HANDSHAKE_MESSAGE + ' ')) {
                    identifier = msgString.slice(-2);
                } else if (msgString === HANDSHAKE_MESSAGE) {
                    identifier = 'unknown';
                } else {
                    return;
                }

                // Check if this is the device we're looking for
                if (identifier === targetIdentifier) {
                    if (resolved) return;
                    resolved = true;
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    this.udpServer.close();
                    const device = { ...remote, identifier };
                    Prompt.print(`Found PicoExpander [${identifier}] at ${remote.address}`);
                    resolve(device);
                }
            });
        });
    }

    discoverDevices() {
        return new Promise((resolve, reject) => {
            this.udpServer = dgram.createSocket('udp4');
            const discoveredDevices = [];
            let discoveryTimeout = null;
            
            this.udpServer.on('listening', () => {
                Prompt.print("Scanning for SVI-3x8 PicoExpanders...");
            });

            this.udpServer.on('error', (err) => {
                if (discoveryTimeout) clearTimeout(discoveryTimeout);
                reject(err);
            });

            this.udpServer.bind(UDP_PORT, () => {
                this.udpServer.setBroadcast(true);
            });

            this.udpServer.on('message', (message, remote) => {
                const msgString = message.toString().trim();
                let identifier = null;

                if (msgString.startsWith(HANDSHAKE_MESSAGE + ' ')) {
                    identifier = msgString.slice(-2);
                } else if (msgString === HANDSHAKE_MESSAGE) {
                    identifier = 'unknown';
                } else {
                    return;
                }

                const deviceKey = `${remote.address}:${identifier}`;
                if (!discoveredDevices.some(d => `${d.address}:${d.identifier}` === deviceKey)) {
                    const device = { ...remote, identifier };
                    discoveredDevices.push(device);
                    Prompt.print(`Found PicoExpander [${identifier}] at ${remote.address}`);

                    if (discoveredDevices.length === 1) {
                        discoveryTimeout = setTimeout(() => {
                            this.udpServer.close();
                            resolve(discoveredDevices);
                        }, 1000);
                    }
                }
            });
        });
    }

    close() {
        if (this.udpServer) {
            this.udpServer.close();
            this.udpServer = null;
        }
    }
}

module.exports = NetworkDiscovery;
