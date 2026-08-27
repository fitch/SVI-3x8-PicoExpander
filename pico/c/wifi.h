/**
 * SVI-3x8 PicoExpander
 *
 * Copyright (c) 2026 Markus Rautopuro
 *
 * Works only with Raspberry Pico 2 W.
 */


void wifi_init(void);
int wifi_scan(const char *ssid_to_find);  // Returns auth_mode, or -1 if not found
void wait_for_ip();
void pico_set_led(bool led_on);

#define MEDIA_DISK_SIZE 360448 // Maximum disk size, rounded up to next CHUNK_SIZE (16384) bytes
#define MEDIA_DISK_OFFSET 0x3A4000 // FIXME: This could be pointed to __media_disk and - XIP_BASE

#define MEDIA_TAPE_SIZE 524288
#define MEDIA_TAPE_OFFSET 0x324000

void send_udp_broadcast();
