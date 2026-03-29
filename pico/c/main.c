/**
 * SVI-3x8 PicoExpander
 * 
 * Copyright (c) 2026 Markus Rautopuro
 * 
 * Works only with Raspberry Pico 2 W.
 */

#include <stdio.h>
#include <string.h>

#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "pico/unique_id.h"
#include "hardware/vreg.h"
#include "hardware/clocks.h"
#include "hardware/flash.h"
#include "wifi.h"
#include "pico/cyw43_arch.h"
#include "pico/cyw43_driver.h"

#include "svi-328-expander-bus.h"
#include "media_control.h"
#include "log.h"

uint8_t pico_unique_id_chars[2] = {'?', '?'};

void error(int numblink) {
    while (true) {
        for (int i = 0; i < numblink; i++) {
            pico_set_led(true);
            sleep_ms(600);
            pico_set_led(false);
            sleep_ms(500);
        }
        sleep_ms(2000);
    }
}

#define PERSISTED_CONFIG_SIZE 4096
#define PERSISTED_CONFIG_OFFSET 0x3FC000
#define CONFIG_HEADER_MAGIC 0xDEADBEEF

extern const uint8_t __persisted_config[PERSISTED_CONFIG_SIZE];

int __not_in_flash_func(fetch_config)(void) {
    const uint8_t *stored_config = &__persisted_config[4 + SSID_MAX_LENGTH + PASSWORD_MAX_LENGTH];
    if (memcmp(stored_config, "FLASH", 5) == 0) {
        memcpy((void *)SVI_CONFIG, stored_config, SVI_CONFIG_SIZE);
    }

    if (*(uint32_t *)__persisted_config != CONFIG_HEADER_MAGIC) {
        return PICO_ERROR_GENERIC;
    }

    memcpy((void *)SSID, &__persisted_config[4], SSID_MAX_LENGTH);
    SSID[SSID_MAX_LENGTH] = '\0';

    memcpy((void *)Password, &__persisted_config[4 + SSID_MAX_LENGTH], PASSWORD_MAX_LENGTH);
    Password[PASSWORD_MAX_LENGTH] = '\0';


    log_message("Stored WiFi SSID found: [%s]", SSID);
    log_message("Stored WiFi Password found: [***] (length %zu)", strlen((void *)Password));

    return PICO_OK;
}

int __not_in_flash_func(store_config)(void) {
    uint8_t sector_buf[PERSISTED_CONFIG_SIZE] = {0};

    *(uint32_t *)sector_buf = CONFIG_HEADER_MAGIC;
    strncpy((char *)&sector_buf[4], (void *)SSID, SSID_MAX_LENGTH);
    strncpy((char *)&sector_buf[4 + SSID_MAX_LENGTH], (void *)Password, PASSWORD_MAX_LENGTH);
    memcpy(&sector_buf[4 + SSID_MAX_LENGTH + PASSWORD_MAX_LENGTH], (void *)SVI_CONFIG, SVI_CONFIG_SIZE);

    uint32_t ints = save_and_disable_interrupts();
    flash_range_erase(PERSISTED_CONFIG_OFFSET, sizeof(sector_buf));
    flash_range_program(PERSISTED_CONFIG_OFFSET, sector_buf, sizeof(sector_buf));
    restore_interrupts(ints);

    log_message("WiFi credentials stored to flash.");
    return PICO_OK;
}

int __not_in_flash_func(erase_wifi_credentials)(void) {
    uint8_t sector_buf[PERSISTED_CONFIG_SIZE] = {0};
    memcpy(&sector_buf[4 + SSID_MAX_LENGTH + PASSWORD_MAX_LENGTH], (void *)SVI_CONFIG, SVI_CONFIG_SIZE);

    uint32_t ints = save_and_disable_interrupts();
    flash_range_erase(PERSISTED_CONFIG_OFFSET, PERSISTED_CONFIG_SIZE);
    flash_range_program(PERSISTED_CONFIG_OFFSET, sector_buf, sizeof(sector_buf));
    restore_interrupts(ints);

    log_message("WiFi credentials erased from flash.");
    return PICO_OK;
}

#define CHECK_INTERVAL_US 500000  // 500 ms in microseconds
static uint32_t last_check_ts;
extern const uint8_t __media_disk[MEDIA_DISK_SIZE];
extern const uint8_t __media_tape[MEDIA_TAPE_SIZE];

int doorbell_fetch_disk_track;
int doorbell_flash_disk_track;
int doorbell_fetch_tape_track;
int doorbell_media_control;
int doorbell_file_server_request;
int doorbell_save_config;
int doorbell_flash_dump_disk;
int doorbell_hdd;

uint8_t disk_flash_buffer[8192]; // Shared buffer: track flash writes AND dump disk double-buffer (2 × 4096)

bool return_to_wifi_credentials = false;

void __not_in_flash_func(core0_doorbell)() {
    // FIXME: The doorbell handler core0_doorbell() runs as an interrupt handler (IRQ). But tcp_write() and tcp_output() are lwIP functions that must run in the main lwIP context (not from an ISR). Calling them from an ISR can corrupt lwIP's internal state
    if (multicore_doorbell_is_set_current_core(doorbell_fetch_disk_track)) {
        uint8_t track = register_track + side * 40;
        uint32_t track_size = track == 0 ? 18 * 128 : 17 * 256;
        uint32_t track_base = track == 0 ? 0 : track * 17 * 256 - 2048;

        memcpy((void *)DISK_TRACK, (void *)(&__media_disk[track_base]), track_size);

        DISK_TRACK_ready = true;           
        multicore_doorbell_clear_current_core(doorbell_fetch_disk_track);
    } else if (multicore_doorbell_is_set_current_core(doorbell_flash_disk_track)) {
        // TODO: REFACTOR - Flash when track is changing AND when disk is shut down

        uint8_t track = register_track + side * 40;
        uint32_t track_size = track == 0 ? 18 * 128 : 17 * 256;
        uint32_t track_base = track == 0 ? 0 : track * 17 * 256 - 2048;

        uint32_t last_boundary = track_base & ~(sizeof(disk_flash_buffer) - 1);
        uint32_t track_offset = track_base - last_boundary;

        memcpy((void *)disk_flash_buffer, (void *)(&__media_disk[last_boundary]), sizeof(disk_flash_buffer));
        memcpy((void *)(&disk_flash_buffer[track_offset]), (void *)DISK_TRACK, track_size);

        uint32_t ints = save_and_disable_interrupts();
        flash_range_erase(MEDIA_DISK_OFFSET + last_boundary, sizeof(disk_flash_buffer));
        flash_range_program(MEDIA_DISK_OFFSET + last_boundary, disk_flash_buffer, sizeof(disk_flash_buffer));
        restore_interrupts(ints);

        write_sector_mode = false;

        DISK_TRACK_ready = true;           
        multicore_doorbell_clear_current_core(doorbell_flash_disk_track);
    } else if (multicore_doorbell_is_set_current_core(doorbell_fetch_tape_track)) {
        memcpy((void *)TAPE_BUFFER, (void *)&__media_tape[tape_index], TAPE_BUFFER_SIZE);
        TAPE_BUFFER_ready = true;
        multicore_doorbell_clear_current_core(doorbell_fetch_tape_track);
    } else if (multicore_doorbell_is_set_current_core(doorbell_media_control)) {
        uint8_t cmd = doorbell_parameter_media_control_command;
        
        if (cmd & 0x80) {
            switch (cmd) {
                case MEDIA_CONTROL_APPLY_BIOS_PATCH:
                    apply_bios_patch();
                    break;
                case MEDIA_CONTROL_REVERT_BIOS_PATCH:
                    revert_bios_patch();
                    break;
            }
        } else {
            if (cmd & MEDIA_CONTROL_EJECT_DISK_0) {
                eject_disk_0();
            }
            if (cmd & MEDIA_CONTROL_EJECT_DISK_1) {
                eject_disk_1();
            }
            if (cmd & MEDIA_CONTROL_EJECT_CARTRIDGE) {
                eject_cartridge();
            }
            if (cmd & MEDIA_CONTROL_EJECT_TAPE) {
                eject_tape();
            }
            if (cmd & MEDIA_CONTROL_LOAD_BK11_TO_CARTRIDGE) {
                load_bk11_to_cartridge();
            }
            if (cmd & MEDIA_CONTROL_LOAD_BOOTSECTOR_TO_CARTRIDGE) {
                load_bootsector_to_cartridge();
            }
        }
        multicore_doorbell_clear_current_core(doorbell_media_control);
        doorbell_parameter_media_control_command = MEDIA_CONTROL_NONE;

    } else if (multicore_doorbell_is_set_current_core(doorbell_file_server_request)) {
        switch (doorbell_parameter_file_server_request_type) {
            case FILE_SERVER_REQUEST_FILE_CHUNK:
                send_file_chunk_request();
                break;
            case FILE_SERVER_REQUEST_FILE_SEND:
                send_file_send_request();
                break;
            case FILE_SERVER_REQUEST_SAVE_STATE:
                send_save_state_request();
                break;
            case FILE_SERVER_REQUEST_SET_FILTER:
                send_set_filter_request();
                break;
        }
        multicore_doorbell_clear_current_core(doorbell_file_server_request);
    } else if (multicore_doorbell_is_set_current_core(doorbell_save_config)) {
        store_config();
        multicore_doorbell_clear_current_core(doorbell_save_config);
    } else if (multicore_doorbell_is_set_current_core(doorbell_flash_dump_disk)) {
        // Flash one 4096-byte half of the disk_flash_buffer (used as dump disk double-buffer)
        uint32_t half_offset = dump_disk_flash_half * DUMP_DISK_SECTOR_SIZE;

        uint32_t ints = save_and_disable_interrupts();
        flash_range_erase(MEDIA_DISK_OFFSET + dump_disk_flash_offset, DUMP_DISK_SECTOR_SIZE);
        flash_range_program(MEDIA_DISK_OFFSET + dump_disk_flash_offset, &disk_flash_buffer[half_offset], DUMP_DISK_SECTOR_SIZE);
        restore_interrupts(ints);

        dump_disk_flash_offset += DUMP_DISK_SECTOR_SIZE;
        multicore_doorbell_clear_current_core(doorbell_flash_dump_disk);
    } else if (multicore_doorbell_is_set_current_core(doorbell_hdd)) {
        // HDD sector read/write request — flag only, TCP calls happen in main loop
        hdd_request_pending = true;
        multicore_doorbell_clear_current_core(doorbell_hdd);
    }
}

typedef struct {
    char ssid[33];
    int8_t rssi;
    uint8_t auth_mode;
} wifi_scan_result_t;

#define MAX_SCAN_RESULTS 32

static int found_ssid_auth_mode = -1;  // -1 means not found
static const char *target_ssid = NULL;
static volatile bool ssid_found = false;

static int scan_callback(void *env, const cyw43_ev_scan_result_t *result) {
    (void)env;
    if (result && target_ssid && !ssid_found) {
        if (result->ssid_len > 0 && strcmp((const char *)result->ssid, target_ssid) == 0) {
            found_ssid_auth_mode = result->auth_mode;
            ssid_found = true;
            log_message("Found target SSID '%s' (auth_mode=%d, rssi=%d)", result->ssid, result->auth_mode, result->rssi);
        }
    }
    return 0;
}

void wifi_init(void) {
    if (cyw43_arch_init() != PICO_OK) {
        pico_state = PICO_STATE_WIFI_ERROR;
        error(5);
    }
}

void perform_wifi_scan(const char *ssid_to_find) {
    cyw43_wifi_scan_options_t scan_options = {0};

    target_ssid = ssid_to_find;
    ssid_found = false;
    found_ssid_auth_mode = -1;

    for (int round = 0; round < 3 && !ssid_found; round++) {
        log_message("Starting Wi-Fi scan round %d for SSID '%s'...", round + 1, ssid_to_find);

        int err = cyw43_wifi_scan(&cyw43_state, &scan_options, NULL, scan_callback);
        if (err) {
            log_message("Wi-Fi scan failed to start: %d", err);
            continue;
        }

        absolute_time_t timeout = make_timeout_time_ms(10000);
        while (cyw43_wifi_scan_active(&cyw43_state) && !time_reached(timeout) && !ssid_found) {
            sleep_ms(10);
        }

        if (!ssid_found && cyw43_wifi_scan_active(&cyw43_state)) {
            log_message("Wi-Fi scan round %d timed out.", round + 1);
        }
    }

    if (!ssid_found) {
        log_message("Target SSID '%s' not found after scanning.", ssid_to_find);
    }

    target_ssid = NULL;
}

int __no_inline_not_in_flash_func(main)() {
    boot_time_us = HW_TIMESTAMP;
    log_message("Booting...");

    // Generate unique visible ASCII characters from Pico's flash serial number
    pico_unique_board_id_t board_id;
    pico_get_unique_board_id(&board_id);
    uint8_t hash1 = board_id.id[0] ^ board_id.id[2] ^ board_id.id[4] ^ board_id.id[6];
    uint8_t hash2 = board_id.id[1] ^ board_id.id[3] ^ board_id.id[5] ^ board_id.id[7];
    pico_unique_id_chars[0] = (hash1 % 94) + 0x21;
    pico_unique_id_chars[1] = (hash2 % 94) + 0x21;
    log_message("PicoExpander unique ID: %c%c", pico_unique_id_chars[0], pico_unique_id_chars[1]);

    vreg_set_voltage(VREG_VOLTAGE_1_20);
    set_sys_clock_khz(300000, true);
    cyw43_set_pio_clkdiv_int_frac8(4, 0); // Default divisor is 2

    gpio_init_mask(ALL_GPIO_MASK);
    gpio_set_dir_in_masked(ALL_GPIO_MASK);

    gpio_put(P_AE_PIN, 1); // Address read is enabled
    gpio_put(P_RD_DE_PIN, 0); // Data read is disabled
    gpio_put(P_WR_DE_PIN, 0); // Data write is disabled
    gpio_put(ROMDIS_PIN, 1); // Start with built-in BIOS ROM and RAM disabled
    gpio_put(RST_PIN, 0); // Start with /RST high
    gpio_set_dir(P_AE_PIN, GPIO_OUT);
    gpio_set_dir(P_RD_DE_PIN, GPIO_OUT);
    gpio_set_dir(P_WR_DE_PIN, GPIO_OUT);
    gpio_set_dir(ROMDIS_PIN, GPIO_OUT);
    gpio_set_dir(RST_PIN, GPIO_OUT);

    doorbell_fetch_disk_track = multicore_doorbell_claim_unused(0b01, true);
    doorbell_flash_disk_track = multicore_doorbell_claim_unused(0b01, true);
    doorbell_fetch_tape_track = multicore_doorbell_claim_unused(0b01, true);
    doorbell_media_control = multicore_doorbell_claim_unused(0b01, true);
    doorbell_file_server_request = multicore_doorbell_claim_unused(0b01, true);
    doorbell_save_config = multicore_doorbell_claim_unused(0b01, true);
    doorbell_flash_dump_disk = multicore_doorbell_claim_unused(0b01, true);
    doorbell_hdd = multicore_doorbell_claim_unused(0b01, true);

    // FIXME: Not sure if this irq2 != irq1 thing is necessary, but it seems to work
    uint32_t irq1 = multicore_doorbell_irq_num(doorbell_fetch_disk_track);
    irq_set_exclusive_handler(irq1, core0_doorbell);
    irq_set_enabled(irq1, true);

    uint32_t irq2 = multicore_doorbell_irq_num(doorbell_flash_disk_track);
    if (irq2 != irq1) {
        irq_set_exclusive_handler(irq2, core0_doorbell);
        irq_set_enabled(irq2, true);
    }

    uint32_t irq3 = multicore_doorbell_irq_num(doorbell_fetch_tape_track);
    if (irq3 != irq1 || irq3 != irq2) {
        irq_set_exclusive_handler(irq3, core0_doorbell);
        irq_set_enabled(irq3, true);
    }

    uint32_t irq4 = multicore_doorbell_irq_num(doorbell_media_control);
    if (irq4 != irq1 || irq4 != irq2 || irq4 != irq3) {
        irq_set_exclusive_handler(irq4, core0_doorbell);
        irq_set_enabled(irq4, true);
    }

    uint32_t irq5 = multicore_doorbell_irq_num(doorbell_file_server_request);
    if (irq5 != irq1 || irq5 != irq2 || irq5 != irq3 || irq5 != irq4) {
        irq_set_exclusive_handler(irq5, core0_doorbell);
        irq_set_enabled(irq5, true);
    }

    uint32_t irq6 = multicore_doorbell_irq_num(doorbell_save_config);
    if (irq6 != irq1 && irq6 != irq2 && irq6 != irq3 && irq6 != irq4 && irq6 != irq5) {
        irq_set_exclusive_handler(irq6, core0_doorbell);
        irq_set_enabled(irq6, true);
    }

    uint32_t irq7 = multicore_doorbell_irq_num(doorbell_flash_dump_disk);
    if (irq7 != irq1 && irq7 != irq2 && irq7 != irq3 && irq7 != irq4 && irq7 != irq5 && irq7 != irq6) {
        irq_set_exclusive_handler(irq7, core0_doorbell);
        irq_set_enabled(irq7, true);
    }

    uint32_t irq8 = multicore_doorbell_irq_num(doorbell_hdd);
    if (irq8 != irq1 && irq8 != irq2 && irq8 != irq3 && irq8 != irq4 && irq8 != irq5 && irq8 != irq6 && irq8 != irq7) {
        irq_set_exclusive_handler(irq8, core0_doorbell);
        irq_set_enabled(irq8, true);
    }

    multicore_launch_core1(core1_entry);

    wifi_init();
    stdio_usb_init();
    /*
    while (!stdio_usb_connected()) {
        sleep_ms(100);
    }
    */
    pico_set_led(true);

    log_message("SVI-3x8 PicoExpander version %s (%s)", VERSION, BUILD_DATE);

    if (fetch_config() != PICO_OK) {
        log_message("No stored WiFi credentials found.");
        log_message("Waiting for WiFi credentials...");

rewait_for_wifi_credentials:
        pico_state = PICO_STATE_WAITING_CREDENTIALS;
        while (pico_state != PICO_STATE_CREDENTIALS_RECEIVED) {
            sleep_ms(10);
        }

        log_message("WiFi SSID received: [%s]", SSID);
        log_message("WiFi Password received: [%s]", Password);

        store_config();
    } 
    pico_state = PICO_STATE_CREDENTIALS_STORED;
    pico_set_led(false);
    pico_state = PICO_STATE_WIFI_CONNECTING;

    log_message("Starting blocking Wi-Fi scan...");
    network_status = NETWORK_STATUS_CONNECTING;
    cyw43_arch_enable_sta_mode();
    perform_wifi_scan((char *)SSID);

    log_message("Connecting to WiFi SSID [%s]...", SSID);
    uint32_t auth = CYW43_AUTH_WPA2_AES_PSK;
    switch (found_ssid_auth_mode) {
        case 0:
            log_message("SSID auth mode: OPEN");
            auth = CYW43_AUTH_OPEN;
            break;
        case 5:
            log_message("SSID auth mode: WPA2_AES_PSK");
            auth = CYW43_AUTH_WPA2_AES_PSK;
            break;
        case -1:
            log_message("SSID wasn't found in scanning, defaulting to WPA2_AES_PSK");
            break;
        default:
            log_message("SSID auth mode unknown (%d), defaulting to WPA2_AES_PSK", found_ssid_auth_mode);
            break;
    }

    int ret = cyw43_arch_wifi_connect_timeout_ms((char *)SSID, (char *)Password, auth, 30000);
    if (ret != PICO_OK) {
        int blink_count;

        network_status = NETWORK_STATUS_ERROR;
        file_server_status = FILE_SERVER_NOT_CONNECTED;

        log_message("WiFi SSID used: [%s]", SSID);
        log_message("WiFi Password used: [%s]", Password); // FIXME: Warning, will expose password

        switch (ret) {
            case PICO_ERROR_TIMEOUT:
                log_message("WiFi connection timed out.");
                erase_wifi_credentials();

                pico_state = PICO_STATE_WIFI_TIMEOUT;
                log_message("Waiting again for WiFi credentials...");
                goto rewait_for_wifi_credentials; // Retry fetching credentials
                break;
            case PICO_ERROR_BADAUTH:
                log_message("WiFi connection failed due to bad authentication.");
                erase_wifi_credentials();

                pico_state = PICO_STATE_WIFI_BAD_AUTH;
                log_message("Waiting again for WiFi credentials...");
                goto rewait_for_wifi_credentials; // Retry fetching credentials
                break;
            case PICO_ERROR_CONNECT_FAILED:
                log_message("WiFi connection failed.");
                blink_count = 3;
                break; 
            default:
                log_message("WiFi connection failed with unknown error code: %d", ret);
                blink_count = 4;
                break;
        }
        pico_state = PICO_STATE_DUMP_LOG;
        erase_wifi_credentials();
        error(blink_count);
    }

    network_status = NETWORK_STATUS_CONNECTED;

    pico_state = PICO_STATE_WIFI_CONNECTED;
    log_message("WiFi connected to access point.");
    wait_for_ip();
    tcp_server_setup();

    last_check_ts = HW_TIMESTAMP;
    bool led_on = true;
    pico_set_led(led_on);

    // FIXME: Do we need to check in this loop if WiFi is still connected?
    while (true) {
        uint32_t now = HW_TIMESTAMP;

        if (return_to_wifi_credentials) {
            return_to_wifi_credentials = false;
            erase_wifi_credentials();
            cyw43_arch_deinit();
            wifi_init();
            network_status = NETWORK_STATUS_NOT_CONNECTED;
            file_server_status = FILE_SERVER_NOT_CONNECTED;

            log_message("Waiting again for WiFi credentials...");
            goto rewait_for_wifi_credentials; // Retry fetching credentials
        }

        if ((uint32_t)(now - last_check_ts) >= CHECK_INTERVAL_US) {
            last_check_ts = now;

            if (!client_connected) {
                led_on = !led_on;
                pico_set_led(led_on);

                send_udp_broadcast();
            } else {
                if (!led_on) {
                    led_on = true;
                    pico_set_led(led_on);
                }
            }
        }

        if (hdd_request_pending) {
            hdd_request_pending = false;
            if (hdd_op_type == HDD_OP_READ) {
                send_hdd_read_request(hdd_request_lba, 0, 256);
            } else {
                send_hdd_write_request(hdd_request_lba, 0, 256, HDD_WRITE_SECTOR);
            }
        }

        cyw43_arch_poll();
        sleep_ms(1);
    }
}
