/**
 * Display utilities for catalog views
 */
class Display {
    /**
     * Print files grouped by type
     * @param {Map} filesMap - The files map to display
     */
    static printFilesByType(filesMap) {
        const filesByType = new Map();
        
        for (const [filePath, fileInfo] of filesMap.entries()) {
            const type = fileInfo.type;
            
            if (!filesByType.has(type)) {
                filesByType.set(type, []);
            }
            
            filesByType.get(type).push(fileInfo);
        }
        
        const sortedTypes = Array.from(filesByType.keys()).sort();
        
        console.log('\n=== File Catalog ===\n');
        
        for (const type of sortedTypes) {
            const files = filesByType.get(type);
            const typeLabel = type ? type.toUpperCase() : 'UNKNOWN';
            console.log(`\n${typeLabel} files (${files.length}):`);
            console.log('─'.repeat(60));
            
            for (const fileInfo of files) {
                console.log(`  ${fileInfo.relativePath}`);
                console.log(`    Size: ${fileInfo.size} bytes`);
                if (fileInfo.typeCode !== undefined) {
                    console.log(`    Type Code: 0x${fileInfo.typeCode.toString(16).toUpperCase().padStart(2, '0')} (0b${fileInfo.typeCode.toString(2).padStart(8, '0')})`);
                }
                
                if (fileInfo.metadata && (fileInfo.metadata.name || fileInfo.metadata.year || 
                    fileInfo.metadata.author || fileInfo.metadata.description)) {
                    const { name, year, author, description } = fileInfo.metadata;
                    if (name) console.log(`    Name: ${name}`);
                    if (year) console.log(`    Year: ${year}`);
                    if (author) console.log(`    Author: ${author}`);
                    if (description) console.log(`    Description: ${description}`);
                }
                
                if (fileInfo.casHeaders && fileInfo.casHeaders.length > 0) {
                    console.log(`    CAS Headers (${fileInfo.casHeaders.length}):`);
                    for (const header of fileInfo.casHeaders) {
                        console.log(`      - ${header.filename} (${header.description})`);
                    }
                }
                
                if (fileInfo.diskFiles && fileInfo.diskFiles.length > 0) {
                    console.log(`    Disk Files (${fileInfo.diskFiles.length}):`);
                    for (const diskFile of fileInfo.diskFiles) {
                        console.log(`      - ${diskFile.fullname} (${diskFile.type})`);
                    }
                }
                
                console.log('');
            }
        }
        
        const totalFiles = filesMap.size;
        console.log(`\nTotal: ${totalFiles} file(s)\n`);
    }

    /**
     * Print summary of files by type (counts only)
     * @param {Map} filesMap - The files map to display
     */
    static printFilesSummary(filesMap) {
        const categories = {
            cassette: 0,
            disk: 0,
            rom: 0,
            savestate: 0,
            hdd: 0
        };

        for (const [filePath, fileInfo] of filesMap.entries()) {
            const type = fileInfo.type;

            if (type === 'cassette') {
                categories.cassette++;
            } else if (type && type.startsWith('disk')) {
                categories.disk++;
            } else if (type === 'rom') {
                categories.rom++;
            } else if (type === 'savestate') {
                categories.savestate++;
            } else if (type === 'hdd') {
                categories.hdd++;
            }
        }
        
        console.log('\n=== File Catalog Summary ===\n');
        
        for (const [category, count] of Object.entries(categories)) {
            if (count > 0) {
                const label = category === 'savestate' ? 'Save states' :
                    category === 'hdd' ? 'HDD' :
                    category.charAt(0).toUpperCase() + category.slice(1);
                const imageText = category === 'savestate' ? '' :
                    (count === 1 ? ' image' : ' images');
                console.log(`  ${label}: ${count}${imageText}`);
            }
        }
        
        const totalFiles = filesMap.size;
        const imageText = totalFiles === 1 ? 'image' : 'images';
        console.log(`\n  Total: ${totalFiles} ${imageText}\n`);
    }

    /**
     * Print invalid files
     * @param {Map} invalidFilesMap - The invalid files map to display
     */
    static printInvalidFiles(invalidFilesMap) {
        if (invalidFilesMap.size === 0) {
            console.log('No invalid files found.');
            return;
        }
        
        console.log('\n=== Invalid Files ===\n');
        
        for (const [filePath, errorInfo] of invalidFilesMap.entries()) {
            console.log(`  ${errorInfo.relativePath}`);
            console.log(`    Error: ${errorInfo.error}`);
            console.log('');
        }
        
        console.log(`Total: ${invalidFilesMap.size} invalid file(s)\n`);
    }

    /**
     * Show help/commands
     */
    static showHelp(server) {
        console.log('\n=== Available Commands ===');
        console.log('  D - Display catalog (show all files grouped by type)');
        console.log('  R - Rescan directory (force refresh)');
        console.log('  I - Show invalid files');
        console.log('  S - Search files (by name, metadata, or contents)');
        console.log('');
        console.log('  1 - Load ROM file');
        console.log('  3 - Save BK4X RAM4 data');
        console.log('  4 - Load Disk image');
        console.log('  5 - Load CAS tape file');
        console.log('  6 - Boot to Launcher');
        console.log('  7 - Save BIOS data');
        console.log('  8 - Save machine state (save state capture)');
        console.log('  9 - Save Disk image');
        console.log('');
        if (server && server.picoConnection && server.picoConnection.hddImage) {
            console.log('  U - Unload HDD image');
        }
        console.log('  L - Request both logs from PicoExpander');
        console.log('  T - Request text log from PicoExpander');
        console.log('  W - Request hardware log from PicoExpander');
        console.log('  H - Show this help message');
        console.log('  Q - Quit server');

        if (server && server.picoConnection && server.picoConnection.hddImage) {
            const sectors = Math.floor(server.picoConnection.hddImage.length / 256);
            const sizeMB = (server.picoConnection.hddImage.length / (1024 * 1024)).toFixed(1);
            console.log(`\n  HDD: Image loaded (${sectors} sectors, ${sizeMB} MB)`);
        } else {
            console.log('\n  HDD: No image loaded');
        }
    }
}

module.exports = Display;
