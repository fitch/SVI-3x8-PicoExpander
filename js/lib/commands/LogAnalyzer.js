const fs = require('fs');
const path = require('path');

const MAGIC_HEADER = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);

/**
 * LogAnalyzer handles hardware log parsing and interpretation
 */
class LogAnalyzer {
    constructor() {
        this.HW_LOG_OPS = null;
        this.HW_LOG_NAMES = null;
        this.PICO_COMMANDS = null;
        this.lastRegister15 = -1;
        this.loadHeaders();
    }

    /**
     * Load hardware log operation definitions from header file
     */
    loadHeaders() {
        const headerPath = path.resolve(__dirname, '../../../pico/c/svi-328-expander-bus.h');
        try {
            const headerContent = fs.readFileSync(headerPath, 'utf8');
            
            // Load HW_LOG_OPS entries
            const re = /X\(\s*(\w+)\s*,\s*"([^"\\]*)"\s*\)/g;
            const entries = [];
            let match;
            while ((match = re.exec(headerContent)) !== null) {
                entries.push({ name: match[1], desc: match[2] });
            }
            if (!entries.length) throw new Error('No HW_LOG_OPS entries found in svi-328-expander-bus.h');
            this.HW_LOG_NAMES = entries.map(e => e.name);
            this.HW_LOG_OPS = entries.map(e => e.desc);
            console.log(`Loaded ${entries.length} HW_LOG_OPS entries from svi-328-expander-bus.h`);

            // Load PICO_COMMANDS from write_mode_t enum
            const cmdRe = /(WRITE_MODE_\w+|COMMAND_\w+)\s*=\s*(0x[0-9a-fA-F]+)/g;
            this.PICO_COMMANDS = {};
            let cmdMatch;
            while ((cmdMatch = cmdRe.exec(headerContent)) !== null) {
                const name = cmdMatch[1];
                const value = parseInt(cmdMatch[2], 16);
                this.PICO_COMMANDS[value] = name;
            }
            console.log(`Loaded ${Object.keys(this.PICO_COMMANDS).length} PICO_COMMANDS entries from svi-328-expander-bus.h`);
        } catch (err) {
            console.error(`Failed to load HW_LOG_OPS from header: ${err}.`);
            process.exit(1);
        }
    }

    /**
     * Format timestamp for display
     * @param {number} ts - Timestamp value
     * @returns {string} Formatted timestamp
     */
    formatTimestamp(ts) {
        const s = ts.toString();
        const padded = s.padStart(9, '0');
        return `[${padded}]`;
    }

    /**
     * Log with timestamp prefix
     * @param {number} ts - Timestamp
     * @param {string} text - Log text
     */
    logWithTimestamp(ts, text) {
        console.log(`${this.formatTimestamp(ts)} ${text}`);
    }

    /**
     * Analyze bank control register changes
     * @param {number} currValue - Current register value
     * @param {number} prevValue - Previous register value
     * @returns {Array<string>} Array of change descriptions
     */
    analyzeBankControlRegister(currValue, prevValue) {
        const bitmask = 0b11011111;
        currValue &= bitmask;

        const isBitActive = (value, bit) => ((value >> bit) & 1) === 0;

        const getSlotBank = (slot, value) => {
            const CART = isBitActive(value, 0);
            const BK21 = isBitActive(value, 1);
            const BK22 = isBitActive(value, 2);
            const BK31 = isBitActive(value, 3);
            const BK32 = isBitActive(value, 4);
            const ROMEN0 = isBitActive(value, 6) && CART;
            const ROMEN1 = isBitActive(value, 7) && CART;

            if (slot === 1) {
                if (CART) return "BK11 CART Game cartridge";
                if (BK31 && BK21) return "BK41 Custom Expansion RAM";
                if (BK31) return "BK31 Expansion RAM";
                if (BK21) return "BK21 built-in RAM (SVI-328)";
                return "BK01 BASIC BIOS";
            }

            if (slot === 2) {
                if (ROMEN0 && ROMEN1) return "BK12 ROMEN0+ROMEN1";
                if (ROMEN1) return "BK12/H ROMEN1";
                if (ROMEN0) return "BK12/L ROMEN0";
                if (BK32 && BK22) return "BK42 Custom Expansion RAM";
                if (BK32) return "BK32 Expansion RAM";
                if (BK22) return "BK22 Expansion RAM";
                return "BK02 built-in RAM";
            }
        };

        let changes = [];

        if (prevValue === -1) {
            changes.push(`Slot 1 now showing ${getSlotBank(1, currValue)}`);
            changes.push(`Slot 2 now showing ${getSlotBank(2, currValue)}`);
            return changes;
        }

        const prevSlot1 = getSlotBank(1, prevValue);
        const currSlot1 = getSlotBank(1, currValue);
        if (prevSlot1 !== currSlot1) {
            changes.push(`Slot 1 changed from ${prevSlot1} to ${currSlot1}`);
        }

        const prevSlot2 = getSlotBank(2, prevValue);
        const currSlot2 = getSlotBank(2, currValue);
        if (prevSlot2 !== currSlot2) {
            changes.push(`Slot 2 changed from ${prevSlot2} to ${currSlot2}`);
        }

        return changes;
    }

    /**
     * Interpret PSG Register 15 value
     * @param {number} ts - Timestamp
     * @param {number} value - Register value
     * @param {number} lastValue - Previous register value
     */
    interpretPsgRegister15(ts, value, lastValue) {
        const CAPS = value & 0b00100000;
        const lastCAPS = lastValue & 0b00100000;

        if (lastValue === -1 || CAPS !== lastCAPS) {
            this.logWithTimestamp(ts, `CAPS: ${CAPS ? "ON" : "OFF"}`);
        }

        let lastBankValue = lastValue & 0b11011111;
        let bankValue = value & 0b11011111;

        if (lastValue === -1 || bankValue !== lastBankValue) {
            let changes = this.analyzeBankControlRegister(bankValue, lastValue === -1 ? -1 : lastBankValue);
            this.logWithTimestamp(ts, changes.join(", "));
        }
    }

    /**
     * Process hardware log entry
     * @param {Buffer} payload - Log entry payload
     * @param {number} offset - Offset in payload
     */
    processHardwareLogEntry(payload, offset) {
        const ts = payload.readUInt32LE(offset);
        const op = payload[offset + 4];
        const port = payload[offset + 5];
        const value = payload.readUInt16LE(offset + 6);

        const msg = this.HW_LOG_OPS[op] || `Unknown (0x${op.toString(16)})`;
        const name = (this.HW_LOG_NAMES && this.HW_LOG_NAMES[op]) || null;

        switch (name) {
            case 'HW_LOG_WR_DRIVE':
            case 'HW_LOG_WR_CONTROLLER':
            case 'HW_LOG_WR_DENSITY':
            case 'HW_LOG_WR_DATA':
            case 'HW_LOG_RD_DRIVE':
            case 'HW_LOG_RD_DATA':
            case 'HW_LOG_RD_CONTROLLER':
            case 'HW_LOG_WR_CONTROLLER_RS':
                this.logWithTimestamp(ts, `${msg}: 0x${value.toString(16)}`);
                break;
            case 'HW_LOG_PSG_READ_15':
                this.logWithTimestamp(ts, `${msg}: 0x${value.toString(16)}`);
                this.lastRegister15 = value & 0xff;
                break;
            case 'HW_LOG_RD_DATA_COMPLETED':
            case 'HW_LOG_WR_DATA_COMPLETED':
            case 'HW_LOG_WR_TRACK':
            case 'HW_LOG_WR_SECTOR':
            case 'HW_LOG_RD_TRACK':
            case 'HW_LOG_RD_SECTOR':                    
            case 'HW_LOG_WR_CONTROLLER_SIT':
            case 'HW_LOG_WR_CONTROLLER_SOT':
            case 'HW_LOG_WR_CONTROLLER_S':
            case 'HW_LOG_TAPE_END':
                this.logWithTimestamp(ts, `${msg}: ${value}`);
                break;
            case 'HW_LOG_PSG_WRITE_15':
                this.logWithTimestamp(ts, `${msg}: 0x${value.toString(16)}`);
                this.interpretPsgRegister15(ts, value & 0xff, this.lastRegister15);
                this.lastRegister15 = value & 0xff;
                break;
            case 'HW_LOG_BIOS_FD_TEST_START':
            case 'HW_LOG_WR_CONTROLLER_R':
            case 'HW_LOG_WR_CONTROLLER_FI':
                this.logWithTimestamp(ts, `${msg}`);
                break;
            case 'HW_LOG_PICO_COMMAND':
                const cmdName = this.PICO_COMMANDS[value] || `Unknown (0x${value.toString(16)})`;
                this.logWithTimestamp(ts, `${msg}: ${cmdName}`);
                break;
            case 'HW_LOG_INJECT_REVERT_15_ADDRESS':
            case 'HW_LOG_INJECT_REVERT_15_RD':
            case 'HW_LOG_INJECT_REVERT_15_WR':
            case 'HW_LOG_INJECT_REVERT_15_UNPLANNED_WR':
            case 'HW_LOG_INJECT_REVERT_0X90_ADDRESS':
            case 'HW_LOG_INJECT_REVERT_0X90_RD':
            case 'HW_LOG_INJECT_REVERT_0X90_UNPLANNED_WR':
            case 'HW_LOG_INJECT_CAPS_LOCK_ADDRESS':
            case 'HW_LOG_INJECT_CAPS_LOCK_RD':
            case 'HW_LOG_INJECT_CAPS_LOCK_WR':
            case 'HW_LOG_INJECT_CAPS_LOCK_UNPLANNED_WR':
            case 'HW_LOG_PSG_LATCH_WR':
            case 'HW_LOG_PICO_WR':
            case 'HW_LOG_DEBUG':
            case 'HW_LOG_MREQ_PREPARE_RD':
            case 'HW_LOG_INJECT_REVERT_0X90':
            case 'HW_LOG_VDP_0X80':
            case 'HW_LOG_VDP_0X81':
            case 'HW_LOG_FILE_NAME_INDEX_BYTE':
            case 'HW_LOG_FILE_SEND_INDEX_BYTE':
            case 'HW_LOG_SET_FILE_TYPE_FILTER':
            case 'HW_LOG_FILE_COUNT_RESPONSE':
            case 'HW_LOG_FILE_NAME_READ_VALUE':
            case 'HW_LOG_FILE_CHUNK_REQUEST':
            case 'HW_LOG_MREQ_RD_ADDR':
            case 'HW_LOG_MREQ_RD_VALUE':
                this.logWithTimestamp(ts, `${msg}: 0x${value.toString(16)}`);
                break;
            case 'HW_LOG_SASI_RESET':
            case 'HW_LOG_SASI_SET_PARAMS':
            case 'HW_LOG_HDD_INIT':
                this.logWithTimestamp(ts, `${msg}`);
                break;
            case 'HW_LOG_SASI_SELECT':
            case 'HW_LOG_SASI_CMD':
            case 'HW_LOG_SASI_STATUS':
            case 'HW_LOG_SASI_DETECT':
            case 'HW_LOG_SASI_DATA_IN':
            case 'HW_LOG_SASI_DATA_OUT':
            case 'HW_LOG_SASI_MSG_IN':
            case 'HW_LOG_SASI_BUS_STATUS':
            case 'HW_LOG_PPI_KBD_READ':
                this.logWithTimestamp(ts, `${msg}: 0x${value.toString(16)}`);
                break;
            case 'HW_LOG_SASI_READ':
            case 'HW_LOG_SASI_WRITE':
            case 'HW_LOG_SASI_OUT_OF_RANGE':
                this.logWithTimestamp(ts, `${msg}: LBA ${value}`);
                break;
            default:
                this.logWithTimestamp(ts, `${msg}`);
                break;
        }
    }

    /**
     * Process incoming log data
     * @param {Buffer} buffer - Buffer containing log data
     * @returns {Buffer} Remaining buffer after processing
     */
    processLogData(buffer) {
        let magicIndex;
        while ((magicIndex = buffer.indexOf(MAGIC_HEADER)) !== -1) {
            if (buffer.length < magicIndex + 8) return buffer;

            const type = buffer[magicIndex + 4];
            const totalLength = buffer.readUInt16BE(magicIndex + 5);
            const overflow = buffer[magicIndex + 7];

            if (buffer.length < magicIndex + totalLength) return buffer;

            // totalLength includes the 8-byte header, so payload size is totalLength - 8
            const payloadSize = totalLength - 8;
            const payload = buffer.subarray(magicIndex + 8, magicIndex + 8 + payloadSize);

            if (type == 0x01 && totalLength == 8) {
                console.log("*** Empty hardware log ***");
            } else {
                console.log(`*** ${type ? "Hardware log" : "Text log"} (${payloadSize} bytes payload, ${totalLength} bytes total, ${!overflow ? "no overflow" : "overflowed"}) ***`);
            }

            if (type === 0x00) {
                console.log(payload.toString());
            } else if (type === 0x01) {
                for (let offset = 0; offset < payload.length; offset += 8) {
                    this.processHardwareLogEntry(payload, offset);
                }
            }

            buffer = buffer.subarray(magicIndex + totalLength);
        }

        return buffer;
    }
}

module.exports = LogAnalyzer;
