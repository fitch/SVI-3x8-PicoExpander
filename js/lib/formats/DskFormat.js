const fs = require('fs');
const {
    VALID_DSK_SIZES,
    SECTOR_SIZE,
    SECTORS_PER_TRACK,
    DISKBASIC_SIGNATURE,
    DISKBASIC_SIGNATURE_OFFSET,
    DISKBASIC_GEOMETRY,
    CPM_DETECTION_STRINGS
} = require('../utils/constants');

/**
 * Disk (DSK) file format handler
 * Supports DiskBasic and CP/M formats
 */
class DskFormat {
    /**
     * Validate DSK file format and detect type
     * @param {Buffer} buffer - First bytes of the file
     * @param {number} fileSize - Size of the file in bytes
     * @returns {Object} - {valid: boolean, error: string|null, type: string, info: string}
     */
    static validate(buffer, fileSize) {
        // Check file size
        if (!VALID_DSK_SIZES.includes(fileSize)) {
            return {
                valid: false,
                error: `Invalid DSK size: ${fileSize} bytes (expected ${VALID_DSK_SIZES.join(' or ')})`,
                type: 'disk'
            };
        }

        let diskType = 'disk';
        let diskInfo = '';

        // Check for DiskBasic signature: "Disk version" string at offset 0x263
        if (buffer.length >= 0x270) {
            const diskVersionCheck = buffer.toString('ascii', DISKBASIC_SIGNATURE_OFFSET, DISKBASIC_SIGNATURE_OFFSET + DISKBASIC_SIGNATURE.length);
            
            if (diskVersionCheck === DISKBASIC_SIGNATURE) {
                // It's a DiskBasic disk - check disk geometry at offset 0x175-0x178
                if (buffer.length >= 0x179) {
                    const sig = [buffer[0x175], buffer[0x176], buffer[0x177], buffer[0x178]];
                    
                    // Check against known geometries
                    for (const [key, geom] of Object.entries(DISKBASIC_GEOMETRY)) {
                        if (sig.every((byte, idx) => byte === geom.bytes[idx])) {
                            diskType = geom.name;
                            diskInfo = ` (${geom.label})`;
                            break;
                        }
                    }
                    
                    // If no match found
                    if (diskType === 'disk') {
                        diskType = 'disk-basic';
                        diskInfo = ' (DiskBasic - unknown geometry)';
                    }
                }
            }
            // Check for CP/M signature
            else if (buffer.length >= 0x100) {
                // CP/M disks have different boot code and directory commands
                const cpmCheck = buffer.toString('ascii', 0xF0, 0x100);
                const isCPM = CPM_DETECTION_STRINGS.some(str => cpmCheck.includes(str));
                
                if (isCPM) {
                    // Distinguish between CP/M disk formats by size
                    if (fileSize === 172032) {
                        diskType = 'disk-cpm-40ss';
                        diskInfo = ' (CP/M 40-track single-sided)';
                    } else if (fileSize === 346112) {
                        diskType = 'disk-cpm-40ds';
                        diskInfo = ' (CP/M 40-track double-sided)';
                    } else {
                        diskType = 'disk-cpm';
                        diskInfo = ' (CP/M)';
                    }
                }
            }
        }

        return { valid: true, error: null, type: diskType, info: diskInfo };
    }

    /**
     * Scan DSK file to extract file directory
     * @param {string} filePath - Path to the DSK file
     * @param {string} type - The disk type (disk-basic-40ss, disk-basic-40ds, disk-basic-80ss, disk-cpm-40ss, disk-cpm-40ds)
     * @returns {Promise<Object>} - {files: Array} Information about files in the disk image
     */
    static scanFile(filePath, type = 'disk') {
        return new Promise((resolve) => {
            fs.readFile(filePath, (err, buffer) => {
                if (err) {
                    console.error(`Error reading DSK file: ${err.message}`);
                    resolve({ files: [] });
                    return;
                }

                const files = [];
                
                // Calculate the offset to the directory track based on disk format
                let trackOffset;
                let directoryTrack;
                let entrySize;
                let isCPM = false;
                
                // CP/M disk formats have different directory structure
                if (type === 'disk-cpm-40ss') {
                    // CP/M 40-track single-sided: directory at logical track 3
                    // Offset: 18*128 + 17*256*2 = 11008
                    directoryTrack = 3;
                    trackOffset = 18 * 128 + 17 * 256 * 2;
                    entrySize = 32; // CP/M uses 32-byte directory entries
                    isCPM = true;
                } else if (type === 'disk-cpm-40ds') {
                    // CP/M 40-track double-sided: directory at logical track 3 (side interleaved)
                    // Offset: 18*128 + 17*256*5 = 24064
                    directoryTrack = 3;
                    trackOffset = 18 * 128 + 17 * 256 * 5;
                    entrySize = 32; // CP/M uses 32-byte directory entries
                    isCPM = true;
                } else if (type === 'disk-basic-40ss') {
                    // DiskBasic 40-track single-sided: directory at track 20
                    // Offset: 18*128 + 19*17*256 = 84992
                    directoryTrack = 20;
                    trackOffset = 18 * 128 + 19 * 17 * 256;
                    entrySize = 16; // DiskBasic uses 16-byte directory entries
                } else if (type === 'disk-basic-40ds') {
                    // DiskBasic 40-track double-sided: directory at track 20 side 0 (side interleaved)
                    // Offset: 18*128 + 39*17*256 = 172032
                    directoryTrack = 20;
                    trackOffset = 18 * 128 + 39 * 17 * 256;
                    entrySize = 16; // DiskBasic uses 16-byte directory entries
                } else if (type === 'disk-basic-80ss') {
                    // DiskBasic 80-track single-sided: directory at track 40
                    // Offset: 18*128 + 39*17*256 = 172032
                    directoryTrack = 40;
                    trackOffset = 18 * 128 + 39 * 17 * 256;
                    entrySize = 16; // DiskBasic uses 16-byte directory entries
                } else {
                    // Unknown format, use default calculation (may not work correctly)
                    directoryTrack = 20;
                    trackOffset = 20 * SECTORS_PER_TRACK * SECTOR_SIZE;
                    entrySize = 16;
                }
                
                // CP/M directory occupies 8 sectors (64 entries), DiskBasic uses sectors 1-13
                const maxDirectorySectors = isCPM ? 8 : 13;
                const entriesPerSector = Math.floor(SECTOR_SIZE / entrySize);
                
                // Read directory sectors
                for (let sector = 0; sector < maxDirectorySectors; sector++) {
                    const sectorOffset = trackOffset + (sector * SECTOR_SIZE);
                    
                    // Each sector contains multiple file entries
                    for (let entry = 0; entry < entriesPerSector; entry++) {
                        const entryOffset = sectorOffset + (entry * entrySize);
                        
                        if (entryOffset + entrySize > buffer.length) break;
                        
                        const firstByte = buffer[entryOffset];
                        let filename = '';
                        let ext = '';
                        let fileTypeDesc = 'unknown';
                        let attribute = 0;
                        
                        if (isCPM) {
                            // Parse CP/M entry
                            const parsed = DskFormat._parseCPMEntry(buffer, entryOffset);
                            if (!parsed) continue;
                            
                            filename = parsed.filename;
                            ext = parsed.ext;
                            fileTypeDesc = parsed.fileTypeDesc;
                            attribute = firstByte;
                        } else {
                            // Parse DiskBasic entry
                            const parsed = DskFormat._parseDiskBasicEntry(buffer, entryOffset);
                            if (!parsed) {
                                if (firstByte === 0xFF) {
                                    resolve({ files });
                                    return;
                                }
                                continue;
                            }
                            
                            filename = parsed.filename;
                            ext = parsed.ext;
                            fileTypeDesc = parsed.fileTypeDesc;
                            attribute = parsed.attribute;
                        }
                        
                        files.push({
                            filename,
                            ext,
                            fullname: ext ? `${filename}.${ext}` : filename,
                            type: fileTypeDesc,
                            attribute: isCPM ? `User ${firstByte}` : `0x${attribute.toString(16).toUpperCase().padStart(2, '0')}`
                        });
                    }
                }
                
                resolve({ files });
            });
        });
    }

    /**
     * Parse a CP/M directory entry (32 bytes)
     * @private
     */
    static _parseCPMEntry(buffer, offset) {
        const firstByte = buffer[offset];
        
        // Skip deleted/empty entries (0xE5)
        if (firstByte === 0xE5) return null;
        
        // Extract filename (8 characters, bytes 1-8)
        let filename = '';
        for (let i = 1; i <= 8; i++) {
            const ch = buffer[offset + i] & 0x7F; // Mask off high bit
            if (ch >= 0x20 && ch <= 0x7E) {
                filename += String.fromCharCode(ch);
            }
        }
        filename = filename.trim();
        
        // If filename is empty, skip this entry
        if (!filename) return null;
        
        // Extract extension (3 characters, bytes 9-11)
        let ext = '';
        for (let i = 9; i <= 11; i++) {
            const ch = buffer[offset + i] & 0x7F; // Mask off high bit
            if (ch >= 0x20 && ch <= 0x7E) {
                ext += String.fromCharCode(ch);
            }
        }
        ext = ext.trim();
        
        // CP/M file type detection from extension
        let fileTypeDesc;
        if (ext === 'COM') {
            fileTypeDesc = 'CP/M executable';
        } else if (ext === 'BAS') {
            fileTypeDesc = 'BASIC program';
        } else if (ext === 'TXT' || ext === 'DOC') {
            fileTypeDesc = 'text';
        } else if (ext === 'ASM' || ext === 'MAC') {
            fileTypeDesc = 'assembly source';
        } else if (ext === 'SYS') {
            fileTypeDesc = 'system file';
        } else if (ext) {
            fileTypeDesc = 'file';
        } else {
            fileTypeDesc = 'unknown';
        }
        
        return { filename, ext, fileTypeDesc };
    }

    /**
     * Parse a DiskBasic directory entry (16 bytes)
     * @private
     */
    static _parseDiskBasicEntry(buffer, offset) {
        const firstByte = buffer[offset];
        
        // Directory ends when filename starts with 0xFF
        if (firstByte === 0xFF) return null;
        
        // Skip empty entries (all zeros)
        if (firstByte === 0x00) return null;
        
        // Extract filename (6 characters)
        let filename = '';
        for (let i = 0; i < 6; i++) {
            const ch = buffer[offset + i];
            if (ch >= 0x20 && ch <= 0x7E) {
                filename += String.fromCharCode(ch);
            }
        }
        filename = filename.trim();
        
        // If filename is empty (all spaces/invalid), end of directory
        if (!filename) return null;
        
        // Extract extension (3 characters)
        let ext = '';
        for (let i = 6; i < 9; i++) {
            const ch = buffer[offset + i];
            if (ch >= 0x20 && ch <= 0x7E) {
                ext += String.fromCharCode(ch);
            }
        }
        ext = ext.trim();
        
        // Extract attribute byte (byte 9)
        const attribute = buffer[offset + 9];
        
        // Determine file type from extension and attribute byte
        let fileTypeDesc;
        if (attribute & 0x80) {
            fileTypeDesc = 'BASIC';
        } else if (ext === 'BAS') {
            fileTypeDesc = 'BASIC program';
        } else if (ext === 'COM' || ext === 'BIN') {
            fileTypeDesc = 'executable';
        } else if (ext === 'TXT' || ext === 'DOC') {
            fileTypeDesc = 'text';
        } else if (ext === 'DAT') {
            fileTypeDesc = 'data';
        } else if (attribute & 0x01) {
            fileTypeDesc = 'ASCII';
        } else if (ext) {
            fileTypeDesc = 'Binary';
        } else {
            fileTypeDesc = 'unknown';
        }
        
        return { filename, ext, fileTypeDesc, attribute };
    }
}

module.exports = DskFormat;
