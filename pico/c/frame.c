/**
 * SVI-3x8 PicoExpander — v2 Protocol Framing Layer
 *
 * Copyright (c) 2026 Markus Rautopuro
 */

#include <string.h>
#include "pico/stdlib.h"
#include "pico/cyw43_arch.h"
#include "lwip/tcp.h"

#include "frame.h"
#include "cmd.h"
#include "log.h"
#include "svi-328-expander-bus.h"

static frame_conn_t v2_conn;
static send_queue_t send_queue;
static uint32_t conn_generation = 0; // Incremented on each new connection

static const char *err_to_str(err_t err) {
    switch (err) {
        case ERR_OK:         return "OK";
        case ERR_MEM:        return "MEM (out of memory)";
        case ERR_BUF:        return "BUF (buffer error)";
        case ERR_TIMEOUT:    return "TIMEOUT";
        case ERR_RTE:        return "RTE (routing problem)";
        case ERR_INPROGRESS: return "INPROGRESS";
        case ERR_VAL:        return "VAL (illegal value)";
        case ERR_WOULDBLOCK: return "WOULDBLOCK";
        case ERR_USE:        return "USE (address in use)";
        case ERR_ALREADY:    return "ALREADY (already connecting)";
        case ERR_ISCONN:     return "ISCONN (already connected)";
        case ERR_CONN:       return "CONN (not connected)";
        case ERR_IF:         return "IF (low-level netif error)";
        case ERR_ABRT:       return "ABRT (connection aborted)";
        case ERR_RST:        return "RST (connection reset by peer)";
        case ERR_CLSD:       return "CLSD (connection closed)";
        case ERR_ARG:        return "ARG (illegal argument)";
        default:             return "unknown";
    }
}

// ---------------------------------------------------------------------------
// Send queue (ring buffer)
// ---------------------------------------------------------------------------

static void send_queue_init(send_queue_t *q) {
    q->head = 0;
    q->tail = 0;
    q->used = 0;
}

static uint16_t send_queue_free(const send_queue_t *q) {
    return SEND_QUEUE_SIZE - q->used;
}

// Push raw bytes into the ring buffer. Returns false if not enough space.
static bool send_queue_push_bytes(send_queue_t *q, const uint8_t *data, uint16_t len) {
    if (len > send_queue_free(q)) return false;

    for (uint16_t i = 0; i < len; i++) {
        q->data[q->tail] = data[i];
        q->tail = (q->tail + 1) % SEND_QUEUE_SIZE;
    }
    q->used += len;
    return true;
}

// Peek at bytes from head without consuming them.
static void send_queue_peek(const send_queue_t *q, uint8_t *out, uint16_t offset, uint16_t len) {
    uint16_t pos = (q->head + offset) % SEND_QUEUE_SIZE;
    for (uint16_t i = 0; i < len; i++) {
        out[i] = q->data[pos];
        pos = (pos + 1) % SEND_QUEUE_SIZE;
    }
}

// Advance head by len bytes (consume).
static void send_queue_advance(send_queue_t *q, uint16_t len) {
    q->head = (q->head + len) % SEND_QUEUE_SIZE;
    q->used -= len;
}

// Copy len bytes from the ring buffer starting at offset from head
// into a contiguous output buffer (for tcp_write).
static void send_queue_copy_out(const send_queue_t *q, uint8_t *out, uint16_t offset, uint16_t len) {
    send_queue_peek(q, out, offset, len);
}

bool frame_queue_send(uint8_t priority,
                      const uint8_t *payload, uint32_t payload_len) {
    uint16_t frame_len = FRAME_HEADER_SIZE + payload_len;
    uint16_t entry_len = 2 + frame_len; // 2-byte length prefix + frame

    if (entry_len > send_queue_free(&send_queue)) {
        return false;
    }

    // Write 2-byte frame length (LE)
    uint8_t len_prefix[2] = { frame_len & 0xFF, (frame_len >> 8) & 0xFF };
    send_queue_push_bytes(&send_queue, len_prefix, 2);

    // Write frame header
    uint8_t header[FRAME_HEADER_SIZE];
    header[0] = FRAME_MAGIC;
    header[1] = priority;
    header[2] = (payload_len >> 16) & 0xFF;
    header[3] = (payload_len >> 8) & 0xFF;
    header[4] = payload_len & 0xFF;
    send_queue_push_bytes(&send_queue, header, FRAME_HEADER_SIZE);

    // Write payload
    if (payload_len > 0) {
        send_queue_push_bytes(&send_queue, payload, payload_len);
    }

    return true;
}

err_t frame_send_direct(uint8_t priority,
                        const uint8_t *payload, uint32_t payload_len) {
    if (!v2_conn.connected || !v2_conn.pcb) return ERR_CONN;

    struct tcp_pcb *pcb = v2_conn.pcb;
    uint32_t total_len = FRAME_HEADER_SIZE + payload_len;

    if (tcp_sndbuf(pcb) < total_len) {
        return ERR_MEM;
    }

    uint8_t header[FRAME_HEADER_SIZE];
    header[0] = FRAME_MAGIC;
    header[1] = priority;
    header[2] = (payload_len >> 16) & 0xFF;
    header[3] = (payload_len >> 8) & 0xFF;
    header[4] = payload_len & 0xFF;

    tcp_write(pcb, header, FRAME_HEADER_SIZE, TCP_WRITE_FLAG_COPY);

    if (payload_len > 0) {
        tcp_write(pcb, payload, payload_len, TCP_WRITE_FLAG_COPY);
    }

    return tcp_output(pcb);
}

err_t frame_send_direct_parts(uint8_t priority,
                              const uint8_t *part1, uint32_t part1_len,
                              const uint8_t *part2, uint32_t part2_len) {
    if (!v2_conn.connected || !v2_conn.pcb) {
        return ERR_CONN;
    }

    struct tcp_pcb *pcb = v2_conn.pcb;
    uint32_t payload_len = part1_len + part2_len;
    uint32_t total_len = FRAME_HEADER_SIZE + payload_len;

    // Check that the entire frame fits in the send buffer before writing anything.
    // Writing a partial frame corrupts the stream and causes the server to disconnect.
    uint16_t sndbuf = tcp_sndbuf(pcb);
    if (sndbuf < total_len) {
        return ERR_MEM;
    }

    uint8_t header[FRAME_HEADER_SIZE];
    header[0] = FRAME_MAGIC;
    header[1] = priority;
    header[2] = (payload_len >> 16) & 0xFF;
    header[3] = (payload_len >> 8) & 0xFF;
    header[4] = payload_len & 0xFF;

    tcp_write(pcb, header, FRAME_HEADER_SIZE, TCP_WRITE_FLAG_COPY);

    if (part1_len > 0) {
        tcp_write(pcb, part1, part1_len, TCP_WRITE_FLAG_COPY);
    }

    if (part2_len > 0) {
        tcp_write(pcb, part2, part2_len, TCP_WRITE_FLAG_COPY);
    }

    return tcp_output(pcb);
}

void frame_queue_drain(void) {
    if (!v2_conn.connected || !v2_conn.pcb) return;

    struct tcp_pcb *pcb = v2_conn.pcb;

    // Queued frames are small (acks and log lines, <= 256 bytes); large transfers
    // go through frame_send_direct_parts. A FRAME_MAX_PAYLOAD-sized buffer here
    // would blow the 2 KB core-0 stack into the lwIP pbuf pool.
    uint8_t drain_buf[512];

    while (send_queue.used >= 2) {
        // Peek at the 2-byte frame length
        uint8_t len_bytes[2];
        send_queue_peek(&send_queue, len_bytes, 0, 2);
        uint16_t frame_len = len_bytes[0] | (len_bytes[1] << 8);

        uint16_t entry_len = 2 + frame_len;
        if (send_queue.used < entry_len) break; // Incomplete entry (shouldn't happen)

        if (frame_len > sizeof(drain_buf)) { // Oversize entry (shouldn't happen): drop it
            send_queue_advance(&send_queue, entry_len);
            log_message("Error: dropped oversize queued frame (%u)", frame_len);
            continue;
        }

        // Check if TCP send buffer has room
        uint16_t sndbuf = tcp_sndbuf(pcb);
        if (sndbuf < frame_len) break;

        // Copy frame out of ring buffer into contiguous buffer
        send_queue_copy_out(&send_queue, drain_buf, 2, frame_len);

        err_t err = tcp_write(pcb, drain_buf, frame_len, TCP_WRITE_FLAG_COPY);
        if (err != ERR_OK) break;

        send_queue_advance(&send_queue, entry_len);
    }

    if (send_queue.used == 0 || tcp_sndbuf(pcb) > 0) {
        tcp_output(pcb);
    }
}

// ---------------------------------------------------------------------------
// Frame receive state machine
// ---------------------------------------------------------------------------

static void frame_rx_reset(frame_rx_t *rx) {
    rx->state = FRAME_RX_MAGIC;
    rx->header_pos = 0;
    rx->payload_pos = 0;
    rx->payload_len = 0;
}

static void frame_rx_feed(struct tcp_pcb *pcb, frame_rx_t *rx,
                          const uint8_t *data, uint16_t len) {
    for (uint16_t i = 0; i < len; i++) {
        uint8_t b = data[i];

        switch (rx->state) {
            case FRAME_RX_MAGIC:
                if (b == FRAME_MAGIC) {
                    rx->state = FRAME_RX_HEADER;
                    rx->header_pos = 0;
                }
                break;

            case FRAME_RX_HEADER:
                rx->header[rx->header_pos++] = b;
                if (rx->header_pos == 4) {
                    rx->payload_len = ((uint32_t)rx->header[1] << 16)
                                    | ((uint32_t)rx->header[2] << 8)
                                    | (uint32_t)rx->header[3];
                    rx->payload_pos = 0;

                    if (rx->payload_len == 0) {
                        cmd_on_message(rx->header[0], NULL, 0);
                        frame_rx_reset(rx);
                    } else if (rx->payload_len > FRAME_MAX_PAYLOAD) {
                        log_message("Frame too large (%lu), resync",
                                    (unsigned long)rx->payload_len);
                        frame_rx_reset(rx);
                    } else {
                        rx->state = FRAME_RX_PAYLOAD;
                    }
                }
                break;

            case FRAME_RX_PAYLOAD:
                rx->payload[rx->payload_pos++] = b;
                if (rx->payload_pos == rx->payload_len) {
                    cmd_on_message(rx->header[0],
                                     rx->payload, rx->payload_len);
                    frame_rx_reset(rx);
                }
                break;
        }
    }
}

// ---------------------------------------------------------------------------
// lwIP TCP callbacks for port 4244
// ---------------------------------------------------------------------------

static err_t frame_tcp_recv(void *arg, struct tcp_pcb *tpcb,
                            struct pbuf *p, err_t err) {
    (void)arg;

    if (!p || err != ERR_OK) {
        if (tpcb == v2_conn.pcb) {
            int32_t rssi = 0;
            cyw43_wifi_get_rssi(&cyw43_state, &rssi);
            int link = cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA);
            log_message("Client disconnected (p=%s, err=%d %s) link=%d RSSI=%ld dBm",
                        p ? "data" : "NULL", err, err_to_str(err), link, (long)rssi);
            v2_conn.connected = false;
            v2_conn.pcb = NULL;
        }
        if (p) pbuf_free(p);
        // Detach callbacks so we don't get further events on this pcb
        // (otherwise a late RST while we're in LAST_ACK fires tcp_err).
        tcp_arg(tpcb, NULL);
        tcp_recv(tpcb, NULL);
        tcp_err(tpcb, NULL);
        // Complete the close from our side; otherwise the pcb lingers in
        // CLOSE_WAIT and lwIP eventually RSTs it (the "-14" aftershock).
        if (tcp_close(tpcb) != ERR_OK) {
            tcp_abort(tpcb);
            return ERR_ABRT;
        }
        return ERR_OK;
    }

    // A received pbuf may be a CHAIN (p->tot_len > p->len) when lwIP reassembles
    // coalesced / out-of-order segments — common on a lossy link. Feed every link
    // to the parser, not just the first; otherwise the later links' bytes are
    // dropped from the frame stream (while still acked via tcp_recved below),
    // desyncing the parser and permanently stalling all further receives.
    for (struct pbuf *q = p; q != NULL; q = q->next) {
        frame_rx_feed(tpcb, &v2_conn.rx, (const uint8_t *)q->payload, q->len);
    }

    tcp_recved(tpcb, p->tot_len);
    pbuf_free(p);
    return ERR_OK;
}

static void frame_tcp_error(void *arg, err_t err) {
    uint32_t gen = (uint32_t)(uintptr_t)arg;
    if (gen != conn_generation) {
        log_message("Error: Stale connection %d %s (gen %lu, current %lu), ignoring",
                    err, err_to_str(err), (unsigned long)gen, (unsigned long)conn_generation);
        return;
    }
    int32_t rssi = 0;
    cyw43_wifi_get_rssi(&cyw43_state, &rssi);
    int link = cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA);
    log_message("Error: Connection error %d %s link=%d RSSI=%ld dBm",
                err, err_to_str(err), link, (long)rssi);
    v2_conn.connected = false;
    v2_conn.pcb = NULL;
}

static err_t frame_tcp_accept(void *arg, struct tcp_pcb *new_pcb, err_t err) {
    (void)arg;
    (void)err;

    // Allow new connection even if old one is still lingering —
    // the old connection's error callback will be ignored via generation check.
    if (v2_conn.connected && v2_conn.pcb) {
        log_message("Replacing old connection");
        tcp_abort(v2_conn.pcb);
    }

    conn_generation++;
    v2_conn.pcb = new_pcb;
    v2_conn.connected = true;
    v2_conn.next_seq = 0;
    frame_rx_reset(&v2_conn.rx);

    tcp_recv(new_pcb, frame_tcp_recv);
    tcp_err(new_pcb, frame_tcp_error);
    tcp_arg(new_pcb, (void *)(uintptr_t)conn_generation);
    new_pcb->so_options |= SOF_KEEPALIVE;
    log_message("Client connected (gen %lu)", (unsigned long)conn_generation);

    return ERR_OK;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

void frame_init(void) {
    memset(&v2_conn, 0, sizeof(v2_conn));
    send_queue_init(&send_queue);
}

bool frame_is_connected(void) {
    return v2_conn.connected && v2_conn.pcb != NULL;
}

int frame_server_setup(void) {
    struct netif *netif = &cyw43_state.netif[CYW43_ITF_STA];

    struct tcp_pcb *pcb = tcp_new_ip_type(IPADDR_TYPE_V4);
    if (!pcb) {
        log_message("Failed to create PCB");
        return -1;
    }

    err_t err = tcp_bind(pcb, &netif->ip_addr, FRAME_PORT);
    if (err != ERR_OK) {
        log_message("TCP bind failed");
        return -1;
    }

    pcb = tcp_listen(pcb);
    tcp_accept(pcb, frame_tcp_accept);

    log_message("Server listening on %s port %d",
                ip4addr_ntoa(netif_ip4_addr(netif)), FRAME_PORT);
    return 0;
}
