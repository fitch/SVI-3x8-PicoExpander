const fs = require('fs');
const { padBuffer } = require('../network/ProtocolUtils');
const { PRI_BULK } = require('../network/FrameTransport');
const ProgressBar = require('../utils/ProgressBar');

const BLOCK_SIZE = 16384;

/**
 * CRC-16/CCITT (poly 0x1021, init 0xFFFF)
 */
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

/**
 * RomLoader handles ROM file uploads to the SVI-3x8 PicoExpander via v2 protocol
 */
class RomLoader {
    /**
     * Load a ROM file to the device
     * @param {string} filename - Path to ROM file
     * @param {FrameTransport} transport - v2 FrameTransport instance
     * @param {Function} onComplete - Callback when operation completes
     * @param {Function} onError - Callback on error
     */
    static async load(filename, transport, onComplete = null, onError = null) {
        try {
            let romData = fs.readFileSync(filename);

            if (romData.length < 2048 || romData.length > 65536) {
                throw new Error(`ROM file size must be 2048-65536 bytes, got ${romData.length}`);
            }

            romData = padBuffer(romData, 65536, 0xFF);

            const expectedCrc = crc16(romData);

            // Send file_begin
            await transport.sendCommand('file_begin', {
                type: 'rom',
                size: romData.length,
                block_size: BLOCK_SIZE
            }, PRI_BULK);

            // Send data blocks with per-block acks
            const totalBlocks = Math.ceil(romData.length / BLOCK_SIZE);
            const progressBar = new ProgressBar(romData.length, 'Sending');
            let lastAck;
            for (let block = 0; block < totalBlocks; block++) {
                const offset = block * BLOCK_SIZE;
                const chunk = romData.subarray(offset, offset + BLOCK_SIZE);
                lastAck = await transport.sendData(block, chunk);
                progressBar.update(offset + chunk.length);
            }
            progressBar.complete();

            // Verify CRC from final ack
            if (lastAck && lastAck.crc !== undefined) {
                if (lastAck.crc !== expectedCrc) {
                    throw new Error(`CRC mismatch: expected 0x${expectedCrc.toString(16).padStart(4, '0')}, got 0x${lastAck.crc.toString(16).padStart(4, '0')}`);
                }
                const Prompt = require('../ui/Prompt');
                Prompt.print(`ROM CRC: 0x${expectedCrc.toString(16).padStart(4, '0')} OK`, false);
            }

            if (onComplete) onComplete();
        } catch (err) {
            if (onError) onError(err);
        }
    }
}

module.exports = RomLoader;
