const { ROM_MAGIC_BYTES } = require('../utils/constants');

/**
 * ROM/BIN file format handler
 */
class RomFormat {
    /**
     * Validate ROM/BIN file format
     * @param {Buffer} buffer - First bytes of the file
     * @param {number} fileSize - Size of the file in bytes
     * @returns {Object} - {valid: boolean, error: string|null}
     */
    static validate(buffer, fileSize) {
        if (fileSize < 2048 || fileSize > 65536) {
            return {
                valid: false,
                error: `Invalid ROM size: ${fileSize} bytes (expected 2048 - 65536 bytes)`,
                type: 'rom'
            };
        }
        
        // Must start with 0xF3 and 0x31
        if (buffer.length >= 2 && 
            (buffer[0] !== ROM_MAGIC_BYTES[0] || buffer[1] !== ROM_MAGIC_BYTES[1])) {
            return {
                valid: false,
                error: `Invalid ROM header: expected 0x${ROM_MAGIC_BYTES[0].toString(16).toUpperCase()} 0x${ROM_MAGIC_BYTES[1].toString(16).toUpperCase()}, got 0x${buffer[0].toString(16).padStart(2, '0')} 0x${buffer[1].toString(16).padStart(2, '0')}`,
                type: 'rom'
            };
        }
        
        return { valid: true, error: null, type: 'rom', info: '' };
    }
}

module.exports = RomFormat;
