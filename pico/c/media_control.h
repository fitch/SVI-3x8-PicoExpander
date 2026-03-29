/**
 * SVI-3x8 PicoExpander - Media Control
 * 
 * Copyright (c) 2026 Markus Rautopuro
 * 
 * Functions for media control operations executed on core0.
 */

#ifndef MEDIA_CONTROL_H
#define MEDIA_CONTROL_H

void apply_bios_patch(void);
void revert_bios_patch(void);
void eject_disk_0(void);
void eject_disk_1(void);
void eject_cartridge(void);
void eject_tape(void);
void load_bk11_to_cartridge(void);
void load_bootsector_to_cartridge(void);

extern bool bios_patched;

#endif // MEDIA_CONTROL_H
