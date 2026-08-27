const fs = require('fs');
const { padToChunks } = require('../network/ProtocolUtils');
const { PRI_BULK } = require('../network/FrameTransport');
const Prompt = require('../ui/Prompt');
const ProgressBar = require('../utils/ProgressBar');

const BLOCK_SIZE = 16384;

function crc16(data) {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i] << 8;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
        }
    }
    return crc;
}

class DiskLoader {
    static async load(filename, transport, onComplete = null, onError = null) {
        try {
            let diskData = fs.readFileSync(filename);

            if (diskData.length !== 172032 && diskData.length !== 346112) {
                throw new Error(`Disk image must be exactly 172032 or 346112 bytes, got ${diskData.length}`);
            }

            // Pad to chunk boundaries
            diskData = padToChunks(diskData, BLOCK_SIZE);

            const expectedCrc = crc16(diskData);

            await transport.sendCommand('file_begin', {
                type: 'disk',
                size: diskData.length,
                block_size: BLOCK_SIZE
            }, PRI_BULK);

            const totalBlocks = Math.ceil(diskData.length / BLOCK_SIZE);
            const progressBar = new ProgressBar(diskData.length, 'Sending');
            let lastAck;
            for (let block = 0; block < totalBlocks; block++) {
                const offset = block * BLOCK_SIZE;
                const chunk = diskData.subarray(offset, offset + BLOCK_SIZE);
                lastAck = await transport.sendData(block, chunk);
                progressBar.update(offset + chunk.length);
            }
            progressBar.complete();

            if (lastAck && lastAck.crc !== undefined) {
                if (lastAck.crc !== expectedCrc) {
                    throw new Error(`CRC mismatch: expected 0x${expectedCrc.toString(16).padStart(4, '0')}, got 0x${lastAck.crc.toString(16).padStart(4, '0')}`);
                }
                Prompt.print(`Disk CRC: 0x${expectedCrc.toString(16).padStart(4, '0')} OK`, false);
            }

            if (onComplete) onComplete();
        } catch (err) {
            if (onError) onError(err);
        }
    }
}

module.exports = DiskLoader;
