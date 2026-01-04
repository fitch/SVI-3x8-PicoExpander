#!/usr/bin/env node

const fs = require('fs');
const RomLoader = require('./lib/commands/RomLoader');
const DiskLoader = require('./lib/commands/DiskLoader');
const CasLoader = require('./lib/commands/CasLoader');
const Bk4xLoader = require('./lib/commands/Bk4xLoader');
const Bk4xSaver = require('./lib/commands/Bk4xSaver');
const BootCommands = require('./lib/commands/BootCommands');
const LogCommand = require('./lib/commands/LogCommand');

console.log("SVI-3x8 PicoExpander Command Center 1.4.2 - (c) 2025 MAG-4");

const command = process.argv[2];
const filename = process.argv[3];

const usage = () => {
    console.error(`
Usage: node send_command.js <command> <path/to/image.file> <options>

Commands:
    load_rom <path/to/romfile.rom>    Send a ROM file to the SVI-3x8
    load_disk <path/to/diskimage.dsk> Send a disk image to the SVI-3x8
    load_cas <path/to/file.cas>       Send a CAS file to the SVI-3x8
    load_bk4x <path/to/romfile.rom>   Send a BK31 and BK32 launcher ROM file to the SVI-3x8
    save_bk4x [path/to/output.bin]    Download BK4X RAM4 data (65536 bytes) from the SVI-3x8
                                      (defaults to saved_bk4x.bin in current directory)
    launcher                          Boot the SVI-3x8 back to the launcher
    get_log                           Get both text and hardware logs from the SVI-3x8
    get_text_log                      Get only text log from the SVI-3x8
    get_hardware_log                  Get only hardware log from the SVI-3x8
    `);
}

if (!command) {
    usage();
    process.exit(1);
}

/**
 * Main command dispatcher
 */
async function main() {
    try {
        switch (command) {
            case 'load_rom':
                if (!filename || !fs.existsSync(filename)) {
                    console.error("Please provide a valid ROM image file path.");
                    process.exit(1);
                }
                await RomLoader.load(filename);
                break;
            case 'load_bk4x':
                if (!filename || !fs.existsSync(filename)) {
                    console.error("Please provide a valid ROM image file path.");
                    process.exit(1);
                }
                await Bk4xLoader.load(filename);
                break;
            case 'load_disk':
                if (!filename || !fs.existsSync(filename)) {
                    console.error("Please provide a valid disk image file path.");
                    process.exit(1);
                }
                await DiskLoader.load(filename);
                break;
            case 'load_cas':
                if (!filename || !fs.existsSync(filename)) {
                    console.error("Please provide a valid tape image file path.");
                    process.exit(1);
                }
                await CasLoader.load(filename);
                break;
            case 'save_bk4x':
                // filename is optional - defaults to saved_bk4x.bin in current directory
                await Bk4xSaver.save(filename);
                break;
            case 'launcher':
                await BootCommands.bootToLauncher();
                break;
            case 'get_log':
                await LogCommand.getLog();
                break;
            case 'get_text_log':
                await LogCommand.getTextLog();
                break;
            case 'get_hardware_log':
                await LogCommand.getHardwareLog();
                break;
            default:
                console.error("Unknown command");
                usage();
                process.exit(1);
        }
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

// Run if executed directly
if (require.main === module) {
    main();
}