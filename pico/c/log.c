/**
 * SVI-3x8 PicoExpander
 * 
 * Copyright (c) 2026 Markus Rautopuro
 * 
 * Works only with Raspberry Pico 2 W.
 */

#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include "pico/stdlib.h"
#include "lwip/apps/http_client.h"
#include "lwip/tcp.h"

#include "log.h"
#include "svi-328-expander-bus.h"

#define LOG_BUFFER_SIZE 8192

char log_buffer[LOG_BUFFER_SIZE];
size_t log_index = 0;

uint32_t boot_time_us = 0;

void log_message_ts(uint32_t timestamp_us, const char *format, ...) {
    va_list args;
    char temp_buffer[256];
    char final_buffer[300];

    va_start(args, format);
    int len = vsnprintf(temp_buffer, sizeof(temp_buffer), format, args);
    va_end(args);

    if (len < 0) {
        return;
    }

    snprintf(final_buffer, sizeof(final_buffer), "[%09lu] %s\n", (unsigned long)timestamp_us, temp_buffer);

    len = strlen(final_buffer);
    if (log_index + len < LOG_BUFFER_SIZE - 1) {
        strcpy(&log_buffer[log_index], final_buffer);
        log_index += len;
    }

    printf("%s", final_buffer);
}

#define MAX_CHUNK_SIZE 1024

typedef void (*log_completion_callback_t)(struct tcp_pcb *pcb);

typedef struct {
    struct tcp_pcb *pcb;
    const uint8_t *buffer;
    size_t total_length;
    size_t sent;
    log_completion_callback_t on_complete;
} log_send_state_t;

static log_send_state_t log_send_state;
// FIXME: This takes a lot of stack space
static uint8_t send_buffer[8 + sizeof(log_buffer) + 8 + sizeof(hw_log_buffer)];

void send_next_log_chunk() {
    size_t remaining = log_send_state.total_length - log_send_state.sent;
    if (remaining == 0) {
        tcp_sent(log_send_state.pcb, NULL);
        if (log_send_state.on_complete) {
            log_send_state.on_complete(log_send_state.pcb);
        }
        return;
    }

    uint16_t snd_buf = tcp_sndbuf(log_send_state.pcb);
    size_t chunk_size = remaining < snd_buf ? remaining : snd_buf;

    if (chunk_size > MAX_CHUNK_SIZE) {
        chunk_size = MAX_CHUNK_SIZE;
    }

    if (chunk_size == 0) {
        tcp_output(log_send_state.pcb);
        return; 
    }

    err_t err = tcp_write(
        log_send_state.pcb,
        log_send_state.buffer + log_send_state.sent,
        chunk_size,
        TCP_WRITE_FLAG_COPY
    );

    if (err != ERR_OK) {
        log_message("tcp_write failed: %d", err);
        return; // FIXME: This doesn't do anything, should handle error properly
    }

    log_send_state.sent += chunk_size;
    tcp_output(log_send_state.pcb);
}

err_t log_sent_callback(void *arg, struct tcp_pcb *tpcb, u16_t len) {
    (void)arg;
    (void)tpcb;
    (void)len;

    send_next_log_chunk();
    return ERR_OK;
}

void flush_logs(struct tcp_pcb *pcb, log_completion_callback_t on_complete) {
    size_t log_text_send_length = log_index;
    uint8_t log_text_overflow_flag = log_index >= LOG_BUFFER_SIZE ? 0x01 : 0x00;
    if (log_text_overflow_flag) {
        log_text_send_length = LOG_BUFFER_SIZE;
    }

    uint32_t capped_hw_log_index = hw_log_index & HW_LOG_MASK;

    size_t log_hardware_send_length = capped_hw_log_index * sizeof(hw_log_entry_t);
    uint8_t log_hardware_overflow_flag = hw_log_buffer[HW_LOG_MAX_ENTRIES - 1].timestamp != 0 ? 0x01 : 0x00;
    if (log_hardware_overflow_flag) {
        log_hardware_send_length = sizeof(hw_log_buffer);
    }

    uint16_t log_text_total_length = 8 + log_text_send_length;
    uint16_t log_hardware_total_length = 8 + log_hardware_send_length;

    memset(send_buffer, 0, sizeof(send_buffer));

    // Prepare log buffer

    send_buffer[0] = 0xDE;
    send_buffer[1] = 0xAD;
    send_buffer[2] = 0xBE;
    send_buffer[3] = 0xEF;
    send_buffer[4] = 0x00;
    send_buffer[5] = (log_text_total_length >> 8) & 0xFF;
    send_buffer[6] = log_text_total_length & 0xFF;
    send_buffer[7] = log_text_overflow_flag;

    memcpy(send_buffer + 8, log_buffer, log_text_send_length);

    // Prepare hardware log buffer

    size_t hw_log_offset = 8 + log_text_send_length;

    send_buffer[hw_log_offset + 0] = 0xDE;
    send_buffer[hw_log_offset + 1] = 0xAD;
    send_buffer[hw_log_offset + 2] = 0xBE;
    send_buffer[hw_log_offset + 3] = 0xEF;
    send_buffer[hw_log_offset + 4] = 0x01;
    send_buffer[hw_log_offset + 5] = (log_hardware_total_length >> 8) & 0xFF;
    send_buffer[hw_log_offset + 6] = log_hardware_total_length & 0xFF;
    send_buffer[hw_log_offset + 7] = log_hardware_overflow_flag;

    if (log_hardware_overflow_flag) {
        size_t first_part_length = (HW_LOG_MAX_ENTRIES - capped_hw_log_index) * sizeof(hw_log_entry_t);
        memcpy(send_buffer + hw_log_offset + 8, (void *)&hw_log_buffer[capped_hw_log_index], first_part_length);
        memcpy(send_buffer + hw_log_offset + 8 + first_part_length, (void *)hw_log_buffer, capped_hw_log_index * sizeof(hw_log_entry_t));
    } else {
        memcpy(send_buffer + hw_log_offset + 8, (void *)hw_log_buffer, log_hardware_send_length);
    }

    log_index = 0;
    hw_log_index = 0;
    hw_log_buffer[HW_LOG_MAX_ENTRIES - 1].timestamp = 0;

    log_send_state.pcb = pcb;
    log_send_state.buffer = send_buffer;
    log_send_state.total_length = log_text_total_length + log_hardware_total_length;
    log_send_state.sent = 0;
    log_send_state.on_complete = on_complete;

    tcp_sent(pcb, log_sent_callback);
    send_next_log_chunk();
}

void flush_text_log(struct tcp_pcb *pcb, log_completion_callback_t on_complete) {
    size_t log_text_send_length = log_index;
    uint8_t log_text_overflow_flag = log_index >= LOG_BUFFER_SIZE ? 0x01 : 0x00;
    if (log_text_overflow_flag) {
        log_text_send_length = LOG_BUFFER_SIZE;
    }

    uint16_t log_text_total_length = 8 + log_text_send_length;

    // Clear send buffer to prevent old data contamination
    memset(send_buffer, 0, sizeof(send_buffer));

    // Prepare log buffer
    send_buffer[0] = 0xDE;
    send_buffer[1] = 0xAD;
    send_buffer[2] = 0xBE;
    send_buffer[3] = 0xEF;
    send_buffer[4] = 0x00;
    send_buffer[5] = (log_text_total_length >> 8) & 0xFF;
    send_buffer[6] = log_text_total_length & 0xFF;
    send_buffer[7] = log_text_overflow_flag;

    memcpy(send_buffer + 8, log_buffer, log_text_send_length);

    log_index = 0;

    log_send_state.pcb = pcb;
    log_send_state.buffer = send_buffer;
    log_send_state.total_length = log_text_total_length;
    log_send_state.sent = 0;
    log_send_state.on_complete = on_complete;

    tcp_sent(pcb, log_sent_callback);
    send_next_log_chunk();
}

void flush_hardware_log(struct tcp_pcb *pcb, log_completion_callback_t on_complete) {
    uint32_t capped_hw_log_index = hw_log_index & HW_LOG_MASK;

    size_t log_hardware_send_length = capped_hw_log_index * sizeof(hw_log_entry_t);
    uint8_t log_hardware_overflow_flag = hw_log_buffer[HW_LOG_MAX_ENTRIES - 1].timestamp != 0 ? 0x01 : 0x00;
    if (log_hardware_overflow_flag) {
        log_hardware_send_length = sizeof(hw_log_buffer);
    }

    uint16_t log_hardware_total_length = 8 + log_hardware_send_length;

    // Clear send buffer to prevent old data contamination
    memset(send_buffer, 0, sizeof(send_buffer));

    // Prepare hardware log buffer
    send_buffer[0] = 0xDE;
    send_buffer[1] = 0xAD;
    send_buffer[2] = 0xBE;
    send_buffer[3] = 0xEF;
    send_buffer[4] = 0x01;
    send_buffer[5] = (log_hardware_total_length >> 8) & 0xFF;
    send_buffer[6] = log_hardware_total_length & 0xFF;
    send_buffer[7] = log_hardware_overflow_flag;

    if (log_hardware_overflow_flag) {
        size_t first_part_length = (HW_LOG_MAX_ENTRIES - capped_hw_log_index) * sizeof(hw_log_entry_t);
        memcpy(send_buffer + 8, (void *)&hw_log_buffer[capped_hw_log_index], first_part_length);
        memcpy(send_buffer + 8 + first_part_length, (void *)hw_log_buffer, capped_hw_log_index * sizeof(hw_log_entry_t));
    } else {
        memcpy(send_buffer + 8, (void *)hw_log_buffer, log_hardware_send_length);
    }

    hw_log_index = 0;
    hw_log_buffer[HW_LOG_MAX_ENTRIES - 1].timestamp = 0;

    log_send_state.pcb = pcb;
    log_send_state.buffer = send_buffer;
    log_send_state.total_length = log_hardware_total_length;
    log_send_state.sent = 0;
    log_send_state.on_complete = on_complete;

    tcp_sent(pcb, log_sent_callback);
    send_next_log_chunk();
}