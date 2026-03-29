#!/usr/bin/env node

/**
 * HDD Image Generator for SV-608M Hard Disk
 *
 * Creates a blank, formatted HDD image and writes the CP/M system tracks
 * from a T0T1.SYS file, replicating the combined effect of MFORMAT + MSYSGEN
 * on the original SV-608M hardware.
 *
 * The image is a linear representation of the Seagate ST-212 hard drive:
 *   1,224 tracks × 32 sectors/track × 256 bytes/sector = 10,027,008 bytes
 *
 * Disk layout (after initialisation):
 *   Sectors  0–48  : CP/M system image from T0T1.SYS (boot + BIOS + CCP/BDOS)
 *   Sectors 49–62  : Reserved (E5h fill)
 *   Sector  63     : DSIZE marker (usable track count for the system)
 *   Sectors 64+    : Data area, E5h fill (4 CP/M partitions)
 *
 * Partition layout:
 *   Partition 1: tracks   0–257  (258 tracks, ~2 MB, OFF=2 — 2 reserved system tracks)
 *   Partition 2: tracks 258–513  (256 tracks, ~2 MB)
 *   Partition 3: tracks 514–769  (256 tracks, ~2 MB)
 *   Partition 4: tracks 770–1159 (390 tracks, ~3 MB)
 *   Tracks 1160–1223 are spare (bad track alternates).
 *
 * Drive letter mapping depends on BIOS build:
 *   Floppy BIOS: A:=floppy, B:–E:=partitions 1–4
 *   HDD BIOS (T0T1.SYS): A:–D:=partitions 1–4, E:=floppy
 *
 * References:
 *   doc/608m_analysis/mformat.md  — MFORMAT.COM disassembly analysis
 *   doc/608m_analysis/msysgen.md  — MSYSGEN.COM disassembly analysis
 *   doc/608m_analysis/README.md   — CP/M 2.27 system disk analysis
 *
 * Usage: node hdd_sysgen.js <T0T1.SYS> [output.img]
 */

const fs = require('fs');
const path = require('path');

// --- Hard disk geometry (Seagate ST-212, as configured by the BIOS) ---

const TRACKS           = 1224;           // 306 cylinders × 4 heads
const SECTORS_PER_TRACK = 32;            // WD1002-SHD formatted sectors
const BYTES_PER_SECTOR  = 256;           // SASI sector size
const BYTES_PER_TRACK   = SECTORS_PER_TRACK * BYTES_PER_SECTOR;  // 8,192
const IMAGE_SIZE        = TRACKS * BYTES_PER_TRACK;              // 10,027,008

// --- System area layout ---

// MSYSGEN writes 49 sectors (12,544 bytes = 98 CP/M 128-byte records)
// to the start of the disk. This covers the 2 reserved system tracks
// of partition B: (OFF=2 in the DPB).
const T0T1_SECTORS = 49;
const T0T1_BYTES   = T0T1_SECTORS * BYTES_PER_SECTOR;  // 12,544

// MFORMAT's SUB069 writes the DSIZE marker using a 4-sector write
// with address calculation: DE(=15) × 4 = linear sector 60. The marker
// is placed at offset 768 (3rd sector) within the 4-sector block,
// landing at linear sector 63 — the very last sector of the 2-track
// reserved system area.
const DSIZE_SECTOR = 63;
const DSIZE_OFFSET = DSIZE_SECTOR * BYTES_PER_SECTOR;  // 16,128

// Format fill byte — MFORMAT fills all sectors with this value
const FORMAT_FILL = 0xE5;

/**
 * Build the 12-byte DSIZE marker as written by MFORMAT's SUB069.
 *
 * Layout:
 *   Bytes 0–5:  ASCII "DSIZE:"
 *   Bytes 6–7:  Usable track count (16-bit little-endian)
 *   Bytes 8–11: ASCII "####" (signature)
 *
 * @param {number} trackCount - Number of usable tracks (1224 for a clean format)
 * @returns {Buffer}
 */
function buildDsizeMarker(trackCount) {
    const marker = Buffer.alloc(12);
    marker.write('DSIZE:', 0, 'ascii');
    marker.writeUInt16LE(trackCount, 6);
    marker.write('####', 8, 'ascii');
    return marker;
}

/**
 * Create a formatted HDD image and write the CP/M system from T0T1.SYS.
 *
 * @param {string} t0t1Path  - Path to the T0T1.SYS file
 * @param {string} outputPath - Path for the output image file
 */
function createHddImage(t0t1Path, outputPath) {
    // --- Read T0T1.SYS ---
    let t0t1;
    try {
        t0t1 = fs.readFileSync(t0t1Path);
    } catch (err) {
        console.error(`Error: Cannot read T0T1.SYS: ${err.message}`);
        process.exit(1);
    }

    if (t0t1.length < T0T1_BYTES) {
        console.error(
            `Error: T0T1.SYS is too small (${t0t1.length} bytes, need at least ${T0T1_BYTES}).`
        );
        console.error(
            'MSYSGEN expects 98 records (12,544 bytes) = 49 hard disk sectors.'
        );
        process.exit(1);
    }

    // --- Step 1: MFORMAT — fill entire image with E5h ---
    console.log(`Creating ${IMAGE_SIZE.toLocaleString()} byte HDD image (${TRACKS} tracks)...`);
    const image = Buffer.alloc(IMAGE_SIZE, FORMAT_FILL);
    console.log('  Format: filled with E5h');

    // --- Step 2: MSYSGEN — write CP/M system image ---
    // Copy exactly 49 sectors (12,544 bytes) from T0T1.SYS to sector 0,
    // matching MSYSGEN's behaviour (SASI Write, 49 sectors at address 0).
    t0t1.copy(image, 0, 0, T0T1_BYTES);
    console.log(`  System: wrote ${T0T1_BYTES.toLocaleString()} bytes (${T0T1_SECTORS} sectors) from ${path.basename(t0t1Path)}`);

    // --- Step 3: MFORMAT — write DSIZE directory marker ---
    // The marker records the usable disk capacity. For a clean format
    // with no bad tracks, this is the full 1,224 tracks.
    const dsize = buildDsizeMarker(TRACKS);
    dsize.copy(image, DSIZE_OFFSET);
    console.log(`  DSIZE:  wrote marker at sector ${DSIZE_SECTOR} (offset ${DSIZE_OFFSET}), track count = ${TRACKS}`);

    // --- Write output ---
    try {
        fs.writeFileSync(outputPath, image);
    } catch (err) {
        console.error(`Error: Cannot write output image: ${err.message}`);
        process.exit(1);
    }

    console.log();
    console.log(`Image written to: ${outputPath}`);
    console.log();

    // --- Summary ---
    console.log('Partition map:');
    const partitions = [
        { drive: 'B:', start: 0,   end: 257,  off: 2,   dsm: 1023, drm: 383 },
        { drive: 'C:', start: 258, end: 513,  off: 258, dsm: 1023, drm: 383 },
        { drive: 'D:', start: 514, end: 769,  off: 514, dsm: 1023, drm: 383 },
        { drive: 'E:', start: 770, end: 1159, off: 770, dsm: 1559, drm: 511 },
    ];
    for (const p of partitions) {
        const tracks = p.end - p.start + 1;
        const capacity = (p.dsm + 1) * 2;  // 2K blocks
        console.log(
            `  ${p.drive}  tracks ${String(p.start).padStart(4)}–${String(p.end).padStart(4)}` +
            `  (${String(tracks).padStart(4)} tracks, ${String(capacity).padStart(4)}K)`
        );
    }
    console.log(`  Spare: tracks 1160–1223 (64 tracks, reserved for bad track alternates)`);
}

// --- Main ---

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('HDD Image Generator for SV-608M Hard Disk');
    console.log('==========================================');
    console.log();
    console.log('Creates a formatted 10 MB HDD image with CP/M system tracks installed,');
    console.log('replicating MFORMAT + MSYSGEN for the SVI-328 with SV-608M expansion.');
    console.log();
    console.log('Usage: node hdd_sysgen.js <T0T1.SYS> [output.img]');
    console.log();
    console.log('Arguments:');
    console.log('  T0T1.SYS    CP/M system image file (at least 12,544 bytes)');
    console.log('  output.img  Output image path (default: hdd.img)');
    console.log();
    console.log('The T0T1.SYS file contains the CP/M boot sector, BIOS, CCP, and BDOS');
    console.log('for the hard disk. It can be found on the CP/M 2.27 system floppy or');
    console.log('in doc/608m_analysis/images/stitched_cpm_227_608m_system_40ss/T0T1.SYS');
    process.exit(0);
}

const t0t1Path = path.resolve(args[0]);
const outputPath = path.resolve(args[1] || 'hdd.img');

if (!fs.existsSync(t0t1Path)) {
    console.error(`Error: File not found: ${t0t1Path}`);
    process.exit(1);
}

createHddImage(t0t1Path, outputPath);
