#!/usr/bin/env node

/**
 * CP/M Disk Image File Lister
 *
 * Lists files and their sizes in a CP/M 2.2x format DSK disk image.
 * Supports SVI-328 40-track single-sided and double-sided disk images.
 *
 * Usage: node list_cpm_files.js [--extract] <path-to-dsk-file>
 */

const fs = require('fs');
const path = require('path');

const {
    VALID_DSK_SIZES,
    SECTOR_SIZE,
    SECTORS_PER_TRACK,
    CPM_DETECTION_STRINGS,
} = require('./lib/utils/constants');
const DskFormat = require('./lib/formats/DskFormat');

// CP/M Disk Parameter Block definitions for supported formats
const CPM_DISK_PARAMS = {
    'disk-cpm-40ss': {
        label: 'CP/M 40-track single-sided',
        blockSize: 2048,          // BLS: 2K blocks
        directoryEntries: 64,     // DRM+1
        systemTracks: 3,          // OFF: reserved tracks (0-2)
        dirOffset: 18 * 128 + 17 * 256 * 2,  // byte offset to directory
        singleBytePointers: true, // DSM < 256
    },
    'disk-cpm-40ds': {
        label: 'CP/M 40-track double-sided',
        blockSize: 2048,
        directoryEntries: 128,
        systemTracks: 3,
        dirOffset: 18 * 128 + 17 * 256 * 5,
        singleBytePointers: true,
    },
};

/**
 * Parse a single 32-byte CP/M directory entry
 * @param {Buffer} buffer - Disk image buffer
 * @param {number} offset - Byte offset of this entry
 * @param {boolean} singleBytePointers - true for 1-byte block pointers, false for 2-byte
 * @returns {Object|null} Parsed entry or null if empty/deleted
 */
function parseCPMEntry(buffer, offset, singleBytePointers) {
    const userNumber = buffer[offset];

    // 0xE5 = deleted entry
    if (userNumber === 0xE5) return null;
    // User number must be 0-15
    if (userNumber > 15) return null;

    // Filename (bytes 1-8), mask high bit (used for attributes)
    let filename = '';
    for (let i = 1; i <= 8; i++) {
        const ch = buffer[offset + i] & 0x7F;
        if (ch >= 0x20 && ch <= 0x7E) {
            filename += String.fromCharCode(ch);
        }
    }
    filename = filename.trim();
    if (!filename) return null;

    // Extension (bytes 9-11), high bits carry attribute flags
    const readOnly = (buffer[offset + 9] & 0x80) !== 0;
    const system   = (buffer[offset + 10] & 0x80) !== 0;

    let ext = '';
    for (let i = 9; i <= 11; i++) {
        const ch = buffer[offset + i] & 0x7F;
        if (ch >= 0x20 && ch <= 0x7E) {
            ext += String.fromCharCode(ch);
        }
    }
    ext = ext.trim();

    // Extent counters
    const EX = buffer[offset + 12]; // extent low
    const S1 = buffer[offset + 13]; // reserved
    const S2 = buffer[offset + 14]; // extent high
    const RC = buffer[offset + 15]; // record count (128-byte records in this extent)

    const extentNumber = S2 * 32 + EX;

    // Allocation block pointers (bytes 16-31)
    const blocks = [];
    if (singleBytePointers) {
        for (let i = 16; i < 32; i++) {
            const b = buffer[offset + i];
            if (b !== 0) blocks.push(b);
        }
    } else {
        for (let i = 16; i < 32; i += 2) {
            const b = buffer.readUInt16LE(offset + i);
            if (b !== 0) blocks.push(b);
        }
    }

    return {
        userNumber,
        filename,
        ext,
        fullname: ext ? `${filename}.${ext}` : filename,
        extentNumber,
        RC,
        blocks,
        readOnly,
        system,
    };
}

/**
 * Parse the CP/M disk image and return structured file information
 * @param {string} filePath - Path to the .dsk file
 * @returns {Object} - {buffer, params, rawEntries, fileMap}
 */
function parseCPMDisk(filePath) {
    // Read file
    let buffer;
    try {
        buffer = fs.readFileSync(filePath);
    } catch (err) {
        console.error(`Error: Cannot read file: ${err.message}`);
        process.exit(1);
    }

    // Validate and detect type
    const validation = DskFormat.validate(buffer, buffer.length);
    if (!validation.valid) {
        console.error(`Error: ${validation.error}`);
        process.exit(1);
    }

    const diskType = validation.type;
    const params = CPM_DISK_PARAMS[diskType];

    if (!params) {
        console.error(`Error: Unsupported disk type '${diskType}'${validation.info}`);
        console.error('This tool only supports CP/M format disks (40SS and 40DS).');
        process.exit(1);
    }

    // Parse all directory entries
    const rawEntries = [];
    const maxEntries = params.directoryEntries;

    for (let e = 0; e < maxEntries; e++) {
        const offset = params.dirOffset + e * 32;
        if (offset + 32 > buffer.length) break;

        const entry = parseCPMEntry(buffer, offset, params.singleBytePointers);
        if (entry) {
            rawEntries.push(entry);
        }
    }

    // Group entries by file (user + filename + ext) — files can span multiple extents
    const fileMap = new Map();
    for (const entry of rawEntries) {
        const key = `${entry.userNumber}:${entry.fullname}`;
        if (!fileMap.has(key)) {
            fileMap.set(key, {
                userNumber: entry.userNumber,
                filename: entry.filename,
                ext: entry.ext,
                fullname: entry.fullname,
                readOnly: entry.readOnly,
                system: entry.system,
                extents: [],
            });
        }
        const file = fileMap.get(key);
        file.extents.push(entry);
        // Merge attribute flags (if any extent is marked, mark the file)
        if (entry.readOnly) file.readOnly = true;
        if (entry.system) file.system = true;
    }

    return { buffer, params, rawEntries, fileMap };
}

/**
 * List files in a CP/M disk image
 * @param {string} filePath - Path to the .dsk file
 */
function listCPMFiles(filePath) {
    const { buffer, params, rawEntries, fileMap } = parseCPMDisk(filePath);

    console.log(`Disk image: ${path.basename(filePath)}`);
    console.log(`Format:     ${params.label}`);
    console.log(`File size:  ${buffer.length} bytes`);
    console.log(`Block size: ${params.blockSize} bytes`);
    console.log();

    if (fileMap.size === 0) {
        console.log('No files found on disk.');
        return;
    }

    // Calculate file sizes and prepare display rows
    const files = [];
    let totalRecords = 0;
    let totalBlocks = 0;

    for (const [, file] of fileMap) {
        // Sort extents by extent number
        file.extents.sort((a, b) => a.extentNumber - b.extentNumber);

        // Count all allocated blocks across all extents
        const allBlocks = new Set();
        for (const ext of file.extents) {
            for (const b of ext.blocks) {
                allBlocks.add(b);
            }
        }

        // File size from records:
        // For all extents except the last, assume a full set of records
        // (records_per_extent = blockSize * 16 / 128 for single-byte pointers)
        // For the last extent, use RC
        const recordsPerExtent = (params.blockSize * (params.singleBytePointers ? 16 : 8)) / 128;
        let fileRecords = 0;
        for (let i = 0; i < file.extents.length; i++) {
            if (i < file.extents.length - 1) {
                // Full extent
                fileRecords += recordsPerExtent;
            } else {
                // Last extent — use RC plus any additional records from EX & EXM
                const ext = file.extents[i];
                // With EXM, lower bits of EX contribute to record count
                // EXM = (blockSize * pointersPerEntry / (128 * 32)) - 1
                const pointersPerEntry = params.singleBytePointers ? 16 : 8;
                const EXM = (params.blockSize * pointersPerEntry) / (128 * 32) - 1;
                const extraRecords = (ext.extentNumber % (EXM + 1)) * 128;
                fileRecords += extraRecords + ext.RC;
            }
        }

        const sizeBytes = fileRecords * 128;
        const allocatedBytes = allBlocks.size * params.blockSize;

        totalRecords += fileRecords;
        totalBlocks += allBlocks.size;

        // Build attribute string
        const attrs = [];
        if (file.readOnly) attrs.push('R/O');
        if (file.system) attrs.push('SYS');

        files.push({
            user: file.userNumber,
            name: file.fullname,
            sizeBytes,
            sizeK: Math.ceil(sizeBytes / 1024),
            allocatedK: allBlocks.size * (params.blockSize / 1024),
            records: fileRecords,
            extents: file.extents.length,
            attrs: attrs.join(' '),
        });
    }

    // Sort by user number, then filename
    files.sort((a, b) => a.user - b.user || a.name.localeCompare(b.name));

    // Print table
    const nameWidth = Math.max(12, ...files.map(f => f.name.length));

    const header = [
        'User'.padEnd(4),
        'Filename'.padEnd(nameWidth),
        'Size'.padStart(8),
        'Alloc'.padStart(8),
        'Recs'.padStart(6),
        'Exts'.padStart(5),
        'Attrs',
    ].join('  ');

    const separator = '-'.repeat(header.length);

    console.log(header);
    console.log(separator);

    for (const f of files) {
        console.log([
            String(f.user).padEnd(4),
            f.name.padEnd(nameWidth),
            formatSize(f.sizeBytes).padStart(8),
            `${f.allocatedK}K`.padStart(8),
            String(f.records).padStart(6),
            String(f.extents).padStart(5),
            f.attrs,
        ].join('  '));
    }

    console.log(separator);

    const totalSizeBytes = totalRecords * 128;
    const totalAllocK = totalBlocks * (params.blockSize / 1024);

    // Compute total disk capacity (data blocks only)
    // For 40SS: tracks 3-39 = 37 tracks, each 17*256 = 4352 bytes
    const totalCapacity = buffer.length - params.dirOffset;
    const totalDiskBlocks = Math.floor(
        (buffer.length - (18 * 128 + (params.systemTracks - 1) * SECTORS_PER_TRACK * SECTOR_SIZE)) / params.blockSize
    );

    console.log(
        `${files.length} file(s), ${formatSize(totalSizeBytes)} in ${totalRecords} records, ` +
        `${totalAllocK}K allocated`
    );

    // Count free blocks — scan all allocated blocks across all entries
    const usedBlocks = new Set();
    for (const entry of rawEntries) {
        for (const b of entry.blocks) {
            usedBlocks.add(b);
        }
    }
    // Block 0 is the directory block(s)
    // Calculate directory blocks
    const dirBlocks = Math.ceil((params.directoryEntries * 32) / params.blockSize);
    for (let i = 0; i < dirBlocks; i++) {
        usedBlocks.add(i);
    }

    const freeBlocks = totalDiskBlocks - usedBlocks.size;
    const freeK = freeBlocks * (params.blockSize / 1024);
    console.log(`${freeK}K free out of ${totalDiskBlocks * (params.blockSize / 1024)}K total`);
}

/**
 * Calculate the file size in bytes for a grouped file entry
 * @param {Object} file - Grouped file with extents array
 * @param {Object} params - Disk parameters
 * @returns {number} File size in bytes
 */
function calculateFileSize(file, params) {
    const recordsPerExtent = (params.blockSize * (params.singleBytePointers ? 16 : 8)) / 128;
    let fileRecords = 0;
    for (let i = 0; i < file.extents.length; i++) {
        if (i < file.extents.length - 1) {
            fileRecords += recordsPerExtent;
        } else {
            const ext = file.extents[i];
            const pointersPerEntry = params.singleBytePointers ? 16 : 8;
            const EXM = (params.blockSize * pointersPerEntry) / (128 * 32) - 1;
            const extraRecords = (ext.extentNumber % (EXM + 1)) * 128;
            fileRecords += extraRecords + ext.RC;
        }
    }
    return fileRecords * 128;
}

/**
 * Extract all files from a CP/M disk image into a directory
 * @param {string} filePath - Path to the .dsk file
 */
function extractCPMFiles(filePath) {
    const { buffer, params, rawEntries, fileMap } = parseCPMDisk(filePath);

    if (fileMap.size === 0) {
        console.log('No files to extract.');
        return;
    }

    // Create output directory next to the .dsk file, named after it without extension
    const dskDir = path.dirname(filePath);
    const dskBase = path.basename(filePath, path.extname(filePath));
    const outputDir = path.join(dskDir, dskBase);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log(`Extracting to: ${outputDir}`);
    console.log();

    let extractedCount = 0;

    for (const [, file] of fileMap) {
        // Sort extents by extent number
        file.extents.sort((a, b) => a.extentNumber - b.extentNumber);

        // Calculate file size
        const sizeBytes = calculateFileSize(file, params);

        // Collect all blocks in order across all extents
        const orderedBlocks = [];
        for (const ext of file.extents) {
            for (const b of ext.blocks) {
                orderedBlocks.push(b);
            }
        }

        // Read block data
        const chunks = [];
        for (const blockNum of orderedBlocks) {
            const blockOffset = params.dirOffset + blockNum * params.blockSize;
            if (blockOffset + params.blockSize <= buffer.length) {
                chunks.push(buffer.slice(blockOffset, blockOffset + params.blockSize));
            } else if (blockOffset < buffer.length) {
                chunks.push(buffer.slice(blockOffset, buffer.length));
            }
        }

        // Concatenate and truncate to actual file size
        const rawData = Buffer.concat(chunks);
        const fileData = rawData.slice(0, sizeBytes);

        // Build output filename — prepend user area if non-zero
        let outName = file.fullname;
        if (file.userNumber > 0) {
            outName = `[user${file.userNumber}]_${outName}`;
        }

        const outPath = path.join(outputDir, outName);
        fs.writeFileSync(outPath, fileData);
        console.log(`  ${outName} (${formatSize(sizeBytes)})`);
        extractedCount++;
    }

    console.log();
    console.log(`${extractedCount} file(s) extracted.`);
}

/**
 * Format a byte size in a human-readable way
 */
function formatSize(bytes) {
    if (bytes < 1024) return `${bytes}`;
    const kb = bytes / 1024;
    if (kb === Math.floor(kb)) return `${kb}K`;
    return `${kb.toFixed(1)}K`;
}

// --- Main ---
const args = process.argv.slice(2);

let extractMode = false;
let dskPath = null;

for (const arg of args) {
    if (arg === '--extract' || arg === '-x') {
        extractMode = true;
    } else if (!arg.startsWith('-')) {
        dskPath = arg;
    }
}

if (!dskPath) {
    console.log('Usage: node list_cpm_files.js [--extract] <disk-image.dsk>');
    console.log();
    console.log('Lists files and sizes in a CP/M 2.2x format DSK disk image.');
    console.log('Supports SVI-328 40-track single-sided and double-sided images.');
    console.log();
    console.log('Options:');
    console.log('  --extract, -x  Extract files into a directory named after the disk image');
    process.exit(0);
}

const filePath = path.resolve(dskPath);
if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
}

listCPMFiles(filePath);

if (extractMode) {
    console.log();
    extractCPMFiles(filePath);
}
