/**
 * Save state (.sta) file format validation and parsing
 * 
 * Header format (version 0x01):
 * - Bytes 0-20: Magic string "PicoExpanderSaveState"
 * - Byte 21: Version (0x01)
 * - Byte 22: Reserved
 * - Byte 23: Bank configuration byte
 * - Bytes 24-31: Reserved (filled with 0x00)
 * 
 * Data layout: RAM4 first, then banks in order (BK01, BK02, BK11, BK12, BK21, BK22, BK31, BK32)
 */

const HEADER_MAGIC = 'PicoExpanderSaveState';
const HEADER_SIZE = 32;
const HEADER_VERSION = 0x01;

/**
 * Bank configuration bit flags
 */
const BANK_CONFIG = {
    BK01: 0x01,  // Bit 0: BIOS ROM (32KB)
    BK02: 0x02,  // Bit 1: RAM0 (32KB)
    BK11: 0x04,  // Bit 2: ROM_CARTRIDGE lower 32KB
    BK12: 0x08,  // Bit 3: ROM_CARTRIDGE upper 32KB
    BK21: 0x10,  // Bit 4: RAM2 lower 32KB
    BK22: 0x20,  // Bit 5: RAM2 upper 32KB
    BK31: 0x40,  // Bit 6: RAM3 lower 32KB
    BK32: 0x80   // Bit 7: RAM3 upper 32KB
};

/**
 * RAM4 dump size (0xB000-0xF03F = 16448 bytes)
 */
const RAM4_DUMP_SIZE = 0xF040 - 0xB000; // 16448 bytes

/**
 * Bank size in bytes
 */
const BANK_SIZE = 32768; // 32KB per bank

/**
 * Calculate expected data size based on bank configuration
 * @param {number} bankConfig - Bank configuration byte
 * @returns {number} Expected data size in bytes
 */
function calculateExpectedDataSize(bankConfig) {
    // Count how many banks are enabled
    let bankCount = 0;
    for (let i = 0; i < 8; i++) {
        if (bankConfig & (1 << i)) bankCount++;
    }
    
    return RAM4_DUMP_SIZE + (bankCount * BANK_SIZE);
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

class StaFormat {
    /**
     * Validate a save state file
     * @param {Buffer} buffer - File buffer (at least first 32 bytes)
     * @param {number} fileSize - Total file size
     * @returns {Object} - {valid: boolean, error: string|null, type: string, info: string}
     */
    static validate(buffer, fileSize) {
        // Check minimum size (header + some data)
        if (fileSize < HEADER_SIZE + 1024) {
            return {
                valid: false,
                error: 'Save state file too small',
                type: 'savestate'
            };
        }
        
        // Check magic string
        const magic = buffer.subarray(0, HEADER_MAGIC.length).toString('ascii');
        if (magic !== HEADER_MAGIC) {
            return {
                valid: false,
                error: 'Invalid save state header (magic mismatch)',
                type: 'savestate'
            };
        }
        
        // Check version
        const version = buffer.readUInt8(21);
        if (version !== HEADER_VERSION) {
            return {
                valid: false,
                error: `Unsupported save state version: ${version}`,
                type: 'savestate'
            };
        }
        
        // Get bank configuration
        const bankConfig = buffer.readUInt8(23);
        const expectedDataSize = calculateExpectedDataSize(bankConfig);
        const description = getBankConfigDescription(bankConfig);
        
        const expectedFileSize = HEADER_SIZE + expectedDataSize;
        
        if (fileSize !== expectedFileSize) {
            return {
                valid: false,
                error: `Save state size mismatch: expected ${expectedFileSize} bytes, got ${fileSize}`,
                type: 'savestate'
            };
        }
        
        return {
            valid: true,
            error: null,
            type: 'savestate',
            info: description,
            version: version,
            bankConfig: bankConfig
        };
    }
}

module.exports = StaFormat;
module.exports.HEADER_SIZE = HEADER_SIZE;
module.exports.HEADER_MAGIC = HEADER_MAGIC;
module.exports.HEADER_VERSION = HEADER_VERSION;
module.exports.BANK_CONFIG = BANK_CONFIG;
module.exports.RAM4_DUMP_SIZE = RAM4_DUMP_SIZE;
module.exports.BANK_SIZE = BANK_SIZE;
module.exports.calculateExpectedDataSize = calculateExpectedDataSize;
module.exports.getBankConfigDescription = getBankConfigDescription;
