/**
 * SVI-3x8 PicoExpander - Media Control
 * 
 * Copyright (c) 2026 Markus Rautopuro
 * 
 * Functions for media control operations executed on core0.
 */

#include "pico/stdlib.h"
#include <string.h>

#include "media_control.h"
#include "svi-328-expander-bus.h"
#include "biospatch.h"
#include "launcher_bootsector.h"

static uint8_t BIOSORIGINAL[sizeof(BIOSPATCH)];
bool bios_patched = false;

static void apply_patch(uint8_t *rom, const uint8_t *patch, uint8_t *original) {
    size_t idx = 0;
    uint16_t offset;
    while ((offset = ((const uint16_t *)(patch + idx))[0]) != 0) {
        if (original) {
            ((uint16_t *)(original + idx))[0] = offset;
        }
        idx += 2;
        uint8_t len = patch[idx];
        if (original) {
            original[idx] = len;
        }
        idx++;
        for (uint8_t i = 0; i < len; ++i) {
            if (original) {
                original[idx] = rom[offset + i];
            }
            rom[offset + i] = patch[idx];
            idx++;
        }
    }
    if (original) {
        ((uint16_t *)(original + idx))[0] = 0;
    }
}

void apply_bios_patch(void) {
    if (bios_patched) return;
    apply_patch((uint8_t *)BIOS, BIOSPATCH, BIOSORIGINAL);
    bios_patched = true;
}

void revert_bios_patch(void) {
    if (!bios_patched) return;
    apply_patch((uint8_t *)BIOS, BIOSORIGINAL, NULL);
    bios_patched = false;
}

void eject_disk_0(void) {
    disk_size = 0;
    // NOTE: This does not zero out the flash contents, but disk_size controls whether the disk is available or not
}

void eject_disk_1(void) {
    // TODO: Implement disk 1 support when dual disk is available
}

void eject_cartridge(void) {
    memset((void *)ROM_CARTRIDGE, 0xff, 65536);
}

void eject_tape(void) {
    tape_size = 0;
    tape_index = 0;
    // NOTE: This does not zero out the flash contents, but tape_size controls whether the tape is available or not
}

void load_bk11_to_cartridge(void) {
    memcpy((void *)ROM_CARTRIDGE, (void *)BK11, 32768);
}

void load_bootsector_to_cartridge(void) {
    memcpy((void *)ROM_CARTRIDGE, (void *)LAUNCHER_BOOTSECTOR, LAUNCHER_BOOTSECTOR_len);
}
