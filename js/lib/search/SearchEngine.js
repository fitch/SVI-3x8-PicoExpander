const { MAX_SEARCH_RESULTS } = require('../utils/constants');
const { highlightMatch } = require('../utils/highlight');

/**
 * Search engine for finding files by filename, metadata, or contents
 */
class SearchEngine {
    /**
     * Search for files matching a query term
     * @param {Map} filesMap - The files map to search through
     * @param {string} searchTerm - The search term
     * @returns {Array} - Array of search results with highlighting
     */
    static searchFiles(filesMap, searchTerm) {
        const results = [];
        const seen = new Set(); // Track unique files
        
        if (!searchTerm || searchTerm.trim() === '') {
            return results;
        }
        
        const term = searchTerm.trim().toLowerCase();
        
        for (const [filePath, fileInfo] of filesMap.entries()) {
            const uniqueKey = `${fileInfo.relativePath}|${fileInfo.name}`;
            if (seen.has(uniqueKey)) {
                continue;
            }
            
            const filename = fileInfo.name.toLowerCase();
            if (filename.includes(term)) {
                results.push({
                    type: 'filename',
                    path: fileInfo.relativePath,
                    match: fileInfo.name,
                    highlight: highlightMatch(fileInfo.name, term),
                    uniqueKey
                });
                seen.add(uniqueKey);
                if (results.length >= MAX_SEARCH_RESULTS) break;
                continue; // Move to next file
            }
            
            if (fileInfo.metadata) {
                const { name: metaName, year, author, description } = fileInfo.metadata;
                
                if (metaName && metaName.toLowerCase().includes(term)) {
                    results.push({
                        type: 'metadata_name',
                        path: fileInfo.relativePath,
                        match: `Name: ${metaName}`,
                        highlight: `Name: ${highlightMatch(metaName, term)}`,
                        uniqueKey
                    });
                    seen.add(uniqueKey);
                    if (results.length >= MAX_SEARCH_RESULTS) break;
                    continue;
                }
                
                if (year && year.toString().includes(term)) {
                    results.push({
                        type: 'metadata_year',
                        path: fileInfo.relativePath,
                        match: `Year: ${year}`,
                        highlight: `Year: ${highlightMatch(year.toString(), term)}`,
                        uniqueKey
                    });
                    seen.add(uniqueKey);
                    if (results.length >= MAX_SEARCH_RESULTS) break;
                    continue;
                }
                
                if (author && author.toLowerCase().includes(term)) {
                    results.push({
                        type: 'metadata_author',
                        path: fileInfo.relativePath,
                        match: `Author: ${author}`,
                        highlight: `Author: ${highlightMatch(author, term)}`,
                        uniqueKey
                    });
                    seen.add(uniqueKey);
                    if (results.length >= MAX_SEARCH_RESULTS) break;
                    continue;
                }
                
                if (description && description.toLowerCase().includes(term)) {
                    results.push({
                        type: 'metadata_description',
                        path: fileInfo.relativePath,
                        match: `Description: ${description}`,
                        highlight: `Description: ${highlightMatch(description, term)}`,
                        uniqueKey
                    });
                    seen.add(uniqueKey);
                    if (results.length >= MAX_SEARCH_RESULTS) break;
                    continue;
                }
            }
            
            if (fileInfo.casHeaders && fileInfo.casHeaders.length > 0) {
                for (const header of fileInfo.casHeaders) {
                    if (header.filename.toLowerCase().includes(term)) {
                        results.push({
                            type: 'cas_content',
                            path: fileInfo.relativePath,
                            match: `CAS file: ${header.filename} (${header.description})`,
                            highlight: `CAS file: ${highlightMatch(header.filename, term)} (${header.description})`,
                            uniqueKey: `${uniqueKey}|cas|${header.filename}`
                        });
                        seen.add(uniqueKey);
                        if (results.length >= MAX_SEARCH_RESULTS) break;
                    }
                    if (header.description.toLowerCase().includes(term)) {
                        results.push({
                            type: 'cas_content',
                            path: fileInfo.relativePath,
                            match: `CAS file: ${header.filename} (${header.description})`,
                            highlight: `CAS file: ${header.filename} (${highlightMatch(header.description, term)})`,
                            uniqueKey: `${uniqueKey}|cas|${header.description}`
                        });
                        seen.add(uniqueKey);
                        if (results.length >= MAX_SEARCH_RESULTS) break;
                    }
                }
                if (results.length >= MAX_SEARCH_RESULTS) break;
            }
            
            if (fileInfo.diskFiles && fileInfo.diskFiles.length > 0) {
                for (const diskFile of fileInfo.diskFiles) {
                    if (diskFile.fullname.toLowerCase().includes(term)) {
                        results.push({
                            type: 'disk_content',
                            path: fileInfo.relativePath,
                            match: `Disk file: ${diskFile.fullname} (${diskFile.type})`,
                            highlight: `Disk file: ${highlightMatch(diskFile.fullname, term)} (${diskFile.type})`,
                            uniqueKey: `${uniqueKey}|disk|${diskFile.fullname}`
                        });
                        seen.add(uniqueKey);
                        if (results.length >= MAX_SEARCH_RESULTS) break;
                    }
                }
                if (results.length >= MAX_SEARCH_RESULTS) break;
            }
        }
        
        return results;
    }
}

module.exports = SearchEngine;
