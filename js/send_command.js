const dgram = require('dgram');
const net = require('net');
const fs = require('fs');
const path = require('path');

const UDP_PORT = 4243;
const TCP_PORT = 4242;
const HANDSHAKE_MESSAGE = "SVI-3x8 PicoExpander hello!";

let udpServer;

console.log("SVI-3x8 PicoExpander Command Center 1.4 - (c) 2025 MAG-4");

const command = process.argv[2];
const filename = process.argv[3];
const option1 = process.argv[4];

const usage = () => {
    console.error(`
Usage: node send_command.js <command> <path/to/image.file> <options>

Commands:
    load_rom <path/to/romfile.rom>    Send a ROM file to the SVI-3x8
    load_disk <path/to/diskimage.dsk> Send a disk image to the SVI-3x8
    load_cas <path/to/file.cas>       Send a CAS file to the SVI-3x8
    launcher                          Boot the SVI-3x8 back to the launcher
    bios                              Boot the SVI-3x8 back to the BIOS (works only in launcher)
    bios_cas                          Boot the SVI-3x8 back to the BIOS with CAS emulation (works only in launcher)
    `);
}

if (!command) {
    usage();
    process.exit(1);
}

let setupUdpServer = (onHanshake) => {
    udpServer = dgram.createSocket('udp4');
    
    udpServer.on('listening', () => {
        const address = udpServer.address();
        console.log("Waiting for SVI-3x8 PicoExpander...");
    });

    udpServer.bind(UDP_PORT, () => {
        udpServer.setBroadcast(true);
    });

    udpServer.on('message', (message, remote) => {
        const msgString = message.toString().trim();

        if (msgString === HANDSHAKE_MESSAGE) {
            console.log("Handshake received from SVI-3x8 PicoExpander, sending a command...\n");

            udpServer.close();

            onHanshake(remote);
        }
    });
}

const CHUNK_SIZE = 16384;

const sendDisk = (filename) => {
    let diskData = fs.readFileSync(filename);
    if (diskData.length !== 172032 && diskData.length !== 346112) {
        console.error("Disk image file must be exactly 172032 or 346112 bytes");
        process.exit(1);
    }
        
    setupUdpServer((remote) => {
        const tcpClient = new net.Socket();

        let buffer = Buffer.alloc(0);
        let state = 'waiting_for_OK';
        let offset = 0;

        tcpClient.connect(TCP_PORT, remote.address, () => {
            console.log("Connected. Sending disk upload command...");
            tcpClient.write(commandBuffer("LD", diskData.length, 16384));

            let fullChunks = Math.ceil(diskData.length / CHUNK_SIZE);
            let paddedSize = fullChunks * CHUNK_SIZE;
            if (diskData.length < paddedSize) {
                const padding = Buffer.alloc(paddedSize - diskData.length, 0x00);
                diskData = Buffer.concat([diskData, padding]);
            }
        });

        tcpClient.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);

            while (buffer.length >= 10) {
                const cmd = buffer.subarray(0, 2).toString('ascii');
                const pad = buffer.subarray(2, 10);

                if (!pad.equals(Buffer.alloc(8))) {
                    console.error("Invalid response");
                    tcpClient.end();
                    return;
                }

                buffer = buffer.subarray(10);

                if (state === 'waiting_for_OK' && cmd === 'OK') {
                    console.log("Received OK. Sending first chunk...");
                    const chunk = diskData.subarray(offset, offset + CHUNK_SIZE);
                    tcpClient.write(chunk);
                    console.log(`Sent chunk at offset ${offset}`);
                    offset += CHUNK_SIZE;
                    state = 'waiting_for_RD';
                } else if (state === 'waiting_for_RD' && cmd === 'RD') {
                    const chunk = diskData.subarray(offset, offset + CHUNK_SIZE);
                    tcpClient.write(chunk);
                    console.log(`Sent chunk at offset ${offset}`);
                    offset += CHUNK_SIZE;
                    if (offset >= diskData.length) {
                        state = 'waiting_for_FI';
                    }
                } else if (state === 'waiting_for_FI' && cmd === 'FI') {
                    console.log("Upload finished successfully. Closing.");
                    tcpClient.end();
                } else {
                    console.error(`Unexpected command '${cmd}' in state '${state}'`);
                    tcpClient.end();
                    return;
                }
            }
        });

        tcpClient.on('close', () => {
            console.log('TCP connection closed');
        });

        tcpClient.on('error', (err) => {
            console.error(`TCP Error: ${err.message}`);
        });
    });
}

const sendRom = (filename) => {
    let romData = fs.readFileSync(filename);
    if (romData.length !== 16384 && romData.length !== 32768 && romData.length !== 65536) {
        console.error("ROM file must be exactly 16384, 32768 or 65536 bytes, now ${romData.length} bytes");
        process.exit(1);
    }

    if (romData.length < 65536) {
        const paddedBuffer = Buffer.alloc(65536);
        romData.copy(paddedBuffer, 0, 0, romData.length);
        romData = paddedBuffer;
    }
    
    setupUdpServer((remote) => {
        const tcpClient = new net.Socket();
        let buffer = Buffer.alloc(0);

        tcpClient.connect(TCP_PORT, remote.address, () => {
            console.log("Connected. Sending ROM upload command...");
            tcpClient.write(commandBuffer("LR", romData.length, romData.length));
        });

        tcpClient.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);

            while (buffer.length >= 10) {
                const cmd = buffer.subarray(0, 2).toString('ascii');
                const pad = buffer.subarray(2, 10);

                if (!pad.equals(Buffer.alloc(8))) {
                    console.error("Invalid response");
                    tcpClient.end();
                    return;
                }

                if (cmd === 'OK') {
                    console.log("Received OK. Sending ROM data...");
                    tcpClient.write(romData);
                    console.log("ROM image sent");
                    tcpClient.end();
                    return;
                } else if (cmd === 'ER') {
                    console.error("Error response received, aborting...");
                    tcpClient.end();
                    return;
                }
            }
        });

        tcpClient.on('close', () => {
            console.log('TCP connection closed');
        });

        tcpClient.on('error', (err) => {
            console.error(`TCP Error: ${err.message}`);
        });
    });
}

let commandBuffer = (command, totalSize, chunkSize) => {
    const buffer = Buffer.alloc(10);
    buffer.write(command, 0, 2, 'ascii');
    buffer.writeUInt32BE(totalSize, 2);
    buffer.writeUInt32BE(chunkSize, 6);
    return buffer;
}

let bootToBios = () => {
    setupUdpServer((remote) => {
        const tcpClient = new net.Socket();
        let buffer = Buffer.alloc(0);

        tcpClient.connect(TCP_PORT, remote.address, () => {
            console.log("Connected. Sending request to boot to default BIOS...");
            tcpClient.write(commandBuffer("BB", 0, 0));
            tcpClient.end();
        });

        tcpClient.on('data', (data) => {
        });

        tcpClient.on('close', () => {
            console.log('TCP connection closed');
        });

        tcpClient.on('error', (err) => {
            console.error(`TCP Error: ${err.message}`);
        });
    });
}

let bootToBiosCas = () => {
    setupUdpServer((remote) => {
        const tcpClient = new net.Socket();
        let buffer = Buffer.alloc(0);

        tcpClient.connect(TCP_PORT, remote.address, () => {
            console.log("Connected. Sending request to boot to patched BIOS...");
            tcpClient.write(commandBuffer("BP", 0, 0));
            tcpClient.end();
        });

        tcpClient.on('data', (data) => {
        });

        tcpClient.on('close', () => {
            console.log('TCP connection closed');
        });

        tcpClient.on('error', (err) => {
            console.error(`TCP Error: ${err.message}`);
        });
    });
}

let bootToLauncher = () => {
    setupUdpServer((remote) => {
        const tcpClient = new net.Socket();
        let buffer = Buffer.alloc(0);

        tcpClient.connect(TCP_PORT, remote.address, () => {
            console.log("Connected. Sending request to boot back to launcher...");
            tcpClient.write(commandBuffer("BL", 0, 0));
        });

        tcpClient.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);

            while (buffer.length >= 10) {
                const cmd = buffer.subarray(0, 2).toString('ascii');
                const pad = buffer.subarray(2, 10);

                if (!pad.equals(Buffer.alloc(8))) {
                    console.error("Invalid response");
                    tcpClient.end();
                    return;
                }

                if (cmd === 'OK') {
                    console.log("Boot was successful.");
                    tcpClient.end();
                    return;
                } else if (cmd === 'ER') {
                    console.error("Boot was unsuccesful, aborting...");
                    tcpClient.end();
                    return;
                }
            }
        });

        tcpClient.on('close', () => {
            console.log('TCP connection closed');
        });

        tcpClient.on('error', (err) => {
            console.error(`TCP Error: ${err.message}`);
        });
    });
}


let sendCas = (filename) => {
    let casData = fs.readFileSync(filename);
    const casSizeBuffer = Buffer.alloc(4);
    casSizeBuffer.writeUInt32LE(casData.length);

    if (casData.length > 524288) {
        console.error("Max supported CAS size is 524288 bytes");
        process.exit(1);
    }
    
    setupUdpServer((remote) => {
        const tcpClient = new net.Socket();

        let buffer = Buffer.alloc(0);
        let state = 'waiting_for_OK';
        let offset = 0;

        tcpClient.connect(TCP_PORT, remote.address, () => {
            console.log("Connected. Sending tape upload command...");
            tcpClient.write(commandBuffer("LT", casData.length, 16384));

            let fullChunks = Math.ceil(casData.length / CHUNK_SIZE);
            let paddedSize = fullChunks * CHUNK_SIZE;
            if (casData.length < paddedSize) {
                const padding = Buffer.alloc(paddedSize - casData.length, 0x00);
                casData = Buffer.concat([casData, padding]);
            }
        });

        tcpClient.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);

            while (buffer.length >= 10) {
                const cmd = buffer.subarray(0, 2).toString('ascii');
                const pad = buffer.subarray(2, 10);

                if (!pad.equals(Buffer.alloc(8))) {
                    console.error("Invalid response");
                    tcpClient.end();
                    return;
                }

                buffer = buffer.subarray(10);

                if (state === 'waiting_for_OK' && cmd === 'OK') {
                    console.log("Received OK. Sending first chunk...");
                    const chunk = casData.subarray(offset, offset + CHUNK_SIZE);
                    tcpClient.write(chunk);
                    console.log(`Sent chunk at offset ${offset}`);
                    offset += CHUNK_SIZE;
                    if (offset >= casData.length) {
                        state = 'waiting_for_FI';
                    } else {
                        state = 'waiting_for_RD';
                    }
                } else if (state === 'waiting_for_RD' && cmd === 'RD') {
                    const chunk = casData.subarray(offset, offset + CHUNK_SIZE);
                    tcpClient.write(chunk);
                    console.log(`Sent chunk at offset ${offset}`);
                    offset += CHUNK_SIZE;
                    if (offset >= casData.length) {
                        state = 'waiting_for_FI';
                    }
                } else if (state === 'waiting_for_FI' && cmd === 'FI') {
                    console.log("Upload finished successfully. Closing.");
                    tcpClient.end();
                } else {
                    console.error(`Unexpected command '${cmd}' in state '${state}'`);
                    tcpClient.end();
                    return;
                }
            }
        });

        tcpClient.on('close', () => {
            console.log('TCP connection closed');
        });

        tcpClient.on('error', (err) => {
            console.error(`TCP Error: ${err.message}`);
        });
    });
}

switch (command) {
    case 'load_rom':
        if (!filename || !fs.existsSync(filename)) {
            console.error("Please provide a valid ROM image file path.");
            process.exit(1);
        }
        sendRom(filename);
        break;
    case 'load_disk':
        if (!filename || !fs.existsSync(filename)) {
            console.error("Please provide a valid disk image file path.");
            process.exit(1);
        }
        sendDisk(filename);
        break;
    case 'load_cas':
        if (!filename || !fs.existsSync(filename)) {
            console.error("Please provide a valid tape image file path.");
            process.exit(1);
        }
        sendCas(filename);
        break;
    case 'launcher':
        bootToLauncher();
        break;
    case 'bios':
        bootToBios();
        break;
    case 'bios_cas':
        bootToBiosCas();
        break;
    default:
        console.error("Unknown command");
        process.exit(1);
}