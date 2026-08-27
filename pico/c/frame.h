/**
 * SVI-3x8 PicoExpander — v2 Protocol Framing Layer
 *
 * Length-prefixed frames with MessagePack payloads over TCP.
 * Runs on port 4244 alongside the existing v1 protocol on 4242.
 *
 * Frame format:
 *   [0xE5] [pri:1] [len:3 BE] [payload: 0..16MB]
 *
 * Send queue:
 *   8KB FIFO ring buffer for pri 1-2 outbound frames.
 *   Pri 0 (CRITICAL) bypasses the queue — direct tcp_write.
 *   Pri 3 (BULK) bypasses the queue — dedicated send buffer.
 *
 * Copyright (c) 2026 Markus Rautopuro
 */

#ifndef FRAME_H
#define FRAME_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "lwip/tcp.h"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

#define FRAME_MAGIC       0xE5
#define FRAME_HEADER_SIZE 5
#define FRAME_MAX_PAYLOAD 16512 // 16384 data + 128 bytes msgpack envelope
#define FRAME_BUF_SIZE    (FRAME_HEADER_SIZE + FRAME_MAX_PAYLOAD)

#define FRAME_PORT        4244

// Priority levels (stored in frame header byte 1)
#define FRAME_PRI_CRITICAL 0
#define FRAME_PRI_HIGH     1
#define FRAME_PRI_NORMAL   2
#define FRAME_PRI_BULK     3

// Send queue size (8KB FIFO ring buffer)
#define SEND_QUEUE_SIZE    8192

// ---------------------------------------------------------------------------
// Send queue (ring buffer)
// ---------------------------------------------------------------------------

// Frame storage in ring buffer:
//   [frame_len:2 LE] [wire-ready frame: magic+pri+len+msgpack]
// The 2-byte length prefix lets the drain logic know frame boundaries.

typedef struct {
    uint8_t data[SEND_QUEUE_SIZE];
    uint16_t head;      // Read position (drain from here)
    uint16_t tail;      // Write position (push here)
    uint16_t used;      // Bytes currently in the buffer
} send_queue_t;

// ---------------------------------------------------------------------------
// Frame receive state machine
// ---------------------------------------------------------------------------

typedef enum {
    FRAME_RX_MAGIC,     // Waiting for 0xE5
    FRAME_RX_HEADER,    // Accumulating pri + len (4 bytes)
    FRAME_RX_PAYLOAD,   // Accumulating payload
} frame_rx_state_t;

typedef struct {
    frame_rx_state_t state;
    uint8_t header[4];      // pri(1) + len(3)
    uint8_t header_pos;
    uint8_t payload[FRAME_MAX_PAYLOAD];
    uint32_t payload_len;   // Expected payload length (from header)
    uint32_t payload_pos;   // Bytes accumulated so far
} frame_rx_t;

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

typedef struct {
    struct tcp_pcb *pcb;
    bool connected;
    frame_rx_t rx;
    uint16_t next_seq;  // Next sequence number for outbound commands
} frame_conn_t;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Initialise the send queue. Call as early as possible (before any log_message).
void frame_init(void);

// Start the v2 TCP listener on FRAME_PORT. Call once after WiFi is up.
int frame_server_setup(void);

// Send a frame directly to TCP, bypassing the send queue.
// Use for bulk data too large for the queue (e.g., hardware log).
err_t frame_send_direct(uint8_t priority,
                        const uint8_t *payload, uint32_t payload_len);

// Send a frame with payload assembled from two parts (envelope + data).
// Avoids needing a single contiguous buffer for large payloads.
err_t frame_send_direct_parts(uint8_t priority,
                              const uint8_t *part1, uint32_t part1_len,
                              const uint8_t *part2, uint32_t part2_len);

// Push a wire-ready frame into the send queue.
// The frame (header + payload) is built internally.
// Returns true if the frame was queued, false if the queue is full.
bool frame_queue_send(uint8_t priority,
                      const uint8_t *payload, uint32_t payload_len);

// Drain queued frames to TCP. Call from the main loop or tcp poll callback.
void frame_queue_drain(void);

// Returns true if a v2 client is connected.
bool frame_is_connected(void);

#endif /* FRAME_H */
