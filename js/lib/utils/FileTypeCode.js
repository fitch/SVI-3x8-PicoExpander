/**
 * File type code calculator according to README.md specification
 * 
 * Format: Lower 4 bits = main type, upper 4 bits = subtype
 * Main types: 1=Tape, 2=ROM, 3=Disk, 4=Savestate
 */
class FileTypeCode {
    /**
     * Calculate file type code byte based on file type and size
     * @param {string} type - File type string (e.g., 'cassette', 'rom', 'disk-basic-40ss')
     * @param {number} size - File size in bytes
     * @returns {number} - File type code byte (0x00-0xFF)
     */
    static calculate(type, size) {
        // Cassette files - type code 0x11
        if (type === 'cassette') {
            return 0x11; // 0b00010001 (main type 1, subtype 1)
        }
        
        // ROM files - main type 2, subtype based on size
        if (type === 'rom') {
            if (size <= 32768) {
                return 0x12; // 0b00010010 (main type 2, subtype 1)
            }
            return 0x22; // 0b00100010 (main type 2, subtype 2)
        }
        
        // Disk files - main type 3, subtype based on disk format
        if (type === 'disk-basic-40ss') {
            return 0x13; // 0b00010011 (main type 3, subtype 1)
        }
        if (type === 'disk-basic-40ds') {
            return 0x23; // 0b00100011 (main type 3, subtype 2)
        }
        if (type === 'disk-basic-80ss') {
            return 0x33; // 0b00110011 (main type 3, subtype 3)
        }
        if (type === 'disk-cpm-40ss') {
            return 0x43; // 0b01000011 (main type 3, subtype 4)
        }
        if (type === 'disk-cpm-40ds') {
            return 0x53; // 0b01010011 (main type 3, subtype 5)
        }
        if (type === 'disk-cpm-80ss') {
            return 0x63; // 0b01100011 (main type 3, subtype 6)
        }
        
        // Savestate files - main type 4, subtype 1 (bank configuration determines size)
        if (type === 'savestate' || type === 'save-state') {
            return 0x14; // 0b00010100 (main type 4, subtype 1)
        }
        
        return 0x00; // Unknown type
    }
    
    /**
     * Get main type from type code
     * @param {number} typeCode - File type code byte
     * @returns {number} - Main type (0-15)
     */
    static getMainType(typeCode) {
        return typeCode & 0x0F;
    }
    
    /**
     * Get subtype from type code
     * @param {number} typeCode - File type code byte
     * @returns {number} - Subtype (0-15)
     */
    static getSubtype(typeCode) {
        return (typeCode >> 4) & 0x0F;
    }
}

module.exports = FileTypeCode;
