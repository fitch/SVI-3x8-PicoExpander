/**
 * Minimal MessagePack encoder/decoder
 *
 * Supports the subset needed by the v2 protocol:
 *   - nil, booleans
 *   - integers (positive fixint, uint 8/16/32, negative fixint, int 8/16/32)
 *   - strings (fixstr, str 8/16/32)
 *   - binary (bin 8/16/32)
 *   - maps (fixmap, map 16)
 *   - arrays (fixarray, array 16)
 *
 * Reference: https://github.com/msgpack/msgpack/blob/master/spec.md
 */

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

function encode(value) {
    const parts = [];
    encodeValue(value, parts);
    return Buffer.concat(parts);
}

function encodeValue(value, parts) {
    if (value === null || value === undefined) {
        parts.push(Buffer.from([0xc0]));
    } else if (typeof value === 'boolean') {
        parts.push(Buffer.from([value ? 0xc3 : 0xc2]));
    } else if (typeof value === 'number') {
        encodeInteger(value, parts);
    } else if (typeof value === 'string') {
        encodeString(value, parts);
    } else if (Buffer.isBuffer(value)) {
        encodeBinary(value, parts);
    } else if (Array.isArray(value)) {
        encodeArray(value, parts);
    } else if (typeof value === 'object') {
        encodeMap(value, parts);
    } else {
        throw new Error(`msgpack: unsupported type ${typeof value}`);
    }
}

function encodeInteger(n, parts) {
    if (Number.isInteger(n)) {
        if (n >= 0) {
            if (n <= 0x7f) {
                parts.push(Buffer.from([n]));
            } else if (n <= 0xff) {
                parts.push(Buffer.from([0xcc, n]));
            } else if (n <= 0xffff) {
                const b = Buffer.alloc(3);
                b[0] = 0xcd;
                b.writeUInt16BE(n, 1);
                parts.push(b);
            } else if (n <= 0xffffffff) {
                const b = Buffer.alloc(5);
                b[0] = 0xce;
                b.writeUInt32BE(n, 1);
                parts.push(b);
            } else {
                throw new Error(`msgpack: integer too large: ${n}`);
            }
        } else {
            if (n >= -32) {
                // negative fixint: 111xxxxx
                parts.push(Buffer.from([n & 0xff]));
            } else if (n >= -128) {
                parts.push(Buffer.from([0xd0, n & 0xff]));
            } else if (n >= -32768) {
                const b = Buffer.alloc(3);
                b[0] = 0xd1;
                b.writeInt16BE(n, 1);
                parts.push(b);
            } else if (n >= -2147483648) {
                const b = Buffer.alloc(5);
                b[0] = 0xd2;
                b.writeInt32BE(n, 1);
                parts.push(b);
            } else {
                throw new Error(`msgpack: integer too small: ${n}`);
            }
        }
    } else {
        // Float64 for non-integers
        const b = Buffer.alloc(9);
        b[0] = 0xcb;
        b.writeDoubleBE(n, 1);
        parts.push(b);
    }
}

function encodeString(s, parts) {
    const encoded = Buffer.from(s, 'utf8');
    const len = encoded.length;
    if (len <= 31) {
        parts.push(Buffer.from([0xa0 | len]));
    } else if (len <= 0xff) {
        parts.push(Buffer.from([0xd9, len]));
    } else if (len <= 0xffff) {
        const b = Buffer.alloc(3);
        b[0] = 0xda;
        b.writeUInt16BE(len, 1);
        parts.push(b);
    } else {
        const b = Buffer.alloc(5);
        b[0] = 0xdb;
        b.writeUInt32BE(len, 1);
        parts.push(b);
    }
    parts.push(encoded);
}

function encodeBinary(buf, parts) {
    const len = buf.length;
    if (len <= 0xff) {
        parts.push(Buffer.from([0xc4, len]));
    } else if (len <= 0xffff) {
        const b = Buffer.alloc(3);
        b[0] = 0xc5;
        b.writeUInt16BE(len, 1);
        parts.push(b);
    } else {
        const b = Buffer.alloc(5);
        b[0] = 0xc6;
        b.writeUInt32BE(len, 1);
        parts.push(b);
    }
    parts.push(buf);
}

function encodeArray(arr, parts) {
    const len = arr.length;
    if (len <= 15) {
        parts.push(Buffer.from([0x90 | len]));
    } else if (len <= 0xffff) {
        const b = Buffer.alloc(3);
        b[0] = 0xdc;
        b.writeUInt16BE(len, 1);
        parts.push(b);
    } else {
        throw new Error(`msgpack: array too large: ${len}`);
    }
    for (const item of arr) {
        encodeValue(item, parts);
    }
}

function encodeMap(obj, parts) {
    const keys = Object.keys(obj);
    const len = keys.length;
    if (len <= 15) {
        parts.push(Buffer.from([0x80 | len]));
    } else if (len <= 0xffff) {
        const b = Buffer.alloc(3);
        b[0] = 0xde;
        b.writeUInt16BE(len, 1);
        parts.push(b);
    } else {
        throw new Error(`msgpack: map too large: ${len}`);
    }
    for (const key of keys) {
        encodeValue(key, parts);
        encodeValue(obj[key], parts);
    }
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

function decode(buffer) {
    const state = { buf: buffer, pos: 0 };
    const value = decodeValue(state);
    return value;
}

function decodeValue(state) {
    const byte = state.buf[state.pos++];

    // positive fixint (0x00 - 0x7f)
    if (byte <= 0x7f) return byte;

    // fixmap (0x80 - 0x8f)
    if ((byte & 0xf0) === 0x80) return decodeMapEntries(state, byte & 0x0f);

    // fixarray (0x90 - 0x9f)
    if ((byte & 0xf0) === 0x90) return decodeArrayEntries(state, byte & 0x0f);

    // fixstr (0xa0 - 0xbf)
    if ((byte & 0xe0) === 0xa0) return decodeStr(state, byte & 0x1f);

    // negative fixint (0xe0 - 0xff)
    if (byte >= 0xe0) return byte - 256;

    switch (byte) {
        case 0xc0: return null;       // nil
        case 0xc2: return false;      // false
        case 0xc3: return true;       // true

        // bin 8/16/32
        case 0xc4: return decodeBin(state, state.buf[state.pos++]);
        case 0xc5: return decodeBin(state, readUint16(state));
        case 0xc6: return decodeBin(state, readUint32(state));

        // float 32/64
        case 0xca: return readFloat32(state);
        case 0xcb: return readFloat64(state);

        // uint 8/16/32
        case 0xcc: return state.buf[state.pos++];
        case 0xcd: return readUint16(state);
        case 0xce: return readUint32(state);

        // int 8/16/32
        case 0xd0: return readInt8(state);
        case 0xd1: return readInt16(state);
        case 0xd2: return readInt32(state);

        // str 8/16/32
        case 0xd9: return decodeStr(state, state.buf[state.pos++]);
        case 0xda: return decodeStr(state, readUint16(state));
        case 0xdb: return decodeStr(state, readUint32(state));

        // array 16/32
        case 0xdc: return decodeArrayEntries(state, readUint16(state));
        case 0xdd: return decodeArrayEntries(state, readUint32(state));

        // map 16/32
        case 0xde: return decodeMapEntries(state, readUint16(state));
        case 0xdf: return decodeMapEntries(state, readUint32(state));

        default:
            throw new Error(`msgpack: unsupported type byte 0x${byte.toString(16)}`);
    }
}

function readUint16(state) {
    const v = state.buf.readUInt16BE(state.pos);
    state.pos += 2;
    return v;
}

function readUint32(state) {
    const v = state.buf.readUInt32BE(state.pos);
    state.pos += 4;
    return v;
}

function readInt8(state) {
    const v = state.buf.readInt8(state.pos);
    state.pos += 1;
    return v;
}

function readInt16(state) {
    const v = state.buf.readInt16BE(state.pos);
    state.pos += 2;
    return v;
}

function readInt32(state) {
    const v = state.buf.readInt32BE(state.pos);
    state.pos += 4;
    return v;
}

function readFloat32(state) {
    const v = state.buf.readFloatBE(state.pos);
    state.pos += 4;
    return v;
}

function readFloat64(state) {
    const v = state.buf.readDoubleBE(state.pos);
    state.pos += 8;
    return v;
}

function decodeStr(state, len) {
    const s = state.buf.toString('utf8', state.pos, state.pos + len);
    state.pos += len;
    return s;
}

function decodeBin(state, len) {
    const b = state.buf.subarray(state.pos, state.pos + len);
    state.pos += len;
    return Buffer.from(b); // copy so it doesn't hold a reference to the larger buffer
}

function decodeMapEntries(state, count) {
    const obj = {};
    for (let i = 0; i < count; i++) {
        const key = decodeValue(state);
        obj[key] = decodeValue(state);
    }
    return obj;
}

function decodeArrayEntries(state, count) {
    const arr = new Array(count);
    for (let i = 0; i < count; i++) {
        arr[i] = decodeValue(state);
    }
    return arr;
}

module.exports = { encode, decode };
