const fs = require('fs');
const { PRI_BULK } = require('../network/FrameTransport');
const Prompt = require('../ui/Prompt');
const ProgressBar = require('../utils/ProgressBar');
const {
    HEADER_SIZE, HEADER_MAGIC, HEADER_VERSION,
    RAM4_DUMP_SIZE, BANK_SIZE,
    getBankConfigDescription, calculateExpectedDataSize
} = require('./SaveStateSaver');

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

class SaveStateLoader {
    /**
     * Load a save state file to the Pico via v2 protocol
     * @param {string} filename - Path to .sta file
     * @param {FrameTransport} transport - v2 FrameTransport instance
     * @param {Function} onComplete - Callback when operation completes
     * @param {Function} onError - Callback on error
     */
    static async load(filename, transport, onComplete = null, onError = null) {
        try {
            const fileData = fs.readFileSync(filename);

            if (fileData.length < HEADER_SIZE + 1024) {
                throw new Error(`Save state file too small: ${fileData.length} bytes`);
            }

            // Verify header
            const magic = fileData.subarray(0, 21).toString('ascii');
            if (magic !== HEADER_MAGIC) {
                throw new Error('Invalid save state header');
            }

            const version = fileData.readUInt8(21);
            if (version !== HEADER_VERSION) {
                throw new Error(`Unsupported save state version: 0x${version.toString(16).padStart(2, '0')}`);
            }

            const bankConfig = fileData.readUInt8(23);
            Prompt.print(`Save state bank config: 0x${bankConfig.toString(16).padStart(2, '0')} (${getBankConfigDescription(bankConfig)})`, false);

            // Strip header, prepend bank_config byte
            // Data format sent to Pico: bank_config (1 byte) + RAM4 + banks
            const bankConfigByte = Buffer.alloc(1);
            bankConfigByte.writeUInt8(bankConfig, 0);
            const payload = Buffer.concat([bankConfigByte, fileData.subarray(HEADER_SIZE)]);

            // CRC over RAM4 region (matching what the Pico computes on receive)
            const ram4Data = payload.subarray(1, 1 + RAM4_DUMP_SIZE);
            const expectedCrc = crc16(ram4Data);

            // Send file_begin with savestate type and bank_config
            await transport.sendCommand('file_begin', {
                type: 'savestate',
                size: payload.length,
                block_size: BLOCK_SIZE,
                bank_config: bankConfig
            }, PRI_BULK);

            // Send data blocks
            const totalBlocks = Math.ceil(payload.length / BLOCK_SIZE);
            const progressBar = new ProgressBar(payload.length, 'Sending');
            let lastAck;
            for (let block = 0; block < totalBlocks; block++) {
                const offset = block * BLOCK_SIZE;
                const chunk = payload.subarray(offset, offset + BLOCK_SIZE);
                lastAck = await transport.sendData(block, chunk);
                progressBar.update(offset + chunk.length);
            }
            progressBar.complete();

            if (lastAck && lastAck.crc !== undefined) {
                if (lastAck.crc !== expectedCrc) {
                    throw new Error(`CRC mismatch: expected 0x${expectedCrc.toString(16).padStart(4, '0')}, got 0x${lastAck.crc.toString(16).padStart(4, '0')}`);
                }
                Prompt.print(`Save state CRC: 0x${expectedCrc.toString(16).padStart(4, '0')} OK`, false);
            }

            if (onComplete) onComplete();
        } catch (err) {
            if (onError) onError(err);
        }
    }
}

module.exports = SaveStateLoader;
