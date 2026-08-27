#!/usr/bin/env node

const FileServer = require('./lib/FileServer');
const CommandHandler = require('./lib/ui/CommandHandler');
const PicoConnection = require('./lib/network/PicoConnection');
const Prompt = require('./lib/ui/Prompt');

/**
 * Main entry point for the file server
 * 
 * Usage: node server.js <directory>
 * Example: node server.js ./images
 */
const VERSION = '1.4.4';

async function main() {
    console.log(`SVI-3x8 PicoExpander Server ${VERSION} - (c) 2026 MAG-4\n`);

    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.error('Usage: node server.js <directory>');
        console.error('Example: node server.js ./images');
        process.exit(1);
    }

    const directory = args[0];

    try {
        const server = new FileServer(directory);
        await server.start();
        
        const picoConnection = new PicoConnection();
        picoConnection.server = server;  // Store reference for file count access
        server.picoConnection = picoConnection;
        
        CommandHandler.setup(server);
        
        const connectToPico = async () => {
            try {
                await picoConnection.connect();
            } catch (err) {
                Prompt.print(`Connection error: ${err.message}`);
                setTimeout(() => connectToPico(), 3000);
            }
        };
        
        // Store connectToPico on picoConnection for abort/rescan functionality
        picoConnection.startFreshConnection = connectToPico;
        
        connectToPico();
        
        const shutdown = async () => {
            console.log('\n\nShutting down server...');
            // Best-effort: tell the Pico the HDD is gone so the PicoExpander
            // doesn't keep showing a mounted HDD after we exit. shutdown() also
            // disconnects; it's bounded by a short timeout on a dead link.
            await picoConnection.shutdown();
            server.stop();
            process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Fatal error:', err.message);
        process.exit(1);
    });
}

module.exports = FileServer;
