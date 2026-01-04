const readline = require('readline');
const path = require('path');

/**
 * Interactive file selector with autocomplete
 */
class FileSelector {
    /**
     * Select a file from the files map filtered by type
     * @param {Map} filesMap - The files map to search through
     * @param {string|Array|Function} fileTypes - File type(s) to filter by (e.g., 'rom', 'cassette', or a function that returns true for matching types)
     * @param {Function} onSelect - Callback with selected file path
     * @param {Function} onCancel - Callback when cancelled
     */
    static selectFile(filesMap, fileTypes, onSelect, onCancel) {
        // Create a filter function
        let filterFn;
        if (typeof fileTypes === 'function') {
            filterFn = fileTypes;
        } else {
            const types = Array.isArray(fileTypes) ? fileTypes : [fileTypes];
            filterFn = (type) => types.includes(type);
        }
        
        // Get all files matching the type(s)
        const matchingFiles = [];
        for (const [filePath, fileInfo] of filesMap.entries()) {
            if (filterFn(fileInfo.type)) {
                matchingFiles.push({
                    path: filePath,
                    relativePath: fileInfo.relativePath,
                    info: fileInfo
                });
            }
        }
        
        if (matchingFiles.length === 0) {
            console.log(`No matching files found in catalog`);
            if (onCancel) onCancel();
            return;
        }
        
        // Sort by relative path
        matchingFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        
        const typeLabel = typeof fileTypes === 'function' ? 'DISK' : 
                         (Array.isArray(fileTypes) ? fileTypes.map(t => t.toUpperCase()).join('/') : fileTypes.toUpperCase());
        console.log(`\nFound ${matchingFiles.length} ${typeLabel} file(s) in catalog`);
        
        // Create readline interface for file input
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            completer: (line) => {
                const hits = matchingFiles
                    .map(f => f.relativePath)
                    .filter((name) => name.toLowerCase().includes(line.toLowerCase()));
                return [hits.length ? hits : matchingFiles.map(f => f.relativePath), line];
            }
        });
        
        rl.question('Enter filename (Tab for autocomplete, Enter to cancel): ', (answer) => {
            rl.close();
            
            if (!answer || answer.trim() === '') {
                console.log('Cancelled.\n');
                if (onCancel) onCancel();
                return;
            }
            
            let selectedFile = null;
            const input = answer.trim();
            
            // Try to find exact match first (case insensitive)
            const exactMatch = matchingFiles.find(f => 
                f.relativePath.toLowerCase() === input.toLowerCase()
            );
            
            if (exactMatch) {
                selectedFile = exactMatch;
            } else {
                // Try partial match
                const partialMatches = matchingFiles.filter(f => 
                    f.relativePath.toLowerCase().includes(input.toLowerCase())
                );
                
                if (partialMatches.length === 1) {
                    selectedFile = partialMatches[0];
                } else if (partialMatches.length > 1) {
                    console.log(`\nMultiple matches found (${partialMatches.length}):`);
                    partialMatches.slice(0, 10).forEach(file => {
                        console.log(`  ${file.relativePath}`);
                    });
                    if (partialMatches.length > 10) {
                        console.log(`  ... and ${partialMatches.length - 10} more`);
                    }
                    console.log('Please be more specific.\n');
                    if (onCancel) onCancel();
                    return;
                } else {
                    console.log(`File not found: ${input}\n`);
                    if (onCancel) onCancel();
                    return;
                }
            }
            
            console.log(`Selected: ${selectedFile.relativePath}\n`);
            if (onSelect) onSelect(selectedFile.path, selectedFile.info);
        });
        
        // Handle Ctrl+C in readline
        rl.on('SIGINT', () => {
            console.log('\nCancelled.\n');
            rl.close();
            if (onCancel) onCancel();
        });
    }
}

module.exports = FileSelector;
