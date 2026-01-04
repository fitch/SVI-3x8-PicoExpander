/**
 * Network constants for SVI-3x8 PicoExpander communication
 */

const UDP_PORT = 4243;
const TCP_PORT = 4242;
const HANDSHAKE_MESSAGE = "SVI-3x8 PicoExpander hello!";
const CHUNK_SIZE = 16384;

module.exports = {
    UDP_PORT,
    TCP_PORT,
    HANDSHAKE_MESSAGE,
    CHUNK_SIZE
};
