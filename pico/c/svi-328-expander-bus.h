/**
 * SVI-3x8 PicoExpander
 * 
 * Copyright (c) 2026 Markus Rautopuro
 * 
 * Works only with Raspberry Pico 2 W.
 */

/*
    A0..A15 -> GPIO0..15
    D0..D7 <-> GPIO8..15

    /RD -> GPIO16
    /WR -> GPIO17
    /IORQ -> GPIO18
    /MREQ -> GPIO21

    RST -> GPIO19 (inverted /RST)
    ROMDIS <- GPIO20 (inverted /ROMDIS)
    Reset button -> GPIO22

    P_AE <- GPIO23 (Enable address line read)
    P_RD_DE <- GPIO24 (Enable data line read)
    P_WR_DE <- GPIO25 (Enable data line write)
*/

#define RD_PIN 16
#define WR_PIN 17
#define IORQ_PIN 18
#define MREQ_PIN 21
#define RST_PIN 19
#define ROMDIS_PIN 20
#define RESET_BUTTON_PIN 22
#define P_AE_PIN 26 // Address read enable, enabled when high
#define P_RD_DE_PIN 27 // Data read enable, enabled when high
#define P_WR_DE_PIN 28 // Data write enable, enabled when high

#define P_AE_GPIO_MASK (1UL << P_AE_PIN)
#define P_RD_DE_GPIO_MASK (1UL << P_RD_DE_PIN)
#define P_WR_DE_GPIO_MASK (1UL << P_WR_DE_PIN)
#define RD_GPIO_MASK (1UL << RD_PIN)
#define WR_GPIO_MASK (1UL << WR_PIN)
#define IORQ_GPIO_MASK (1UL << IORQ_PIN)
#define MREQ_GPIO_MASK (1UL << MREQ_PIN)
#define RST_GPIO_MASK (1UL << RST_PIN)
#define ROMDIS_GPIO_MASK (1UL << ROMDIS_PIN)
#define RESET_BUTTON_GPIO_MASK (1UL << RESET_BUTTON_PIN)

#define OTHER_PIN_MASK (P_AE_GPIO_MASK | P_RD_DE_GPIO_MASK | P_WR_DE_GPIO_MASK | RD_GPIO_MASK | WR_GPIO_MASK | IORQ_GPIO_MASK | MREQ_GPIO_MASK | RST_GPIO_MASK | RESET_BUTTON_GPIO_MASK | ROMDIS_GPIO_MASK)
#define ADDRESS_PIN_MASK ((1UL << 16) - 1)
#define DATA_PIN_MASK (((1UL << 8) - 1) << 8) // Data pins shared with higher address pins in GPIO8..15
#define ALL_GPIO_MASK (ADDRESS_PIN_MASK | OTHER_PIN_MASK)
#define IORQ_PORT_PIN_MASK ((1UL << 8) - 1) // I/O port pins are GPIO0..7

#define SSID_MAX_LENGTH 32
#define PASSWORD_MAX_LENGTH 63
#define SAVE_STATE_FILENAME_MAX_LENGTH 256
#define SVI_CONFIG_SIZE 16

#define PICO_ENABLED 255
#define PICO_DISABLED 0
typedef enum {
    PICO_STATE_WAITING_CREDENTIALS = 100,
    PICO_STATE_CREDENTIALS_RECEIVED = 101,
    PICO_STATE_CREDENTIALS_STORED = 102,
    PICO_STATE_WIFI_CONNECTING = 103,
    PICO_STATE_WIFI_CONNECTED = 104,
    PICO_STATE_WIFI_ERROR = 105,
    PICO_STATE_CLIENT_CONNECTED = 106,
    PICO_STATE_RECEIVING_ROM = 107,
    PICO_STATE_ROM_READY = 108,
    PICO_STATE_RECEIVING_DISK = 109,
    PICO_STATE_DISK_READY = 110,
    PICO_STATE_DUMPING_LOG = 111,
    PICO_STATE_CLIENT_DISCONNECTED = 112,
    PICO_STATE_RECEIVING_TAPE = 113,
    PICO_STATE_TAPE_READY = 114,
    PICO_STATE_BOOT_BIOS = 115,
    PICO_STATE_RECEIVING_BK4X = 116,
    PICO_STATE_SENDING_BK4X = 118,
    PICO_STATE_RECEIVING_FILE_CHUNK = 119,
    PICO_STATE_SENDING_SAVE_STATE = 120,
    PICO_STATE_SENDING_BIOS = 121,
    PICO_STATE_SENDING_DISK = 124,
    PICO_STATE_RECEIVING_SAVE_STATE = 122,
    PICO_STATE_SAVE_STATE_READY = 123,
    PICO_STATE_INJECTING_BOOT = 200,
    PICO_STATE_BOOT_SUCCESS = 201,
    PICO_STATE_WIFI_BAD_AUTH = 230,
    PICO_STATE_WIFI_TIMEOUT = 231,
    PICO_STATE_WIFI_RESET = 232,
    PICO_STATE_DUMP_LOG = 251,
    PICO_STATE_BOOT_FAIL = 252,
    PICO_STATE_MEMORY_ERROR = 253,
    PICO_STATE_ERROR = 254,
    PICO_STATE_UNKNOWN = 255
} pico_state_t;

typedef enum {
    INJECT_TYPE_NONE = 0,
    INJECT_TYPE_BOOT = 1,
    INJECT_TYPE_REVERT_CART = 2,
    INJECT_TYPE_REVERT_REGISTER_15 = 3,
    INJECT_TYPE_REVERT_0X90_READ = 4,
    INJECT_TYPE_CAPS_LOCK = 5,
    INJECT_TYPE_PREPARE = 6
} inject_type_t;

typedef enum {
    NETWORK_STATUS_NOT_CONNECTED = 0x00,   // 0b00000000 - Not connected, idle
    NETWORK_STATUS_CONNECTING = 0x01,      // 0b00000001 - Connecting
    NETWORK_STATUS_ERROR = 0x02,           // 0b00000010 - Error connecting
    NETWORK_STATUS_CONNECTED = 0x03        // 0b00000011 - Connected
} network_status_t;

typedef enum {
    FILE_SERVER_NOT_CONNECTED = 0x00,      // 0b00000000 - Not connected
    FILE_SERVER_CONNECTED_NO_LIST = 0x08,  // 0b00001000 - Connected, no file list
    FILE_SERVER_UPDATING_LIST = 0x10,      // 0b00010000 - Busy updating file list
    FILE_SERVER_ACTIVE_IDLE = 0x18,        // 0b00011000 - Active and idle
    FILE_SERVER_SENDING_IMAGE = 0x20,      // 0b00100000 - Busy sending an image
    FILE_SERVER_HAS_UPDATED_LIST = 0x28    // 0b00101000 - Has updated file list available
} file_server_status_t;

typedef enum {
    FILE_SERVER_REQUEST_FILE_CHUNK = 1,
    FILE_SERVER_REQUEST_FILE_SEND = 2,
    FILE_SERVER_REQUEST_SAVE_STATE = 3,
    FILE_SERVER_REQUEST_SET_FILTER = 4
} file_server_request_type_t;

typedef enum {
    MEDIA_CONTROL_NONE = 0x00,
    MEDIA_CONTROL_EJECT_DISK_0 = 0x01,
    MEDIA_CONTROL_EJECT_DISK_1 = 0x02,
    MEDIA_CONTROL_EJECT_CARTRIDGE = 0x04,
    MEDIA_CONTROL_EJECT_TAPE = 0x08,
    MEDIA_CONTROL_LOAD_BK11_TO_CARTRIDGE = 0x10,
    MEDIA_CONTROL_LOAD_BOOTSECTOR_TO_CARTRIDGE = 0x20,
    MEDIA_CONTROL_APPLY_BIOS_PATCH = 0x80,
    MEDIA_CONTROL_REVERT_BIOS_PATCH = 0x81
} media_control_command_t;

typedef enum {
    WRITE_MODE_NONE = 0x00,
    WRITE_MODE_CREDENTIALS = 0x01,
    WRITE_MODE_SAVE_STATE = 0x02,
    WRITE_MODE_TERMINATE = 0x03,
    WRITE_MODE_BIOS = 0x04,
    WRITE_MODE_32KB_ROM = 0x05,
    COMMAND_STOP_SERVING_PREPARE = 0x06,
    COMMAND_DUMP_DISK = 0x07,
    COMMAND_PATCH_BIOS = 0x10,
    COMMAND_REVERT_BIOS = 0x11,
    COMMAND_DUMP_LOG = 0x12,
    COMMAND_ERASE_CREDENTIALS = 0x13,
    COMMAND_CLEAR_HARDWARE_LOG = 0x14,
    COMMAND_GET_FILE_COUNT = 0x20,
    COMMAND_GET_FILE_INFORMATION = 0x21,
    COMMAND_REQUEST_FILE_SEND = 0x22,
    COMMAND_DISABLE_SHORT_BOOT_PRESS = 0x30,
    COMMAND_ENABLE_SHORT_BOOT_PRESS = 0x31,
    COMMAND_SET_FILE_TYPE_FILTER = 0x40,
    COMMAND_ACCESS_STORED_CONFIG = 0x50,
    COMMAND_FEATURE_FLAGS = 0x51,
    COMMAND_MEDIA_CONTROL = 0x52
} write_mode_t;

typedef enum {
    FILE_REQUEST_STATUS_NOT_READY = 0x80,
    FILE_REQUEST_STATUS_SUCCESS = 0x00,
    FILE_REQUEST_STATUS_FAILED = 0x01
} file_request_status_t;

void __no_inline_not_in_flash_func(core1_entry)();

extern volatile pico_state_t pico_state;
extern volatile inject_type_t inject_type;

extern volatile network_status_t network_status;
extern volatile file_server_status_t file_server_status;
extern volatile file_server_request_type_t doorbell_parameter_file_server_request_type;
extern volatile media_control_command_t doorbell_parameter_media_control_command;

extern volatile unsigned char SSID[];
extern volatile unsigned char Password[];
extern volatile unsigned char SVI_CONFIG[];
extern volatile unsigned char save_state_filename[];

extern volatile uint8_t DISK_TRACK[];
extern volatile bool DISK_TRACK_ready;
extern volatile uint8_t side;
extern volatile uint8_t register_track;
extern volatile bool write_sector_mode;
extern volatile uint32_t disk_size;

#define DUMP_DISK_BUFFER_SIZE 8192
#define DUMP_DISK_SECTOR_SIZE 4096
extern uint8_t disk_flash_buffer[];
extern volatile uint32_t dump_disk_index;
extern volatile uint32_t dump_disk_flash_offset;
extern volatile bool dump_disk_active;
extern volatile uint8_t dump_disk_flash_half;

#define TAPE_BUFFER_SIZE 32768
extern volatile uint8_t TAPE_BUFFER[];
extern volatile bool TAPE_BUFFER_ready;
extern volatile uint32_t tape_index;
extern volatile uint32_t tape_size;

extern volatile uint8_t ROM_CARTRIDGE[];
extern volatile uint8_t BK11[];
extern volatile uint8_t BIOS[];
extern volatile uint8_t RAM0[];
extern volatile uint8_t RAM2[];
extern volatile uint8_t RAM3[];
extern volatile uint8_t RAM4[];

extern volatile bool skip_ram4_init;
extern bool return_to_wifi_credentials;

#define HW_LOG_MAX_ENTRIES 1024 // Must be a power of 2
#define HW_LOG_MASK (HW_LOG_MAX_ENTRIES - 1)
#define HW_TIMESTAMP (timer_hw->timelr)

#define FILE_CACHE_SIZE 256
#define FILE_ENTRY_SIZE 32
#define FILE_NAME_SIZE 30

// File cache: 256 files × 32 bytes per file
// Entry format: [1 byte reserved][1 byte type][30 bytes filename]
extern volatile uint8_t FILE_CACHE[FILE_CACHE_SIZE * FILE_ENTRY_SIZE];
extern volatile uint16_t file_cache_start_index;
extern volatile uint16_t file_cache_count;
extern volatile uint8_t file_type_filter;
extern volatile uint16_t file_cache_request_index;

// The strings are used in get_log.js

#define HW_LOG_OPS \
    X(HW_LOG_INIT_PREPARE, "Hardware emulation: prepare") \
    X(HW_LOG_INIT_MAIN, "Hardware emulation: main") \
    X(HW_LOG_INJECT_BOOT, "Starting injecting BOOT") \
    X(HW_LOG_INJECT_BOOT_SUCCESS, "Booting success") \
    X(HW_LOG_INJECT_REVERT_15, "INJECTION: Reverting PSG set register 15") \
    X(HW_LOG_INJECT_REVERT_15_END, "INJECTION: PSG register 15 injection ends") \
    X(HW_LOG_INJECT_REVERT_15_RD, "REVERT 15 MREQ RD") \
    X(HW_LOG_INJECT_REVERT_15_WR, "REVERT 15 MREQ WR") \
    X(HW_LOG_INJECT_REVERT_15_UNPLANNED_WR, "REVERT 15 unplanned WR") \
    X(HW_LOG_INJECT_REVERT_15_ADDRESS, "REVERT 15 addr") \
    X(HW_LOG_INJECT_REVERT_0X90, "INJECTION: Reverting read I/O 0x90, type") \
    X(HW_LOG_INJECT_REVERT_0X90_RD, "REVERT READ 0x90 MREQ RD") \
    X(HW_LOG_INJECT_REVERT_0X90_UNPLANNED_WR, "REVERT READ 0x90 unplanned WR") \
    X(HW_LOG_INJECT_REVERT_0X90_ADDRESS, "REVERT READ 0x90 addr") \
    X(HW_LOG_INJECT_REVERT_0X90_UNSUPPORTED, "REVERT READ 0x90 unsupported") \
    X(HW_LOG_INJECT_CAPS_LOCK_RD, "CAPS LOCK RD") \
    X(HW_LOG_INJECT_CAPS_LOCK_WR, "CAPS LOCK MREQ WR") \
    X(HW_LOG_INJECT_CAPS_LOCK_UNPLANNED_WR, "CAPS LOCK unplanned WR") \
    X(HW_LOG_INJECT_CAPS_LOCK_ADDRESS, "CAPS LOCK addr") \
    X(HW_LOG_BIOS_FD_TEST_START, "BIOS floppy disk test begins") \
    X(HW_LOG_BIOS_FD_TEST_END, "BIOS floppy disk test completed") \
    X(HW_LOG_RD_PICO_STATE, "RD 0x13 (Pico state)") \
    X(HW_LOG_RD_TRACK, "RD 0x31 (track)") \
    X(HW_LOG_RD_SECTOR, "RD 0x32 (sector)") \
    X(HW_LOG_RD_DATA, "RD 0x33 (data)") \
    X(HW_LOG_WR_DATA, "WR 0x33 (data)") \
    X(HW_LOG_RD_DATA_COMPLETED, "RD 0x33 (data read completed) bytes") \
    X(HW_LOG_WR_DATA_COMPLETED, "WR 0x33 (data write completed) bytes") \
    X(HW_LOG_RD_DRIVE, "RD 0x34 (d: status)") \
    X(HW_LOG_WR_DRIVE, "WR 0x34 (d: command)") \
    X(HW_LOG_RD_CONTROLLER, "RD 0x30 (c: status)") \
    X(HW_LOG_WR_TRACK, "WR 0x31 (track)") \
    X(HW_LOG_WR_SECTOR, "WR 0x32 (sector)") \
    X(HW_LOG_WR_CONTROLLER, "WR 0x30 (c: unsupported)") \
    X(HW_LOG_WR_CONTROLLER_R, "WR 0x30 (c: restore, seek track 0)") \
    X(HW_LOG_WR_CONTROLLER_FI, "WR 0x30 (c: force interrupt)") \
    X(HW_LOG_WR_CONTROLLER_RS, "WR 0x30 (c: read sector)") \
    X(HW_LOG_WR_CONTROLLER_WS, "WR 0x30 (c: write sector)") \
    X(HW_LOG_WR_CONTROLLER_SIT, "WR 0x30 (c: step in) to track") \
    X(HW_LOG_WR_CONTROLLER_SOT, "WR 0x30 (c: step out) to track") \
    X(HW_LOG_WR_CONTROLLER_S, "WR 0x30 (c: seek) to track") \
    X(HW_LOG_RD_DENSITY, "RD 0x38 (density & side)") \
    X(HW_LOG_WR_DENSITY, "WR 0x38 (density & side)") \
    X(HW_LOG_PSG_SELECT_15, "PSG select register 15") \
    X(HW_LOG_PSG_DESELECT_15, "PSG deselect register 15") \
    X(HW_LOG_PSG_WRITE_15, "PSG write register 15") \
    X(HW_LOG_PSG_READ_15, "PSG read register 15") \
    X(HW_LOG_PSG_LATCH_WR, "PSG latch write") \
    X(HW_LOG_DISCONNECTED_WARNING, "RD and WR are both low, the edge connector is disconnected?") \
    X(HW_LOG_TAPE_REWIND, "Tape rewind") \
    X(HW_LOG_TAPE_END, "Tape end reached") \
    X(HW_LOG_TAPE_START_WRITE, "Tape start write") \
    X(HW_LOG_TAPE_STOP_WRITE, "Tape stop write") \
    X(HW_LOG_PICO_COMMAND, "Pico command") \
    X(HW_LOG_PICO_WR, "Pico write") \
    X(HW_LOG_DEBUG, "Debug") \
    X(HW_LOG_MREQ_RD_ADDR, "MREQ RD addr") \
    X(HW_LOG_MREQ_RD_VALUE, "MREQ RD value") \
    X(HW_LOG_VDP_0X80, "IORQ WR 0x80 value") \
    X(HW_LOG_VDP_0X81, "IORQ WR 0x81 value") \
    X(HW_LOG_MULTICORE_DISK_TRACK_NOT_READY, "Multicore DISK_TRACK not ready, waiting...") \
    X(HW_LOG_SELECT_DISK_0, "WR 0x34 (d: select disk 0)") \
    X(HW_LOG_SELECT_DISK_1, "WR 0x34 (d: select disk 1)") \
    X(HW_LOG_BIOS_WRITTEN, "BIOS written to Pico") \
    X(HW_LOG_32KB_ROM_WRITTEN, "32KB ROM written to Pico") \
    X(HW_LOG_DESELECT_DISK, "WR 0x34 (d: deselect disk)") \
    X(HW_LOG_CREDENTIALS_RECEIVED, "Credentials received") \
    X(HW_LOG_SAVE_STATE_REQUESTED, "Save state requested") \
    X(HW_LOG_TAPE_FETCH_NEXT_BUFFER, "Tape fetch next buffer") \
    X(HW_LOG_TAPE_NOT_READY, "Tape not ready, waiting for next buffer") \
    X(HW_LOG_MREQ_PREPARE_RD, "MREQ RD prepare") \
    X(HW_LOG_CLEAR, "Hardware log cleared") \
    X(HW_LOG_FILE_COUNT_REQUESTED, "File count requested") \
    X(HW_LOG_FILE_INFORMATION_REQUESTED, "File information requested") \
    X(HW_LOG_FILE_NAME_READ_VALUE, "File name read value") \
    X(HW_LOG_FILE_NAME_INDEX_BYTE, "File name index") \
    X(HW_LOG_SET_FILE_TYPE_FILTER, "Set file type filter") \
    X(HW_LOG_FILE_COUNT_RESPONSE, "File count response byte") \
    X(HW_LOG_FILE_SEND_INDEX_BYTE, "File send index byte") \
    X(HW_LOG_FILE_CHUNK_REQUEST, "File chunk request") \
    X(HW_LOG_FILE_SEND_REQUEST, "File send request") \
    X(HW_LOG_RESET_BUTTON_SHORT_PRESSED, "Reset button short press") \
    X(HW_LOG_RESET_BUTTON_LONG_PRESSED, "Reset button long press") \
    X(HW_LOG_SVI_CONFIG_SAVE_REQUESTED, "SVI config save requested") \
    X(HW_LOG_SVI_CONFIG_READ_COMPLETED, "SVI config read completed") \
    X(HW_LOG_FDC_EMULATION_ENABLED, "FDC emulation enabled (no physical FDC)") \
    X(HW_LOG_FDC_EMULATION_DISABLED, "FDC emulation disabled (physical FDC detected)") \
    X(HW_LOG_HDD_INIT, "HDD emulation initialized (RAM3 loaded)") \
    X(HW_LOG_SASI_RESET, "SASI bus reset (port 40h write)") \
    X(HW_LOG_SASI_SELECT, "SASI target select (port 43h write)") \
    X(HW_LOG_SASI_CMD, "SASI command received (CDB opcode)") \
    X(HW_LOG_SASI_READ, "SASI Read(6) LBA") \
    X(HW_LOG_SASI_WRITE, "SASI Write(6) LBA") \
    X(HW_LOG_SASI_STATUS, "SASI status byte sent") \
    X(HW_LOG_SASI_DETECT, "SASI detection port access") \
    X(HW_LOG_SASI_DATA_IN, "SASI data-in byte read (port 42h)") \
    X(HW_LOG_SASI_DATA_OUT, "SASI data-out byte written (port 41h)") \
    X(HW_LOG_SASI_SET_PARAMS, "SASI SetParameters command") \
    X(HW_LOG_SASI_OUT_OF_RANGE, "SASI LBA out of range (>255)") \
    X(HW_LOG_SASI_MSG_IN, "SASI message-in byte sent") \
    X(HW_LOG_SASI_BUS_STATUS, "SASI bus status read (port 46h)") \
    X(HW_LOG_PPI_KBD_READ, "PPI keyboard read (port 99h, row 6)")

typedef enum {
    #define X(op, str) op,
    HW_LOG_OPS
    #undef X
} hw_log_op_t;
    
typedef struct {
    uint32_t timestamp;
    hw_log_op_t op;
    uint8_t port; // I/O port if applicable
    uint16_t value; // Value if applicable
} hw_log_entry_t;

extern volatile hw_log_entry_t hw_log_buffer[HW_LOG_MAX_ENTRIES];
extern volatile uint32_t hw_log_index;

extern volatile uint16_t server_file_count;
extern volatile uint16_t file_index_request;

extern volatile uint8_t sasi_phase;
extern volatile uint8_t sasi_status_byte;

#define SASI_PHASE_BUSY  0x07  // Z80 polls, sees unrecognized phase, keeps polling
#define HDD_OP_READ  0
#define HDD_OP_WRITE 1

extern volatile uint8_t HDD_READ_SECTOR[256];
extern volatile uint8_t HDD_WRITE_SECTOR[256];
extern volatile uint32_t hdd_read_sector_lba;
extern volatile uint32_t hdd_write_sector_lba;
extern volatile uint32_t hdd_request_lba;
extern volatile uint32_t hdd_total_lbas;
extern volatile bool hdd_read_sector_valid;
extern volatile bool hdd_op_complete;
extern volatile uint8_t hdd_op_type;
extern volatile bool hdd_request_pending;
extern volatile uint16_t hdd_sectors_remaining;
extern volatile uint16_t sasi_sector_offset;
extern volatile uint32_t current_write_lba;