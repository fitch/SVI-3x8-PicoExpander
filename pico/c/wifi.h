/**
 * SVI-3x8 PicoExpander
 * 
 * Copyright (c) 2026 Markus Rautopuro
 * 
 * Works only with Raspberry Pico 2 W.
 */


void wait_for_ip(); 
void pico_set_led(bool led_on);
int tcp_server_setup();
void send_file_chunk_request();
void send_file_send_request();
void send_save_state_request();
void send_set_filter_request();
void send_hdd_read_request(uint32_t offset, uint16_t file_number, uint16_t length);
void send_hdd_write_request(uint32_t offset, uint16_t file_number, uint16_t length, volatile uint8_t *data);

extern bool client_connected;
extern struct tcp_pcb *server_pcb;
extern bool command_in_progress;

#define MEDIA_DISK_SIZE 360448 // Maximum disk size, rounded up to next CHUNK_SIZE (16384) bytes
#define MEDIA_DISK_OFFSET 0x3A4000 // FIXME: This could be pointed to __media_disk and - XIP_BASE

#define MEDIA_TAPE_SIZE 524288
#define MEDIA_TAPE_OFFSET 0x324000

void send_udp_broadcast();