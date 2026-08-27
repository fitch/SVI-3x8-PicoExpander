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

class CasLoader {
    static async load(filename, transport, onComplete = null, onError = null) {
        try {
            let casData = fs.readFileSync(filename);

            if (casData.length > 524288) {
                throw new Error(`Max supported CAS size is 524288 bytes, got ${casData.length}`);
            }

            // Pad to chunk boundaries
            casData = padToChunks(casData, BLOCK_SIZE);

            const expectedCrc = crc16(casData);

            await transport.sendCommand('file_begin', {
                type: 'cassette',
                size: casData.length,
                block_size: BLOCK_SIZE
            }, PRI_BULK);

            const totalBlocks = Math.ceil(casData.length / BLOCK_SIZE);
            const progressBar = new ProgressBar(casData.length, 'Sending');
            let lastAck;
            for (let block = 0; block < totalBlocks; block++) {
                const offset = block * BLOCK_SIZE;
                const chunk = casData.subarray(offset, offset + BLOCK_SIZE);
                lastAck = await transport.sendData(block, chunk);
                progressBar.update(offset + chunk.length);
            }
            progressBar.complete();

            if (lastAck && lastAck.crc !== undefined) {
                if (lastAck.crc !== expectedCrc) {
                    throw new Error(`CRC mismatch: expected 0x${expectedCrc.toString(16).padStart(4, '0')}, got 0x${lastAck.crc.toString(16).padStart(4, '0')}`);
                }
                Prompt.print(`Tape CRC: 0x${expectedCrc.toString(16).padStart(4, '0')} OK`, false);
            }

            if (onComplete) onComplete();
        } catch (err) {
            if (onError) onError(err);
        }
    }
}

module.exports = CasLoader;
