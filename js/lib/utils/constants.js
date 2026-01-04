/**
 * Constants for file validation and type detection
 */

// Supported file extensions and their types
const SUPPORTED_EXTENSIONS = {
    '.cas': 'cassette',
    '.rom': 'rom',
    '.dsk': 'disk',
    '.dmk': 'disk-dmk',
    '.bin': 'rom',
    '.sta': 'savestate'
};

// Valid DSK file sizes in bytes
const VALID_DSK_SIZES = [172032, 346112];

// ROM magic bytes (must start with 0xF3 0x31)
const ROM_MAGIC_BYTES = [0xF3, 0x31];

// CAS format constants
const CAS_SYNC_BYTE = 0x55;
const CAS_SYNC_MIN_COUNT = 2;
const CAS_MARKER_BYTE = 0x7F;

// Disk format constants
const SECTOR_SIZE = 256;
const SECTORS_PER_TRACK = 17;

// DiskBasic signature
const DISKBASIC_SIGNATURE = 'Disk version';
const DISKBASIC_SIGNATURE_OFFSET = 0x263;

// DiskBasic geometry signatures
const DISKBASIC_GEOMETRY = {
    '40DS': { bytes: [0x6B, 0x50, 0x59, 0x08], size: 346112, name: 'disk-basic-40ds', label: 'DiskBasic 40-track double-sided' },
    '40SS': { bytes: [0x6D, 0x50, 0x59, 0x0C], size: 172032, name: 'disk-basic-40ss', label: 'DiskBasic 40-track single-sided' },
    '80SS': { bytes: [0x6B, 0x50, 0x58, 0x08], size: 172032, name: 'disk-basic-80ss', label: 'DiskBasic 80-track single-sided' }
};

// CP/M detection strings
const CPM_DETECTION_STRINGS = ['dir a:', 'stat'];

// Debounce delay for file watcher (milliseconds)
const FILE_WATCH_DEBOUNCE = 100;

// Maximum search results to display
const MAX_SEARCH_RESULTS = 20;

module.exports = {
    SUPPORTED_EXTENSIONS,
    VALID_DSK_SIZES,
    ROM_MAGIC_BYTES,
    CAS_SYNC_BYTE,
    CAS_SYNC_MIN_COUNT,
    CAS_MARKER_BYTE,
    SECTOR_SIZE,
    SECTORS_PER_TRACK,
    DISKBASIC_SIGNATURE,
    DISKBASIC_SIGNATURE_OFFSET,
    DISKBASIC_GEOMETRY,
    CPM_DETECTION_STRINGS,
    FILE_WATCH_DEBOUNCE,
    MAX_SEARCH_RESULTS
};
