const fs = require('fs');
const { CAS_SYNC_BYTE, CAS_MARKER_BYTE } = require('../utils/constants');

/**
 * Cassette (CAS) file format handler
 */
class CasFormat {
    /**
     * Validate CAS file format
     * @param {Buffer} buffer - First bytes of the file
     * @returns {Object} - {valid: boolean, error: string|null}
     */
    static validate(buffer) {
        // Must contain at least two 0x55 bytes in the beginning
        let count55 = 0;
        for (let i = 0; i < Math.min(buffer.length, 100); i++) {
            if (buffer[i] === CAS_SYNC_BYTE) {
                count55++;
                if (count55 >= 2) break;
            }
        }
        if (count55 < 2) {
            return {
                valid: false,
                error: `Invalid CAS format: missing required 0x55 header bytes`,
                type: 'cassette'
            };
        }
        return { valid: true, error: null, type: 'cassette', info: '' };
    }

    /**
     * Scan CAS file to extract internal file information
     * @param {string} filePath - Path to the CAS file
     * @returns {Promise<Object>} - {headers: Array} Information about the CAS file contents
     */
    static scanFile(filePath) {
        return new Promise((resolve) => {
            fs.readFile(filePath, (err, buffer) => {
                if (err) {
                    console.error(`Error reading CAS file: ${err.message}`);
                    resolve({ headers: [] });
                    return;
                }

                const headers = [];
                let offset = 0;

                // Helper function to find SYNC pattern
                // SYNC = many 0x55 bytes (at least 10) followed by 0x7F
                const findSync = (start) => {
                    for (let i = start; i < buffer.length - 17; i++) {
                        // Look for pattern: multiple 0x55 followed by 0x7F
                        if (buffer[i] === CAS_SYNC_BYTE) {
                            // Count consecutive 0x55 bytes
                            let count = 0;
                            let j = i;
                            while (j < buffer.length && buffer[j] === CAS_SYNC_BYTE) {
                                count++;
                                j++;
                            }
                            
                            // Need at least 10 0x55 bytes
                            if (count >= 10 && j < buffer.length && buffer[j] === CAS_MARKER_BYTE) {
                                // Found SYNC, return position after 0x7F (start of header)
                                return j + 1;
                            }
                        }
                    }
                    return -1;
                };

                // Scan for headers
                while (offset < buffer.length - 17) {
                    // Find SYNC
                    const syncPos = findSync(offset);
                    if (syncPos === -1) break;
                    
                    offset = syncPos;

                    // Read header (17 bytes total)
                    // First 10 bytes should be the type repeated
                    const type = buffer[offset];
                    let validHeader = true;

                    // Verify type byte is repeated 10 times
                    for (let i = 1; i < 10; i++) {
                        if (buffer[offset + i] !== type) {
                            validHeader = false;
                            break;
                        }
                    }

                    if (validHeader && (type === 0xD3 || type === 0xD0 || type === 0xEA)) {
                        // Extract filename (bytes 10-15, 6 bytes total, ASCII, space-padded)
                        let filename = '';
                        for (let i = 10; i < 16; i++) {
                            const ch = buffer[offset + i];
                            if (ch >= 0x20 && ch <= 0x7E) { // Printable ASCII
                                filename += String.fromCharCode(ch);
                            }
                        }
                        filename = filename.trim();

                        // Extract attribute byte (byte 16)
                        const attribute = buffer[offset + 16];

                        // Determine file type description
                        let typeDesc = 'Unknown';
                        if (type === 0xD3) {
                            if (attribute === 0xFF) {
                                typeDesc = 'BASIC program (tokenized)';
                            } else if (attribute === 0x00) {
                                typeDesc = 'Screen mode 0 (text)';
                            } else if (attribute === 0x01) {
                                typeDesc = 'Screen mode 1 (hi-res)';
                            } else if (attribute === 0x02) {
                                typeDesc = 'Screen mode 2 (lo-res)';
                            } else {
                                typeDesc = `Screen (unknown mode, attr: 0x${attribute.toString(16).toUpperCase()})`;
                            }
                        } else if (type === 0xD0) {
                            typeDesc = 'Binary data (BSAVE)';
                        } else if (type === 0xEA) {
                            typeDesc = 'Sequential file / ASCII BASIC';
                        }

                        headers.push({
                            offset: offset - 1, // Include the 0x7F position
                            type: `0x${type.toString(16).toUpperCase()}`,
                            filename: filename,
                            attribute: `0x${attribute.toString(16).toUpperCase()}`,
                            description: typeDesc
                        });

                        offset += 17;
                    } else {
                        // Not a valid header, continue searching
                        offset++;
                    }
                }

                resolve({ headers });
            });
        });
    }
}

module.exports = CasFormat;
