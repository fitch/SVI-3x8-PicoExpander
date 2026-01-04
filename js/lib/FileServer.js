const fs = require('fs');
const path = require('path');
const { FILE_WATCH_DEBOUNCE } = require('./utils/constants');
const FileScanner = require('./FileScanner');
const Display = require('./ui/Display');
const Prompt = require('./ui/Prompt');

/**
 * Main FileServer class - orchestrates file monitoring and catalog management
 */
class FileServer {
    constructor(directory) {
        this.directory = path.resolve(directory);
        this.files = new Map();
        this.invalidFiles = new Map();
        this.debounceTimers = new Map();
        this.watcher = null;
        
        console.log(`Initializing file server for directory: ${this.directory}`);
    }

    /**
     * Start the file server
     */
    async start() {
        // Initial scan
        await this.scanDirectory();
        
        // Setup file watcher
        this._setupWatcher();
        
        // Display initial summary (not full catalog)
        Display.printFilesSummary(this.files);
        
        console.log('File server started. Press H for help.');
    }

    /**
     * Scan the entire directory
     */
    async scanDirectory() {
        console.log('\nScanning directory...');
        
        // Clear existing data
        this.files.clear();
        this.invalidFiles.clear();
        
        // Get all files recursively
        const allFiles = FileScanner.scanDirectoryRecursive(this.directory);
        
        // Scan each file silently during initial scan
        for (const filePath of allFiles) {
            await this._updateFile(filePath, true);
        }
        
        console.log(`Scan complete. Found ${this.files.size} valid file(s) and ${this.invalidFiles.size} invalid file(s).`);
    }

    /**
     * Setup file watcher for the directory
     * @private
     */
    _setupWatcher() {
        try {
            this.watcher = fs.watch(this.directory, { recursive: true }, (eventType, filename) => {
                if (!filename) return;
                
                const filePath = path.join(this.directory, filename);
                
                // Debounce file changes
                if (this.debounceTimers.has(filePath)) {
                    clearTimeout(this.debounceTimers.get(filePath));
                }
                
                const timer = setTimeout(() => {
                    this._handleFileChange(filePath, eventType);
                    this.debounceTimers.delete(filePath);
                }, FILE_WATCH_DEBOUNCE);
                
                this.debounceTimers.set(filePath, timer);
            });
            
            console.log('Watching for file changes...');
        } catch (err) {
            console.error(`Error setting up watcher: ${err.message}`);
        }
    }

    /**
     * Handle file change events
     * @private
     */
    async _handleFileChange(filePath, eventType) {
        // Check if file exists
        fs.access(filePath, fs.constants.F_OK, async (err) => {
            if (err) {
                // File was deleted
                this._removeFile(filePath);
            } else {
                // File was added or modified
                await this._updateFile(filePath);
            }
        });
    }

    /**
     * Update a file in the catalog
     * @private
     * @param {string} filePath - Path to the file
     * @param {boolean} silent - If true, don't log the update
     */
    async _updateFile(filePath, silent = false) {
        const result = await FileScanner.scanFile(filePath, this.directory);
        
        if (result.valid && result.fileInfo) {
            this.invalidFiles.delete(filePath);
            
            const existingFile = this.files.get(filePath);
            
            if (existingFile) {
                const hasChanged = existingFile.size !== result.fileInfo.size;
                
                this.files.set(filePath, result.fileInfo);
                
                if (hasChanged && !silent) {
                    Prompt.clear();
                    console.log(`[+] ${result.fileInfo.relativePath} (${result.fileInfo.type}${result.fileInfo.info})`);
                    Prompt.show();
                }
            } else {
                this.files.set(filePath, result.fileInfo);
                if (!silent) {
                    Prompt.clear();
                    console.log(`[+] ${result.fileInfo.relativePath} (${result.fileInfo.type}${result.fileInfo.info})`);
                    Prompt.show();
                }
            }
        } else if (result.error) {
            this.files.delete(filePath);
            
            const relativePath = path.relative(this.directory, filePath);
            this.invalidFiles.set(filePath, {
                relativePath,
                error: result.error
            });
            
            if (!silent) {
                Prompt.clear();
                console.log(`[?] ${relativePath} - ${result.error}`);
                Prompt.show();
            }
        }
    }

    /**
     * Remove a file from the catalog
     * @private
     */
    _removeFile(filePath) {
        const fileInfo = this.files.get(filePath);
        
        if (fileInfo) {
            this.files.delete(filePath);
            Prompt.clear();
            console.log(`[-] ${fileInfo.relativePath}`);
            Prompt.show();
        }
        
        const invalidInfo = this.invalidFiles.get(filePath);
        if (invalidInfo) {
            this.invalidFiles.delete(filePath);
            Prompt.clear();
            console.log(`[-] ${invalidInfo.relativePath}`);
            Prompt.show();
        }
    }

    /**
     * Stop the file server
     */
    stop() {
        if (this.watcher) {
            this.watcher.close();
        }
        
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        
        console.log('File server stopped.');
    }
}

module.exports = FileServer;
