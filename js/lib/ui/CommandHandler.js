const readline = require('readline');
const Display = require('./Display');
const Prompt = require('./Prompt');
const SearchUI = require('../search/SearchUI');
const FileSelector = require('./FileSelector');
const LogAnalyzer = require('../commands/LogAnalyzer');
const RomLoader = require('../commands/RomLoader');
const DiskSaver = require('../commands/DiskSaver');
const SaveStateSaver = require('../commands/SaveStateSaver');
const DiskLoader = require('../commands/DiskLoader');
const CasLoader = require('../commands/CasLoader');

/**
 * Keyboard command handler
 */
class CommandHandler {
    static keypressHandler = null;
    static server = null;

    /**
     * Setup keyboard input handling
     * @param {Object} server - The FileServer instance
     */
    static setup(server) {
        CommandHandler.server = server;
        readline.emitKeypressEvents(process.stdin);
        
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        
        CommandHandler.keypressHandler = (str, key) => {
            CommandHandler._handleKeypress(str, key, server);
        };
        
        process.stdin.on('keypress', CommandHandler.keypressHandler);
        
        Prompt.show();
    }

    /**
     * Graceful shutdown from a keyboard exit (Ctrl+C / Q): best-effort tell the
     * Pico the HDD is gone, then disconnect and exit. Async, but callers fire it
     * and return — it exits the process itself.
     * @private
     */
    static async _shutdown(server) {
        console.log('\n\nShutting down server...');
        if (server && server.picoConnection) {
            await server.picoConnection.shutdown();
        }
        process.exit(0);
    }

    /**
     * Disable keypress handling
     */
    static disable() {
        if (CommandHandler.keypressHandler) {
            process.stdin.removeListener('keypress', CommandHandler.keypressHandler);
        }
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
    }

    /**
     * Re-enable keypress handling
     */
    static enable() {
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        if (CommandHandler.keypressHandler) {
            process.stdin.on('keypress', CommandHandler.keypressHandler);
        }
        process.stdin.resume();
    }

    /**
     * Handle keypress events
     * @private
     */
    static _handleKeypress(str, key, server) {
        if (key && key.ctrl && key.name === 'c') {
            CommandHandler._shutdown(server);
            return;
        }
        
        if (str && typeof str === 'string') {
            const command = str.toUpperCase();
            
            if (command === '\r' || command === '\n' || command.trim() === '') {
                return;
            }
            
            console.log(command);
            
            switch (command) {
                case 'D':
                    Display.printFilesByType(server.files);
                    Prompt.show();
                    break;
                    
                case 'R':
                    server.scanDirectory(true).then(() => {
                        if (server.picoConnection && server.picoConnection.connected) {
                            server.picoConnection.notifyFileListChanged();
                        }
                        Prompt.printFinal(`Rescanned: ${server.files.size} file(s)`);
                    });
                    Prompt.show();
                    break;
                    
                case 'I':
                    Display.printInvalidFiles(server.invalidFiles);
                    Prompt.show();
                    break;
                    
                case 'S':
                    CommandHandler.disable();
                    
                    SearchUI.interactiveSearch(server.files, () => {
                        CommandHandler.enable();
                        Prompt.show();
                    });
                    break;
                    
                case 'H':
                    Display.showHelp(server);
                    Prompt.show();
                    break;

                case 'M':
                    CommandHandler._mountHdd(server);
                    break;

                case 'U':
                    CommandHandler._unloadHdd(server);
                    break;
                    
                case 'T':
                    if (server.picoConnection) {
                        server.picoConnection.printLog();
                    } else {
                        Prompt.print('Not connected to PicoExpander');
                    }
                    break;
                    
                case 'W':
                    CommandHandler._requestHwLog(server);
                    break;
                    
                case '1':
                    CommandHandler._loadRom(server);
                    break;
                    
                case '4':
                    CommandHandler._loadDisk(server);
                    break;
                    
                case '5':
                    CommandHandler._loadCas(server);
                    break;
                    
                case '6':
                    CommandHandler._bootToLauncher(server);
                    break;
                    
                case '7':
                    CommandHandler._saveBios(server);
                    break;
                    
                case '8':
                    CommandHandler._saveSaveState(server);
                    break;
                
                case '9':
                    CommandHandler._saveDisk(server);
                    break;
                    
                case 'Q':
                    CommandHandler._shutdown(server);
                    break;

                case 'X':
                    CommandHandler._disconnectAndRescan(server);
                    break;
                    
                default:
                    // Ignore other keys
                    Prompt.show();
                    break;
            }
        }
    }
    
    /**
     * Disconnect from current Pico and rescan for all devices
     * @private
     */
    static _disconnectAndRescan(server) {
        if (!server.picoConnection) {
            Prompt.print('No PicoConnection available');
            Prompt.show();
            return;
        }
        
        server.picoConnection.abortAndRescan();
        // Don't show prompt here - it will be shown after connection is established
    }

    /**
     * Load ROM file
     * @private
     */
    static _loadRom(server) {
        if (!server.picoConnection || !server.picoConnection.connected) {
            Prompt.print('Not connected to PicoExpander');
            Prompt.show();
            return;
        }
        
        CommandHandler.disable();
        
        FileSelector.selectFile(server.files, 'rom', async (filePath, fileInfo) => {
            try {
                await RomLoader.load(filePath, server.picoConnection.frameTransport, () => {
                    console.log('ROM load complete');
                    Prompt.show();
                    CommandHandler.enable();
                }, (err) => {
                    Prompt.print(`ROM load error: ${err.message}`);
                    CommandHandler.enable();
                });
            } catch (err) {
                Prompt.print(`Error: ${err.message}`);
                CommandHandler.enable();
                Prompt.show();
            }
        }, () => {
            CommandHandler.enable();
            Prompt.show();
        });
    }
    
    /**
     * Save BIOS data
     * @private
     */
    static async _saveBios(server) {
        if (!server.picoConnection || !server.picoConnection.connected) {
            Prompt.print('Not connected to PicoExpander');
            Prompt.show();
            return;
        }

        Prompt.print('Saving BIOS data...', false);

        try {
            const ProgressBar = require('../utils/ProgressBar');
            const progressBar = new ProgressBar(32768, 'Receiving');
            const data = await server.picoConnection.requestDump('dump_bios', (received) => {
                progressBar.update(received);
            });
            progressBar.complete();

            const filename = require('path').join(process.cwd(), 'saved_bios.bin');
            require('fs').writeFileSync(filename, data);
            Prompt.print(`BIOS data saved to: ${filename}`);
        } catch (err) {
            Prompt.print(`BIOS save error: ${err.message}`);
        }
        Prompt.show();
    }
    
    /**
     * Save disk image
     * @private
     */
    static _saveDisk(server) {
        if (!server.picoConnection || !server.picoConnection.connected) {
            Prompt.print('Not connected to PicoExpander');
            Prompt.show();
            return;
        }

        CommandHandler.disable();

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question('Enter disk image filename (default: saved_disk.dsk): ', async (answer) => {
            rl.close();
            CommandHandler.enable();

            let filename = answer.trim() || 'saved_disk.dsk';

            if (!filename.endsWith('.dsk')) {
                filename += '.dsk';
            }

            const fullPath = require('path').join(server.directory, filename);

            Prompt.print(`Saving disk image to ${filename}...`, false);

            try {
                const ProgressBar = require('../utils/ProgressBar');
                const progressBar = new ProgressBar(0, 'Receiving');
                let data = await server.picoConnection.requestDump('dump_disk', (received, total) => {
                    if (progressBar.total === 0 && total > 0) progressBar.total = total;
                    progressBar.update(received);
                });
                progressBar.complete();

                // Convert 40ds layout from sequential (Pico) back to interleaved (.dsk)
                if (data.length === 346112) {
                    data = DiskSaver._convertDisk40dsToInterleaved(data);
                }

                require('fs').writeFileSync(fullPath, data);
                Prompt.print(`Disk image saved to: ${fullPath}`);
            } catch (err) {
                Prompt.print(`Disk save error: ${err.message}`);
            }
            Prompt.show();
        });
        
        rl.on('SIGINT', () => {
            console.log('\nCancelled.\n');
            rl.close();
            CommandHandler.enable();
            Prompt.show();
        });
    }

    /**
     * Save machine state (save state capture)
     * @private
     */
    static _saveSaveState(server) {
        if (!server.picoConnection || !server.picoConnection.connected) {
            Prompt.print('Not connected to PicoExpander');
            Prompt.show();
            return;
        }
        
        CommandHandler.disable();
        
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        rl.question('Enter save state filename (default: saved_state.sta): ', (answer) => {
            rl.close();
            CommandHandler.enable();
            
            let filename = answer.trim() || 'saved_state.sta';
            
            if (!filename.endsWith('.sta')) {
                filename += '.sta';
            }
            
            const fullPath = require('path').join(server.directory, filename);
            
            Prompt.print(`Saving machine state to ${filename}...`, false);
            
            SaveStateSaver.save(fullPath, server.picoConnection.address, () => {
                Prompt.print('Save state capture complete');
                Prompt.show();
            }, (err) => {
                Prompt.print(`Save state error: ${err.message}`);
                Prompt.show();
            });
        });
        
        rl.on('SIGINT', () => {
            console.log('\nCancelled.\n');
            rl.close();
            CommandHandler.enable();
            Prompt.show();
        });
    }
    
    /**
     * Load Disk image
     * @private
     */
    static _loadDisk(server) {
        if (!server.picoConnection || !server.picoConnection.connected) {
            Prompt.print('Not connected to PicoExpander');
            Prompt.show();
            return;
        }
        
        CommandHandler.disable();
        
        const diskFilter = (type) => type && type.startsWith('disk-');
        
        FileSelector.selectFile(server.files, diskFilter, async (filePath, fileInfo) => {
            try {
                await DiskLoader.load(filePath, server.picoConnection.frameTransport, () => {
                    console.log('Disk load complete');
                    Prompt.show();
                    CommandHandler.enable();
                }, (err) => {
                    Prompt.print(`Disk load error: ${err.message}`);
                    CommandHandler.enable();
                });
            } catch (err) {
                Prompt.print(`Error: ${err.message}`);
                CommandHandler.enable();
                Prompt.show();
            }
        }, () => {
            CommandHandler.enable();
            Prompt.show();
        });
    }
    
    /**
     * Load CAS tape file
     * @private
     */
    static _loadCas(server) {
        if (!server.picoConnection || !server.picoConnection.connected) {
            Prompt.print('Not connected to PicoExpander');
            Prompt.show();
            return;
        }
        
        CommandHandler.disable();
        
        FileSelector.selectFile(server.files, 'cassette', async (filePath, fileInfo) => {
            try {
                await CasLoader.load(filePath, server.picoConnection.frameTransport, () => {
                    console.log('CAS load complete');
                    Prompt.show();
                    CommandHandler.enable();
                }, (err) => {
                    Prompt.print(`CAS load error: ${err.message}`);
                    CommandHandler.enable();
                });
            } catch (err) {
                Prompt.print(`Error: ${err.message}`);
                CommandHandler.enable();
                Prompt.show();
            }
        }, () => {
            CommandHandler.enable();
            Prompt.show();
        });
    }
    
    /**
     * Boot to Launcher
     * @private
     */
    static async _bootToLauncher(server) {
        if (!server.picoConnection || !server.picoConnection.connected) {
            Prompt.print('Not connected to PicoExpander');
            Prompt.show();
            return;
        }

        Prompt.print('Booting to Launcher...', false);

        try {
            const ack = await server.picoConnection.bootToLauncher();
            if (ack && ack.ok) {
                Prompt.printFinal('Boot to Launcher complete');
            } else {
                Prompt.printFinal('Boot to Launcher failed');
            }
        } catch (err) {
            Prompt.printFinal(`Boot to Launcher error: ${err.message}`);
        }
    }
    
    /**
     * Mount (load) an HDD image and notify Pico
     * @private
     */
    static _mountHdd(server) {
        if (!server.picoConnection || !server.picoConnection.connected) {
            Prompt.print('Not connected to PicoExpander');
            Prompt.show();
            return;
        }

        CommandHandler.disable();

        FileSelector.selectFile(server.files, 'hdd', async (filePath) => {
            try {
                // loadHddImage() reads the .hdd, opens it r/w for write-through,
                // and notifies the Pico (hdd_load). It prints its own success line
                // via Prompt.print(), which already restores the prompt — so we must
                // NOT call Prompt.show() here or we'd render a second '> '. The error
                // branch's Prompt.print() likewise restores it.
                await server.picoConnection.loadHddImage(filePath);
            } catch (err) {
                Prompt.print(`HDD mount error: ${err.message}`);
            }
            CommandHandler.enable();
        }, () => {
            CommandHandler.enable();
            Prompt.show();
        });
    }

    /**
     * Unload HDD image and notify Pico
     * @private
     */
    static async _unloadHdd(server) {
        const conn = server.picoConnection;
        if (!conn || !conn.hddImage) {
            console.log('HDD: No image loaded');
            Prompt.show();
            return;
        }

        try {
            await conn.unloadHddImage();
            console.log('HDD: Image unloaded');
        } catch (err) {
            Prompt.print(`HDD unload error: ${err.message}`);
        }
        Prompt.show();
    }

    /**
     * Request hardware log from Pico via v2 protocol
     * @private
     */
    static _hwLogInProgress = false;

    static async _requestHwLog(server) {
        if (!server.picoConnection || !server.picoConnection.frameTransport) {
            Prompt.print('v2 protocol not connected');
            Prompt.show();
            return;
        }

        if (CommandHandler._hwLogInProgress) {
            Prompt.print('Hardware log request already in progress');
            Prompt.show();
            return;
        }

        CommandHandler._hwLogInProgress = true;
        Prompt.print('Requesting hardware log...', false);

        try {
            const result = await server.picoConnection.requestHwLog();
            const count = result.count || 0;
            const overflow = result.overflow || false;

            if (count === 0) {
                console.log('*** Empty hardware log ***');
            } else {
                console.log(`*** Hardware log (${count} entries${overflow ? ', overflowed' : ''}) ***`);
                const analyzer = new LogAnalyzer();
                const data = result.d;
                if (Buffer.isBuffer(data)) {
                    for (let offset = 0; offset < data.length; offset += 8) {
                        analyzer.processHardwareLogEntry(data, offset);
                    }
                }
                console.log(`--- ${count} entries ---`);
            }
        } catch (err) {
            Prompt.print(`Hardware log error: ${err.message}`, false);
        }
        CommandHandler._hwLogInProgress = false;
        Prompt.show();
    }

}

module.exports = CommandHandler;
