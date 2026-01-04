const readline = require('readline');
const Display = require('./Display');
const Prompt = require('./Prompt');
const SearchUI = require('../search/SearchUI');
const FileSelector = require('./FileSelector');
const LogAnalyzer = require('../commands/LogAnalyzer');
const BootCommands = require('../commands/BootCommands');
const RomLoader = require('../commands/RomLoader');
const Bk4xLoader = require('../commands/Bk4xLoader');
const Bk4xSaver = require('../commands/Bk4xSaver');
const BiosSaver = require('../commands/BiosSaver');
const SaveStateSaver = require('../commands/SaveStateSaver');
const DiskLoader = require('../commands/DiskLoader');
const CasLoader = require('../commands/CasLoader');
const { createCommandBuffer } = require('../network/ProtocolUtils');
const { TCP_PORT } = require('../utils/networkConstants');
const net = require('net');

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
            console.log('\n\nShutting down server...');
            if (server.picoConnection) {
                server.picoConnection.disconnect();
            }
            process.exit(0);
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
                    
                case 'C':
                    console.clear();
                    console.log('File Server Running...');
                    if (server.picoConnection && server.picoConnection.connected) {
                        console.log(`Connected to PicoExpander at ${server.picoConnection.address.address}:${server.picoConnection.address.port}`);
                    }
                    console.log('Press H for help\n');
                    Display.printFilesByType(server.files);
                    Prompt.show();
                    break;
                    
                case 'R':
                    console.log('Rescanning directory...');
                    server.scanDirectory();
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
                    Display.showHelp();
                    Prompt.show();
                    break;
                    
                case 'L':
                    CommandHandler._requestLog(server, 'SL');
                    break;
                    
                case 'T':
                    CommandHandler._requestLog(server, 'ST');
                    break;
                    
                case 'W':
                    CommandHandler._requestLog(server, 'SH');
                    break;
                    
                case '1':
                    CommandHandler._loadRom(server);
                    break;
                    
                case '2':
                    CommandHandler._loadBk4x(server);
                    break;
                    
                case '3':
                    CommandHandler._saveBk4x(server);
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
                    
                case 'Q':
                    console.log('\nShutting down server...');
                    if (server.picoConnection) {
                        server.picoConnection.disconnect();
                    }
                    process.exit(0);
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
                await RomLoader.load(filePath, server.picoConnection.address, () => {
                    Prompt.print('ROM load complete');
                    CommandHandler.enable();
                    Prompt.show();
                }, (err) => {
                    Prompt.print(`ROM load error: ${err.message}`);
                    CommandHandler.enable();
                    Prompt.show();
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
     * Load BK4X file
     * @private
     */
    static _loadBk4x(server) {
        if (!server.picoConnection || !server.picoConnection.connected) {
            Prompt.print('Not connected to PicoExpander');
            Prompt.show();
            return;
        }
        
        CommandHandler.disable();
        
        FileSelector.selectFile(server.files, 'rom', async (filePath, fileInfo) => {
            try {
                await Bk4xLoader.load(filePath, server.picoConnection.address, () => {
                    Prompt.print('BK4X load complete');
                    CommandHandler.enable();
                    Prompt.show();
                }, (err) => {
                    Prompt.print(`BK4X load error: ${err.message}`);
                    CommandHandler.enable();
                    Prompt.show();
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
     * Save BK4X RAM4 data
     * @private
     */
    static _saveBk4x(server) {
        if (!server.picoConnection || !server.picoConnection.connected) {
            Prompt.print('Not connected to PicoExpander');
            Prompt.show();
            return;
        }
        
        Prompt.print('Saving BK4X RAM4 data...', false);
        
        Bk4xSaver.save(null, server.picoConnection.address, () => {
            Prompt.print('BK4X save complete');
            Prompt.show();
        }, (err) => {
            Prompt.print(`BK4X save error: ${err.message}`);
            Prompt.show();
        });
    }
    
    /**
     * Save BIOS data
     * @private
     */
    static _saveBios(server) {
        if (!server.picoConnection || !server.picoConnection.connected) {
            Prompt.print('Not connected to PicoExpander');
            Prompt.show();
            return;
        }
        
        Prompt.print('Saving BIOS data...', false);
        
        BiosSaver.save(null, server.picoConnection.address, () => {
            Prompt.print('BIOS save complete');
            Prompt.show();
        }, (err) => {
            Prompt.print(`BIOS save error: ${err.message}`);
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
                await DiskLoader.load(filePath, server.picoConnection.address, () => {
                    Prompt.print('Disk load complete');
                    CommandHandler.enable();
                    Prompt.show();
                }, (err) => {
                    Prompt.print(`Disk load error: ${err.message}`);
                    CommandHandler.enable();
                    Prompt.show();
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
                await CasLoader.load(filePath, server.picoConnection.address, () => {
                    Prompt.print('CAS load complete');
                    CommandHandler.enable();
                    Prompt.show();
                }, (err) => {
                    Prompt.print(`CAS load error: ${err.message}`);
                    CommandHandler.enable();
                    Prompt.show();
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
    static _bootToLauncher(server) {
        if (!server.picoConnection || !server.picoConnection.connected) {
            Prompt.print('Not connected to PicoExpander');
            Prompt.show();
            return;
        }
        
        Prompt.print('Booting to Launcher...', false);
        
        BootCommands.bootToLauncher(server.picoConnection.address, () => {
            Prompt.print('Boot to Launcher complete');
            Prompt.show();
        }, (err) => {
            Prompt.print(`Boot to Launcher error: ${err.message}`);
            Prompt.show();
        });
    }
    
    /**
     * Request logs from Pico
     * @private
     */
    static _requestLog(server, command) {
        if (!server.picoConnection || !server.picoConnection.connected) {
            Prompt.print('Not connected to PicoExpander');
            Prompt.show();
            return;
        }
        
        const commandName = command === 'SL' ? 'both logs' : 
                           command === 'ST' ? 'text log' : 'hardware log';
        Prompt.print(`Requesting ${commandName}...`, false);
        
        const analyzer = new LogAnalyzer();
        const tcpClient = server.picoConnection.tcpClient;
        let isDone = false;
        let buffer = Buffer.alloc(0);
        let receivedResponse = false;

        tcpClient.write(createCommandBuffer(command, 0, 0));

        tcpClient.onData(() => {
            if (isDone) return;
            
            const data = tcpClient.getBuffer();
            if (!data || data.length === 0) return;
            
            buffer = Buffer.concat([buffer, data]);
            tcpClient.setBuffer(Buffer.alloc(0)); // Clear the buffer
            
            if (!receivedResponse && buffer.length >= 2) {
                const response = buffer.toString('ascii', 0, 2);
                Prompt.print(`Pico responded: ${response}`, false);
                
                if (response === 'OK') {
                    buffer = buffer.subarray(2);
                    receivedResponse = true;
                    Prompt.print(`Processing ${commandName}...`, false);
                } else if (response === 'EC') {
                    Prompt.print(`Log retrieval failed - another command is in progress. Please try again.`, false);
                    isDone = true;
                    tcpClient.onData(() => { server.picoConnection._handlePicoRequest(); });
                    Prompt.show();
                    return;
                } else if (response === 'ER') {
                    Prompt.print(`Log retrieval failed - error on Pico.`, false);
                    isDone = true;
                    tcpClient.onData(() => { server.picoConnection._handlePicoRequest(); });
                    Prompt.show();
                    return;
                } else {
                    Prompt.print(`Unexpected response: ${response} (0x${buffer.toString('hex', 0, 2)})`, false);
                }
            }
            
            if (receivedResponse) {
                const fiIndex = buffer.indexOf('FI');
                if (fiIndex !== -1) {
                    if (fiIndex > 0) {
                        const logData = buffer.subarray(0, fiIndex);
                        analyzer.processLogData(logData);
                    }
                    Prompt.print('Log transfer complete', false);
                    isDone = true;
                    tcpClient.onData(() => { server.picoConnection._handlePicoRequest(); });
                    Prompt.show();
                    return;
                }
                
                buffer = analyzer.processLogData(buffer);
            }
        });
    }
}

module.exports = CommandHandler;
