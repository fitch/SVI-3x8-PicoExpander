/**
 * Protocol utilities for SVI-3x8 PicoExpander communication
 */

/**
 * Create a command buffer with command code and size information
 * @param {string} command - Two-character command code (e.g., "LD", "LR")
 * @param {number} totalSize - Total size of data to transfer
 * @param {number} chunkSize - Size of each chunk
 * @returns {Buffer} Command buffer
 */
function createCommandBuffer(command, totalSize, chunkSize) {
    const buffer = Buffer.alloc(10);
    buffer.write(command, 0, 2, 'ascii');
    buffer.writeUInt32BE(totalSize, 2);
    buffer.writeUInt32BE(chunkSize, 6);
    return buffer;
}

/**
 * Validate file size against allowed sizes
 * @param {number} size - File size to validate
 * @param {Array<number>} allowedSizes - Array of allowed sizes
 * @returns {boolean} True if valid
 */
function validateFileSize(size, allowedSizes) {
    return allowedSizes.includes(size);
}

/**
 * Pad data to a specific size
 * @param {Buffer} data - Data to pad
 * @param {number} targetSize - Target size after padding
 * @param {number} fillByte - Byte value to use for padding (default: 0x00)
 * @returns {Buffer} Padded buffer
 */
function padBuffer(data, targetSize, fillByte = 0x00) {
    if (data.length >= targetSize) {
        return data;
    }
    const paddedBuffer = Buffer.alloc(targetSize, fillByte);
    data.copy(paddedBuffer, 0, 0, data.length);
    return paddedBuffer;
}

/**
 * Pad data to chunk boundaries
 * @param {Buffer} data - Data to pad
 * @param {number} chunkSize - Size of each chunk
 * @param {number} fillByte - Byte value to use for padding (default: 0x00)
 * @returns {Buffer} Padded buffer
 */
function padToChunks(data, chunkSize, fillByte = 0x00) {
    const fullChunks = Math.ceil(data.length / chunkSize);
    const paddedSize = fullChunks * chunkSize;
    
    if (data.length < paddedSize) {
        const padding = Buffer.alloc(paddedSize - data.length, fillByte);
        return Buffer.concat([data, padding]);
    }
    
    return data;
}

module.exports = {
    createCommandBuffer,
    validateFileSize,
    padBuffer,
    padToChunks
};
