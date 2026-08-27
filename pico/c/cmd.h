/**
 * SVI-3x8 PicoExpander — v2 Command Layer
 *
 * Parses MessagePack messages and dispatches to command handlers.
 * Sits on top of the framing layer (frame.h).
 *
 * Copyright (c) 2026 Markus Rautopuro
 */

#ifndef CMD_H
#define CMD_H

#include <stdint.h>

// Called by the framing layer when a complete frame payload arrives.
void cmd_on_message(uint8_t priority, const uint8_t *payload, uint32_t len);

// Outbound commands (Pico → Server)
void cmd_send_catalog_get(uint16_t offset);
void cmd_send_catalog_filter(uint8_t filter);
void cmd_send_file_get(uint16_t index);

// Save state upload (Pico → Server)
void cmd_send_save_state(void);
void cmd_save_state_poll(void);

// Memory dump poll (Pico → Server): dump_bk4x, dump_bios, dump_disk
void cmd_dump_poll(void);

// HDD sector operations (Pico → Server)
void cmd_hdd_read(uint32_t lba);
void cmd_hdd_write(uint32_t lba);

#endif /* CMD_H */
