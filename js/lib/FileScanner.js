const fs = require('fs');
const path = require('path');
const { SUPPORTED_EXTENSIONS } = require('./utils/constants');
const FileParser = require('./FileParser');
const RomFormat = require('./formats/RomFormat');
const CasFormat = require('./formats/CasFormat');
const DskFormat = require('./formats/DskFormat');
const StaFormat = require('./formats/StaFormat');
const FileTypeCode = require('./utils/FileTypeCode');

/**
 * File scanner for analyzing and validating files
 */
class FileScanner {
    /**
     * Scan a file and extract its information
     * @param {string} filePath - Absolute path to the file
     * @param {string} baseDir - Base directory for relative path calculation
     * @returns {Promise<Object>} - {valid: boolean, fileInfo: Object|null, error: string|null}
     */
    static async scanFile(filePath, baseDir) {
        return new Promise((resolve) => {
            fs.stat(filePath, async (err, stats) => {
                if (err) {
                    resolve({ 
                        valid: false, 
                        fileInfo: null, 
                        error: `Error reading file: ${err.message}` 
                    });
                    return;
                }
                
                if (!stats.isFile()) {
                    resolve({ valid: false, fileInfo: null, error: null });
                    return;
                }
                
                const ext = path.extname(filePath).toLowerCase();
                const filename = path.basename(filePath);
                const relativePath = path.relative(baseDir, filePath);
                
                // Check if file extension is supported
                if (!(ext in SUPPORTED_EXTENSIONS)) {
                    resolve({ valid: false, fileInfo: null, error: null });
                    return;
                }
                
                // Read first few KB for validation
                const fd = fs.openSync(filePath, 'r');
                const bufferSize = Math.min(stats.size, 4096);
                const buffer = Buffer.alloc(bufferSize);
                fs.readSync(fd, buffer, 0, bufferSize, 0);
                fs.closeSync(fd);
                
                // Validate based on file type
                const validation = FileScanner._validateFile(buffer, stats.size, ext);
                
                if (!validation.valid) {
                    resolve({ 
                        valid: false, 
                        fileInfo: null, 
                        error: validation.error 
                    });
                    return;
                }
                
                // Create file info object
                const fileInfo = {
                    name: filename,
                    relativePath: relativePath,
                    size: stats.size,
                    type: validation.type,
                    typeCode: FileTypeCode.calculate(validation.type, stats.size),
                    info: validation.info || '',
                    metadata: FileParser.parseFilename(filename)
                };
                
                // Scan CAS files for headers
                if (ext === '.cas') {
                    try {
                        const casData = await CasFormat.scanFile(filePath);
                        fileInfo.casHeaders = casData.headers;
                    } catch (error) {
                        console.error(`Error scanning CAS file ${filePath}: ${error.message}`);
                    }
                }
                
                // Scan DSK files for directory
                if (ext === '.dsk') {
                    try {
                        const dskData = await DskFormat.scanFile(filePath, validation.type);
                        fileInfo.diskFiles = dskData.files;
                    } catch (error) {
                        console.error(`Error scanning DSK file ${filePath}: ${error.message}`);
                    }
                }
                
                resolve({ valid: true, fileInfo, error: null });
            });
        });
    }

    /**
     * Validate a file based on its type
     * @private
     */
    static _validateFile(buffer, fileSize, ext) {
        switch (ext) {
            case '.rom':
            case '.bin':
                return RomFormat.validate(buffer, fileSize);
                
            case '.cas':
                return CasFormat.validate(buffer);
                
            case '.dsk':
                return DskFormat.validate(buffer, fileSize);
                
            case '.dmk':
                // DMK files - basic size check
                if (fileSize < 1024) {
                    return { 
                        valid: false, 
                        error: 'DMK file too small',
                        type: 'disk' 
                    };
                }
                return { valid: true, error: null, type: 'disk', info: ' (DMK format)' };
                
            case '.sta':
                return StaFormat.validate(buffer, fileSize);
                
            default:
                return { 
                    valid: false, 
                    error: `Unknown file type: ${ext}`,
                    type: 'unknown' 
                };
        }
    }

    /**
     * Recursively scan a directory and return all file paths
     * @param {string} dirPath - Directory to scan
     * @param {Array} fileList - Accumulated file list (used for recursion)
     * @returns {Array<string>} - Array of absolute file paths
     */
    static scanDirectoryRecursive(dirPath, fileList = []) {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                
                if (entry.isDirectory()) {
                    FileScanner.scanDirectoryRecursive(fullPath, fileList);
                } else if (entry.isFile()) {
                    fileList.push(fullPath);
                }
            }
        } catch (err) {
            console.error(`Error scanning directory ${dirPath}: ${err.message}`);
        }
        
        return fileList;
    }
}

module.exports = FileScanner;
