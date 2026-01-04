const fs = require('fs');
const path = require('path');
const NetworkDiscovery = require('../network/NetworkDiscovery');
const TcpClient = require('../network/TcpClient');
const { createCommandBuffer } = require('../network/ProtocolUtils');
const ProgressBar = require('../utils/ProgressBar');

class BiosSaver {
    static async save(filename = null, picoAddress = null, onComplete = null, onError = null) {
        if (!filename) {
            filename = path.join(process.cwd(), 'saved_bios.bin');
        }
        
        const expectedSize = 32768; // BIOS is 32KB
        let receivedData = Buffer.alloc(0);
        
        let remote = picoAddress;
        if (!remote) {
            const discovery = new NetworkDiscovery();
            remote = await discovery.waitForHandshake();
        }
        
        const client = new TcpClient(remote);
        await client.connect();
        
        let waitingForOK = true;
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
                        waitingForOK = false;
                        const afterOK = currentBuffer.subarray(10);
                        chunks = afterOK.length > 0 ? [afterOK] : [];
                        progressBar = new ProgressBar(expectedSize, 'Receiving');
                        progressBar.update(afterOK.length);
                    } else if (cmd === 'EC') {
                        console.error("BIOS save failed - another command is in progress. Please try again.");
                        client.end();
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
                        const finalData = receivedData.subarray(0, expectedSize);
                        
                        try {
                            fs.writeFileSync(filename, finalData);
                            console.log(`\nBIOS data saved to: ${filename}`);
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
                        console.log(`\nPartial BIOS data saved to: ${filename} (${receivedData.length} bytes)`);
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

        client.write(createCommandBuffer("SI", 0, 0)); // SI = Save bIos
    }
}

module.exports = BiosSaver;
