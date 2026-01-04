const fs = require('fs');
const path = require('path');
const NetworkDiscovery = require('../network/NetworkDiscovery');
const TcpClient = require('../network/TcpClient');
const { createCommandBuffer } = require('../network/ProtocolUtils');
const ProgressBar = require('../utils/ProgressBar');

/**
 * Bank configuration bit flags for version 0x01
 * Each bit represents whether a specific bank is included in the save state
 */
const BANK_CONFIG = {
    BK01: 0x01,  // Bit 0: BIOS ROM (32KB)
    BK02: 0x02,  // Bit 1: RAM0 (32KB)
    BK11: 0x04,  // Bit 2: ROM_CARTRIDGE lower (32KB)
    BK12: 0x08,  // Bit 3: ROM_CARTRIDGE upper (32KB)
    BK21: 0x10,  // Bit 4: RAM2 lower (32KB)
    BK22: 0x20,  // Bit 5: RAM2 upper (32KB)
    BK31: 0x40,  // Bit 6: RAM3 lower (32KB)
    BK32: 0x80   // Bit 7: RAM3 upper (32KB)
};

/**
 * All banks configuration - Pico always sends all banks
 */
const BANK_CONFIG_ALL = 0xFF;  // All 8 banks

/**
 * RAM4 dump size (0xB000-0xF03F = 16448 bytes)
 */
const RAM4_DUMP_SIZE = 0xF040 - 0xB000; // 16448 bytes

/**
 * Bank size in bytes
 */
const BANK_SIZE = 32768;

/**
 * Calculate expected data size based on bank configuration
 * @param {number} bankConfig - Bank configuration byte
 * @returns {number} Expected data size in bytes (including 1-byte bank config prefix)
 */
function calculateExpectedDataSize(bankConfig) {
    const bankCount = countBanksInConfig(bankConfig);
    // 1 byte bank config + RAM4 + (number of banks × 32KB)
    return 1 + RAM4_DUMP_SIZE + (bankCount * BANK_SIZE);
}

/**
 * Count the number of banks in a bank configuration
 * @param {number} bankConfig - Bank configuration byte
 * @returns {number} Number of banks
 */
function countBanksInConfig(bankConfig) {
    let count = 0;
    for (let i = 0; i < 8; i++) {
        if (bankConfig & (1 << i)) count++;
    }
    return count;
}

/**
 * Get human-readable description of bank configuration
 * @param {number} bankConfig - Bank configuration byte
 * @returns {string} Description of included banks
 */
function getBankConfigDescription(bankConfig) {
    const banks = [];
    if (bankConfig & BANK_CONFIG.BK01) banks.push('BK01');
    if (bankConfig & BANK_CONFIG.BK02) banks.push('BK02');
    if (bankConfig & BANK_CONFIG.BK11) banks.push('BK11');
    if (bankConfig & BANK_CONFIG.BK12) banks.push('BK12');
    if (bankConfig & BANK_CONFIG.BK21) banks.push('BK21');
    if (bankConfig & BANK_CONFIG.BK22) banks.push('BK22');
    if (bankConfig & BANK_CONFIG.BK31) banks.push('BK31');
    if (bankConfig & BANK_CONFIG.BK32) banks.push('BK32');
    
    if (banks.length === 0) return 'No banks';
    
    const totalSize = banks.length * 32;
    return `${totalSize}KB (${banks.join(', ')})`;
}

/**
 * Save state header format:
 * - Bytes 0-20: Magic string "PicoExpanderSaveState"
 * - Byte 21: Version (0x01)
 * - Byte 22: Reserved (0x00)
 * - Byte 23: Bank configuration
 * - Bytes 24-31: Reserved (filled with 0x00)
 */
const HEADER_MAGIC = 'PicoExpanderSaveState';
const HEADER_VERSION = 0x01;
const HEADER_SIZE = 32;

/**
 * Create save state file header
 * @param {number} bankConfig - Bank configuration byte
 * @returns {Buffer} 32-byte header
 */
function createHeader(bankConfig = BANK_CONFIG_ALL) {
    const header = Buffer.alloc(HEADER_SIZE, 0x00);
    header.write(HEADER_MAGIC, 0, 'ascii');
    header.writeUInt8(HEADER_VERSION, 21);
    // Byte 22 is reserved (0x00)
    header.writeUInt8(bankConfig, 23);
    return header;
}

class SaveStateSaver {
    /**
     * Save the current machine state to a file
     * Pico scans banks and sends only non-empty ones
     * Protocol: OK (10 bytes) + bank_config (1 byte) + RAM4 + banks
     * @param {string|null} filename - Output filename (defaults to saved_state.sta)
     * @param {Object|null} picoAddress - Pico address (if null, performs discovery)
     * @param {Function|null} onComplete - Callback when complete
     * @param {Function|null} onError - Callback on error
     */
    static async save(filename = null, picoAddress = null, onComplete = null, onError = null) {
        if (!filename) {
            filename = path.join(process.cwd(), 'saved_state.sta');
        }
        
        // Ensure .sta extension
        if (!filename.endsWith('.sta')) {
            filename += '.sta';
        }
        
        console.log('Waiting for Pico to scan banks and send data...');
        
        let remote = picoAddress;
        if (!remote) {
            const discovery = new NetworkDiscovery();
            remote = await discovery.waitForHandshake();
        }
        
        const client = new TcpClient(remote);
        await client.connect();
        
        let state = 'waiting_for_ok';
        let bankConfig = null;
        let expectedDataSize = null;
        let chunks = [];
        let progressBar = null;

        client.client.on('data', (chunk) => {
            chunks.push(chunk);
            
            try {
                if (state === 'waiting_for_ok') {
                    const currentBuffer = Buffer.concat(chunks);
                    
                    if (currentBuffer.length < 10) {
                        return;
                    }
                    
                    const cmd = currentBuffer.subarray(0, 2).toString('ascii');

                    if (cmd === 'OK') {
                        state = 'waiting_for_bank_config';
                        const afterOK = currentBuffer.subarray(10);
                        chunks = afterOK.length > 0 ? [afterOK] : [];
                        
                        // Check if we already have the bank config byte
                        if (afterOK.length >= 1) {
                            bankConfig = afterOK.readUInt8(0);
                            expectedDataSize = calculateExpectedDataSize(bankConfig);
                            console.log(`Bank config received: 0x${bankConfig.toString(16).padStart(2, '0')} (${getBankConfigDescription(bankConfig)})`);
                            console.log(`Expected data size: ${expectedDataSize} bytes`);
                            state = 'receiving_data';
                            progressBar = new ProgressBar(expectedDataSize, 'Receiving');
                            progressBar.update(afterOK.length);
                        }
                    } else if (cmd === 'EC') {
                        console.error("Save state failed - another command is in progress. Please try again.");
                        client.end();
                        if (onError) onError(new Error('Another command in progress'));
                    } else if (cmd === 'ER') {
                        console.error("Error response from device");
                        client.end();
                        if (onError) onError(new Error('Device returned error'));
                    }
                } else if (state === 'waiting_for_bank_config') {
                    const currentBuffer = Buffer.concat(chunks);
                    
                    if (currentBuffer.length >= 1) {
                        bankConfig = currentBuffer.readUInt8(0);
                        expectedDataSize = calculateExpectedDataSize(bankConfig);
                        console.log(`Bank config received: 0x${bankConfig.toString(16).padStart(2, '0')} (${getBankConfigDescription(bankConfig)})`);
                        console.log(`Expected data size: ${expectedDataSize} bytes`);
                        state = 'receiving_data';
                        progressBar = new ProgressBar(expectedDataSize, 'Receiving');
                        progressBar.update(currentBuffer.length);
                    }
                } else if (state === 'receiving_data') {
                    const totalReceived = chunks.reduce((sum, c) => sum + c.length, 0);
                    if (progressBar) progressBar.update(totalReceived);
                    
                    if (totalReceived >= expectedDataSize) {
                        if (progressBar) progressBar.complete();
                        const receivedData = Buffer.concat(chunks);
                        
                        // Extract data: skip first byte (bank config), then RAM4, then banks
                        const dataAfterConfig = receivedData.subarray(1, expectedDataSize);
                        
                        // Create the save state file with header
                        const header = createHeader(bankConfig);
                        const saveStateFile = Buffer.concat([header, dataAfterConfig]);
                        
                        console.log(`\nBank configuration: 0x${bankConfig.toString(16).padStart(2, '0')} (${getBankConfigDescription(bankConfig)})`);
                        
                        try {
                            fs.writeFileSync(filename, saveStateFile);
                            console.log(`Save state saved to: ${filename}`);
                            console.log(`Total file size: ${saveStateFile.length} bytes`);
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
            if (state === 'receiving_data' && expectedDataSize) {
                const totalReceived = chunks.reduce((sum, c) => sum + c.length, 0);
                if (totalReceived < expectedDataSize) {
                    console.error(`Warning: Only received ${totalReceived} bytes, expected ${expectedDataSize}`);
                    console.error('Cannot save partial save state - incomplete bank data');
                }
            }
            
            if (onComplete) onComplete();
        });

        client.onError((err) => {
            console.error(`TCP Error: ${err.message}`);
            if (onError) onError(err);
        });

        // Send save state command (no size type needed - Pico always sends all banks)
        // SV = Save State (from server side - tells Pico to send data)
        const cmdBuffer = createCommandBuffer("SV", 0, 0);
        client.write(cmdBuffer);
    }
}

module.exports = SaveStateSaver;
module.exports.BANK_CONFIG = BANK_CONFIG;
module.exports.BANK_CONFIG_ALL = BANK_CONFIG_ALL;
module.exports.calculateExpectedDataSize = calculateExpectedDataSize;
module.exports.countBanksInConfig = countBanksInConfig;
module.exports.getBankConfigDescription = getBankConfigDescription;
module.exports.HEADER_SIZE = HEADER_SIZE;
module.exports.HEADER_MAGIC = HEADER_MAGIC;
module.exports.HEADER_VERSION = HEADER_VERSION;
module.exports.RAM4_DUMP_SIZE = RAM4_DUMP_SIZE;
module.exports.BANK_SIZE = BANK_SIZE;
