/**
 * SVI-3x8 PicoExpander — v2 Command Layer
 *
 * Copyright (c) 2026 Markus Rautopuro
 */

#include <string.h>
#include "pico/stdlib.h"
#include "hardware/flash.h"
#include "hardware/sync.h"

#include "cmd.h"
#include "frame.h"
#include "log.h"
#include "svi-328-expander-bus.h"
#include "media_control.h"
#include "wifi.h"
#include "mpack.h"

// Sequence number counter for outbound commands
static uint16_t next_seq = 0;

// CRC-16/CCITT (poly 0x1021, init 0xFFFF)
static uint16_t crc16(const uint8_t *data, size_t len) {
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (int j = 0; j < 8; j++) {
            crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
        }
    }
    return crc;
}

// ---------------------------------------------------------------------------
// MessagePack encoding helpers
// ---------------------------------------------------------------------------

static size_t encode_ack(uint8_t *buf, size_t buf_size, uint16_t seq) {
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)buf, buf_size);

    mpack_start_map(&w, 2);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "ack");
    mpack_write_cstr(&w, "s");
    mpack_write_u16(&w, seq);
    mpack_finish_map(&w);

    size_t used = mpack_writer_buffer_used(&w);
    if (mpack_writer_destroy(&w) != mpack_ok) return 0;
    return used;
}

// ---------------------------------------------------------------------------
// Message dispatch parsing — extracts t, c, s for routing
// ---------------------------------------------------------------------------

typedef struct {
    char type[8];
    char cmd[32];
    uint16_t seq;
    bool has_seq;
} msg_header_t;

static bool parse_header(const uint8_t *payload, uint32_t len, msg_header_t *hdr) {
    memset(hdr, 0, sizeof(*hdr));

    mpack_reader_t r;
    mpack_reader_init_data(&r, (const char *)payload, len);

    uint32_t map_count = mpack_expect_map(&r);
    if (mpack_reader_error(&r) != mpack_ok) return false;

    for (uint32_t i = 0; i < map_count; i++) {
        char key[16] = {0};
        mpack_expect_cstr(&r, key, sizeof(key));
        if (mpack_reader_error(&r) != mpack_ok) break;

        if (strcmp(key, "t") == 0) {
            mpack_expect_cstr(&r, hdr->type, sizeof(hdr->type));
        } else if (strcmp(key, "c") == 0) {
            mpack_expect_cstr(&r, hdr->cmd, sizeof(hdr->cmd));
        } else if (strcmp(key, "s") == 0) {
            hdr->seq = mpack_expect_u16(&r);
            hdr->has_seq = true;
        } else {
            mpack_discard(&r);
        }
    }
    mpack_done_map(&r);

    return mpack_reader_destroy(&r) == mpack_ok;
}

// ---------------------------------------------------------------------------
// Command: ping
// ---------------------------------------------------------------------------

static void handle_ping(uint16_t seq) {
    uint8_t buf[32];
    size_t ack_len = encode_ack(buf, sizeof(buf), seq);
    if (ack_len > 0) {
        frame_queue_send(FRAME_PRI_NORMAL, buf, ack_len);
    }
}

// ---------------------------------------------------------------------------
// Command: boot (reboot to launcher)
// ---------------------------------------------------------------------------

static void handle_boot(uint16_t seq) {
    log_message("Boot command received, injecting boot...");

    pico_state = PICO_STATE_INJECTING_BOOT;
    inject_type = INJECT_TYPE_BOOT;

    while (pico_state == PICO_STATE_INJECTING_BOOT) {
        sleep_ms(10);
    }

    bool success = (pico_state == PICO_STATE_BOOT_SUCCESS);
    if (success) {
        log_message("Boot to launcher successful");
    } else {
        log_message("Error: Boot to launcher failed (state=%d)", pico_state);
    }

    pico_state = PICO_STATE_CLIENT_CONNECTED;

    // Send ack with result
    uint8_t buf[48];
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)buf, sizeof(buf));
    mpack_start_map(&w, 3);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "ack");
    mpack_write_cstr(&w, "s");
    mpack_write_u16(&w, seq);
    mpack_write_cstr(&w, "ok");
    mpack_write_bool(&w, success);
    mpack_finish_map(&w);
    size_t ack_len = mpack_writer_buffer_used(&w);
    if (mpack_writer_destroy(&w) == mpack_ok && ack_len > 0) {
        frame_queue_send(FRAME_PRI_NORMAL, buf, ack_len);
    }
}

// ---------------------------------------------------------------------------
// Command: hw_log
// ---------------------------------------------------------------------------

static void handle_hw_log(uint16_t seq) {
    uint32_t count = hw_log_index;
    bool overflow = count >= HW_LOG_MAX_ENTRIES;
    if (count > HW_LOG_MAX_ENTRIES) count = HW_LOG_MAX_ENTRIES;

    size_t data_size = count * sizeof(hw_log_entry_t);
    uint8_t env[80];
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)env, sizeof(env));

    mpack_start_map(&w, 5);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "ack");
    mpack_write_cstr(&w, "s");
    mpack_write_u16(&w, seq);
    mpack_write_cstr(&w, "count");
    mpack_write_u32(&w, count);
    mpack_write_cstr(&w, "overflow");
    mpack_write_bool(&w, overflow);
    mpack_write_cstr(&w, "d");

    size_t env_used = mpack_writer_buffer_used(&w);
    env[env_used++] = 0xc6; // bin32
    env[env_used++] = (data_size >> 24) & 0xFF;
    env[env_used++] = (data_size >> 16) & 0xFF;
    env[env_used++] = (data_size >> 8) & 0xFF;
    env[env_used++] = data_size & 0xFF;

    frame_queue_drain();

    log_message("Hardware log sending env=%u data=%u", (unsigned)env_used, (unsigned)data_size);

    err_t err = frame_send_direct_parts(FRAME_PRI_NORMAL,
                            env, env_used,
                            (const uint8_t *)hw_log_buffer, data_size);
    if (err != ERR_OK) {
        log_message("Error: Hardware log send failed: %d", err);
    } else {
        // Reset only on success so a transient send failure doesn't lose the log
        hw_log_index = 0;
        hw_log_buffer[HW_LOG_MAX_ENTRIES - 1].timestamp = 0;
    }
}

// ---------------------------------------------------------------------------
// Command: catalog_update (server → pico)
// ---------------------------------------------------------------------------

static void handle_catalog_update(uint16_t seq, const uint8_t *payload, uint32_t len) {
    mpack_reader_t r;
    mpack_reader_init_data(&r, (const char *)payload, len);

    uint32_t map_count = mpack_expect_map(&r);
    if (mpack_reader_error(&r) != mpack_ok) return;

    uint16_t offset = 0;
    uint16_t total = 0;
    uint8_t filter = 0;

    for (uint32_t i = 0; i < map_count; i++) {
        char key[16] = {0};
        mpack_expect_cstr(&r, key, sizeof(key));
        if (mpack_reader_error(&r) != mpack_ok) break;

        if (strcmp(key, "offset") == 0) {
            offset = mpack_expect_u16(&r);
        } else if (strcmp(key, "total") == 0) {
            total = mpack_expect_u16(&r);
        } else if (strcmp(key, "filter") == 0) {
            filter = mpack_expect_u8(&r);
        } else if (strcmp(key, "d") == 0) {
            size_t bin_len = mpack_expect_bin(&r);
            if (mpack_reader_error(&r) == mpack_ok && bin_len <= sizeof(FILE_CACHE)) {
                mpack_read_bytes(&r, (char *)FILE_CACHE, bin_len);
                mpack_done_bin(&r);
            } else {
                mpack_discard(&r);
            }
        } else {
            mpack_discard(&r);
        }
    }
    mpack_done_map(&r);
    mpack_reader_destroy(&r);

    // Update file cache state
    file_cache_start_index = offset;
    server_file_count = total;
    file_type_filter = filter;

    uint16_t remaining_files = total - offset;
    file_cache_count = (remaining_files < 256) ? remaining_files : 256;

    file_server_status = FILE_SERVER_ACTIVE_IDLE;

    log_message("Catalog updated: offset=%d, total=%d, filter=%d, count=%d",
                offset, total, filter, file_cache_count);

    // Send ack
    uint8_t buf[32];
    size_t ack_len = encode_ack(buf, sizeof(buf), seq);
    if (ack_len > 0) {
        frame_queue_send(FRAME_PRI_NORMAL, buf, ack_len);
    }
}

// ---------------------------------------------------------------------------
// Command: file_begin / data (file transfer, server → pico)
// ---------------------------------------------------------------------------

#define CHUNK_SIZE 16384

// Buffer for flash writes (disk/tape) — must be CHUNK_SIZE for flash_range_erase/program
static uint8_t flash_chunk[CHUNK_SIZE];

// Active file transfer state
static struct {
    bool active;
    uint16_t seq;           // Sequence number of the file_begin command
    char type[16];          // "rom", "disk", "cassette", "savestate"
    uint32_t size;          // Total expected bytes
    uint32_t block_size;    // Bytes per block
    uint32_t received;      // Bytes received so far
    uint16_t next_block;    // Next expected block number
    uint32_t flash_base;    // Flash base offset for disk/tape
    uint8_t bank_config;    // For savestate: which banks are present
} file_xfer;

static size_t encode_block_ack(uint8_t *buf, size_t buf_size, uint16_t seq, uint16_t block) {
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)buf, buf_size);

    mpack_start_map(&w, 3);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "ack");
    mpack_write_cstr(&w, "s");
    mpack_write_u16(&w, seq);
    mpack_write_cstr(&w, "block");
    mpack_write_u16(&w, block);
    mpack_finish_map(&w);

    size_t used = mpack_writer_buffer_used(&w);
    if (mpack_writer_destroy(&w) != mpack_ok) return 0;
    return used;
}

static void handle_file_begin(uint16_t seq, const uint8_t *payload, uint32_t len) {
    if (file_xfer.active) {
        log_message("file_begin while transfer active, aborting previous");
    }

    mpack_reader_t r;
    mpack_reader_init_data(&r, (const char *)payload, len);

    uint32_t map_count = mpack_expect_map(&r);
    if (mpack_reader_error(&r) != mpack_ok) return;

    memset(&file_xfer, 0, sizeof(file_xfer));

    for (uint32_t i = 0; i < map_count; i++) {
        char key[16] = {0};
        mpack_expect_cstr(&r, key, sizeof(key));
        if (mpack_reader_error(&r) != mpack_ok) break;

        if (strcmp(key, "type") == 0) {
            mpack_expect_cstr(&r, file_xfer.type, sizeof(file_xfer.type));
        } else if (strcmp(key, "size") == 0) {
            file_xfer.size = mpack_expect_u32(&r);
        } else if (strcmp(key, "block_size") == 0) {
            file_xfer.block_size = mpack_expect_u32(&r);
        } else if (strcmp(key, "bank_config") == 0) {
            file_xfer.bank_config = mpack_expect_u8(&r);
        } else {
            mpack_discard(&r);
        }
    }
    mpack_done_map(&r);
    mpack_reader_destroy(&r);

    file_xfer.active = true;
    file_xfer.seq = seq;
    file_xfer.received = 0;
    file_xfer.next_block = 0;

    if (strcmp(file_xfer.type, "disk") == 0) {
        file_xfer.flash_base = MEDIA_DISK_OFFSET;
        pico_state = PICO_STATE_RECEIVING_DISK;
    } else if (strcmp(file_xfer.type, "cassette") == 0) {
        file_xfer.flash_base = MEDIA_TAPE_OFFSET;
        pico_state = PICO_STATE_RECEIVING_TAPE;
    } else if (strcmp(file_xfer.type, "rom") == 0) {
        pico_state = PICO_STATE_RECEIVING_ROM;
    } else if (strcmp(file_xfer.type, "savestate") == 0) {
        pico_state = PICO_STATE_RECEIVING_SAVE_STATE;
    }

    log_message("file_begin type=%s size=%lu block_size=%lu",
                file_xfer.type, (unsigned long)file_xfer.size,
                (unsigned long)file_xfer.block_size);

    // Ack the file_begin
    uint8_t buf[32];
    size_t ack_len = encode_ack(buf, sizeof(buf), seq);
    if (ack_len > 0) {
        frame_queue_send(FRAME_PRI_NORMAL, buf, ack_len);
    }
}

// Dispatch a chunk of save state data to the correct memory regions.
// Data layout: [1 byte bank_config] [RAM4_DUMP_SIZE] [BK01?] [BK02?] ... [BK32?]
// `data` is the chunk, `data_len` bytes, starting at global offset `global_offset`.
static void savestate_dispatch(const uint8_t *data, size_t data_len,
                               uint32_t global_offset, uint8_t bank_config) {
    // Compute region boundaries
    size_t bk01_size = (bank_config & BANK_CONFIG_BK01) ? BANK_SIZE : 0;
    size_t bk02_size = (bank_config & BANK_CONFIG_BK02) ? BANK_SIZE : 0;
    size_t bk11_size = (bank_config & BANK_CONFIG_BK11) ? BANK_SIZE : 0;
    size_t bk12_size = (bank_config & BANK_CONFIG_BK12) ? BANK_SIZE : 0;
    size_t bk21_size = (bank_config & BANK_CONFIG_BK21) ? BANK_SIZE : 0;
    size_t bk22_size = (bank_config & BANK_CONFIG_BK22) ? BANK_SIZE : 0;
    size_t bk31_size = (bank_config & BANK_CONFIG_BK31) ? BANK_SIZE : 0;
    size_t bk32_size = (bank_config & BANK_CONFIG_BK32) ? BANK_SIZE : 0;

    // Region start offsets (cumulative)
    size_t ram4_start = 1;  // After 1-byte bank_config prefix
    size_t bk01_start = ram4_start + RAM4_DUMP_SIZE;
    size_t bk02_start = bk01_start + bk01_size;
    size_t bk11_start = bk02_start + bk02_size;
    size_t bk12_start = bk11_start + bk11_size;
    size_t bk21_start = bk12_start + bk12_size;
    size_t bk22_start = bk21_start + bk21_size;
    size_t bk31_start = bk22_start + bk22_size;
    size_t bk32_start = bk31_start + bk31_size;

    // Region table: [start_offset, size, destination pointer]
    struct { size_t start; size_t size; volatile uint8_t *dest; } regions[] = {
        { 0,          1,             NULL },                                    // bank_config byte (skip)
        { ram4_start, RAM4_DUMP_SIZE, &RAM4[RAM4_DUMP_START] },                // RAM4
        { bk01_start, bk01_size,     BIOS },                                   // BK01
        { bk02_start, bk02_size,     RAM0 },                                   // BK02
        { bk11_start, bk11_size,     ROM_CARTRIDGE },                          // BK11
        { bk12_start, bk12_size,     (volatile uint8_t *)ROM_CARTRIDGE + BANK_SIZE }, // BK12
        { bk21_start, bk21_size,     RAM2 },                                   // BK21
        { bk22_start, bk22_size,     (volatile uint8_t *)RAM2 + BANK_SIZE },   // BK22
        { bk31_start, bk31_size,     RAM3 },                                   // BK31
        { bk32_start, bk32_size,     (volatile uint8_t *)RAM3 + BANK_SIZE },   // BK32
    };

    size_t pos = 0;
    size_t offset = global_offset;

    for (size_t r = 0; r < sizeof(regions)/sizeof(regions[0]) && pos < data_len; r++) {
        size_t region_end = regions[r].start + regions[r].size;
        if (regions[r].size == 0 || offset >= region_end) continue;

        size_t region_off = (offset > regions[r].start) ? offset - regions[r].start : 0;
        size_t skip = (offset < regions[r].start) ? regions[r].start - offset : 0;

        if (skip > 0) {
            // Data chunk hasn't reached this region yet
            if (skip >= data_len - pos) break;
            pos += skip;
            offset += skip;
            region_off = 0;
        }

        size_t space = regions[r].size - region_off;
        size_t avail = data_len - pos;
        size_t to_copy = (avail < space) ? avail : space;

        if (regions[r].dest != NULL) {
            memcpy((void *)(regions[r].dest + region_off), data + pos, to_copy);
        }
        // else: skip (bank_config byte)

        pos += to_copy;
        offset += to_copy;
    }
}

static void handle_data(uint16_t seq, const uint8_t *payload, uint32_t len) {
    if (!file_xfer.active) {
        log_message("Error: Data received with no active transfer");
        return;
    }

    mpack_reader_t r;
    mpack_reader_init_data(&r, (const char *)payload, len);

    uint32_t map_count = mpack_expect_map(&r);
    if (mpack_reader_error(&r) != mpack_ok) return;

    uint16_t block = 0;
    size_t bin_len = 0;
    bool got_data = false;

    for (uint32_t i = 0; i < map_count; i++) {
        char key[16] = {0};
        mpack_expect_cstr(&r, key, sizeof(key));
        if (mpack_reader_error(&r) != mpack_ok) break;

        if (strcmp(key, "block") == 0) {
            block = mpack_expect_u16(&r);
        } else if (strcmp(key, "d") == 0) {
            bin_len = mpack_expect_bin(&r);
            if (mpack_reader_error(&r) == mpack_ok && bin_len > 0) {
                if (strcmp(file_xfer.type, "rom") == 0) {
                    // ROM: write directly to ROM_CARTRIDGE
                    if (file_xfer.received + bin_len <= 65536) {
                        mpack_read_bytes(&r, (char *)&ROM_CARTRIDGE[file_xfer.received], bin_len);
                    } else {
                        mpack_skip_bytes(&r, bin_len);
                    }
                } else if (strcmp(file_xfer.type, "launcher") == 0) {
                    // Launcher ROM: write directly to RAM4
                    if (file_xfer.received + bin_len <= 65536) {
                        mpack_read_bytes(&r, (char *)&RAM4[file_xfer.received], bin_len);
                    } else {
                        mpack_skip_bytes(&r, bin_len);
                    }
                } else if (strcmp(file_xfer.type, "disk") == 0 || strcmp(file_xfer.type, "cassette") == 0) {
                    // Disk/tape: read into flash_chunk, then write to flash
                    size_t to_read = bin_len <= CHUNK_SIZE ? bin_len : CHUNK_SIZE;
                    mpack_read_bytes(&r, (char *)flash_chunk, to_read);
                    if (bin_len > CHUNK_SIZE) mpack_skip_bytes(&r, bin_len - CHUNK_SIZE);

                    // FIXME: Programs a full CHUNK_SIZE regardless of to_read, so a short block
                    // writes up to 16 kB of stale flash_chunk leftovers into flash. Only masked
                    // because the server pads blocks (padToChunks in js/lib/commands/DiskLoader.js).
                    // FIXME: The offset comes from file_xfer.received, which advances by the actual
                    // bin_len, so erase alignment depends entirely on the server sending exactly
                    // CHUNK_SIZE blocks. A short block misaligns flash_range_erase, and -DNDEBUG
                    // compiles out the SDK's alignment checks, so it would corrupt silently.
                    uint32_t ints = save_and_disable_interrupts();
                    flash_range_erase(file_xfer.flash_base + file_xfer.received, CHUNK_SIZE);
                    flash_range_program(file_xfer.flash_base + file_xfer.received, flash_chunk, CHUNK_SIZE);
                    restore_interrupts(ints);
                } else if (strcmp(file_xfer.type, "savestate") == 0) {
                    // Save state: read into flash_chunk, then dispatch to memory regions
                    size_t to_read = bin_len <= CHUNK_SIZE ? bin_len : CHUNK_SIZE;
                    mpack_read_bytes(&r, (char *)flash_chunk, to_read);
                    if (bin_len > CHUNK_SIZE) mpack_skip_bytes(&r, bin_len - CHUNK_SIZE);
                    savestate_dispatch(flash_chunk, to_read, file_xfer.received, file_xfer.bank_config);
                } else {
                    mpack_skip_bytes(&r, bin_len);
                }
                mpack_done_bin(&r);
                got_data = true;
            }
        } else {
            mpack_discard(&r);
        }
    }
    mpack_done_map(&r);
    mpack_reader_destroy(&r);

    if (!got_data) {
        log_message("Error: Data block %d has no payload", block);
        return;
    }

    file_xfer.received += bin_len;
    file_xfer.next_block = block + 1;

    // Check if transfer is complete
    bool complete = file_xfer.received >= file_xfer.size;

    if (complete) {
        // Finalize and compute CRC16
        uint16_t crc = 0;
        if (strcmp(file_xfer.type, "rom") == 0) {
            crc = crc16((const uint8_t *)ROM_CARTRIDGE, file_xfer.size);
            pico_state = PICO_STATE_ROM_READY;
        } else if (strcmp(file_xfer.type, "disk") == 0) {
            extern const uint8_t __media_disk[];
            crc = crc16(__media_disk, file_xfer.size);
            disk_size = file_xfer.received;
            pico_state = PICO_STATE_DISK_READY;
        } else if (strcmp(file_xfer.type, "cassette") == 0) {
            extern const uint8_t __media_tape[];
            crc = crc16(__media_tape, file_xfer.size);
            apply_bios_patch();
            memcpy((void *)TAPE_BUFFER, (void *)__media_tape, TAPE_BUFFER_SIZE);
            tape_size = file_xfer.received;
            pico_state = PICO_STATE_TAPE_READY;
        } else if (strcmp(file_xfer.type, "savestate") == 0) {
            crc = crc16((const uint8_t *)&RAM4[RAM4_DUMP_START], RAM4_DUMP_SIZE);
            pico_state = PICO_STATE_SAVE_STATE_READY;
        } else if (strcmp(file_xfer.type, "launcher") == 0) {
            crc = crc16((const uint8_t *)RAM4, file_xfer.size);
            skip_ram4_init = true;
            // Trigger boot to launcher
            pico_state = PICO_STATE_INJECTING_BOOT;
            inject_type = INJECT_TYPE_BOOT;
            while (pico_state == PICO_STATE_INJECTING_BOOT) {
                sleep_ms(10);
            }
            if (pico_state == PICO_STATE_BOOT_SUCCESS) {
                log_message("Launcher boot successful");
            } else {
                log_message("Error: Launcher boot failed (state=%d)", pico_state);
            }
            pico_state = PICO_STATE_CLIENT_CONNECTED;
        }

        // Send final ack with CRC
        uint8_t buf[48];
        mpack_writer_t w;
        mpack_writer_init(&w, (char *)buf, sizeof(buf));
        mpack_start_map(&w, 4);
        mpack_write_cstr(&w, "t");
        mpack_write_cstr(&w, "ack");
        mpack_write_cstr(&w, "s");
        mpack_write_u16(&w, seq);
        mpack_write_cstr(&w, "block");
        mpack_write_u16(&w, block);
        mpack_write_cstr(&w, "crc");
        mpack_write_u16(&w, crc);
        mpack_finish_map(&w);
        size_t ack_len = mpack_writer_buffer_used(&w);
        if (mpack_writer_destroy(&w) == mpack_ok && ack_len > 0) {
            frame_queue_send(FRAME_PRI_NORMAL, buf, ack_len);
        }

        log_message("%s upload complete (%lu bytes, crc=0x%04X)",
                    file_xfer.type, (unsigned long)file_xfer.received, crc);
        file_xfer.active = false;
    } else {
        // Ack this block
        uint8_t buf[48];
        size_t ack_len = encode_block_ack(buf, sizeof(buf), seq, block);
        if (ack_len > 0) {
            frame_queue_send(FRAME_PRI_NORMAL, buf, ack_len);
        }
    }
}

// ---------------------------------------------------------------------------
// Save state upload (Pico → Server)
// ---------------------------------------------------------------------------

#define SAVE_BLOCK_SIZE 8192  // Must fit in TCP_SND_BUF (11680) with frame+envelope overhead

// Multi-buffer descriptor for gathering save state data from non-contiguous regions
#define SAVE_MAX_BUFFERS 10

static struct {
    bool active;
    uint16_t seq;
    uint8_t bank_config;
    uint16_t next_block;
    // Scatter-gather buffers
    const uint8_t *buffers[SAVE_MAX_BUFFERS];
    size_t buffer_sizes[SAVE_MAX_BUFFERS];
    uint8_t buffer_count;
    size_t total_size;
    size_t sent;  // Total bytes sent so far
} save_xfer;

static bool is_bank_empty(const uint8_t *bank, size_t size) {
    for (size_t i = 0; i < size; i++) {
        if (bank[i] != 0xFF) return false;
    }
    return true;
}

static uint8_t scan_bank_config(void) {
    uint8_t config = 0;
    if (!is_bank_empty((const uint8_t *)RAM0, BANK_SIZE))
        config |= BANK_CONFIG_BK02;
    if (!is_bank_empty((const uint8_t *)ROM_CARTRIDGE, BANK_SIZE))
        config |= BANK_CONFIG_BK11;
    if (!is_bank_empty((const uint8_t *)ROM_CARTRIDGE + BANK_SIZE, BANK_SIZE))
        config |= BANK_CONFIG_BK12;
    if (!is_bank_empty((const uint8_t *)RAM2, BANK_SIZE))
        config |= BANK_CONFIG_BK21;
    if (!is_bank_empty((const uint8_t *)RAM2 + BANK_SIZE, BANK_SIZE))
        config |= BANK_CONFIG_BK22;
    if (!is_bank_empty((const uint8_t *)RAM3, BANK_SIZE))
        config |= BANK_CONFIG_BK31;
    if (!is_bank_empty((const uint8_t *)RAM3 + BANK_SIZE, BANK_SIZE))
        config |= BANK_CONFIG_BK32;
    return config;
}

// Copy up to `max` bytes from the scatter-gather buffers starting at global offset `from`.
// Returns number of bytes copied.
static size_t save_gather(uint8_t *out, size_t from, size_t max) {
    size_t copied = 0;
    size_t buf_start = 0;
    for (uint8_t i = 0; i < save_xfer.buffer_count && copied < max; i++) {
        size_t buf_end = buf_start + save_xfer.buffer_sizes[i];
        if (from < buf_end) {
            size_t offset_in_buf = (from > buf_start) ? from - buf_start : 0;
            size_t avail = save_xfer.buffer_sizes[i] - offset_in_buf;
            size_t to_copy = (avail < max - copied) ? avail : max - copied;
            memcpy(out + copied, save_xfer.buffers[i] + offset_in_buf, to_copy);
            copied += to_copy;
            from += to_copy;
        }
        buf_start = buf_end;
    }
    return copied;
}

void cmd_send_save_state(void) {
    if (save_xfer.active) {
        log_message("Error: save state already in progress");
        return;
    }

    uint8_t bank_config = scan_bank_config();
    log_message("Save state bank_config=0x%02X", bank_config);

    // Build scatter-gather list
    memset(&save_xfer, 0, sizeof(save_xfer));
    save_xfer.bank_config = bank_config;

    // First: 1-byte bank config prefix
    static uint8_t bank_config_byte;
    bank_config_byte = bank_config;
    save_xfer.buffers[save_xfer.buffer_count] = &bank_config_byte;
    save_xfer.buffer_sizes[save_xfer.buffer_count] = 1;
    save_xfer.total_size += 1;
    save_xfer.buffer_count++;

    // RAM4 area (always included)
    save_xfer.buffers[save_xfer.buffer_count] = (const uint8_t *)RAM4 + RAM4_DUMP_START;
    save_xfer.buffer_sizes[save_xfer.buffer_count] = RAM4_DUMP_SIZE;
    save_xfer.total_size += RAM4_DUMP_SIZE;
    save_xfer.buffer_count++;

    // Banks (in order, only non-empty ones)
    struct { uint8_t flag; const uint8_t *addr; } banks[] = {
        { BANK_CONFIG_BK02, (const uint8_t *)RAM0 },
        { BANK_CONFIG_BK11, (const uint8_t *)ROM_CARTRIDGE },
        { BANK_CONFIG_BK12, (const uint8_t *)ROM_CARTRIDGE + BANK_SIZE },
        { BANK_CONFIG_BK21, (const uint8_t *)RAM2 },
        { BANK_CONFIG_BK22, (const uint8_t *)RAM2 + BANK_SIZE },
        { BANK_CONFIG_BK31, (const uint8_t *)RAM3 },
        { BANK_CONFIG_BK32, (const uint8_t *)RAM3 + BANK_SIZE },
    };
    for (size_t i = 0; i < sizeof(banks)/sizeof(banks[0]); i++) {
        if (bank_config & banks[i].flag) {
            save_xfer.buffers[save_xfer.buffer_count] = banks[i].addr;
            save_xfer.buffer_sizes[save_xfer.buffer_count] = BANK_SIZE;
            save_xfer.total_size += BANK_SIZE;
            save_xfer.buffer_count++;
        }
    }

    // Send the initial state_save command
    save_xfer.seq = next_seq++;
    save_xfer.next_block = 0;
    save_xfer.sent = 0;
    save_xfer.active = true;
    pico_state = PICO_STATE_SENDING_SAVE_STATE;

    uint8_t buf[128];
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)buf, sizeof(buf));

    uint8_t nfields = 6;
    size_t fn_len = strlen((const char *)save_state_filename);
    if (fn_len > 0) nfields = 7;

    mpack_start_map(&w, nfields);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "cmd");
    mpack_write_cstr(&w, "c");
    mpack_write_cstr(&w, "state_save");
    mpack_write_cstr(&w, "s");
    mpack_write_u16(&w, save_xfer.seq);
    mpack_write_cstr(&w, "bank_config");
    mpack_write_u8(&w, bank_config);
    mpack_write_cstr(&w, "size");
    mpack_write_u32(&w, (uint32_t)save_xfer.total_size);
    mpack_write_cstr(&w, "block_size");
    mpack_write_u32(&w, SAVE_BLOCK_SIZE);
    if (fn_len > 0) {
        mpack_write_cstr(&w, "filename");
        mpack_write_cstr(&w, (const char *)save_state_filename);
    }
    mpack_finish_map(&w);

    size_t used = mpack_writer_buffer_used(&w);
    if (mpack_writer_destroy(&w) == mpack_ok && used > 0) {
        frame_queue_send(FRAME_PRI_NORMAL, buf, used);
    }

    log_message("state_save initiated, %zu bytes in %u buffers",
                save_xfer.total_size, save_xfer.buffer_count);
}

void cmd_save_state_poll(void) {
    if (!save_xfer.active) return;
    if (save_xfer.sent >= save_xfer.total_size) return;

    // Gather the next block of data
    size_t remaining = save_xfer.total_size - save_xfer.sent;
    size_t block_len = (remaining < SAVE_BLOCK_SIZE) ? remaining : SAVE_BLOCK_SIZE;

    // Build msgpack envelope: {t:"data", c:"state_save", s:seq, block:N, d:<bin>}
    uint8_t env[80];
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)env, sizeof(env));

    mpack_start_map(&w, 5);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "data");
    mpack_write_cstr(&w, "c");
    mpack_write_cstr(&w, "state_save");
    mpack_write_cstr(&w, "s");
    mpack_write_u16(&w, save_xfer.seq);
    mpack_write_cstr(&w, "block");
    mpack_write_u16(&w, save_xfer.next_block);
    mpack_write_cstr(&w, "d");

    size_t env_used = mpack_writer_buffer_used(&w);
    // Manually encode bin32 header for the data
    env[env_used++] = 0xc6; // bin32
    env[env_used++] = (block_len >> 24) & 0xFF;
    env[env_used++] = (block_len >> 16) & 0xFF;
    env[env_used++] = (block_len >> 8) & 0xFF;
    env[env_used++] = block_len & 0xFF;

    // Gather data from scatter-gather buffers into flash_chunk (reuse the static buffer)
    size_t gathered = save_gather(flash_chunk, save_xfer.sent, block_len);
    if (gathered != block_len) {
        log_message("Error: Save state gather mismatch: expected %zu, got %zu", block_len, gathered);
        save_xfer.active = false;
        return;
    }

    // Try to send via frame_send_direct_parts
    frame_queue_drain();
    err_t err = frame_send_direct_parts(FRAME_PRI_BULK,
                                        env, env_used,
                                        flash_chunk, block_len);
    if (err != ERR_OK) {
        // TCP buffer full — retry next poll cycle
        return;
    }

    save_xfer.sent += block_len;
    save_xfer.next_block++;

    if (save_xfer.sent >= save_xfer.total_size) {
        log_message("state_save complete (%zu bytes, %u blocks)",
                    save_xfer.total_size, save_xfer.next_block);
        save_xfer.active = false;
        pico_state = PICO_STATE_SAVE_STATE_SENT;
    }
}

// ---------------------------------------------------------------------------
// Memory dump commands (Pico → Server): dump_bk4x, dump_bios, dump_disk
// ---------------------------------------------------------------------------

static struct {
    bool active;
    uint16_t seq;
    char type[16];
    const uint8_t *data;
    uint32_t total_size;
    uint32_t sent;
    uint16_t next_block;
} dump_xfer;

static void cmd_start_dump(const char *type, const uint8_t *data, uint32_t size) {
    if (dump_xfer.active || save_xfer.active) {
        log_message("Error: Dump rejected, transfer already active");
        return;
    }

    memset(&dump_xfer, 0, sizeof(dump_xfer));
    strncpy(dump_xfer.type, type, sizeof(dump_xfer.type) - 1);
    dump_xfer.data = data;
    dump_xfer.total_size = size;
    dump_xfer.seq = next_seq++;
    dump_xfer.active = true;

    // Send initial command
    uint8_t buf[80];
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)buf, sizeof(buf));

    mpack_start_map(&w, 5);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "cmd");
    mpack_write_cstr(&w, "c");
    mpack_write_cstr(&w, type);
    mpack_write_cstr(&w, "s");
    mpack_write_u16(&w, dump_xfer.seq);
    mpack_write_cstr(&w, "size");
    mpack_write_u32(&w, size);
    mpack_write_cstr(&w, "block_size");
    mpack_write_u32(&w, SAVE_BLOCK_SIZE);
    mpack_finish_map(&w);

    size_t used = mpack_writer_buffer_used(&w);
    if (mpack_writer_destroy(&w) == mpack_ok && used > 0) {
        frame_queue_send(FRAME_PRI_NORMAL, buf, used);
    }

    log_message("%s dump initiated, %lu bytes", type, (unsigned long)size);
}

static void handle_dump_bk4x(uint16_t seq) {
    (void)seq;
    pico_state = PICO_STATE_SENDING_BK4X;
    cmd_start_dump("dump_bk4x", (const uint8_t *)RAM4, 65536);
}

static void handle_dump_bios(uint16_t seq) {
    (void)seq;
    pico_state = PICO_STATE_SENDING_BIOS;
    cmd_start_dump("dump_bios", (const uint8_t *)BIOS, 32768);
}

static void handle_dump_disk(uint16_t seq) {
    (void)seq;
    if (disk_size == 0) {
        // Send error ack
        uint8_t buf[48];
        mpack_writer_t w;
        mpack_writer_init(&w, (char *)buf, sizeof(buf));
        mpack_start_map(&w, 3);
        mpack_write_cstr(&w, "t");
        mpack_write_cstr(&w, "err");
        mpack_write_cstr(&w, "s");
        mpack_write_u16(&w, seq);
        mpack_write_cstr(&w, "msg");
        mpack_write_cstr(&w, "no disk");
        mpack_finish_map(&w);
        size_t used = mpack_writer_buffer_used(&w);
        if (mpack_writer_destroy(&w) == mpack_ok && used > 0) {
            frame_queue_send(FRAME_PRI_NORMAL, buf, used);
        }
        return;
    }
    extern const uint8_t __media_disk[];
    pico_state = PICO_STATE_SENDING_DISK;
    cmd_start_dump("dump_disk", __media_disk, disk_size);
}

void cmd_dump_poll(void) {
    if (!dump_xfer.active) return;
    if (dump_xfer.sent >= dump_xfer.total_size) return;

    uint32_t remaining = dump_xfer.total_size - dump_xfer.sent;
    uint32_t block_len = (remaining < SAVE_BLOCK_SIZE) ? remaining : SAVE_BLOCK_SIZE;

    // Build msgpack envelope
    uint8_t env[80];
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)env, sizeof(env));

    mpack_start_map(&w, 5);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "data");
    mpack_write_cstr(&w, "c");
    mpack_write_cstr(&w, dump_xfer.type);
    mpack_write_cstr(&w, "s");
    mpack_write_u16(&w, dump_xfer.seq);
    mpack_write_cstr(&w, "block");
    mpack_write_u16(&w, dump_xfer.next_block);
    mpack_write_cstr(&w, "d");

    size_t env_used = mpack_writer_buffer_used(&w);
    // bin32 header
    env[env_used++] = 0xc6;
    env[env_used++] = (block_len >> 24) & 0xFF;
    env[env_used++] = (block_len >> 16) & 0xFF;
    env[env_used++] = (block_len >> 8) & 0xFF;
    env[env_used++] = block_len & 0xFF;

    frame_queue_drain();
    err_t err = frame_send_direct_parts(FRAME_PRI_BULK,
                                        env, env_used,
                                        dump_xfer.data + dump_xfer.sent, block_len);
    if (err != ERR_OK) {
        return;  // TCP buffer full, retry next poll
    }

    dump_xfer.sent += block_len;
    dump_xfer.next_block++;

    if (dump_xfer.sent >= dump_xfer.total_size) {
        log_message("%s dump complete (%lu bytes, %u blocks)",
                    dump_xfer.type, (unsigned long)dump_xfer.total_size, dump_xfer.next_block);
        dump_xfer.active = false;
        pico_state = PICO_STATE_CLIENT_CONNECTED;
    }
}

// ---------------------------------------------------------------------------
// HDD sector read/write (Pico ↔ Server)
// ---------------------------------------------------------------------------

// Sequence number for matching HDD acks
static uint16_t hdd_pending_seq = 0;

void cmd_hdd_read(uint32_t lba) {
    uint8_t buf[48];
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)buf, sizeof(buf));

    hdd_pending_seq = next_seq++;

    mpack_start_map(&w, 4);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "cmd");
    mpack_write_cstr(&w, "c");
    mpack_write_cstr(&w, "hdd_read");
    mpack_write_cstr(&w, "s");
    mpack_write_u16(&w, hdd_pending_seq);
    mpack_write_cstr(&w, "lba");
    mpack_write_u32(&w, lba);
    mpack_finish_map(&w);

    size_t used = mpack_writer_buffer_used(&w);
    if (mpack_writer_destroy(&w) == mpack_ok && used > 0) {
        frame_queue_send(FRAME_PRI_CRITICAL, buf, used);
    }
}

void cmd_hdd_write(uint32_t lba) {
    // Build envelope + binary sector data
    uint8_t env[64];
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)env, sizeof(env));

    hdd_pending_seq = next_seq++;

    mpack_start_map(&w, 5);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "cmd");
    mpack_write_cstr(&w, "c");
    mpack_write_cstr(&w, "hdd_write");
    mpack_write_cstr(&w, "s");
    mpack_write_u16(&w, hdd_pending_seq);
    mpack_write_cstr(&w, "lba");
    mpack_write_u32(&w, lba);
    mpack_write_cstr(&w, "d");

    size_t env_used = mpack_writer_buffer_used(&w);
    // bin16 header for 256 bytes
    env[env_used++] = 0xcd; // uint16
    // Actually we need bin format, not uint16
    env_used -= 1;
    env[env_used++] = 0xc5; // bin16
    env[env_used++] = 0x01; // 256 >> 8
    env[env_used++] = 0x00; // 256 & 0xFF

    frame_queue_drain();
    frame_send_direct_parts(FRAME_PRI_CRITICAL,
                            env, env_used,
                            (const uint8_t *)HDD_WRITE_SECTOR, 256);
}

// Handle ack for hdd_read: extract sector data into HDD_READ_SECTOR
static void handle_hdd_read_ack(const uint8_t *payload, uint32_t len) {
    mpack_reader_t r;
    mpack_reader_init_data(&r, (const char *)payload, len);

    uint32_t map_count = mpack_expect_map(&r);
    if (mpack_reader_error(&r) != mpack_ok) return;

    for (uint32_t i = 0; i < map_count; i++) {
        char key[16] = {0};
        mpack_expect_cstr(&r, key, sizeof(key));
        if (mpack_reader_error(&r) != mpack_ok) break;

        if (strcmp(key, "d") == 0) {
            size_t bin_len = mpack_expect_bin(&r);
            if (mpack_reader_error(&r) == mpack_ok && bin_len == 256) {
                mpack_read_bytes(&r, (char *)HDD_READ_SECTOR, 256);
                mpack_done_bin(&r);
                hdd_read_sector_lba = hdd_request_lba;
                hdd_read_sector_valid = true;
            } else {
                mpack_discard(&r);
            }
        } else if (strcmp(key, "lba") == 0) {
            uint32_t lba = mpack_expect_u32(&r);
            hdd_read_sector_lba = lba;
        } else {
            mpack_discard(&r);
        }
    }
    mpack_done_map(&r);
    mpack_reader_destroy(&r);

    hdd_op_complete = true;
}

// Handle hdd_load command from server
static void handle_hdd_load(uint16_t seq, const uint8_t *payload, uint32_t len) {
    mpack_reader_t r;
    mpack_reader_init_data(&r, (const char *)payload, len);

    uint32_t map_count = mpack_expect_map(&r);
    if (mpack_reader_error(&r) != mpack_ok) return;

    uint32_t lbas = 0;

    for (uint32_t i = 0; i < map_count; i++) {
        char key[16] = {0};
        mpack_expect_cstr(&r, key, sizeof(key));
        if (mpack_reader_error(&r) != mpack_ok) break;

        if (strcmp(key, "lbas") == 0) {
            lbas = mpack_expect_u32(&r);
        } else if (strcmp(key, "d") == 0) {
            // Sector 0 data pushed with load command
            size_t bin_len = mpack_expect_bin(&r);
            if (mpack_reader_error(&r) == mpack_ok && bin_len == 256) {
                mpack_read_bytes(&r, (char *)HDD_READ_SECTOR, 256);
                mpack_done_bin(&r);
                hdd_read_sector_lba = 0;
                hdd_read_sector_valid = true;
            } else {
                mpack_discard(&r);
            }
        } else {
            mpack_discard(&r);
        }
    }
    mpack_done_map(&r);
    mpack_reader_destroy(&r);

    hdd_total_lbas = lbas;
    log_message("HDD loaded, %lu sectors", (unsigned long)lbas);

    // Ack
    uint8_t buf[32];
    size_t ack_len = encode_ack(buf, sizeof(buf), seq);
    if (ack_len > 0) {
        frame_queue_send(FRAME_PRI_NORMAL, buf, ack_len);
    }
}

// Handle hdd_unload command from server
static void handle_hdd_unload(uint16_t seq) {
    hdd_total_lbas = 0;
    hdd_read_sector_valid = false;
    // Unblock any pending HDD operation
    if (sasi_phase == SASI_PHASE_BUSY) {
        sasi_status_byte = 0x02; // Check Condition
        hdd_op_complete = true;
    }
    log_message("HDD unloaded");

    uint8_t buf[32];
    size_t ack_len = encode_ack(buf, sizeof(buf), seq);
    if (ack_len > 0) {
        frame_queue_send(FRAME_PRI_NORMAL, buf, ack_len);
    }
}

// ---------------------------------------------------------------------------
// Outbound commands (Pico → Server)
// ---------------------------------------------------------------------------

void cmd_send_catalog_get(uint16_t offset) {
    uint8_t buf[64];
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)buf, sizeof(buf));

    mpack_start_map(&w, 4);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "cmd");
    mpack_write_cstr(&w, "c");
    mpack_write_cstr(&w, "catalog_get");
    mpack_write_cstr(&w, "s");
    mpack_write_u16(&w, next_seq++);
    mpack_write_cstr(&w, "offset");
    mpack_write_u16(&w, offset);
    mpack_finish_map(&w);

    size_t used = mpack_writer_buffer_used(&w);
    if (mpack_writer_destroy(&w) == mpack_ok && used > 0) {
        frame_queue_send(FRAME_PRI_NORMAL, buf, used);
    }
}

void cmd_send_catalog_filter(uint8_t filter) {
    uint8_t buf[64];
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)buf, sizeof(buf));

    mpack_start_map(&w, 4);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "cmd");
    mpack_write_cstr(&w, "c");
    mpack_write_cstr(&w, "catalog_filter");
    mpack_write_cstr(&w, "s");
    mpack_write_u16(&w, next_seq++);
    mpack_write_cstr(&w, "filter");
    mpack_write_u8(&w, filter);
    mpack_finish_map(&w);

    size_t used = mpack_writer_buffer_used(&w);
    if (mpack_writer_destroy(&w) == mpack_ok && used > 0) {
        frame_queue_send(FRAME_PRI_NORMAL, buf, used);
    }
}

void cmd_send_file_get(uint16_t index) {
    uint8_t buf[64];
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)buf, sizeof(buf));

    mpack_start_map(&w, 4);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "cmd");
    mpack_write_cstr(&w, "c");
    mpack_write_cstr(&w, "file_get");
    mpack_write_cstr(&w, "s");
    mpack_write_u16(&w, next_seq++);
    mpack_write_cstr(&w, "index");
    mpack_write_u16(&w, index);
    mpack_finish_map(&w);

    size_t used = mpack_writer_buffer_used(&w);
    if (mpack_writer_destroy(&w) == mpack_ok && used > 0) {
        frame_queue_send(FRAME_PRI_NORMAL, buf, used);
    }
}

// ---------------------------------------------------------------------------
// Public API — message dispatch
// ---------------------------------------------------------------------------

void cmd_on_message(uint8_t priority, const uint8_t *payload, uint32_t len) {
    (void)priority;

    msg_header_t hdr;
    if (!parse_header(payload, len, &hdr)) {
        log_message("msgpack parse error");
        return;
    }

    if (strcmp(hdr.type, "cmd") == 0) {
        if (strcmp(hdr.cmd, "ping") == 0) {
            handle_ping(hdr.seq);
        } else if (strcmp(hdr.cmd, "boot") == 0) {
            handle_boot(hdr.seq);
        } else if (strcmp(hdr.cmd, "hw_log") == 0) {
            handle_hw_log(hdr.seq);
        } else if (strcmp(hdr.cmd, "catalog_update") == 0) {
            handle_catalog_update(hdr.seq, payload, len);
        } else if (strcmp(hdr.cmd, "file_begin") == 0) {
            handle_file_begin(hdr.seq, payload, len);
        } else if (strcmp(hdr.cmd, "dump_bk4x") == 0) {
            handle_dump_bk4x(hdr.seq);
        } else if (strcmp(hdr.cmd, "dump_bios") == 0) {
            handle_dump_bios(hdr.seq);
        } else if (strcmp(hdr.cmd, "dump_disk") == 0) {
            handle_dump_disk(hdr.seq);
        } else if (strcmp(hdr.cmd, "hdd_load") == 0) {
            handle_hdd_load(hdr.seq, payload, len);
        } else if (strcmp(hdr.cmd, "hdd_unload") == 0) {
            handle_hdd_unload(hdr.seq);
        } else {
            log_message("Error: Unknown cmd '%s'", hdr.cmd);
        }
    } else if (strcmp(hdr.type, "ack") == 0) {
        // Handle HDD read/write acks
        if (hdr.has_seq && hdr.seq == hdd_pending_seq) {
            if (hdd_op_type == HDD_OP_READ) {
                handle_hdd_read_ack(payload, len);
            } else {
                // Write ack — just signal completion
                hdd_op_complete = true;
            }
        }
    } else if (strcmp(hdr.type, "data") == 0) {
        handle_data(hdr.seq, payload, len);
    } else {
        log_message("Error: Unhandled type '%s'", hdr.type);
    }
}
