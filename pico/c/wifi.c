/**
 * SVI-3x8 PicoExpander
 * 
 * Copyright (c) 2026 Markus Rautopuro
 * 
 * Works only with Raspberry Pico 2 W.
 */

#include "pico/cyw43_arch.h"
#include "lwip/tcp.h"
#include "pico/multicore.h"
#include "hardware/flash.h"

#include "wifi.h"
#include "log.h"
#include "svi-328-expander-bus.h"
#include "media_control.h"

extern uint8_t pico_unique_id_chars[2];

extern const uint8_t __media_disk[MEDIA_DISK_SIZE];

#define TCP_PORT 4242
#define UDP_BROADCAST_PORT 4243

bool client_connected = false;
struct tcp_pcb *server_pcb;
size_t media_offset = 0;

void pico_set_led(bool led_on) {
    cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, led_on);
}

void wait_for_ip() {
    struct netif *netif = &cyw43_state.netif[0];
    log_message("Waiting for IP address...");
    while (netif->ip_addr.addr == 0) {
        sleep_ms(100);
    }
    log_message("IP Address obtained: %s", ipaddr_ntoa(&netif->ip_addr));
}

void tcp_error_callback(void *arg, err_t err) {
    (void)arg;
    log_message("Client disconnected or connection error occurred, error: %d", err);
    client_connected = false;
}

uint32_t read_u32_be(const uint8_t *p) {
    return (p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3];
}

uint16_t read_u16_be(const uint8_t *p) {
    return (p[0] << 8) | p[1];
}

#define COMMAND_SIZE 10

err_t send_response(struct tcp_pcb *tpcb, const char *code) {
    char response[COMMAND_SIZE] = {0};  // Initializes all bytes to 0
    response[0] = code[0];
    response[1] = code[1];

    err_t write_err = tcp_write(tpcb, response, sizeof(response), TCP_WRITE_FLAG_COPY);
    if (write_err == ERR_OK) {
        tcp_output(tpcb);  // Send the data
        return ERR_OK;
    } else {
        return write_err;  // Return the error if tcp_write failed
    }
}

#define CHUNK_SIZE 16384 // This is now hardcoded here, so if you adjust Node.js code, you need to adjust this too. Must be divisible by FLASH_SECTOR_SIZE

uint32_t expected_total_size = 0;
uint32_t expected_chunk_size = 0;
uint32_t chunk_offset = 0;
uint8_t chunk[CHUNK_SIZE];

static uint16_t pending_file_chunk_start_index = 0;  // Temporary storage for FX command chunk start index
static uint8_t pending_bank_config = 0;  // Temporary storage for LS command bank configuration

void __not_in_flash_func(store_media_chunk)(const uint32_t flash_offset, const uint8_t *data, size_t size, size_t chunk_size) {
    (void)chunk_size;
    
    uint32_t ints = save_and_disable_interrupts();
    flash_range_erase(flash_offset + media_offset, CHUNK_SIZE);
    flash_range_program(flash_offset + media_offset, data, CHUNK_SIZE);
    restore_interrupts(ints);

    log_message("Stored media chunk of size: %zu bytes at offset: %zu", size, media_offset);
    media_offset += size;
}

#define MAX_SEND_CHUNK_SIZE 1024
#define BK4X_SIZE 65536
#define BIOS_SIZE 32768
#define BANK_SIZE 32768
#define RAM4_DUMP_START 0xB000
#define RAM4_DUMP_END 0xF040
#define RAM4_DUMP_SIZE (RAM4_DUMP_END - RAM4_DUMP_START) // 16448 bytes

// Bank configuration bit flags
#define BANK_CONFIG_BK01 0x01  // Bit 0: BIOS ROM (always excluded)
#define BANK_CONFIG_BK02 0x02  // Bit 1: RAM0
#define BANK_CONFIG_BK11 0x04  // Bit 2: ROM_CARTRIDGE lower
#define BANK_CONFIG_BK12 0x08  // Bit 3: ROM_CARTRIDGE upper
#define BANK_CONFIG_BK21 0x10  // Bit 4: RAM2 lower
#define BANK_CONFIG_BK22 0x20  // Bit 5: RAM2 upper
#define BANK_CONFIG_BK31 0x40  // Bit 6: RAM3 lower
#define BANK_CONFIG_BK32 0x80  // Bit 7: RAM3 upper

/**
 * Check if a bank buffer contains only 0xFF bytes (unused/empty)
 */
static bool is_bank_empty(const uint8_t *bank, size_t size) {
    for (size_t i = 0; i < size; i++) {
        if (bank[i] != 0xFF) {
            return false;
        }
    }
    return true;
}

typedef struct {
    struct tcp_pcb *pcb;
    const uint8_t *buffer;
    size_t total_length;
    size_t sent;            // Bytes queued for sending
    size_t acknowledged;    // Bytes actually acknowledged by client
} data_send_state_t;

// Multi-buffer sending for save state
#define MAX_SEND_BUFFERS 10
typedef struct {
    struct tcp_pcb *pcb;
    const uint8_t *buffers[MAX_SEND_BUFFERS];
    size_t buffer_sizes[MAX_SEND_BUFFERS];
    size_t buffer_count;
    size_t current_buffer;
    size_t current_offset;  // Offset within current buffer
    size_t total_length;
    size_t sent;            // Bytes queued for sending
    size_t acknowledged;    // Bytes actually acknowledged by client
} multi_buffer_send_state_t;

static data_send_state_t data_send_state;
static multi_buffer_send_state_t multi_send_state;
bool command_in_progress = false;

void send_next_data_chunk() {
    size_t remaining = data_send_state.total_length - data_send_state.sent;
    if (remaining == 0) {
        if (data_send_state.acknowledged >= data_send_state.total_length) {
            tcp_output(data_send_state.pcb);
            tcp_sent(data_send_state.pcb, NULL);
            command_in_progress = false;
            pico_state = PICO_STATE_CLIENT_CONNECTED;
        }
        return;
    }

    uint16_t snd_buf = tcp_sndbuf(data_send_state.pcb);
    size_t chunk_size = remaining < snd_buf ? remaining : snd_buf;

    if (chunk_size > MAX_SEND_CHUNK_SIZE) {
        chunk_size = MAX_SEND_CHUNK_SIZE;
    }

    if (chunk_size == 0) {
        tcp_output(data_send_state.pcb);
        return; 
    }

    uint8_t flags = TCP_WRITE_FLAG_COPY;
    if (data_send_state.sent + chunk_size < data_send_state.total_length) {
        flags |= TCP_WRITE_FLAG_MORE;
    }
    
    err_t err = tcp_write(
        data_send_state.pcb,
        data_send_state.buffer + data_send_state.sent,
        chunk_size,
        flags
    );

    if (err != ERR_OK) {
        command_in_progress = false;
        return;
    }

    data_send_state.sent += chunk_size;
    tcp_output(data_send_state.pcb);
    if (data_send_state.sent >= data_send_state.total_length) {
        tcp_output(data_send_state.pcb);
    }
}

err_t data_sent_callback(void *arg, struct tcp_pcb *tpcb, u16_t len) {
    (void)arg;
    (void)tpcb;

    data_send_state.acknowledged += len;
    send_next_data_chunk();
    return ERR_OK;
}

void flush_bk4x_data(struct tcp_pcb *pcb) {
    if (command_in_progress) {
        return;
    }
    command_in_progress = true;

    data_send_state.pcb = pcb;
    data_send_state.buffer = (const void *)RAM4;
    data_send_state.total_length = BK4X_SIZE;
    data_send_state.sent = 0;
    data_send_state.acknowledged = 0;

    tcp_sent(pcb, data_sent_callback);
    send_next_data_chunk();
}

void flush_bios_data(struct tcp_pcb *pcb) {
    if (command_in_progress) {
        return;
    }
    command_in_progress = true;

    data_send_state.pcb = pcb;
    data_send_state.buffer = (const void *)BIOS;
    data_send_state.total_length = BIOS_SIZE;
    data_send_state.sent = 0;
    data_send_state.acknowledged = 0;

    tcp_sent(pcb, data_sent_callback);
    send_next_data_chunk();
}

void flush_disk_data(struct tcp_pcb *pcb) {
    if (command_in_progress) {
        return;
    }
    command_in_progress = true;

    data_send_state.pcb = pcb;
    data_send_state.buffer = (const void *)__media_disk;
    data_send_state.total_length = disk_size;
    data_send_state.sent = 0;
    data_send_state.acknowledged = 0;

    tcp_sent(pcb, data_sent_callback);
    send_next_data_chunk();
}

// Forward declaration
err_t multi_buffer_sent_callback(void *arg, struct tcp_pcb *tpcb, u16_t len);

void send_next_multi_buffer_chunk() {
    size_t remaining = multi_send_state.total_length - multi_send_state.sent;
    if (remaining == 0) {
        if (multi_send_state.acknowledged >= multi_send_state.total_length) {
            tcp_output(multi_send_state.pcb);
            tcp_sent(multi_send_state.pcb, NULL);
            command_in_progress = false;
            pico_state = PICO_STATE_CLIENT_CONNECTED;
        }
        return;
    }

    uint16_t snd_buf = tcp_sndbuf(multi_send_state.pcb);
    size_t chunk_size = remaining < snd_buf ? remaining : snd_buf;

    if (chunk_size > MAX_SEND_CHUNK_SIZE) {
        chunk_size = MAX_SEND_CHUNK_SIZE;
    }

    if (chunk_size == 0) {
        tcp_output(multi_send_state.pcb);
        return; 
    }

    // Determine which buffer(s) to send from
    size_t bytes_to_send = chunk_size;
    while (bytes_to_send > 0 && multi_send_state.current_buffer < multi_send_state.buffer_count) {
        size_t current_buffer_remaining = multi_send_state.buffer_sizes[multi_send_state.current_buffer] - multi_send_state.current_offset;
        size_t send_from_current = bytes_to_send < current_buffer_remaining ? bytes_to_send : current_buffer_remaining;
        
        uint8_t flags = TCP_WRITE_FLAG_COPY;
        if (multi_send_state.sent + send_from_current < multi_send_state.total_length) {
            flags |= TCP_WRITE_FLAG_MORE;
        }
        
        err_t err = tcp_write(
            multi_send_state.pcb,
            multi_send_state.buffers[multi_send_state.current_buffer] + multi_send_state.current_offset,
            send_from_current,
            flags
        );

        if (err != ERR_OK) {
            command_in_progress = false;
            return;
        }

        multi_send_state.sent += send_from_current;
        multi_send_state.current_offset += send_from_current;
        bytes_to_send -= send_from_current;
        
        // Move to next buffer if current is exhausted
        if (multi_send_state.current_offset >= multi_send_state.buffer_sizes[multi_send_state.current_buffer]) {
            multi_send_state.current_buffer++;
            multi_send_state.current_offset = 0;
        }
    }
    
    tcp_output(multi_send_state.pcb);
}

err_t multi_buffer_sent_callback(void *arg, struct tcp_pcb *tpcb, u16_t len) {
    (void)arg;
    (void)tpcb;

    multi_send_state.acknowledged += len;
    send_next_multi_buffer_chunk();
    return ERR_OK;
}

void flush_save_state_data(struct tcp_pcb *pcb, uint8_t bank_config) {
    if (command_in_progress) {
        return;
    }
    command_in_progress = true;

    multi_send_state.pcb = pcb;
    multi_send_state.buffer_count = 0;
    multi_send_state.current_buffer = 0;
    multi_send_state.current_offset = 0;
    multi_send_state.sent = 0;
    multi_send_state.acknowledged = 0;
    multi_send_state.total_length = 0;
    
    // First buffer: bank config byte (1 byte)
    // We store this in a static variable so it persists during async send
    static uint8_t bank_config_buffer;
    bank_config_buffer = bank_config;
    multi_send_state.buffers[multi_send_state.buffer_count] = &bank_config_buffer;
    multi_send_state.buffer_sizes[multi_send_state.buffer_count] = 1;
    multi_send_state.total_length += 1;
    multi_send_state.buffer_count++;
    
    // RAM4 area 0xB000-0xF03F (always included)
    multi_send_state.buffers[multi_send_state.buffer_count] = (const uint8_t *)RAM4 + RAM4_DUMP_START;
    multi_send_state.buffer_sizes[multi_send_state.buffer_count] = RAM4_DUMP_SIZE;
    multi_send_state.total_length += RAM4_DUMP_SIZE;
    multi_send_state.buffer_count++;
    
    // BK01 - BIOS ROM: always excluded (bit 0)
    // FIXME: We currently never send BIOS in save states
    
    // BK02 - RAM0 (32KB)
    if (bank_config & BANK_CONFIG_BK02) {
        multi_send_state.buffers[multi_send_state.buffer_count] = (const uint8_t *)RAM0;
        multi_send_state.buffer_sizes[multi_send_state.buffer_count] = BANK_SIZE;
        multi_send_state.total_length += BANK_SIZE;
        multi_send_state.buffer_count++;
    }
    
    // BK11 - ROM_CARTRIDGE lower 32KB
    if (bank_config & BANK_CONFIG_BK11) {
        multi_send_state.buffers[multi_send_state.buffer_count] = (const uint8_t *)ROM_CARTRIDGE;
        multi_send_state.buffer_sizes[multi_send_state.buffer_count] = BANK_SIZE;
        multi_send_state.total_length += BANK_SIZE;
        multi_send_state.buffer_count++;
    }
    
    // BK12 - ROM_CARTRIDGE upper 32KB
    if (bank_config & BANK_CONFIG_BK12) {
        multi_send_state.buffers[multi_send_state.buffer_count] = (const uint8_t *)ROM_CARTRIDGE + BANK_SIZE;
        multi_send_state.buffer_sizes[multi_send_state.buffer_count] = BANK_SIZE;
        multi_send_state.total_length += BANK_SIZE;
        multi_send_state.buffer_count++;
    }
    
    // BK21 - RAM2 lower 32KB
    if (bank_config & BANK_CONFIG_BK21) {
        multi_send_state.buffers[multi_send_state.buffer_count] = (const uint8_t *)RAM2;
        multi_send_state.buffer_sizes[multi_send_state.buffer_count] = BANK_SIZE;
        multi_send_state.total_length += BANK_SIZE;
        multi_send_state.buffer_count++;
    }
    
    // BK22 - RAM2 upper 32KB
    if (bank_config & BANK_CONFIG_BK22) {
        multi_send_state.buffers[multi_send_state.buffer_count] = (const uint8_t *)RAM2 + BANK_SIZE;
        multi_send_state.buffer_sizes[multi_send_state.buffer_count] = BANK_SIZE;
        multi_send_state.total_length += BANK_SIZE;
        multi_send_state.buffer_count++;
    }
    
    // BK31 - RAM3 lower 32KB
    if (bank_config & BANK_CONFIG_BK31) {
        multi_send_state.buffers[multi_send_state.buffer_count] = (const uint8_t *)RAM3;
        multi_send_state.buffer_sizes[multi_send_state.buffer_count] = BANK_SIZE;
        multi_send_state.total_length += BANK_SIZE;
        multi_send_state.buffer_count++;
    }
    
    // BK32 - RAM3 upper 32KB
    if (bank_config & BANK_CONFIG_BK32) {
        multi_send_state.buffers[multi_send_state.buffer_count] = (const uint8_t *)RAM3 + BANK_SIZE;
        multi_send_state.buffer_sizes[multi_send_state.buffer_count] = BANK_SIZE;
        multi_send_state.total_length += BANK_SIZE;
        multi_send_state.buffer_count++;
    }
    
    log_message("Sending save state: bank_config=0x%02X, total %zu bytes from %zu buffers", 
                bank_config, multi_send_state.total_length, multi_send_state.buffer_count);

    tcp_sent(pcb, multi_buffer_sent_callback);
    send_next_multi_buffer_chunk();
}

/**
 * Scan all banks and determine which ones have data (not all 0xFF)
 * Returns a bank configuration byte
 */
static uint8_t scan_bank_config(void) {
    uint8_t bank_config = 0;
    
    // BK01 - BIOS: always excluded from save states
    // (we don't set BANK_CONFIG_BK01)
    
    // BK02 - RAM0
    if (!is_bank_empty((const uint8_t *)RAM0, BANK_SIZE)) {
        bank_config |= BANK_CONFIG_BK02;
        log_message("  BK02 (RAM0): has data");
    } else {
        log_message("  BK02 (RAM0): empty");
    }
    
    // BK11 - ROM_CARTRIDGE lower
    if (!is_bank_empty((const uint8_t *)ROM_CARTRIDGE, BANK_SIZE)) {
        bank_config |= BANK_CONFIG_BK11;
        log_message("  BK11 (ROM_CART low): has data");
    } else {
        log_message("  BK11 (ROM_CART low): empty");
    }
    
    // BK12 - ROM_CARTRIDGE upper
    if (!is_bank_empty((const uint8_t *)ROM_CARTRIDGE + BANK_SIZE, BANK_SIZE)) {
        bank_config |= BANK_CONFIG_BK12;
        log_message("  BK12 (ROM_CART high): has data");
    } else {
        log_message("  BK12 (ROM_CART high): empty");
    }
    
    // BK21 - RAM2 lower
    if (!is_bank_empty((const uint8_t *)RAM2, BANK_SIZE)) {
        bank_config |= BANK_CONFIG_BK21;
        log_message("  BK21 (RAM2 low): has data");
    } else {
        log_message("  BK21 (RAM2 low): empty");
    }
    
    // BK22 - RAM2 upper
    if (!is_bank_empty((const uint8_t *)RAM2 + BANK_SIZE, BANK_SIZE)) {
        bank_config |= BANK_CONFIG_BK22;
        log_message("  BK22 (RAM2 high): has data");
    } else {
        log_message("  BK22 (RAM2 high): empty");
    }
    
    // BK31 - RAM3 lower
    if (!is_bank_empty((const uint8_t *)RAM3, BANK_SIZE)) {
        bank_config |= BANK_CONFIG_BK31;
        log_message("  BK31 (RAM3 low): has data");
    } else {
        log_message("  BK31 (RAM3 low): empty");
    }
    
    // BK32 - RAM3 upper
    if (!is_bank_empty((const uint8_t *)RAM3 + BANK_SIZE, BANK_SIZE)) {
        bank_config |= BANK_CONFIG_BK32;
        log_message("  BK32 (RAM3 high): has data");
    } else {
        log_message("  BK32 (RAM3 high): empty");
    }
    
    return bank_config;
}

void log_transfer_complete(struct tcp_pcb *pcb) {
    send_response(pcb, "FI");
    command_in_progress = false;
}

void send_file_chunk_request() {
    if (!client_connected || !server_pcb) {
        return;
    }
    
    if (command_in_progress) {
        return; // Don't send request if another command is in progress
    }
    
    char request[COMMAND_SIZE] = {0};
    request[0] = 'G';  // GX = Get chunk by index
    request[1] = 'X';
    request[2] = (file_index_request >> 8) & 0xFF;  // High byte
    request[3] = file_index_request & 0xFF;         // Low byte
    
    err_t write_err = tcp_write(server_pcb, request, sizeof(request), TCP_WRITE_FLAG_COPY);
    if (write_err == ERR_OK) {
        tcp_output(server_pcb);
        log_message("Requested file chunk for index %d from server", file_index_request);
    } else {
        log_message("Failed to request file chunk, error: %d", write_err);
    }
}

void send_file_send_request() {
    if (!client_connected || !server_pcb) {
        return;
    }
    
    if (command_in_progress) {
        return; // Don't send request if another command is in progress
    }
        
    char request[COMMAND_SIZE] = {0};
    request[0] = 'G';  // GF = Get file (send file to SVI)
    request[1] = 'F';
    request[2] = (file_index_request >> 8) & 0xFF;  // High byte
    request[3] = file_index_request & 0xFF;         // Low byte
    
    err_t write_err = tcp_write(server_pcb, request, sizeof(request), TCP_WRITE_FLAG_COPY);
    if (write_err == ERR_OK) {
        tcp_output(server_pcb);
        log_message("Requested file send for index %d from server", file_index_request);
    } else {
        log_message("Failed to request file send, error: %d", write_err);
    }
}

void send_save_state_request() {
    if (!client_connected || !server_pcb) {
        return;
    }
    
    if (command_in_progress) {
        return; // Don't send request if another command is in progress
    }
            
    char request[COMMAND_SIZE] = {0};
    request[0] = 'S';  // SS = Save State
    request[1] = 'S';
    // No longer sending save state size type - Pico always sends all banks
    
    err_t write_err = tcp_write(server_pcb, request, sizeof(request), TCP_WRITE_FLAG_COPY | TCP_WRITE_FLAG_MORE);
    if (write_err != ERR_OK) {
        log_message("Failed to send SS command, error: %d", write_err);
        pico_state = PICO_STATE_ERROR;
        return;
    }
    
    // Send filename as separate 256-byte payload (null-padded)
    char filename_payload[SAVE_STATE_FILENAME_MAX_LENGTH] = {0};
    size_t filename_len = strlen((char *)save_state_filename);
    if (filename_len > 0 && filename_len < SAVE_STATE_FILENAME_MAX_LENGTH) {
        memcpy(filename_payload, (void *)save_state_filename, filename_len);
    }
    
    write_err = tcp_write(server_pcb, filename_payload, sizeof(filename_payload), TCP_WRITE_FLAG_COPY);
    if (write_err == ERR_OK) {
        tcp_output(server_pcb);
        if (filename_len > 0) {
            log_message("Requesting save state, filename: %s", save_state_filename);
        } else {
            log_message("Requesting save state (default filename)");
        }
    } else {
        log_message("Failed to send filename payload, error: %d", write_err);
        pico_state = PICO_STATE_ERROR;
    }
}

void send_set_filter_request() {
    if (!client_connected || !server_pcb) {
        return;
    }
    
    if (command_in_progress) {
        return; // Don't send request if another command is in progress
    }
    
    char request[COMMAND_SIZE] = {0};
    request[0] = 'S';  // SF = Set Filter
    request[1] = 'F';
    request[2] = file_type_filter;  // Filter value byte
    
    err_t write_err = tcp_write(server_pcb, request, sizeof(request), TCP_WRITE_FLAG_COPY);
    if (write_err == ERR_OK) {
        tcp_output(server_pcb);
        log_message("Sent file type filter: %d", file_type_filter);
    } else {
        log_message("Failed to send file type filter, error: %d", write_err);
    }
}

void send_hdd_read_request(uint32_t offset, uint16_t file_number, uint16_t length) {
    if (!client_connected || !server_pcb) return;
    uint8_t cmd[COMMAND_SIZE];
    cmd[0] = 'F'; cmd[1] = 'R';
    cmd[2] = (offset >> 24) & 0xFF;
    cmd[3] = (offset >> 16) & 0xFF;
    cmd[4] = (offset >> 8) & 0xFF;
    cmd[5] = offset & 0xFF;
    cmd[6] = (file_number >> 8) & 0xFF;
    cmd[7] = file_number & 0xFF;
    cmd[8] = (length >> 8) & 0xFF;
    cmd[9] = length & 0xFF;
    tcp_write(server_pcb, cmd, COMMAND_SIZE, TCP_WRITE_FLAG_COPY);
    tcp_output(server_pcb);
}

void send_hdd_write_request(uint32_t offset, uint16_t file_number, uint16_t length, volatile uint8_t *data) {
    if (!client_connected || !server_pcb) return;
    uint8_t cmd[COMMAND_SIZE + 256]; // max payload = 256
    cmd[0] = 'F'; cmd[1] = 'W';
    cmd[2] = (offset >> 24) & 0xFF;
    cmd[3] = (offset >> 16) & 0xFF;
    cmd[4] = (offset >> 8) & 0xFF;
    cmd[5] = offset & 0xFF;
    cmd[6] = (file_number >> 8) & 0xFF;
    cmd[7] = file_number & 0xFF;
    cmd[8] = (length >> 8) & 0xFF;
    cmd[9] = length & 0xFF;
    memcpy(cmd + COMMAND_SIZE, (const void *)data, length);
    tcp_write(server_pcb, cmd, COMMAND_SIZE + length, TCP_WRITE_FLAG_COPY);
    tcp_output(server_pcb);
}

extern const uint8_t __media_tape[MEDIA_TAPE_SIZE];

err_t tcp_recv_callback(void *arg, struct tcp_pcb *tpcb, struct pbuf *p, err_t err) {
    (void)arg;
    (void)err;

    if (!p) {
        log_message("Client disconnected");
        tcp_close(tpcb);
        client_connected = false;
        media_offset = 0;
        if (pico_state == PICO_STATE_CLIENT_CONNECTED) {
            pico_state = PICO_STATE_CLIENT_DISCONNECTED;
        }
        file_server_status = FILE_SERVER_NOT_CONNECTED;
        // Unblock any pending HDD operation on disconnect
        if (sasi_phase == SASI_PHASE_BUSY) {
            sasi_status_byte = 0x02; // Check Condition
            hdd_op_complete = true;
        }
        hdd_total_lbas = 0; // Clear HDD Available flag
        return ERR_OK;
    }

    char *data = (char *)p->payload;

    // Intercept HDD protocol commands (HI, FS) before standard command routing.
    // These may be larger than COMMAND_SIZE (e.g., FS read response = 266 bytes)
    // and must not fall through to the data-stream handler.
    // Use p->tot_len and pbuf_copy_partial for safe chained-pbuf handling.
    if (p->tot_len >= COMMAND_SIZE && data[0] == 'H' && data[1] == 'I') {
        uint8_t hdr[COMMAND_SIZE];
        pbuf_copy_partial(p, hdr, COMMAND_SIZE, 0);
        hdd_total_lbas = read_u32_be(&hdr[2]);
        log_message("HDD image loaded: %lu sectors", hdd_total_lbas);
        tcp_recved(tpcb, p->tot_len);
        pbuf_free(p);
        return ERR_OK;
    }
    if (p->tot_len >= COMMAND_SIZE && data[0] == 'F' && data[1] == 'S') {
        uint8_t hdr[COMMAND_SIZE];
        pbuf_copy_partial(p, hdr, COMMAND_SIZE, 0);
        uint32_t offset = read_u32_be(&hdr[2]);
        uint16_t length = read_u16_be(&hdr[8]);
        if (hdd_op_type == HDD_OP_READ && p->tot_len >= COMMAND_SIZE + length) {
            // Read response: copy sector data from (potentially chained) pbuf
            pbuf_copy_partial(p, (void *)HDD_READ_SECTOR, length, COMMAND_SIZE);
            hdd_read_sector_lba = offset;
            hdd_read_sector_valid = true;
        }
        // Both read response and write ACK signal completion
        hdd_op_complete = true;
        tcp_recved(tpcb, p->tot_len);
        pbuf_free(p);
        return ERR_OK;
    }

    if (p->len == COMMAND_SIZE) { // Receive command
        char cmd[3] = { data[0], data[1], '\0' };
        uint32_t total_size = read_u32_be((const uint8_t *)&data[2]);
        uint32_t chunk_size = read_u32_be((const uint8_t *)&data[6]);
        
        expected_total_size = total_size;
        expected_chunk_size = chunk_size;

        // Combine two command chars into a 16-bit value for switch
        #define CMD(a, b) (((a) << 8) | (b))
        uint16_t cmd_code = CMD(cmd[0], cmd[1]);

        switch (cmd_code) {
            case CMD('F', 'X'): // File Chunk (256 files × 32 bytes) with embedded file count and filter
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                // total_size contains chunk_start_index (low 16 bits) and file_count (high 16 bits)
                pending_file_chunk_start_index = (uint16_t)(total_size & 0xFFFF);
                server_file_count = (uint16_t)((total_size >> 16) & 0xFFFF);
                // chunk_size contains filter (high 8 bits) and data size (low 24 bits)
                file_type_filter = (uint8_t)((chunk_size >> 24) & 0xFF);
                expected_total_size = chunk_size & 0xFFFFFF;
                pico_state = PICO_STATE_RECEIVING_FILE_CHUNK;
                command_in_progress = true;
                media_offset = 0;
                log_message("Receiving file chunk starting at index %d, total files: %d, filter: %d", pending_file_chunk_start_index, server_file_count, file_type_filter);
                send_response(tpcb, "OK");
                break;

            case CMD('S', 'L'): // Send both logs
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                send_response(tpcb, "OK");
                pico_state = PICO_STATE_DUMPING_LOG;
                command_in_progress = true;
                flush_logs(tpcb, log_transfer_complete);
                // FI response and flag clearing will be done by log callback when complete
                pico_state = PICO_STATE_CLIENT_CONNECTED;
                break;

            case CMD('S', 'T'): // Send text log
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                send_response(tpcb, "OK");
                pico_state = PICO_STATE_DUMPING_LOG;
                command_in_progress = true;
                flush_text_log(tpcb, log_transfer_complete);
                // FI response and flag clearing will be done by log callback when complete
                pico_state = PICO_STATE_CLIENT_CONNECTED;
                break;

            case CMD('S', 'H'): // Send hardware log
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                send_response(tpcb, "OK");
                pico_state = PICO_STATE_DUMPING_LOG;
                command_in_progress = true;
                flush_hardware_log(tpcb, log_transfer_complete);
                // FI response and flag clearing will be done by log callback when complete
                pico_state = PICO_STATE_CLIENT_CONNECTED;
                break;

            case CMD('L', 'D'): // Load disk
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                if (expected_chunk_size != CHUNK_SIZE) {
                    log_message("Invalid chunk size for disk load: %zu, expected: %zu", expected_chunk_size, CHUNK_SIZE);
                    send_response(tpcb, "ER");
                    pbuf_free(p);
                    return ERR_OK;
                }
                command_in_progress = true;
                send_response(tpcb, "OK");
                log_message("Received LD command. Waiting for disk data...");

                pico_state = PICO_STATE_RECEIVING_DISK;
                media_offset = 0;
                break;

            case CMD('L', 'R'): // Load ROM
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                if (expected_chunk_size != 65536) { // It will now upload ROMs in one chunk
                    log_message("Invalid chunk size for disk load: %zu, expected: %zu", expected_chunk_size, 65536);
                    send_response(tpcb, "ER");
                    pbuf_free(p);
                    return ERR_OK;
                }

                command_in_progress = true;
                send_response(tpcb, "OK");
                log_message("Received LR command. Waiting for ROM data...");

                pico_state = PICO_STATE_RECEIVING_ROM;
                media_offset = 0;
                break;

            case CMD('L', 'L'): // Load launcher ROM to BK31 and BK32
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                if (expected_chunk_size != 65536) { // It will now upload ROMs in one chunk
                    log_message("Invalid chunk size for disk load: %zu, expected: %zu", expected_chunk_size, 65536);
                    send_response(tpcb, "ER");
                    pbuf_free(p);
                    return ERR_OK;
                }

                command_in_progress = true;
                send_response(tpcb, "OK");
                log_message("Received LL command. Waiting for ROM data...");

                pico_state = PICO_STATE_RECEIVING_BK4X;
                media_offset = 0;
                break;

            case CMD('S', 'B'): // Save BK4X RAM4 data
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                send_response(tpcb, "OK");
                pico_state = PICO_STATE_SENDING_BK4X;
                flush_bk4x_data(tpcb);
                break;

            case CMD('S', 'I'): // Save bIos data
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                send_response(tpcb, "OK");
                pico_state = PICO_STATE_SENDING_BIOS;
                flush_bios_data(tpcb);
                break;

            case CMD('S', 'D'): // Save Disk image
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                if (disk_size == 0) {
                    send_response(tpcb, "ER");
                    pbuf_free(p);
                    return ERR_OK;
                }
                {
                    // Send OK response with disk_size in bytes 2-5 (big-endian)
                    char response[COMMAND_SIZE] = {0};
                    response[0] = 'O';
                    response[1] = 'K';
                    response[2] = (disk_size >> 24) & 0xFF;
                    response[3] = (disk_size >> 16) & 0xFF;
                    response[4] = (disk_size >> 8) & 0xFF;
                    response[5] = disk_size & 0xFF;
                    tcp_write(tpcb, response, sizeof(response), TCP_WRITE_FLAG_COPY);
                    tcp_output(tpcb);
                }
                pico_state = PICO_STATE_SENDING_DISK;
                flush_disk_data(tpcb);
                break;

            case CMD('S', 'V'): // Save state (from serVer request)
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                log_message("Received SV command. Scanning banks...");
                uint8_t bank_config = scan_bank_config();
                log_message("Bank config: 0x%02X", bank_config);
                send_response(tpcb, "OK");
                pico_state = PICO_STATE_SENDING_SAVE_STATE;
                flush_save_state_data(tpcb, bank_config);
                break;

            case CMD('B', 'L'): // Boot back to launcher
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                log_message("Received BL command. Sending a request to boot back to the launcher...");
        
                command_in_progress = true;
                pico_state = PICO_STATE_INJECTING_BOOT;
                inject_type = INJECT_TYPE_BOOT;

                while (pico_state == PICO_STATE_INJECTING_BOOT) {
                    sleep_ms(10);
                }

                if (pico_state == PICO_STATE_BOOT_SUCCESS) {
                    log_message("Booted to launcher successfully.");
                    send_response(tpcb, "OK");
                } else if (pico_state == PICO_STATE_BOOT_FAIL) {
                    log_message("Boot to launcher failed.");
                    send_response(tpcb, "ER");
                } else {
                    log_message("Unexpected pico_state after booting to launcher: %d", pico_state);
                    send_response(tpcb, "ER");
                }

                command_in_progress = false;
                pico_state = PICO_STATE_CLIENT_CONNECTED;
                break;

            case CMD('L', 'T'): // Load tape
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                if (expected_chunk_size != CHUNK_SIZE) {
                    log_message("Invalid chunk size for tape load: %zu, expected: %zu", expected_chunk_size, CHUNK_SIZE);
                    send_response(tpcb, "ER");
                    pbuf_free(p);
                    return ERR_OK;
                }
                command_in_progress = true;
                send_response(tpcb, "OK");
                log_message("Received LT command. Waiting for tape data...");

                pico_state = PICO_STATE_RECEIVING_TAPE;
                media_offset = 0;
                break;

            case CMD('L', 'S'): // Load Save state (version 0x01)
                if (command_in_progress) {
                    send_response(tpcb, "EC");
                    pbuf_free(p);
                    return ERR_OK;
                }
                // Version 0x01 protocol:
                // total_size contains bank configuration byte
                // chunk_size contains expected data size (1 byte bank config + RAM4 + banks)
                {
                    uint8_t bank_config = (uint8_t)(total_size & 0xFF);
                    expected_total_size = chunk_size;  // Data size (including 1-byte bank config prefix)
                    pending_bank_config = bank_config;
                    command_in_progress = true;
                    send_response(tpcb, "OK");
                    log_message("Received LS command. Bank config: 0x%02X, data size: %zu", bank_config, expected_total_size);
                    pico_state = PICO_STATE_RECEIVING_SAVE_STATE;
                    media_offset = 0;
                }
                break;

            default:
                log_message("Invalid command received: %s", cmd);
                break;
        }
        #undef CMD
    } else {
        uint32_t new_chunk_offset;
        uint32_t bytes_to_copy;
        switch (pico_state) {
            case PICO_STATE_RECEIVING_FILE_CHUNK:
                // Receiving file chunk data (256 files × 32 bytes = 8192 bytes)
                bytes_to_copy = expected_total_size - media_offset;
                if (p->len >= bytes_to_copy) {
                    memcpy((void *)&FILE_CACHE[media_offset], (void *)data, bytes_to_copy);
                    media_offset += bytes_to_copy;
                    
                    if (media_offset >= expected_total_size) {
                        file_cache_start_index = pending_file_chunk_start_index;
                        
                        uint16_t remaining_files = server_file_count - file_cache_start_index;
                        file_cache_count = (remaining_files < 256) ? remaining_files : 256;
                        
                        send_response(tpcb, "FI");
                        log_message("File chunk received, starting at index %d, count %d", file_cache_start_index, file_cache_count);
                        
                        media_offset = 0;
                        
                        file_server_status = FILE_SERVER_ACTIVE_IDLE;
                        pico_state = PICO_STATE_CLIENT_CONNECTED;
                        command_in_progress = false;
                    }
                } else {
                    memcpy((void *)&FILE_CACHE[media_offset], (void *)data, p->len);
                    media_offset += p->len;
                }
                break;

            case PICO_STATE_RECEIVING_DISK: // Receiving data chunk, usually 1460 bytes
                new_chunk_offset = chunk_offset + p->len;
                if (new_chunk_offset == expected_chunk_size) { // FIXME: If it's more, it's an error
                    // log_message("Received complete data chunk of size: %zu bytes", expected_chunk_size);
                    memcpy((void *)&chunk[chunk_offset], (void *)data, p->len);
                    chunk_offset = 0; // Reset for next chunk
                    uint32_t store_size = media_offset + new_chunk_offset > expected_total_size ? expected_total_size - media_offset : expected_chunk_size;
                    store_media_chunk(MEDIA_DISK_OFFSET, chunk, store_size, expected_chunk_size);

                    if (media_offset == expected_total_size) {
                        send_response(tpcb, "FI");
                        log_message("Media upload complete (%zu bytes)", media_offset);

                        disk_size = media_offset;
                        pico_state = PICO_STATE_DISK_READY;
                        command_in_progress = false;
                    } else {
                        send_response(tpcb, "RD");
                    }
                } else {
                    // log_message("Received partial data chunk, expected size: %zu bytes, received: %zu bytes", expected_chunk_size, chunk_offset);
                    memcpy((void *)&chunk[chunk_offset], (void *)data, p->len);
                    chunk_offset = new_chunk_offset;
                }
                break;

            case PICO_STATE_RECEIVING_TAPE: // Receiving data chunk, usually 1460 bytes
                new_chunk_offset = chunk_offset + p->len;
                if (new_chunk_offset == expected_chunk_size) { // FIXME: If it's more, it's an error
                    // log_message("Received complete data chunk of size: %zu bytes", expected_chunk_size);
                    memcpy((void *)&chunk[chunk_offset], (void *)data, p->len);
                    chunk_offset = 0; // Reset for next chunk
                    uint32_t store_size = media_offset + new_chunk_offset > expected_total_size ? expected_total_size - media_offset : expected_chunk_size;

                    store_media_chunk(MEDIA_TAPE_OFFSET, chunk, store_size, expected_chunk_size);

                    if (media_offset == expected_total_size) {
                        send_response(tpcb, "FI");
                        log_message("Media upload complete (%zu bytes)", media_offset);

                        // This applies a patch to the BIOS ROM that enables tape emulation
                        apply_bios_patch();

                        // Load first 32768 bytes of tape image to TAPE_BUFFER
                        memcpy((void *)TAPE_BUFFER, (void *)__media_tape, TAPE_BUFFER_SIZE);

                        tape_size = media_offset;
                        pico_state = PICO_STATE_TAPE_READY;
                        command_in_progress = false;
                    } else {
                        send_response(tpcb, "RD");
                    }
                } else {
                    // log_message("Received partial data chunk, expected size: %zu bytes, received: %zu bytes", expected_chunk_size, chunk_offset);
                    memcpy((void *)&chunk[chunk_offset], (void *)data, p->len);
                    chunk_offset = new_chunk_offset;
                }
                break;

            case PICO_STATE_RECEIVING_ROM:
                bytes_to_copy = 65536 - media_offset;
                if (p->len < bytes_to_copy) {
                    memcpy((void *)&ROM_CARTRIDGE[media_offset], (void *)data, p->len);
                    media_offset += p->len;
                } else {
                    memcpy((void *)&ROM_CARTRIDGE[media_offset], (void *)data, bytes_to_copy);
                    media_offset += bytes_to_copy;
                    send_response(tpcb, "FI");
                    log_message("ROM upload complete (%zu bytes)", media_offset);

                    pico_state = PICO_STATE_ROM_READY;
                    command_in_progress = false;
                }
                break;

            case PICO_STATE_RECEIVING_BK4X: 
                bytes_to_copy = 65536 - media_offset;
                if (p->len < bytes_to_copy) {
                    memcpy((void *)&RAM4[media_offset], (void *)data, p->len);
                    media_offset += p->len;
                } else {
                    memcpy((void *)&RAM4[media_offset], (void *)data, bytes_to_copy);
                    media_offset += bytes_to_copy;
                    send_response(tpcb, "FI");
                    log_message("BK4X upload complete (%zu bytes)", media_offset);

                    skip_ram4_init = true;

                    pico_state = PICO_STATE_INJECTING_BOOT;
                    inject_type = INJECT_TYPE_BOOT;

                    while (pico_state == PICO_STATE_INJECTING_BOOT) {
                        sleep_ms(10);
                    }

                    if (pico_state == PICO_STATE_BOOT_SUCCESS) {
                        log_message("Booted to launcher successfully.");
                        send_response(tpcb, "OK");
                    } else if (pico_state == PICO_STATE_BOOT_FAIL) {
                        log_message("Boot to launcher failed.");
                        send_response(tpcb, "ER");
                    } else {
                        log_message("Unexpected pico_state after booting to launcher: %d", pico_state);
                        send_response(tpcb, "ER");
                    }

                    command_in_progress = false;
                    pico_state = PICO_STATE_CLIENT_CONNECTED;

                    command_in_progress = false;
                }
                break;

            case PICO_STATE_RECEIVING_SAVE_STATE: {
                // Data layout: 1 byte bank config + RAM4 (16448) + banks according to bank config
                // Banks are in order: BK01, BK02, BK11, BK12, BK21, BK22, BK31, BK32
                
                uint8_t bank_config = pending_bank_config;
                
                size_t bk01_size = (bank_config & BANK_CONFIG_BK01) ? BANK_SIZE : 0;
                size_t bk02_size = (bank_config & BANK_CONFIG_BK02) ? BANK_SIZE : 0;
                size_t bk11_size = (bank_config & BANK_CONFIG_BK11) ? BANK_SIZE : 0;
                size_t bk12_size = (bank_config & BANK_CONFIG_BK12) ? BANK_SIZE : 0;
                size_t bk21_size = (bank_config & BANK_CONFIG_BK21) ? BANK_SIZE : 0;
                size_t bk22_size = (bank_config & BANK_CONFIG_BK22) ? BANK_SIZE : 0;
                size_t bk31_size = (bank_config & BANK_CONFIG_BK31) ? BANK_SIZE : 0;
                size_t bk32_size = (bank_config & BANK_CONFIG_BK32) ? BANK_SIZE : 0;
                
                size_t ram4_start = 1;  // After bank config byte
                size_t bk01_start = ram4_start + RAM4_DUMP_SIZE;
                size_t bk02_start = bk01_start + bk01_size;
                size_t bk11_start = bk02_start + bk02_size;
                size_t bk12_start = bk11_start + bk11_size;
                size_t bk21_start = bk12_start + bk12_size;
                size_t bk22_start = bk21_start + bk21_size;
                size_t bk31_start = bk22_start + bk22_size;
                size_t bk32_start = bk31_start + bk31_size;
                size_t data_end = bk32_start + bk32_size;
                
                size_t data_pos = 0;
                size_t remaining = p->len;
                
                while (remaining > 0 && media_offset < expected_total_size) {
                    size_t offset = media_offset;
                    
                    if (offset < ram4_start) {
                        // Skip bank config byte (already parsed from command)
                        size_t to_skip = ram4_start - offset;
                        if (to_skip > remaining) to_skip = remaining;
                        media_offset += to_skip;
                        data_pos += to_skip;
                        remaining -= to_skip;
                    } else if (offset < bk01_start) {
                        // Copy to RAM4 area (0xB000-0xF03F)
                        size_t ram4_offset = offset - ram4_start;
                        size_t space = RAM4_DUMP_SIZE - ram4_offset;
                        size_t to_copy = remaining < space ? remaining : space;
                        memcpy((void *)&RAM4[RAM4_DUMP_START + ram4_offset], (void *)&data[data_pos], to_copy);
                        media_offset += to_copy;
                        data_pos += to_copy;
                        remaining -= to_copy;
                    } else if (bk01_size > 0 && offset < bk02_start) {
                        // Copy to BIOS (BK01)
                        size_t bk_offset = offset - bk01_start;
                        size_t space = bk01_size - bk_offset;
                        size_t to_copy = remaining < space ? remaining : space;
                        memcpy((void *)&BIOS[bk_offset], (void *)&data[data_pos], to_copy);
                        media_offset += to_copy;
                        data_pos += to_copy;
                        remaining -= to_copy;
                    } else if (bk02_size > 0 && offset < bk11_start) {
                        // Copy to RAM0 (BK02)
                        size_t bk_offset = offset - bk02_start;
                        size_t space = bk02_size - bk_offset;
                        size_t to_copy = remaining < space ? remaining : space;
                        memcpy((void *)&RAM0[bk_offset], (void *)&data[data_pos], to_copy);
                        media_offset += to_copy;
                        data_pos += to_copy;
                        remaining -= to_copy;
                    } else if (bk11_size > 0 && offset < bk12_start) {
                        // Copy to ROM_CARTRIDGE lower (BK11)
                        size_t bk_offset = offset - bk11_start;
                        size_t space = bk11_size - bk_offset;
                        size_t to_copy = remaining < space ? remaining : space;
                        memcpy((void *)&ROM_CARTRIDGE[bk_offset], (void *)&data[data_pos], to_copy);
                        media_offset += to_copy;
                        data_pos += to_copy;
                        remaining -= to_copy;
                    } else if (bk12_size > 0 && offset < bk21_start) {
                        // Copy to ROM_CARTRIDGE upper (BK12)
                        size_t bk_offset = offset - bk12_start;
                        size_t space = bk12_size - bk_offset;
                        size_t to_copy = remaining < space ? remaining : space;
                        memcpy((void *)&ROM_CARTRIDGE[BANK_SIZE + bk_offset], (void *)&data[data_pos], to_copy);
                        media_offset += to_copy;
                        data_pos += to_copy;
                        remaining -= to_copy;
                    } else if (bk21_size > 0 && offset < bk22_start) {
                        // Copy to RAM2 lower (BK21)
                        size_t bk_offset = offset - bk21_start;
                        size_t space = bk21_size - bk_offset;
                        size_t to_copy = remaining < space ? remaining : space;
                        memcpy((void *)&RAM2[bk_offset], (void *)&data[data_pos], to_copy);
                        media_offset += to_copy;
                        data_pos += to_copy;
                        remaining -= to_copy;
                    } else if (bk22_size > 0 && offset < bk31_start) {
                        // Copy to RAM2 upper (BK22)
                        size_t bk_offset = offset - bk22_start;
                        size_t space = bk22_size - bk_offset;
                        size_t to_copy = remaining < space ? remaining : space;
                        memcpy((void *)&RAM2[BANK_SIZE + bk_offset], (void *)&data[data_pos], to_copy);
                        media_offset += to_copy;
                        data_pos += to_copy;
                        remaining -= to_copy;
                    } else if (bk31_size > 0 && offset < bk32_start) {
                        // Copy to RAM3 lower (BK31)
                        size_t bk_offset = offset - bk31_start;
                        size_t space = bk31_size - bk_offset;
                        size_t to_copy = remaining < space ? remaining : space;
                        memcpy((void *)&RAM3[bk_offset], (void *)&data[data_pos], to_copy);
                        media_offset += to_copy;
                        data_pos += to_copy;
                        remaining -= to_copy;
                    } else if (bk32_size > 0 && offset < data_end) {
                        // Copy to RAM3 upper (BK32)
                        size_t bk_offset = offset - bk32_start;
                        size_t space = bk32_size - bk_offset;
                        size_t to_copy = remaining < space ? remaining : space;
                        memcpy((void *)&RAM3[BANK_SIZE + bk_offset], (void *)&data[data_pos], to_copy);
                        media_offset += to_copy;
                        data_pos += to_copy;
                        remaining -= to_copy;
                    } else {
                        // Beyond expected data, skip
                        break;
                    }
                }
                
                if (media_offset >= expected_total_size) {
                    send_response(tpcb, "FI");
                    log_message("Save state upload complete (%zu bytes, bank_config=0x%02X)", media_offset, bank_config);
                    pico_state = PICO_STATE_SAVE_STATE_READY;
                    command_in_progress = false;
                }
                break;
            }

            default:
                // Unexpected data received in non-receiving state, ignore
                break;
        }
    }

    tcp_recved(tpcb, p->len);
    pbuf_free(p);
    return ERR_OK;
}

err_t tcp_accept_callback(void *arg, struct tcp_pcb *new_pcb, err_t err) {
    (void)arg;
    (void)err;
    
    client_connected = true;
    log_message("Client connected");
    pico_state = PICO_STATE_CLIENT_CONNECTED;

    file_server_status = FILE_SERVER_CONNECTED_NO_LIST;

    server_pcb = new_pcb;

    tcp_recv(new_pcb, tcp_recv_callback);
    tcp_err(new_pcb, tcp_error_callback);
        
    return ERR_OK;
}

int tcp_server_setup() {
    struct netif *netif = &cyw43_state.netif[CYW43_ITF_STA];

    struct tcp_pcb *pcb = tcp_new_ip_type(IPADDR_TYPE_V4);
    if (!pcb) {
        log_message("Failed to create PCB");
        return -1;
    }

    err_t err = tcp_bind(pcb, &netif->ip_addr, TCP_PORT);
    if (err != ERR_OK) {
        log_message("TCP bind failed");
        return -1;
    }

    pcb = tcp_listen(pcb);
    tcp_accept(pcb, tcp_accept_callback);

    log_message("TCP server listening on %s port %d", ip4addr_ntoa(netif_ip4_addr(netif)), TCP_PORT);

    return ERR_OK;
}

void send_udp_broadcast() {
    struct netif *netif = &cyw43_state.netif[CYW43_ITF_STA];

    struct udp_pcb *udp = udp_new();
    if (!udp) {
        log_message("Failed to create UDP PCB");
        return;
    }

    ip_addr_t broadcast_addr = netif->ip_addr;
    ip4_addr_set_u32(&broadcast_addr, ip4_addr_get_u32(&broadcast_addr) | ~ip4_addr_get_u32(&netif->netmask));

    char msg[64];
    snprintf(msg, sizeof(msg), "SVI-3x8 PicoExpander hello! %c%c", pico_unique_id_chars[0], pico_unique_id_chars[1]);

    struct pbuf *pb = pbuf_alloc(PBUF_TRANSPORT, strlen(msg), PBUF_RAM);
    memcpy(pb->payload, msg, strlen(msg));

    udp_sendto(udp, pb, &broadcast_addr, UDP_BROADCAST_PORT);

    pbuf_free(pb);
    udp_remove(udp);
}
