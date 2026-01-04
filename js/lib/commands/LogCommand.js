const NetworkDiscovery = require('../network/NetworkDiscovery');
const TcpClient = require('../network/TcpClient');
const { createCommandBuffer } = require('../network/ProtocolUtils');
const LogAnalyzer = require('./LogAnalyzer');
const Prompt = require('../ui/Prompt');

/**
 * LogCommand handles retrieving and displaying logs from the SVI-3x8 PicoExpander
 */
class LogCommand {
    /**
     * Get and display both text and hardware logs from the device
     */
    static async getLog() {
        const analyzer = new LogAnalyzer();
        
        const discovery = new NetworkDiscovery();
        const remote = await discovery.waitForHandshake();
        
        const client = new TcpClient(remote);
        await client.connect();
        
        Prompt.print("Requesting logs...");
        client.write(createCommandBuffer("SL", 0, 0));

        let receivedResponse = false;

        client.onData(() => {
            const buffer = client.getBuffer();
            
            if (!receivedResponse && buffer.length >= 2) {
                const response = buffer.toString('ascii', 0, 2);
                
                if (response === 'OK') {
                    const remaining = buffer.subarray(2);
                    client.setBuffer(remaining);
                    receivedResponse = true;
                } else if (response === 'EC') {
                    Prompt.print("Log retrieval failed - another command is in progress. Please try again.");
                    client.end();
                    return;
                } else if (response === 'ER') {
                    Prompt.print("Log retrieval failed - error on Pico.");
                    client.end();
                    return;
                }
            }
            
            if (receivedResponse) {
                const buffer = client.getBuffer();
                
                const fiIndex = buffer.indexOf('FI');
                if (fiIndex !== -1) {
                    if (fiIndex > 0) {
                        const logData = buffer.subarray(0, fiIndex);
                        analyzer.processLogData(logData);
                    }
                    Prompt.print('\nLog transfer complete');
                    client.end();
                    process.exit(0);
                    return;
                }
                
                const remaining = analyzer.processLogData(buffer);
                client.setBuffer(remaining);
            }
        });

        client.onClose(() => {
        });

        client.onError((err) => {
            Prompt.print(`TCP Error: ${err.message}`);
        });
    }

    /**
     * Get and display only text log from the device
     */
    static async getTextLog() {
        const analyzer = new LogAnalyzer();
        
        const discovery = new NetworkDiscovery();
        const remote = await discovery.waitForHandshake();
        
        const client = new TcpClient(remote);
        await client.connect();
        
        Prompt.print("Requesting text log...");
        client.write(createCommandBuffer("ST", 0, 0));

        let receivedResponse = false;

        client.onData(() => {
            const buffer = client.getBuffer();
            
            if (!receivedResponse && buffer.length >= 2) {
                const response = buffer.toString('ascii', 0, 2);
                
                if (response === 'OK') {
                    const remaining = buffer.subarray(2);
                    client.setBuffer(remaining);
                    receivedResponse = true;
                } else if (response === 'EC') {
                    Prompt.print("Text log retrieval failed - another command is in progress. Please try again.");
                    client.end();
                    return;
                } else if (response === 'ER') {
                    Prompt.print("Text log retrieval failed - error on Pico.");
                    client.end();
                    return;
                }
            }
            
            if (receivedResponse) {
                const buffer = client.getBuffer();
                
                const fiIndex = buffer.indexOf('FI');
                if (fiIndex !== -1) {
                    if (fiIndex > 0) {
                        const logData = buffer.subarray(0, fiIndex);
                        analyzer.processLogData(logData);
                    }
                    Prompt.print('\nLog transfer complete');
                    client.end();
                    process.exit(0);
                    return;
                }
                
                const remaining = analyzer.processLogData(buffer);
                client.setBuffer(remaining);
            }
        });

        client.onClose(() => {
        });

        client.onError((err) => {
            Prompt.print(`TCP Error: ${err.message}`);
        });
    }

    /**
     * Get and display only hardware log from the device
     */
    static async getHardwareLog() {
        const analyzer = new LogAnalyzer();
        
        const discovery = new NetworkDiscovery();
        const remote = await discovery.waitForHandshake();
        
        const client = new TcpClient(remote);
        await client.connect();
        
        Prompt.print("Requesting hardware log...");
        client.write(createCommandBuffer("SH", 0, 0));

        let receivedResponse = false;

        client.onData(() => {
            const buffer = client.getBuffer();
            
            if (!receivedResponse && buffer.length >= 2) {
                const response = buffer.toString('ascii', 0, 2);
                
                if (response === 'OK') {
                    const remaining = buffer.subarray(2);
                    client.setBuffer(remaining);
                    receivedResponse = true;
                } else if (response === 'EC') {
                    Prompt.print("Hardware log retrieval failed - another command is in progress. Please try again.");
                    client.end();
                    return;
                } else if (response === 'ER') {
                    Prompt.print("Hardware log retrieval failed - error on Pico.");
                    client.end();
                    return;
                }
            }
            
            if (receivedResponse) {
                const buffer = client.getBuffer();
                
                const fiIndex = buffer.indexOf('FI');
                if (fiIndex !== -1) {
                    if (fiIndex > 0) {
                        const logData = buffer.subarray(0, fiIndex);
                        analyzer.processLogData(logData);
                    }
                    Prompt.print('\nLog transfer complete');
                    client.end();
                    process.exit(0);
                    return;
                }
                
                const remaining = analyzer.processLogData(buffer);
                client.setBuffer(remaining);
            }
        });

        client.onClose(() => {
        });

        client.onError((err) => {
            Prompt.print(`TCP Error: ${err.message}`);
        });
    }
}

module.exports = LogCommand;
