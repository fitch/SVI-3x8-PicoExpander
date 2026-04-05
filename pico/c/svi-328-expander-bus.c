/**
 * SVI-3x8 PicoExpander
 * 
 * Copyright (c) 2026 Markus Rautopuro
 * 
 * Works only with Raspberry Pico 2 W.
 */

#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "hardware/structs/bus_ctrl.h"

#include "svi-328-expander-bus.h"
#include "wifi.h"
#include "log.h"

#include "launcher_bk4x.h"
#include "injectboot.h"
#include "prepare.h"
#include "media_control.h"
extern int doorbell_hdd;

#define WAIT_IORQ_HIGH() do { while (!gpio_get(IORQ_PIN)) { tight_loop_contents(); } } while(0)
#define WAIT_IORQ_LOW() do { while (gpio_get(IORQ_PIN)) { tight_loop_contents(); } } while(0)
#define WAIT_MREQ_HIGH() do { while (!gpio_get(MREQ_PIN)) { tight_loop_contents(); } } while(0)
#define WAIT_MREQ_LOW() do { while (gpio_get(MREQ_PIN)) { tight_loop_contents(); } } while(0)
#define WAIT_RD_LOW() do { while (gpio_get(RD_PIN)) { tight_loop_contents(); } } while(0)
#define WAIT_WR_HIGH() do { while (!gpio_get(WR_PIN)) { tight_loop_contents(); } } while(0)

#define WAIT_RD_OR_WR_LOW_AND_READ_PINS(is_rd, is_wr, pins) \
    uint32_t pins; \
    do { \
        pins = gpio_get_all(); \
        (is_rd) = !(pins & RD_GPIO_MASK); \
        (is_wr) = !(pins & WR_GPIO_MASK); \
    } while (!((is_rd) || (is_wr)))

#define WAIT_IORQ_OR_MREQ_LOW(is_iorq, is_mreq) do { \
    do { \
        (is_iorq) = gpio_get(IORQ_PIN) == 0; \
        (is_mreq) = gpio_get(MREQ_PIN) == 0; \
    } while (!((is_iorq) || (is_mreq))); \
} while(0)

#define IF_WR_READ_DATA_PINS() if (is_wr) { \
    gpio_set_dir_in_masked(DATA_PIN_MASK); \
    gpio_put_masked(P_RD_DE_GPIO_MASK | P_WR_DE_GPIO_MASK | P_AE_GPIO_MASK, P_RD_DE_GPIO_MASK); \
}

#define WRITE_DATA_PINS(value) do { \
    gpio_set_dir_out_masked(DATA_PIN_MASK); \
    gpio_put_masked(DATA_PIN_MASK | P_RD_DE_GPIO_MASK | P_WR_DE_GPIO_MASK | P_AE_GPIO_MASK, ((uint32_t)(value)) << 8 | P_WR_DE_GPIO_MASK); \
} while(0)

#define READ_ADDRESS_PINS() do { \
    gpio_set_dir_in_masked(ADDRESS_PIN_MASK); \
    gpio_put_masked(P_RD_DE_GPIO_MASK | P_WR_DE_GPIO_MASK | P_AE_GPIO_MASK, P_AE_GPIO_MASK); \
} while(0)

#define TIME_CRITICAL_INLINE static inline __attribute__((always_inline, section(".time_critical")))

// RAM4 save state area addresses (matching rom/asm/constants.asm)
#define SAVE_VRAM    0xB000  // - 0xEFFF: VRAM backup
#define SAVE_VDP     0xF000  // - 0xF007: VDP registers
#define SAVE_VRAM_P  0xF008  // - 0xF009: VDP address pointer
#define SAVE_SP      0xF00A  // - 0xF00B: Stack pointer
#define SAVE_PPI     0xF00C  // - 0xF00F: PPI registers
#define SAVE_PSG     0xF010  // - 0xF01F: PSG registers
#define SAVE_PSG_R15 0xF01F  // PSG register 15 (last byte of SAVE_PSG)

#define MENU_STATE_IN_MENU_BIT      0x01  // b0
#define MENU_STATE_REENTER_BIT      0x02  // b1 (not touched by Pico)
#define MENU_STATE_WAITING_BIT      0x04  // b2

TIME_CRITICAL_INLINE void* ram_memcpy(void* dest, const void* src, size_t n) {
    uint8_t* d = (uint8_t*)dest;
    const uint8_t* s = (const uint8_t*)src;
    while (n--) {
        *d++ = *s++;
    }
    return dest;
}

TIME_CRITICAL_INLINE void* ram_memset(void* s, int c, size_t n) {
    uint8_t* p = (uint8_t*)s;
    uint8_t val = (uint8_t)c;
    while (n--) {
        *p++ = val;
    }
    return s;
}

TIME_CRITICAL_INLINE size_t ram_strlen(const char* s) {
    size_t len = 0;
    while (*s++) {
        len++;
    }
    return len;
}

#define memcpy ram_memcpy
#define memset ram_memset
#define strlen ram_strlen

volatile hw_log_entry_t hw_log_buffer[HW_LOG_MAX_ENTRIES];
volatile uint32_t hw_log_index = 0;

#define hw_log(x_op) do { \
    uint32_t idx = hw_log_index; \
    if (__builtin_expect(idx < HW_LOG_MAX_ENTRIES, 1)) { \
        hw_log_index = idx + 1; \
        hw_log_buffer[idx].timestamp = HW_TIMESTAMP; \
        hw_log_buffer[idx].op = (x_op); \
    } \
} while(0)

#define hw_log_value(x_op, x_value) do { \
    uint32_t idx = hw_log_index; \
    if (__builtin_expect(idx < HW_LOG_MAX_ENTRIES, 1)) { \
        hw_log_index = idx + 1; \
        hw_log_buffer[idx].timestamp = HW_TIMESTAMP; \
        hw_log_buffer[idx].op = (x_op); \
        hw_log_buffer[idx].value = (x_value); \
    } \
} while(0)

/*
#define hw_log(x_op) (void)0
#define hw_log_value(x_op, x_value) (void)0
*/

#define MAX_WRITE_RECORD 256

volatile unsigned char SSID[SSID_MAX_LENGTH + 1];
volatile unsigned char Password[PASSWORD_MAX_LENGTH + 1];

volatile uint8_t SVI_CONFIG[SVI_CONFIG_SIZE] = { // NOTE: These defaults are also defined in rom/mainram.asm (FLASH_DEFAULTS)
    'F', 'L', 'A', 'S', 'H',  // Magic header
    0,                        // Version ID (VER_ID)
    PICO_ENABLED,             // Music enabled (MUSIC_ENA)
    PICO_ENABLED,             // Boot-up intro sequence enabled (INTRO_ENA)
    1,                        // FIXME: Old save state size - need to remove this (and recalculate checksum)
    PICO_ENABLED,             // Hide password (HIDE_PASS)
    0, 0, 0, 0, 0,            // Reserved
    0xAC                      // Checksum (calculated by CALC_CHECKSUM algorithm, you need to change this if you change the default values)
};
volatile unsigned char save_state_filename[SAVE_STATE_FILENAME_MAX_LENGTH + 1] = "saved_state";

volatile unsigned char write_record[MAX_WRITE_RECORD];
volatile unsigned int write_index = 0;
volatile write_mode_t write_mode = WRITE_MODE_TERMINATE;
volatile pico_state_t pico_state = PICO_STATE_UNKNOWN;

volatile network_status_t network_status = NETWORK_STATUS_NOT_CONNECTED;
volatile file_server_status_t file_server_status = FILE_SERVER_NOT_CONNECTED;

/**
 * I/O emulation
 */

volatile uint8_t BIOS[32768] = {[0 ... sizeof(BIOS)-1] = 0xff}; // BK01 BASIC BIOS ROM
volatile uint8_t ROM_CARTRIDGE[65536] = {[0 ... sizeof(ROM_CARTRIDGE)-1] = 0xff}; // BK11 and BK12 Cartridge ROM
volatile uint8_t RAM0[32768] = {[0 ... sizeof(RAM0)-1] = 0xff}; // BK02 
volatile uint8_t RAM2[65536] = {[0 ... sizeof(RAM2)-1] = 0xff}; // BK21 and BK22
volatile uint8_t RAM3[65536] = {[0 ... sizeof(RAM3)-1] = 0xff}; // BK31 and BK32
volatile uint8_t RAM4[65536] = {[0 ... sizeof(RAM4)-1] = 0xff}; // BK41 and BK42
volatile uint8_t BK11[32768] = {[0 ... sizeof(BK11)-1] = 0xff}; // Real BK11 contents captured (32 kB cartridge ROM)

volatile uint8_t *LOWER_BANK; // Points to whatever is currently in the lower bank
volatile bool lower_bank_is_ROM;
volatile uint8_t *UPPER_BANK; // Points to whatever is currently in the upper bank
volatile bool upper_bank_is_ROM;

typedef struct {
    uint8_t *lower_bank;
    uint8_t *upper_bank;
    bool lower_is_rom;
    bool upper_is_rom;
    uint8_t cart_type;
} bank_config_t;

volatile bank_config_t bank_lookup_table[256];

volatile inject_type_t inject_type;

volatile bool skip_ram4_init = false; // Gets overridden when a BK4X is uploaded

volatile bool psg_register_15_selected;
volatile bool bios_floppy_test_completed;
volatile bool log_disk_track_not_ready_once; 
volatile bool fdc_emulation_enabled;

volatile uint8_t CART_type;

volatile uint8_t register_sector;
volatile uint8_t register_track;
volatile uint8_t density;
volatile uint8_t side;
volatile uint8_t drive_status;

volatile uint8_t DISK_TRACK[17*256];
volatile bool DISK_TRACK_ready;
volatile uint32_t disk_size;

volatile uint32_t dump_disk_index;        // Current write position within dump disk buffer
volatile uint32_t dump_disk_flash_offset; // Current flash write offset from MEDIA_DISK_OFFSET
volatile bool dump_disk_active;           // Whether a dump is in progress
volatile uint8_t dump_disk_flash_half;    // Which half (0 or 1) to flash

volatile uint32_t tape_index;
volatile uint8_t TAPE_BUFFER[TAPE_BUFFER_SIZE];
volatile bool TAPE_BUFFER_ready;
volatile uint32_t tape_size;

volatile uint8_t repeat_status_0x04_count;
volatile bool read_sector_mode;
volatile bool write_sector_mode;
volatile uint32_t sector_index;
volatile uint8_t last_data;

volatile uint8_t psg_register_15;

volatile uint8_t ppi_registers[4];

volatile uint8_t vdp_registers[8];
volatile uint8_t vdp_first_byte;
volatile bool vdp_expecting_second_byte;
volatile uint16_t vdp_address;

volatile uint8_t * const menu_state = &RAM4[MENU_STATE_ADDRESS];
volatile bool short_press_boot_enabled;
volatile bool short_press_boot_pressed;
volatile uint32_t menu_entrance_counter;

extern int doorbell_fetch_disk_track;
extern int doorbell_flash_disk_track;
extern int doorbell_fetch_tape_track;
extern int doorbell_media_control;
extern int doorbell_erase_credentials;
extern int doorbell_file_server_request;
extern int doorbell_save_config;
extern int doorbell_flash_dump_disk;

volatile media_control_command_t doorbell_parameter_media_control_command;
volatile file_server_request_type_t doorbell_parameter_file_server_request_type;

volatile uint16_t dump_log_index = 0;

volatile uint8_t FILE_CACHE[FILE_CACHE_SIZE * FILE_ENTRY_SIZE];
volatile uint16_t file_cache_start_index;
volatile uint16_t file_cache_count;
volatile uint16_t file_cache_request_index;
volatile uint8_t file_type_filter;

volatile uint16_t server_file_count = 0;
volatile uint16_t file_index_request = 0;
volatile uint8_t file_name_read_index = 0;
volatile file_request_status_t file_request_status = FILE_REQUEST_STATUS_NOT_READY;

volatile uint32_t timer_stored;
volatile uint32_t timer_reset;

#define SASI_PHASE_BUS_FREE  0x00
#define SASI_PHASE_COMMAND   0x0B
#define SASI_PHASE_DATA_OUT  0x03
#define SASI_PHASE_DATA_IN   0x13
#define SASI_PHASE_STATUS    0x1B
#define SASI_PHASE_MSG_IN    0x1F

volatile uint8_t  sasi_phase;
volatile uint8_t  sasi_cdb[6];
volatile uint8_t  sasi_cdb_index;
volatile uint32_t sasi_data_offset;
volatile uint32_t sasi_data_remaining;
volatile uint8_t  sasi_status_byte;
volatile uint8_t  sasi_message_byte;
volatile uint8_t  sasi_port_63h_latch;
volatile bool     sasi_enabled;

volatile uint8_t HDD_READ_SECTOR[256];
volatile uint8_t HDD_WRITE_SECTOR[256];
volatile uint32_t hdd_read_sector_lba;
volatile uint32_t hdd_write_sector_lba;
volatile uint32_t hdd_request_lba;
volatile uint32_t hdd_total_lbas;
volatile bool hdd_read_sector_valid;
volatile bool hdd_op_complete;
volatile uint8_t hdd_op_type;
volatile bool hdd_request_pending;
volatile uint16_t hdd_sectors_remaining;
volatile uint16_t sasi_sector_offset;
volatile uint32_t current_write_lba;

static uint8_t inject_revert_register_15[] = {
    0x77, 0x3e, 0xff, 
    0xd3, 0x88, 0x7e, 0x00 /* Replaced with A register */, 0x18, 0xf8
};

static uint8_t inject_caps_lock[] = {
    0x77, 0x3e, 0x0f, 0xd3, 0x88, 0x3e, 0x00 /* psg_register_15 | 0b11011111 */, 0xd3, 0x8c, 
    0x3e, 0xff, 0xd3, 0x88, 0x7e, 0x00 /* Replaced with A */, 0x18, 0xf0
};

static uint8_t inject_case_0x90[] = {0x3e, 0x00, 0x18, 0xfc};
static uint8_t inject_case_0xa2[] = {0x2b, 0x36, 0x00, 0x23, 0x18, 0xfa};
static uint8_t inject_case_0xaa[] = {0x23, 0x36, 0x00, 0x2b, 0x18, 0xfa};
static uint8_t inject_case_in_xy[] = {0x00, 0x00, 0x18, 0xfc};

#define BK32 0b00010000
#define BK22 0b00000100
#define BK31 0b00001000
#define BK21 0b00000010
#define CART 0b00000001
#define BK42 (BK32 | BK22)
#define BK41 (BK31 | BK21)
#define CAPS_LOCK 0b00100000

static void __no_inline_not_in_flash_func(initialize_bank_lookup_table)() {
    for (uint16_t reg15 = 0; reg15 < 256; reg15++) {
        bank_config_t *config = (bank_config_t *)&bank_lookup_table[reg15];
        
        if (~reg15 & CART) { // CART is low
            config->cart_type = (~reg15 & 0b11000000) ? 0x02 : 0x01; // 0x02 = 64 kB, 0x01 = 32 kB
            config->lower_bank = (uint8_t *)ROM_CARTRIDGE;
            config->lower_is_rom = true;
            
            if (config->cart_type == 0x02) { // In 64 kB CART mode, the upper bank is also ROM
                config->upper_bank = (uint8_t *)&ROM_CARTRIDGE[0x8000];
                config->upper_is_rom = true;
            } else {
                if ((~reg15 & BK42) == BK42) {
                    config->upper_bank = (uint8_t *)&RAM4[0x8000];
                } else if (~reg15 & BK32) {
                    config->upper_bank = (uint8_t *)&RAM3[0x8000];
                } else if (~reg15 & BK22) {
                    config->upper_bank = (uint8_t *)&RAM2[0x8000];
                } else {
                    config->upper_bank = (uint8_t *)RAM0; // Default to BK02 RAM
                }
                config->upper_is_rom = false;
            }
        } else {
            config->cart_type = 0x00; // No cartridge
            
            if ((~reg15 & BK42) == BK42) {
                config->upper_bank = (uint8_t *)&RAM4[0x8000];
            } else if (~reg15 & BK32) {
                config->upper_bank = (uint8_t *)&RAM3[0x8000];
            } else if (~reg15 & BK22) {
                config->upper_bank = (uint8_t *)&RAM2[0x8000];
            } else {
                config->upper_bank = (uint8_t *)RAM0; // Default to BK02 RAM
            }
            config->upper_is_rom = false;
            
            if ((~reg15 & BK41) == BK41) {
                config->lower_bank = (uint8_t *)RAM4;
                config->lower_is_rom = false;
            } else if (~reg15 & BK31) {
                config->lower_bank = (uint8_t *)RAM3;
                config->lower_is_rom = false;
            } else if (~reg15 & BK21) {
                config->lower_bank = (uint8_t *)RAM2;
                config->lower_is_rom = false;
            } else {
                config->lower_bank = (uint8_t *)BIOS; // Default to BASIC BIOS
                config->lower_is_rom = true;
            }
        }
    }
}

extern uint8_t pico_unique_id_chars[2];

void __no_inline_not_in_flash_func(launcher_initialization)() {
    if (!skip_ram4_init) {
        memcpy((void *)RAM4, (void *)LAUNCHER_BK4X, LAUNCHER_BK4X_len);
    }

    *(uint16_t *)&RAM4[DEVICE_ID_ADDRESS] = *(uint16_t *)pico_unique_id_chars;
}

void __no_inline_not_in_flash_func(boot_initialization)() {
    doorbell_parameter_media_control_command = MEDIA_CONTROL_EJECT_CARTRIDGE;
    multicore_doorbell_set_other_core(doorbell_media_control);

    disk_size = 0;
    DISK_TRACK_ready = true;

    tape_size = 0;
    TAPE_BUFFER_ready = true;

    LOWER_BANK = BIOS; // Initially, the lower bank is the BIOS
    UPPER_BANK = RAM0; // And the upper bank is BK02 RAM
    lower_bank_is_ROM = true;

    psg_register_15_selected = false;
    bios_floppy_test_completed = false;
    log_disk_track_not_ready_once = false;
    CART_type = 0x00;

    register_sector = 0;
    register_track = 0;
    density = 0;
    side = 0;
    drive_status = 0;

    repeat_status_0x04_count = 2; // BIOS needs to read 0x04 twice before it can read 0x06
    read_sector_mode = false;
    write_sector_mode = false;
    sector_index = 0;
    last_data = 0;

    psg_register_15 = 0xdf; // CAPS LOCK off by prepare code
    tape_index = 0;

    short_press_boot_enabled = false;
    short_press_boot_pressed = false;
    menu_entrance_counter = 0;

    bios_patched = false;

    timer_stored = 0;
    timer_reset = 0;

    file_cache_start_index = 0xffff; // Invalid marker, waiting for first chunk
    file_cache_request_index = 0; // First cache request is from index 0 if not specified
    file_cache_count = 0;
    file_type_filter = 0xff; // Force server filter sync on next catalog request

    // Note: fdc_emulation_enabled is NOT reset here — it was set by prepare.asm
    // during initial boot and must be preserved across long-press reboots.

    sasi_phase = SASI_PHASE_BUS_FREE;
    sasi_cdb_index = 0;
    sasi_data_offset = 0;
    sasi_data_remaining = 0;
    sasi_status_byte = 0;
    sasi_message_byte = 0;
    sasi_port_63h_latch = 0;
    sasi_enabled = true;

    hdd_total_lbas = 0; // No image loaded yet — set by HI command
    hdd_read_sector_valid = false;
    hdd_op_complete = false;
    hdd_request_pending = false;
    hdd_sectors_remaining = 0;
    sasi_sector_offset = 0;
    current_write_lba = 0;

    hw_log(HW_LOG_HDD_INIT);

    initialize_bank_lookup_table();
}

void __no_inline_not_in_flash_func(prepare)() {
    hw_log(HW_LOG_INIT_PREPARE);
    bool cpu_ready_at_0x0000 = false;
    bool serve_prepare = true;
    int romdis_pin = 1;
    while (inject_type == INJECT_TYPE_PREPARE) {
        bool is_iorq, is_mreq, is_rd, is_wr;

        WAIT_RD_OR_WR_LOW_AND_READ_PINS(is_rd, is_wr, pins);
        IF_WR_READ_DATA_PINS();
        WAIT_IORQ_OR_MREQ_LOW(is_iorq, is_mreq);

        if (is_iorq) { // I/O operation
            uint8_t value = 0;
            bool write_to_data_pins = false;

            if (is_wr) { // WR is low, so prepare to read data pins
                value = (uint8_t)((gpio_get_all() & DATA_PIN_MASK) >> 8);
            } else {
                gpio_put(P_AE_PIN, 0);
            }

            switch (pins & IORQ_PORT_PIN_MASK) {
                case 0x13: 
                    if (is_wr) { // Pico command
                        hw_log_value(HW_LOG_PICO_COMMAND, value);
                        switch (value) {
                            case WRITE_MODE_BIOS:
                                write_index = 0;
                                write_mode = value;
                                break;
                            case WRITE_MODE_32KB_ROM:
                                write_index = 0;
                                write_mode = value;
                                break;
                            case WRITE_MODE_TERMINATE:
                                if (write_mode == WRITE_MODE_BIOS) {
                                    hw_log(HW_LOG_BIOS_WRITTEN);
                                    romdis_pin = 1; // Drop built-in ROM and switch to just uploaded BIOS
                                    inject_type = INJECT_TYPE_NONE;
                                } else if (write_mode == WRITE_MODE_32KB_ROM) {
                                    hw_log(HW_LOG_32KB_ROM_WRITTEN);
                                }
                                write_mode = value;
                                break;
                            case COMMAND_STOP_SERVING_PREPARE:
                                serve_prepare = false;
                                romdis_pin = 0; // Now executing in higher bank, enable BIOS ROM
                                break;
                            case COMMAND_CLEAR_HARDWARE_LOG:
                                hw_log_index = 0;
                                hw_log_buffer[HW_LOG_MAX_ENTRIES - 1].timestamp = 0;
                                hw_log(HW_LOG_CLEAR);
                                break;
                        }
                    }
                    break;
                case 0x14: // Pico data
                    if (is_wr) {
                        if (write_mode == WRITE_MODE_BIOS && write_index < sizeof(BIOS)) {
                            BIOS[write_index++] = value;
                        } else if (write_mode == WRITE_MODE_32KB_ROM && write_index < 32768) {
                            BK11[write_index++] = value;
                        }
                    }
                    break;
                case 0x17: // Debug
                    if (is_wr) {
                        hw_log_value(HW_LOG_DEBUG, value);
                    }
                    break;
            }

            if (write_to_data_pins) {
                WRITE_DATA_PINS(value);
            }

            WAIT_IORQ_HIGH();
        } else { // It's a MREQ operation
            uint8_t value = 0;

            uint32_t addr = pins & ADDRESS_PIN_MASK;

            if (!cpu_ready_at_0x0000) {
                hw_log_value(HW_LOG_MREQ_PREPARE_RD, addr);
                value = 0xc7; // rst 00h
                if (addr == 0x0000) {
                    cpu_ready_at_0x0000 = true;
                }
                WRITE_DATA_PINS(value);
            } else if (is_rd) { // MREQ RD
                if (addr < 0x8000) { // Lower bank
                    if (serve_prepare) {
                        value = BIOS[addr]; // prepare.asm contents
                        WRITE_DATA_PINS(value);
                    }
                } else { // Upper bank
                    value = RAM0[addr & 0x7fff];
                    WRITE_DATA_PINS(value);
                }
            } else { // MREQ WR
                if (addr >= 0x8000) {
                    value = (uint8_t)((gpio_get_all() & DATA_PIN_MASK) >> 8);
                    RAM0[addr & 0x7fff] = value;
                }
            }

            WAIT_MREQ_HIGH();
        }
        READ_ADDRESS_PINS();
        gpio_put(ROMDIS_PIN, romdis_pin);
    }
}

TIME_CRITICAL_INLINE void update_banks() {
    const volatile bank_config_t *config = &bank_lookup_table[psg_register_15];
    LOWER_BANK = config->lower_bank;
    UPPER_BANK = config->upper_bank;
    lower_bank_is_ROM = config->lower_is_rom;
    upper_bank_is_ROM = config->upper_is_rom;
    CART_type = config->cart_type;
}

void __no_inline_not_in_flash_func(floppy_and_ram_emulation)() {
    hw_log(HW_LOG_INIT_MAIN);
    uint8_t last_mreq_value = 0x00;
    
    uint32_t reset_button_press_counter = 0;
    const uint32_t RESET_BUTTON_THRESHOLD = 2685000; // ~3 seconds
    const uint32_t MENU_ENTRANCE_TIMEOUT = 268500; // ~0.3 seconds

    uint16_t sector_size = 0;
    uint32_t sector_base = 0;
    uint8_t kbd_last_row6 = 0xFF;
    bool kbd_combo_monitoring = false;    // Start inactive, activate when all keys released (0xFF)

    while (inject_type == INJECT_TYPE_NONE) {
        bool is_iorq, is_mreq, is_rd, is_wr;

        WAIT_RD_OR_WR_LOW_AND_READ_PINS(is_rd, is_wr, pins);
        IF_WR_READ_DATA_PINS();
        WAIT_IORQ_OR_MREQ_LOW(is_iorq, is_mreq);

        if (is_iorq) { // I/O operation
            uint8_t value = 0;
            bool write_to_data_pins = false;

            if (is_wr) { // WR is low, so prepare to read data pins
                value = (uint8_t)((gpio_get_all() & DATA_PIN_MASK) >> 8);
            } else {
                gpio_put(P_AE_PIN, 0);
            }

            switch (pins & IORQ_PORT_PIN_MASK) {
                case 0x13:
                    if (is_rd) { // Pico state
                        value = pico_state;
                        // hw_log_value(HW_LOG_RD_PICO_STATE, value);
                        write_to_data_pins = true;
                    } else { // Pico command
                        hw_log_value(HW_LOG_PICO_COMMAND, value);
                        switch (value) {
                            case WRITE_MODE_CREDENTIALS:
                                write_index = 0;
                                write_mode = value;
                                break;
                            case WRITE_MODE_SAVE_STATE:
                                write_index = 0;
                                write_mode = value;
                                break;
                            case WRITE_MODE_TERMINATE:
                                if (write_mode == WRITE_MODE_CREDENTIALS) {
                                    memcpy((void*)SSID, (void*)write_record, SSID_MAX_LENGTH);
                                    memcpy((void*)Password, (void*)&write_record[SSID_MAX_LENGTH], PASSWORD_MAX_LENGTH);
                                    hw_log(HW_LOG_CREDENTIALS_RECEIVED);
                                    write_index = 0;
                                    pico_state = PICO_STATE_CREDENTIALS_RECEIVED;
                                } else if (write_mode == WRITE_MODE_SAVE_STATE) {
                                    if (write_index > 0) {
                                        memcpy((void*)save_state_filename, (void*)write_record, write_index);
                                        save_state_filename[write_index] = '\0';
                                    }
                                    hw_log(HW_LOG_SAVE_STATE_REQUESTED);
                                    write_index = 0;
                                    doorbell_parameter_file_server_request_type = FILE_SERVER_REQUEST_SAVE_STATE;
                                    multicore_doorbell_set_other_core(doorbell_file_server_request);
                                } else if (write_mode == COMMAND_DUMP_DISK && dump_disk_active) {
                                    // Flush remaining data in the buffer
                                    uint32_t pos_in_buffer = dump_disk_index & (DUMP_DISK_BUFFER_SIZE - 1);
                                    if (pos_in_buffer > 0) {
                                        uint32_t half_start = pos_in_buffer & ~(DUMP_DISK_SECTOR_SIZE - 1);
                                        for (uint32_t i = pos_in_buffer; i < half_start + DUMP_DISK_SECTOR_SIZE; i++) {
                                            disk_flash_buffer[i] = 0xFF;
                                        }
                                        dump_disk_flash_half = (pos_in_buffer < DUMP_DISK_SECTOR_SIZE) ? 0 : 1;
                                        multicore_doorbell_set_other_core(doorbell_flash_dump_disk);
                                    }
                                    dump_disk_active = false;
                                    disk_size = dump_disk_index;
                                }
                                write_mode = value;
                                break;
                            case COMMAND_DUMP_DISK:
                                write_mode = value;
                                write_index = 0;
                                break;
                            case COMMAND_PATCH_BIOS:
                                doorbell_parameter_media_control_command = MEDIA_CONTROL_APPLY_BIOS_PATCH;
                                multicore_doorbell_set_other_core(doorbell_media_control);
                                break;
                            case COMMAND_REVERT_BIOS:
                                doorbell_parameter_media_control_command = MEDIA_CONTROL_REVERT_BIOS_PATCH;
                                multicore_doorbell_set_other_core(doorbell_media_control);
                                break;
                            case COMMAND_DUMP_LOG:
                                dump_log_index = 0;
                                pico_state = PICO_STATE_DUMP_LOG; // FIXME: This is deprecated
                                write_mode = value;
                                break;
                            case COMMAND_ERASE_CREDENTIALS:
                                pico_state = PICO_STATE_WIFI_RESET;
                                return_to_wifi_credentials = true;
                                break;
                            case COMMAND_CLEAR_HARDWARE_LOG:
                                hw_log_index = 0;
                                hw_log_buffer[HW_LOG_MAX_ENTRIES - 1].timestamp = 0;
                                hw_log(HW_LOG_CLEAR);
                                break;
                            case COMMAND_GET_FILE_COUNT:
                                write_mode = value;
                                write_index = 0;

                                if (file_server_status == FILE_SERVER_HAS_UPDATED_LIST) {
                                    file_server_status = FILE_SERVER_ACTIVE_IDLE;
                                }
                                hw_log(HW_LOG_FILE_COUNT_REQUESTED);
                                
                                if (file_cache_start_index == 0xffff) {
                                    doorbell_parameter_file_server_request_type = FILE_SERVER_REQUEST_FILE_CHUNK;
                                    multicore_doorbell_set_other_core(doorbell_file_server_request);
                                } 
                                
                                break;
                            case COMMAND_GET_FILE_INFORMATION:
                                write_mode = value;
                                write_index = 0;
                                file_index_request = 0;
                                hw_log(HW_LOG_FILE_INFORMATION_REQUESTED);
                                file_request_status = FILE_REQUEST_STATUS_NOT_READY;
                                break;
                            case COMMAND_REQUEST_FILE_SEND:
                                write_mode = value;
                                write_index = 0;
                                file_index_request = 0;
                                file_request_status = FILE_REQUEST_STATUS_NOT_READY;
                                break;
                            case COMMAND_DISABLE_SHORT_BOOT_PRESS:
                                short_press_boot_enabled = false;
                                break;
                            case COMMAND_ENABLE_SHORT_BOOT_PRESS:
                                short_press_boot_enabled = true;
                                break;
                            case COMMAND_SET_FILE_TYPE_FILTER:
                                write_mode = value;
                                write_index = 0;
                                break;
                            case COMMAND_ACCESS_STORED_CONFIG:
                                write_mode = value;
                                write_index = 0;
                                break;
                            case COMMAND_FEATURE_FLAGS:
                                write_mode = value;
                                break;
                            case COMMAND_MEDIA_CONTROL:
                                write_mode = value;
                                break;
                        }
                    }
                    break;
                case 0x14: // Pico data
                    if (is_wr) {
                        if (write_mode == WRITE_MODE_BIOS && write_index < sizeof(BIOS)) {
                            BIOS[write_index++] = value;
                        } else if (write_mode == COMMAND_GET_FILE_INFORMATION) {
                            if (write_index == 0) {
                                file_index_request = value; 
                                write_index++;
                            } else if (write_index == 1) {
                                file_index_request |= (value << 8); 
                                write_index++;

                                hw_log_value(HW_LOG_FILE_NAME_INDEX_BYTE, file_index_request);

                                if (file_cache_start_index != 0xffff && 
                                    file_index_request >= file_cache_start_index && 
                                    file_index_request < (file_cache_start_index + file_cache_count)) { // Cache hit
                                    file_name_read_index = 0;
                                } else if (file_index_request < server_file_count) { // Cache miss
                                    file_cache_request_index = file_index_request;
                                    file_cache_start_index = 0xffff;
                                    hw_log_value(HW_LOG_FILE_CHUNK_REQUEST, file_index_request);
                                    hw_log_value(HW_LOG_FILE_CHUNK_REQUEST, server_file_count);
                                    doorbell_parameter_file_server_request_type = FILE_SERVER_REQUEST_FILE_CHUNK;
                                    multicore_doorbell_set_other_core(doorbell_file_server_request);
                                } else {
                                    // FIXME: Error handling?
                                }
                            }
                        } else if (write_mode == COMMAND_GET_FILE_COUNT && write_index == 0) {
                            write_index++;
                            if (file_type_filter != value) {
                                file_type_filter = value;
                                hw_log_value(HW_LOG_SET_FILE_TYPE_FILTER, value);
                                file_cache_start_index = 0xffff;
                                doorbell_parameter_file_server_request_type = FILE_SERVER_REQUEST_SET_FILTER;
                                multicore_doorbell_set_other_core(doorbell_file_server_request);
                            }
                        } else if (write_mode == COMMAND_SET_FILE_TYPE_FILTER && write_index == 0) {
                            write_mode = WRITE_MODE_NONE;
                            if (file_type_filter != value) {
                                file_type_filter = value;
                                hw_log_value(HW_LOG_SET_FILE_TYPE_FILTER, value);
                                file_cache_start_index = 0xffff;
                                doorbell_parameter_file_server_request_type = FILE_SERVER_REQUEST_SET_FILTER;
                                multicore_doorbell_set_other_core(doorbell_file_server_request);
                            }
                        } else if (write_mode == COMMAND_REQUEST_FILE_SEND) {
                            hw_log_value(HW_LOG_FILE_SEND_INDEX_BYTE, value);
                            if (write_index == 0) {
                                file_index_request = value; // FIXME: Change this to atomic
                                write_index++;
                            } else if (write_index == 1) {
                                file_index_request |= (value << 8);
                                write_index++;
                                
                                hw_log_value(HW_LOG_FILE_SEND_REQUEST, file_index_request);
                                doorbell_parameter_file_server_request_type = FILE_SERVER_REQUEST_FILE_SEND;
                                multicore_doorbell_set_other_core(doorbell_file_server_request);
                                
                                file_request_status = FILE_REQUEST_STATUS_NOT_READY;
                            }
                        } else if (write_mode == COMMAND_ACCESS_STORED_CONFIG && write_index < SVI_CONFIG_SIZE) {
                            write_record[write_index++] = value;
                            // hw_log_value(HW_LOG_DEBUG, value);
                            if (write_index == SVI_CONFIG_SIZE) {
                                memcpy((void*)SVI_CONFIG, (void*)write_record, SVI_CONFIG_SIZE);
                                multicore_doorbell_set_other_core(doorbell_save_config);
                                write_mode = WRITE_MODE_NONE;
                                // hw_log(HW_LOG_SVI_CONFIG_SAVE_REQUESTED);
                            }
                        } else if (write_mode == COMMAND_DUMP_DISK) {
                            if (write_index == 0) {
                                // First byte: drive selection (only drive 0 supported)
                                // Reset dump state
                                dump_disk_index = 0;
                                dump_disk_flash_offset = 0;
                                dump_disk_active = true;
                                memset((void *)disk_flash_buffer, 0xFF, DUMP_DISK_BUFFER_SIZE);
                                write_index = 1;
                            } else if (dump_disk_active) {
                                // Subsequent bytes: disk data
                                uint32_t pos_in_buffer = dump_disk_index & (DUMP_DISK_BUFFER_SIZE - 1);
                                disk_flash_buffer[pos_in_buffer] = value;
                                dump_disk_index++;
                                pos_in_buffer++;

                                // Check if we've filled a 4096-byte half
                                if (pos_in_buffer == DUMP_DISK_SECTOR_SIZE) {
                                    // First half full, flash it
                                    dump_disk_flash_half = 0;
                                    multicore_doorbell_set_other_core(doorbell_flash_dump_disk);
                                } else if (pos_in_buffer == DUMP_DISK_BUFFER_SIZE) {
                                    // Second half full, flash it
                                    dump_disk_flash_half = 1;
                                    multicore_doorbell_set_other_core(doorbell_flash_dump_disk);
                                }
                            }
                        } else if (write_mode == COMMAND_MEDIA_CONTROL) {
                            doorbell_parameter_media_control_command = value & 0x3F;
                            multicore_doorbell_set_other_core(doorbell_media_control);
                            write_mode = WRITE_MODE_NONE;
                        } else if (write_mode == COMMAND_FEATURE_FLAGS) {
                            fdc_emulation_enabled = value & 0x01;
                            if (fdc_emulation_enabled) {
                                hw_log(HW_LOG_FDC_EMULATION_ENABLED);
                            } else {
                                hw_log(HW_LOG_FDC_EMULATION_DISABLED);
                            }
                            write_mode = WRITE_MODE_NONE;
                        } else if (write_mode != WRITE_MODE_TERMINATE && write_index < MAX_WRITE_RECORD) {
                            write_record[write_index++] = value;
                            // hw_log_value(HW_LOG_PICO_WR, value);
                        }
                    } else if (is_rd) {
                        if (pico_state == PICO_STATE_DUMP_LOG) {
                            value = log_buffer[dump_log_index++];
                            write_to_data_pins = true;
                        } else if (write_mode == COMMAND_GET_FILE_COUNT) {
                            if (write_index == 0) { 
                                value = FILE_REQUEST_STATUS_NOT_READY; // FIXME: Think, the read shouldn't occur here yet, should return not ready
                            } else if (write_index == 1) {
                                if (file_cache_start_index == 0xffff) {
                                    value = FILE_REQUEST_STATUS_NOT_READY;
                                } else {
                                    value = FILE_REQUEST_STATUS_SUCCESS; // FIXME: There is no error handling for now
                                    write_index++;
                                }
                            } else if (write_index == 2) {
                                value = (uint8_t)(server_file_count & 0xff);
                                write_index++;
                                hw_log_value(HW_LOG_FILE_COUNT_RESPONSE, value);
                            } else if (write_index == 3) {
                                value = (uint8_t)((server_file_count >> 8) & 0xff);
                                write_mode = WRITE_MODE_NONE;
                                hw_log_value(HW_LOG_FILE_COUNT_RESPONSE, value);
                            }
                            write_to_data_pins = true;
                        } else if (write_mode == COMMAND_GET_FILE_INFORMATION) {
                            if (write_index < 2) { // Illegal read, we'll return not ready
                                value = FILE_REQUEST_STATUS_NOT_READY;
                            } else if (write_index == 2) {
                                if (file_cache_start_index == 0xffff) {
                                    value = FILE_REQUEST_STATUS_NOT_READY; // Still waiting for chunk
                                } else {
                                    value = FILE_REQUEST_STATUS_SUCCESS;
                                    write_index++;
                                }
                            } else if (write_index == 3) {
                                uint16_t cache_offset = (file_index_request - file_cache_start_index) * FILE_ENTRY_SIZE;
                                value = FILE_CACHE[cache_offset + 1]; // Type code at offset 1
                                write_index++;
                            } else if (write_index >= 4) {
                                if (file_name_read_index < FILE_NAME_SIZE) {
                                    uint16_t cache_offset = (file_index_request - file_cache_start_index) * FILE_ENTRY_SIZE;
                                    value = FILE_CACHE[cache_offset + 2 + file_name_read_index];
                                    file_name_read_index++;
                                }
                                if (file_name_read_index >= FILE_NAME_SIZE) {
                                    write_mode = WRITE_MODE_NONE;
                                }
                            }                            
                            // hw_log_value(HW_LOG_FILE_NAME_READ_VALUE, value);
                            write_to_data_pins = true;
                        } else if (write_mode == COMMAND_REQUEST_FILE_SEND && write_index >= 2) {
                            file_request_status = FILE_REQUEST_STATUS_SUCCESS; // TODO: Placeholder for now
                            value = file_request_status;
                            write_to_data_pins = true;
                            write_mode = WRITE_MODE_NONE;
                        } else if (write_mode == COMMAND_ACCESS_STORED_CONFIG && write_index < SVI_CONFIG_SIZE) {
                            value = SVI_CONFIG[write_index++];
                            // hw_log_value(HW_LOG_DEBUG, value);
                            write_to_data_pins = true;
                            if (write_index == SVI_CONFIG_SIZE) {
                                write_mode = WRITE_MODE_NONE;
                                // hw_log(HW_LOG_SVI_CONFIG_READ_COMPLETED);
                            }
                        } else if (write_mode == COMMAND_FEATURE_FLAGS) {
                            value = fdc_emulation_enabled ? 0x01 : 0x00;
                            write_to_data_pins = true;
                            write_mode = WRITE_MODE_NONE;
                        }
                    }
                    break;
                case 0x15: // High bits of timer
                    if (is_rd) {
                        timer_stored = HW_TIMESTAMP - timer_reset;
                        value = (uint8_t)(timer_stored >> 8 & 0xff);
                        write_to_data_pins = true;
                    } else {
                        timer_reset = HW_TIMESTAMP;
                    }
                    break;
                case 0x16: // Low bits of timer
                    if (is_rd) {
                        value = (uint8_t)(timer_stored & 0xff);
                        write_to_data_pins = true;
                    }
                    break;
                case 0x17: // Pico debug
                    if (is_wr) {
                        hw_log_value(HW_LOG_DEBUG, value);
                    }
                    break;
                case 0x18: // Network & file server status
                    if (is_rd) {
                        value = (uint8_t)(network_status & 0x07)
                              | (uint8_t)(file_server_status & 0x38)
                              | (short_press_boot_pressed ? 0x40 : 0x00)
                              | (hdd_total_lbas > 0 ? 0x80 : 0x00);
                        short_press_boot_pressed = false;
                        write_to_data_pins = true;
                    }
                    break;
                case 0x31: // Track register
                    if (fdc_emulation_enabled) {
                        if (is_rd) {
                            value = register_track;
                            hw_log_value(HW_LOG_RD_TRACK, value);
                            write_to_data_pins = true;
                        } else {
                            register_track = value;
                            hw_log_value(HW_LOG_WR_TRACK, value);
                        }
                    }
                    break;
                case 0x32: // Sector register
                    if (fdc_emulation_enabled) {
                        if (is_rd) {
                            if (disk_size > 0) {
                                value = register_sector;
                            } else {
                                value = 0xff; // If disk is not present, return 0xff to kill BIOS floppy disk test
                            }
                            if (!bios_floppy_test_completed && value == 0xff) {
                                hw_log(HW_LOG_BIOS_FD_TEST_END);
                                bios_floppy_test_completed = true;
                            } else if (bios_floppy_test_completed) {
                                hw_log_value(HW_LOG_RD_SECTOR, value);
                            }
                            if (value == 0xff) {
                                // BIOS only writes sector 255 in the test, and needs to read 0x04 twice before it can read 0x06
                                // This is to fix the BIOS test when using BASIC command SWITCH
                                repeat_status_0x04_count = 2;
                            }
                            write_to_data_pins = true;
                        } else {
                            register_sector = value;
                            if (!bios_floppy_test_completed && value == 0x00) {
                                hw_log(HW_LOG_BIOS_FD_TEST_START);
                            } else if (bios_floppy_test_completed) {
                                hw_log_value(HW_LOG_WR_SECTOR, value);
                            }
                        }
                    }
                    break;
                case 0x38: // Density and side select register
                    if (fdc_emulation_enabled) {
                        if (is_wr) {
                            density = value & 0x01;
                            side = (value & 0x02) >> 1;
                            hw_log_value(HW_LOG_WR_DENSITY, value);
                        } else {
                            hw_log_value(HW_LOG_RD_DENSITY, value);
                        }
                    }
                    break;
                case 0x30: // Controller status and command register
                    if (fdc_emulation_enabled) {
                        if (is_rd) {
                            if (disk_size == 0) {
                                // No disk loaded: NOT READY (bit 7) + Seek Error (bit 4)
                                value = 0x90;
                            } else switch (drive_status) {
                                case 0x0e:
                                    value = 0xc4;
                                    break;
                                case 0x0d:
                                    value = 0x04;
                                    if (repeat_status_0x04_count > 0) {
                                        repeat_status_0x04_count--;
                                    } else {
                                        drive_status = 0xff; // Own synthetic status to return 0x06 once
                                    }
                                    break;
                                case 0xff:
                                    value = 0x06;
                                    drive_status = 0x00;
                                    break;
                                default:
                                    value = 0x00;
                                    break;
                            }
                            if (value != 0x00) {
                                hw_log_value(HW_LOG_RD_CONTROLLER, value);
                            }
                            write_to_data_pins = true;
                        } else {
                            uint8_t command = value & 0xF0;
                            switch (command) {
                                case 0x00: // Restore
                                    register_track = 0;
                                    hw_log_value(HW_LOG_WR_CONTROLLER_R, register_track);
                                    if (disk_size > 0) {
                                        DISK_TRACK_ready = false;
                                        multicore_doorbell_set_other_core(doorbell_fetch_disk_track);
                                    }
                                    break;
                                case 0x10: // Seek
                                    register_track = last_data;
                                    hw_log_value(HW_LOG_WR_CONTROLLER_S, register_track);

                                    if (disk_size > 0) {
                                        DISK_TRACK_ready = false;
                                        multicore_doorbell_set_other_core(doorbell_fetch_disk_track);
                                    }
                                    break;
                                case 0x50: // Step in (update track register)
                                    if (register_track < 79) {
                                        register_track++;
                                        hw_log_value(HW_LOG_WR_CONTROLLER_SIT, register_track);
                                        if (disk_size > 0) {
                                            DISK_TRACK_ready = false;
                                            multicore_doorbell_set_other_core(doorbell_fetch_disk_track);
                                        }
                                    } else {
                                        hw_log_value(HW_LOG_WR_CONTROLLER_SIT, register_track);
                                    }
                                    break;
                                case 0x70: // Step out (update track register)
                                    if (register_track > 0) {
                                        register_track--;
                                        hw_log_value(HW_LOG_WR_CONTROLLER_SOT, register_track);
                                        if (disk_size > 0) {
                                            DISK_TRACK_ready = false;
                                            multicore_doorbell_set_other_core(doorbell_fetch_disk_track);
                                        }
                                    } else {
                                        hw_log_value(HW_LOG_WR_CONTROLLER_SOT, register_track);
                                    }
                                    break;
                                case 0x80: // Read sector (single record)
                                    hw_log_value(HW_LOG_WR_CONTROLLER_RS, value);
                                    sector_index = 0;
                                    read_sector_mode = true;

                                    sector_size = (side == 1 || register_track != 0) ? 256 : 128; // FIXME: This code is duplicated in write sector
                                    sector_base = (register_sector - 1) * sector_size;
                                    break;
                                case 0xA0: // Write sector (single record)
                                    hw_log_value(HW_LOG_WR_CONTROLLER_WS, value);
                                    sector_index = 0;
                                    write_sector_mode = true;

                                    sector_size = (side == 1 || register_track != 0) ? 256 : 128;
                                    sector_base = (register_sector - 1) * sector_size;
                                    break;
                                case 0xD0: // Force interrupt
                                    hw_log_value(HW_LOG_WR_CONTROLLER_FI, value);
                                    break;
                                default: // Not supported
                                    hw_log_value(HW_LOG_WR_CONTROLLER, value);
                                    break;                                     
                            }
                        }
                    }
                    break;
                case 0x34: // Drive status and command register
                    if (fdc_emulation_enabled) {
                        if (is_rd) {
                            if (disk_size == 0 && !read_sector_mode && !write_sector_mode) {
                                // No disk loaded and not in read/write mode (e.g., after Restore):
                                // suppress INTRQ so boot code fails fast without retries
                                value = 0x00;
                                hw_log_value(HW_LOG_RD_DRIVE, value);
                            } else if (disk_size == 0 && (read_sector_mode || write_sector_mode)) {
                                // No disk loaded but in read/write mode (CP/M BIOS polling):
                                // return INTRQ so the polling loop exits, then port 0x30 returns error
                                value = 0x80;
                                read_sector_mode = false;
                                write_sector_mode = false;
                                hw_log_value(HW_LOG_RD_DRIVE, value);
                            } else if (!DISK_TRACK_ready) {
                                value = 0x00; // Data not ready
                                if (!log_disk_track_not_ready_once) {
                                    hw_log(HW_LOG_MULTICORE_DISK_TRACK_NOT_READY);
                                    log_disk_track_not_ready_once = true;
                                }
                            } else if (read_sector_mode || write_sector_mode) {
                                value = 0x40; // Data ready
                                log_disk_track_not_ready_once = false;
                            } else {
                                value = 0x80; // INTRQ
                                hw_log_value(HW_LOG_RD_DRIVE, value);
                                log_disk_track_not_ready_once = false;
                            }
                            write_to_data_pins = true;
                        } else {
                            drive_status = value;
                            if (value & 0x01) { // Disk 0 selected
                                hw_log(HW_LOG_SELECT_DISK_0);
                            } else if (value & 0x02) { // Disk 1 selected
                                hw_log(HW_LOG_SELECT_DISK_1);
                            } else if (!(value & 0x03)) { // No disk selected
                                hw_log(HW_LOG_DESELECT_DISK);
                            } else {
                                hw_log_value(HW_LOG_WR_DRIVE, value);
                            }
                        }
                    }
                    break;
                case 0x33: // Data register
                    if (fdc_emulation_enabled) {
                        if (is_rd) {
                            if (read_sector_mode) {
                                value = DISK_TRACK[sector_base + sector_index++];
                                if (sector_index >= sector_size) {
                                    read_sector_mode = false;
                                    hw_log_value(HW_LOG_RD_DATA_COMPLETED, sector_index);
                                }
                            } else {
                                value = 0x00;
                                hw_log_value(HW_LOG_RD_DATA, value);
                            }
                            write_to_data_pins = true;
                        } else {
                            last_data = value; // Used with seek command
                            if (write_sector_mode) {
                                DISK_TRACK[sector_base + sector_index++] = value;
                                if (sector_index >= sector_size) {
                                    // write_sector_mode = false;
                                    hw_log_value(HW_LOG_WR_DATA_COMPLETED, sector_index);

                                    DISK_TRACK_ready = false;
                                    // FIXME: Move this to when track is changing or disk is shut down
                                    multicore_doorbell_set_other_core(doorbell_flash_disk_track);
                                }
                            } else {
                                hw_log_value(HW_LOG_WR_DATA, value);
                            }
                        }
                    }
                    break;

                // ===============================================
                // SASI HDD emulation (SVI-608M compatible)
                // Ports 40h-46h: SASI bus interface
                // Ports 62h-63h: HDD detection
                // ===============================================

                case 0x40: // SASI bus reset (active high WR)
                    if (!is_rd && sasi_enabled && hdd_total_lbas > 0) {
                        sasi_phase = SASI_PHASE_BUS_FREE;
                        sasi_cdb_index = 0;
                        sasi_data_remaining = 0;
                        hw_log(HW_LOG_SASI_RESET);
                    }
                    break;

                case 0x41: // SASI data-out (WR with auto-ACK)
                    if (!is_rd && sasi_enabled && hdd_total_lbas > 0) {
                        if (sasi_phase == SASI_PHASE_COMMAND) {
                            // Receiving CDB bytes
                            if (sasi_cdb_index < 6) {
                                sasi_cdb[sasi_cdb_index++] = value;
                            }
                            if (sasi_cdb_index >= 6) {
                                // Full CDB received, process command
                                uint8_t opcode = sasi_cdb[0];
                                hw_log_value(HW_LOG_SASI_CMD, opcode);

                                if (opcode == 0x00) {
                                    // TestUnitReady: no data phase, go straight to status
                                    sasi_status_byte = 0x00; // Good
                                    sasi_message_byte = 0x00;
                                    sasi_phase = SASI_PHASE_STATUS;
                                    hw_log_value(HW_LOG_SASI_STATUS, sasi_status_byte);
                                } else if (opcode == 0x08) {
                                    // Read(6) — network-backed
                                    uint32_t lba = ((sasi_cdb[1] & 0x1F) << 16)
                                                 | (sasi_cdb[2] << 8)
                                                 | sasi_cdb[3];
                                    uint32_t count = sasi_cdb[4] ? sasi_cdb[4] : 256;
                                    hw_log_value(HW_LOG_SASI_READ, lba);

                                    // Bounds check
                                    if (lba + count > hdd_total_lbas) {
                                        hw_log_value(HW_LOG_SASI_OUT_OF_RANGE, lba);
                                        sasi_status_byte = 0x02; // Check Condition
                                        sasi_message_byte = 0x00;
                                        sasi_phase = SASI_PHASE_STATUS;
                                    } else {
                                        hdd_sectors_remaining = count;
                                        hdd_request_lba = lba;
                                        sasi_status_byte = 0x00;
                                        sasi_message_byte = 0x00;
                                        // Cache hit?
                                        if (hdd_read_sector_valid && hdd_read_sector_lba == lba) {
                                            sasi_sector_offset = 0;
                                            sasi_phase = SASI_PHASE_DATA_IN;
                                        } else {
                                            hdd_op_type = HDD_OP_READ;
                                            hdd_op_complete = false;
                                            __dmb();
                                            multicore_doorbell_set_other_core(doorbell_hdd);
                                            sasi_phase = SASI_PHASE_BUSY;
                                        }
                                    }
                                } else if (opcode == 0x0A) {
                                    // Write(6) — network-backed
                                    uint32_t lba = ((sasi_cdb[1] & 0x1F) << 16)
                                                 | (sasi_cdb[2] << 8)
                                                 | sasi_cdb[3];
                                    uint32_t count = sasi_cdb[4] ? sasi_cdb[4] : 256;
                                    hw_log_value(HW_LOG_SASI_WRITE, lba);

                                    // Bounds check
                                    if (lba + count > hdd_total_lbas) {
                                        hw_log_value(HW_LOG_SASI_OUT_OF_RANGE, lba);
                                        sasi_status_byte = 0x02; // Check Condition
                                        sasi_message_byte = 0x00;
                                        sasi_phase = SASI_PHASE_STATUS;
                                    } else {
                                        hdd_sectors_remaining = count;
                                        current_write_lba = lba;
                                        sasi_sector_offset = 0;
                                        sasi_status_byte = 0x00;
                                        sasi_message_byte = 0x00;
                                        sasi_phase = SASI_PHASE_DATA_OUT;
                                    }
                                } else if (opcode == 0x0C) { // SetParameters: expect 8 bytes of geometry data
                                    sasi_data_remaining = 8;
                                    sasi_data_offset = 0;
                                    hw_log(HW_LOG_SASI_SET_PARAMS);
                                    sasi_status_byte = 0x00;
                                    sasi_message_byte = 0x00;
                                    sasi_phase = SASI_PHASE_DATA_OUT;
                                } else { // Unknown command: return check condition
                                    sasi_status_byte = 0x02;
                                    sasi_message_byte = 0x00;
                                    sasi_phase = SASI_PHASE_STATUS;
                                    hw_log_value(HW_LOG_SASI_STATUS, sasi_status_byte);
                                }
                            }
                        } else if (sasi_phase == SASI_PHASE_DATA_OUT) {
                            // Receiving data from host
                            uint8_t cdb_opcode = sasi_cdb[0];
                            if (cdb_opcode == 0x0C) { // SetParameters: accept and discard geometry data
                                sasi_data_remaining--;
                                if (sasi_data_remaining == 0) {
                                    sasi_phase = SASI_PHASE_STATUS;
                                    hw_log_value(HW_LOG_SASI_STATUS, sasi_status_byte);
                                }
                            } else { // Write(6): buffer into HDD_WRITE_SECTOR
                                HDD_WRITE_SECTOR[sasi_sector_offset++] = value;
                                if (sasi_sector_offset >= 256) {
                                    // Sector complete: send to server
                                    hdd_write_sector_lba = current_write_lba;
                                    hdd_request_lba = current_write_lba;
                                    // Invalidate read buffer if it holds the same sector
                                    if (hdd_read_sector_valid &&
                                        hdd_read_sector_lba == current_write_lba) {
                                        hdd_read_sector_valid = false;
                                    }
                                    hdd_op_type = HDD_OP_WRITE;
                                    hdd_op_complete = false;
                                    __dmb();
                                    multicore_doorbell_set_other_core(doorbell_hdd);
                                    sasi_phase = SASI_PHASE_BUSY; // wait for ACK
                                    hdd_sectors_remaining--;
                                    current_write_lba++;
                                }
                            }
                        }
                    }
                    break;

                case 0x42: // SASI data-in (RD with auto-ACK)
                    if (is_rd && sasi_enabled && hdd_total_lbas > 0) {
                        if (sasi_phase == SASI_PHASE_DATA_IN) { // Read data from HDD_READ_SECTOR buffer
                            value = HDD_READ_SECTOR[sasi_sector_offset++];
                            if (sasi_sector_offset >= 256) {
                                hdd_sectors_remaining--;
                                if (hdd_sectors_remaining > 0) {
                                    // More sectors: fetch next
                                    hdd_request_lba++;
                                    hdd_op_type = HDD_OP_READ;
                                    hdd_op_complete = false;
                                    __dmb();
                                    multicore_doorbell_set_other_core(doorbell_hdd);
                                    sasi_phase = SASI_PHASE_BUSY;
                                } else {
                                    sasi_phase = SASI_PHASE_STATUS;
                                    hw_log_value(HW_LOG_SASI_STATUS, sasi_status_byte);
                                }
                            }
                            write_to_data_pins = true;
                        } else if (sasi_phase == SASI_PHASE_STATUS) {
                            value = sasi_status_byte;
                            hw_log_value(HW_LOG_SASI_STATUS, value);
                            sasi_phase = SASI_PHASE_MSG_IN;
                            write_to_data_pins = true;
                        } else if (sasi_phase == SASI_PHASE_MSG_IN) {
                            value = sasi_message_byte;
                            hw_log_value(HW_LOG_SASI_MSG_IN, value);
                            sasi_phase = SASI_PHASE_BUS_FREE;
                            write_to_data_pins = true;
                        }
                    }
                    break;

                case 0x43: // SASI select target (WR asserts SEL)
                    if (!is_rd && sasi_enabled && hdd_total_lbas > 0) {
                        // value contains target ID bitmap; target 0 = bit 0
                        hw_log_value(HW_LOG_SASI_SELECT, value);
                        if (value & 0x01) {
                            // Target 0 selected (the HDD)
                            sasi_phase = SASI_PHASE_COMMAND;
                            sasi_cdb_index = 0;
                        }
                    }
                    break;

                case 0x46: // SASI bus status (RD)
                    if (is_rd && sasi_enabled && hdd_total_lbas > 0) {
                        // Check if BUSY phase has completed (network response arrived)
                        if (sasi_phase == SASI_PHASE_BUSY && hdd_op_complete) {
                            if (hdd_op_type == HDD_OP_READ) {
                                sasi_sector_offset = 0;
                                sasi_phase = SASI_PHASE_DATA_IN;
                            } else { // HDD_OP_WRITE
                                if (hdd_sectors_remaining > 0) {
                                    sasi_sector_offset = 0;
                                    sasi_phase = SASI_PHASE_DATA_OUT; // next sector
                                } else {
                                    sasi_phase = SASI_PHASE_STATUS;
                                }
                            }
                        }
                        // Bit 5 = target present, bits 0-4 = phase
                        value = sasi_phase | 0x20;
                        hw_log_value(HW_LOG_SASI_BUS_STATUS, value);
                        write_to_data_pins = true;
                    }
                    break;

                case 0x62: // HDD detection port (RD returns 0x00)
                    if (is_rd && sasi_enabled && hdd_total_lbas > 0) {
                        value = 0x00;
                        hw_log_value(HW_LOG_SASI_DETECT, 0x62);
                        write_to_data_pins = true;
                    }
                    break;

                case 0x63: // HDD detection latch (RD/WR)
                    if (sasi_enabled && hdd_total_lbas > 0) {
                        if (is_rd) {
                            value = sasi_port_63h_latch;
                            hw_log_value(HW_LOG_SASI_DETECT, value);
                            write_to_data_pins = true;
                        } else {
                            sasi_port_63h_latch = value;
                            hw_log_value(HW_LOG_SASI_DETECT, value);
                        }
                    }
                    break;

                case 0x64: // 100 - Cassette emulation 1
                    if (is_rd) {
                        if (tape_index == tape_size) {
                            value = 0x00; // Return 0 because tape is at the end
                        } else {
                            value = TAPE_BUFFER[(tape_index++) & (TAPE_BUFFER_SIZE - 1)];

                            if (!(tape_index & (TAPE_BUFFER_SIZE - 1))) {
                                hw_log(HW_LOG_TAPE_FETCH_NEXT_BUFFER); 
                                TAPE_BUFFER_ready = false;
                                multicore_doorbell_set_other_core(doorbell_fetch_tape_track);
                            }
                            if (tape_index == tape_size - 1) {
                                hw_log_value(HW_LOG_TAPE_END, tape_index + 1);
                            }
                        }
                        write_to_data_pins = true;
                    } else {
                        // WR not currently supported
                    }
                    break;
                case 0x65: // 101 - Cassette emulation 2
                    if (is_rd) {
                        if (tape_size > 0) {
                            if (!TAPE_BUFFER_ready) {
                                value = 0xff; 
                                hw_log(HW_LOG_TAPE_NOT_READY);
                            } else if (tape_index == 0) {
                                value = 0x01; // Tape loaded, at 0
                            } else if (tape_index == tape_size) {
                                value = 0x02; // Tape loaded, index at maximum
                            } else {
                                value = 0x03; // Tape loaded, index in between
                            }
                        } else {
                            value = 0x00; // Tape not loaded - FIXME: Should we return 0x02 here?
                        }
                        write_to_data_pins = true;
                    } else {
                        switch (value) {
                            case 0x01:
                                tape_index = 0;
                                if (tape_size > 0) {
                                    TAPE_BUFFER_ready = false;
                                    multicore_doorbell_set_other_core(doorbell_fetch_tape_track);
                                }
                                hw_log(HW_LOG_TAPE_REWIND);
                                break;
                            case 0x02:
                                hw_log(HW_LOG_TAPE_START_WRITE);
                                break;
                            case 0x03:
                                hw_log(HW_LOG_TAPE_STOP_WRITE);
                                break;
                        }
                    }
                    break;
                case 0x80: // VDP data write
                    if (is_wr) {
                        // hw_log_value(HW_LOG_VDP_0X80, value);
                        vdp_address = ((vdp_address + 1) & 0x3fff) | 0x4000;
                        vdp_expecting_second_byte = false;
                    }
                    break;
                case 0x81: // VDP command/register/address
                    if (is_wr) {
                        // hw_log_value(HW_LOG_VDP_0X81, value);
                        if (!vdp_expecting_second_byte) {
                            vdp_first_byte = value;
                            vdp_expecting_second_byte = true;
                        } else {
                            if (value & 0x80) {
                                uint8_t reg = value & 0x07;
                                vdp_registers[reg] = vdp_first_byte;
                            } else {
                                vdp_address = vdp_first_byte | (value << 8);
                            }
                            vdp_expecting_second_byte = false;
                        }
                    }
                    break;
                case 0x84: // VDP data read
                    if (is_rd) {
                        vdp_address = (vdp_address + 1) & 0x3fff;
                        vdp_expecting_second_byte = false;
                    }
                    break;
                case 0x85: // VDP status read
                    if (is_rd) {
                        vdp_expecting_second_byte = false;
                    }
                    break;
                case 0x88: // PSG latch
                    if (is_wr) {
                        // hw_log_value(HW_LOG_PSG_LATCH_WR, value);
                        bool will_select_15 = (value == 0x0f);
                        if (will_select_15) {
                            hw_log(HW_LOG_PSG_SELECT_15);
                            inject_type = INJECT_TYPE_REVERT_REGISTER_15;

/////////////////////////////////////////////////////////////////////////////////////////
// INJECTION CODE TO REVERT SETTING PSG REGISTER 15
//
//                          INJECT_REVERT_REGISTER_15:
//        77                    ld (hl), a                      ; Capture A register to data bus
//        3eff                  ld a, 0xff                      ; Select fake PSG register 255
//        d388                  out (PSG_ADDRESS_LATCH), a
//        7e                    ld a, (hl)                      ; Load A register with the value captured above
//        18f6                  jr INJECT_REVERT_REGISTER_15    ; Jump PC back to the beginning of the injection code
//

    uint8_t *inject_data = inject_revert_register_15;
    uint16_t inject_counter = 0;

    // hw_log(HW_LOG_INJECT_REVERT_15);

    READ_ADDRESS_PINS(); // Prepare address pins read way before starting injection

    while (inject_counter < sizeof(inject_revert_register_15)) {
        bool is_rd, is_wr;

        WAIT_MREQ_LOW();
        WAIT_RD_OR_WR_LOW_AND_READ_PINS(is_rd, is_wr, pins);
        IF_WR_READ_DATA_PINS();

        // uint32_t addr = pins & ADDRESS_PIN_MASK;

        // hw_log_value(HW_LOG_INJECT_REVERT_15_ADDRESS, addr);

        uint8_t value = 0;

        if (is_rd) {
            value = inject_data[inject_counter++];
            // hw_log_value(HW_LOG_INJECT_REVERT_15_RD, value);

            WRITE_DATA_PINS(value);
        } else {
            value = (uint8_t)((gpio_get_all() & DATA_PIN_MASK) >> 8);

            if (inject_counter == 1) { // We're now expecting the value of A
                // hw_log_value(HW_LOG_INJECT_REVERT_15_WR, value);
                inject_data[6] = value; // Revert A to the original value
            } else {
                // hw_log_value(HW_LOG_INJECT_REVERT_15_UNPLANNED_WR, value);
            }
        }
        WAIT_MREQ_HIGH();
        READ_ADDRESS_PINS();
    }
    inject_type = INJECT_TYPE_NONE;
    // hw_log(HW_LOG_INJECT_REVERT_15_END);
/////////////////////////////////////////////////////////////////////////////////////////

                            psg_register_15_selected = true;
                            goto exit_current_loop;
                        } else if (psg_register_15_selected && !will_select_15) { // Deselect register 15 while it was selected
                            // hw_log(HW_LOG_PSG_DESELECT_15);
                            psg_register_15_selected = false;
                        } else {
                            psg_register_15_selected = false;
                        }
                    }
                    break;
                case 0x8c: // PSG write
                    if (is_wr) {
                        if (psg_register_15_selected) {
                            bool caps_lock_state_changed = (value & CAPS_LOCK) != (psg_register_15 & CAPS_LOCK);

                            psg_register_15 = value;
                            hw_log_value(HW_LOG_PSG_WRITE_15, value);

                            if (caps_lock_state_changed) {
                                inject_type = INJECT_TYPE_CAPS_LOCK;

/////////////////////////////////////////////////////////////////////////////////////////
// INJECTION CODE TO SET THE CAPS LOCK STATE TO REAL PSG REGISTER 15
//
//                        INJECT_CAPS_LOCK:
//      77                    ld (hl), a                  ; Send A register value to data bus
//      3e0f                  ld a, 0xf                   ; Select real register 15
//      d388                  out (PSG_ADDRESS_LATCH), a
//      3eff                  ld a, 0xff                  ; Write CAPS LOCK state while preserving bank selector bits high
//      d38c                  out (PSG_DATA_WRITE), a
//      3eff                  ld a, 0xff                  ; Select fake register 255
//      d388                  out (PSG_ADDRESS_LATCH), a
//      7e                    ld a, (hl)                  ; Restore A register value from data bus 
//      18f0                  jr INJECT_CAPS_LOCK
//

    uint8_t *inject_data = inject_caps_lock;
    inject_data[6] = psg_register_15 | ~CAPS_LOCK;
    uint16_t inject_counter = 0;

    READ_ADDRESS_PINS();

    while (inject_counter < sizeof(inject_caps_lock)) {
        bool is_rd, is_wr;

        WAIT_MREQ_LOW();
        WAIT_RD_OR_WR_LOW_AND_READ_PINS(is_rd, is_wr, pins);
        IF_WR_READ_DATA_PINS();

        // uint32_t addr = pins & ADDRESS_PIN_MASK;

        // hw_log_value(HW_LOG_INJECT_CAPS_LOCK_ADDRESS, addr);

        uint8_t value = 0;

        if (is_rd) {
            value = inject_data[inject_counter++];
            // hw_log_value(HW_LOG_INJECT_CAPS_LOCK_RD, value);

            WRITE_DATA_PINS(value);
        } else {
            value = (uint8_t)((gpio_get_all() & DATA_PIN_MASK) >> 8);

            if (inject_counter == 1) { // We're now expecting the value of A
                // hw_log_value(HW_LOG_INJECT_CAPS_LOCK_WR, value);
                inject_data[14] = value; // Revert A to the original value
            } else {
                // hw_log_value(HW_LOG_INJECT_CAPS_LOCK_UNPLANNED_WR, value);
            }
        }

        WAIT_MREQ_HIGH();
        READ_ADDRESS_PINS();
    }
    inject_type = INJECT_TYPE_NONE;
/////////////////////////////////////////////////////////////////////////////////////////
                            }

                            update_banks();

                            if (caps_lock_state_changed) {
                                goto exit_current_loop;
                            }
                        }
                    }
                    break;
                case 0x90: // PSG read
                    if (is_rd) {
                        if (psg_register_15_selected) {
                            value = psg_register_15;
                            // hw_log_value(HW_LOG_PSG_READ_15, value);

                            inject_type = INJECT_TYPE_REVERT_0X90_READ;

/////////////////////////////////////////////////////////////////////////////////////////
// INJECTION CODE TO RETURN THE VALUE OF EMULATED PSG REGISTER 15
//
// #90: // last byte of "IN A, (0x90)"
//         LD A,XXX  // 3e ff
//
// #A2: // INI
//         DEC HL // 2b
//         LD (HL),XXX // 36 ff
//         INC HL // 23
//
// #AA: // IND
//         INC HL // 23
//         LD (HL),XXX // 36 ff
//         DEC HL // 2b
//
// #40, #48, #50, #58, #60, #68, #78: // IN X, (Y)
//         DB VT AND 56 OR 6 // Convert IN to LD
//         DB XXX
//

    uint16_t inject_counter = 0;
    uint8_t inject_size = 0;
    uint8_t *inject_data = NULL;

    switch (last_mreq_value) {
        case 0x90:
            inject_case_0x90[1] = psg_register_15;
            inject_data = inject_case_0x90;
            inject_size = sizeof(inject_case_0x90);
            break;
        case 0xa2:
            inject_case_0xa2[2] = psg_register_15;
            inject_data = inject_case_0xa2;
            inject_size = sizeof(inject_case_0xa2);
            break;
        case 0xaa:
            inject_case_0xaa[2] = psg_register_15;
            inject_data = inject_case_0xaa;
            inject_size = sizeof(inject_case_0xaa);
            break;
        case 0x40:
        case 0x48:
        case 0x50:
        case 0x58:
        case 0x60:
        case 0x68:
        case 0x78:
            inject_case_in_xy[0] = (last_mreq_value & 56) | 6;
            inject_case_in_xy[1] = psg_register_15;
            inject_data = inject_case_in_xy;
            inject_size = sizeof(inject_case_in_xy);
            break;
        default:
            hw_log_value(HW_LOG_INJECT_REVERT_0X90_UNSUPPORTED, last_mreq_value);
            inject_type = INJECT_TYPE_NONE;
            return;
    }

    // hw_log_value(HW_LOG_INJECT_REVERT_0X90, last_mreq_value);

    READ_ADDRESS_PINS();

    while (inject_counter < inject_size) {
        bool is_rd, is_wr;

        WAIT_MREQ_LOW();
        WAIT_RD_OR_WR_LOW_AND_READ_PINS(is_rd, is_wr, pins);
        IF_WR_READ_DATA_PINS();

        // uint32_t addr = pins & ADDRESS_PIN_MASK;
        uint8_t value = 0;
        // hw_log_value(HW_LOG_INJECT_REVERT_0X90_ADDRESS, addr);

        if (is_rd) {
            value = inject_data[inject_counter++];
            // hw_log_value(HW_LOG_INJECT_REVERT_0X90_RD, value);
            WRITE_DATA_PINS(value);
        } else {
            value = (uint8_t)((gpio_get_all() & DATA_PIN_MASK) >> 8);
            // hw_log_value(HW_LOG_INJECT_REVERT_0X90_UNPLANNED_WR, value);
        }

        WAIT_MREQ_HIGH();
        READ_ADDRESS_PINS();
    }
    inject_type = INJECT_TYPE_NONE;
///////////////////////////////////////////////////////////////////////////////////////////

                            goto exit_current_loop;
                        }
                    }
                    break;
                case 0x94: // PPI write A - Joystick / Cassette write (not used normally)
                case 0x95: // PPI write B - Keyboard (do not write)
                case 0x96: // PPI write C - Key click / Cassette / Keyboard line select
                case 0x97: // PPI write control - Mode select
                    if (is_wr) { // Captures all writes to PPI ports
                        ppi_registers[pins & 0x3] = value;
                    }
                    break;
                default:
                    break;
            }

            if (write_to_data_pins) {
                WRITE_DATA_PINS(value);
            }

            WAIT_IORQ_HIGH();
        } else { // It's a MREQ operation
            uint8_t value = 0;

            uint32_t addr = pins & ADDRESS_PIN_MASK;
            uint32_t higher_addr = addr & 0x7fff;

            if (is_rd) { // MREQ RD
                if (addr < 0x8000) { // Lower bank
                    value = LOWER_BANK[addr];
                    if (*menu_state & MENU_STATE_WAITING_BIT) {
                        if (addr == 0x0038) {
                            value = 0x18; // JR
                        } else if (addr == 0x0039) {
                            value = 0xf9; // -7 (0x0038 -> 0x0033)
                        }
                    }
                } else {
                    value = UPPER_BANK[higher_addr];
                }
                last_mreq_value = value;
                WRITE_DATA_PINS(value);

                if ((*menu_state & MENU_STATE_IN_MENU_BIT) && addr == 0x0037) {
                    psg_register_15 = RAM4[SAVE_PSG_R15];
                    update_banks();
                    *menu_state &= ~MENU_STATE_IN_MENU_BIT; // Clear b0
                } else if ((*menu_state & MENU_STATE_WAITING_BIT) && addr == 0x0039) {
                    *(uint32_t*)&RAM4[SAVE_VDP] = *(uint32_t*)&vdp_registers[0];
                    *(uint32_t*)&RAM4[SAVE_VDP + 4] = *(uint32_t*)&vdp_registers[4];
                    *(uint16_t*)&RAM4[SAVE_VRAM_P] = vdp_address;
                    *(uint32_t*)&RAM4[SAVE_PPI] = __builtin_bswap32(*(uint32_t*)&ppi_registers[0]); // 0x97 at 0xF00C, 0x94 at 0xF00F
                    RAM4[SAVE_PSG_R15] = psg_register_15;

                    psg_register_15 = (psg_register_15 & CAPS_LOCK) | ~(BK41 | BK42); // Enable BK41+BK42 while retaining CAPS LOCK bit
                    update_banks();

                    *menu_state = (*menu_state & ~MENU_STATE_WAITING_BIT) | MENU_STATE_IN_MENU_BIT; // Clear b2, set b0
                }
            } else { // MREQ WR
                value = (uint8_t)((gpio_get_all() & DATA_PIN_MASK) >> 8);

                if (addr < 0x8000) {
                    if (!lower_bank_is_ROM) { // FIXME: Is this too slow?
                        LOWER_BANK[addr] = value;
                    }
                } else if (!upper_bank_is_ROM) {
                    UPPER_BANK[higher_addr] = value;
                }
            }

            WAIT_MREQ_HIGH();
        }

        READ_ADDRESS_PINS();

        if (gpio_get(RESET_BUTTON_PIN) == 1) {
            if (++reset_button_press_counter >= RESET_BUTTON_THRESHOLD) {
                hw_log(HW_LOG_RESET_BUTTON_LONG_PRESSED);
                inject_type = INJECT_TYPE_BOOT;
                reset_button_press_counter = 0;
            }
        } else if (reset_button_press_counter > 0) {
            hw_log(HW_LOG_RESET_BUTTON_SHORT_PRESSED);
            short_press_boot_pressed = true;
            if (short_press_boot_enabled) {
                *menu_state |= MENU_STATE_WAITING_BIT;
                menu_entrance_counter = 0;
            }
            reset_button_press_counter = 0;
        }

        if (*(uint32_t*)&LOWER_BANK[0] == 0xB57B50C3 && // BIOS signature found from lower bank
            *(uint32_t*)&LOWER_BANK[4] == 0x0056C456) {
            if (!kbd_combo_monitoring) { // Activate monitoring once all keys are released (all NEWKEYS rows 0xFF)
                if (*(uint32_t*)&UPPER_BANK[0x7D80] == 0xFFFFFFFF &&
                    *(uint32_t*)&UPPER_BANK[0x7D84] == 0xFFFFFFFF) {
                    kbd_combo_monitoring = true;
                    kbd_last_row6 = 0xFF;
                }
            } else {
                uint8_t row6 = UPPER_BANK[0x7D86];
                uint8_t newly_pressed = (row6 ^ kbd_last_row6) & kbd_last_row6; // bits that went 1→0
                kbd_last_row6 = row6;

                if (row6 != 0x00 && (newly_pressed & 0x0F) && (row6 & 0x0F) == 0) { // CTRL + SHIFT + LEFT GRPH + RIGHT GRPH
                    kbd_combo_monitoring = false;
                    short_press_boot_pressed = true;
                    if (short_press_boot_enabled) {
                        *menu_state |= MENU_STATE_WAITING_BIT;
                        menu_entrance_counter = 0;
                    }
                }
            }
        } else {
            kbd_combo_monitoring = false;
        }

        if (*menu_state & MENU_STATE_WAITING_BIT) {
            if (++menu_entrance_counter >= MENU_ENTRANCE_TIMEOUT) {
                *menu_state &= ~MENU_STATE_WAITING_BIT;
                menu_entrance_counter = 0;
            }
        }

exit_current_loop:
    }
}

void __no_inline_not_in_flash_func(inject_boot)() {
    uint16_t inject_counter = 0;

    hw_log(HW_LOG_INJECT_BOOT);
    pico_state = PICO_STATE_INJECTING_BOOT;

    launcher_initialization(); // Do this here because you need to be fast after injecting the boot code
    boot_initialization(); // Note: Resets ROM CARTRIDGE to 0xffs so that BIOS does not boot the cartridge if something was loaded
    load_bootsector_to_cartridge(); // Launcher needs the bootsector ROM in cartridge slot

    gpio_put(RST_PIN, 1);
    sleep_ms(20);
    gpio_put(RST_PIN, 0);

    READ_ADDRESS_PINS();

    while (inject_type == INJECT_TYPE_BOOT) {
        WAIT_RD_LOW();
        WAIT_MREQ_LOW();

        uint8_t value = INJECTBOOT[inject_counter++];

        WRITE_DATA_PINS(value);
        WAIT_MREQ_HIGH();
        READ_ADDRESS_PINS();

        if (inject_counter >= INJECTBOOT_len) {
            inject_type = INJECT_TYPE_NONE;
        }
    }

    hw_log(HW_LOG_INJECT_BOOT_SUCCESS);
    pico_state = PICO_STATE_BOOT_SUCCESS;
}

void __no_inline_not_in_flash_func(core1_entry)() {
    __asm volatile ("cpsid i"); // Disable interrupts
    bus_ctrl_hw->priority = BUSCTRL_BUS_PRIORITY_PROC1_BITS;

    if (!gpio_get(RD_PIN) && !gpio_get(WR_PIN)) {
        hw_log(HW_LOG_DISCONNECTED_WARNING);
    }

    launcher_initialization();
    boot_initialization();
    inject_type = INJECT_TYPE_PREPARE;

    memcpy((void *)BIOS, (void *)PREPARE, sizeof(PREPARE));

    while (true) {
        switch (inject_type) {
            case INJECT_TYPE_PREPARE:
                prepare();
                break;
            case INJECT_TYPE_NONE:
                floppy_and_ram_emulation();
                break;
            case INJECT_TYPE_BOOT:
                inject_boot();
                break;
            default:
                break;
        }
    }
}