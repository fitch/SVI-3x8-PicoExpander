;******************************************************************************
; SVI-3x8 PicoExpander
; (c) 2026 Markus Rautopuro
;
; Bootloader / Prepare code
;
; Compiled to build/prepare.rom -> build/prepare.h
;
        org 0x0000

        di
        ld sp, 0xf4f6               ; Same as in BIOS ROM

        ld a, 0x0f                  ; Prepare PSG bank selector (port 15)
        out (PSG_ADDRESS_LATCH), a
        ld a, 0b11011111            ; Do not enable any bank selector, caps lock off
        out (PSG_DATA_WRITE), a
        ld a, 0x07
        out (PSG_ADDRESS_LATCH), a
        ld a, 0b10000000            ; Set PSG to output port B (makes bank selector active)
        out (PSG_DATA_WRITE), a
        ld a, 0x0f                  ; Prepare PSG bank selector (port 15)
        out (PSG_ADDRESS_LATCH), a

        ld hl, PREPARE_ROM_START
        ld de, PREPARE_RAM_START
        ld bc, PREPARE_SIZE
        ldir

        jp PREPARE_RAM_START

PREPARE_ROM_START:
        phase 0x8000
PREPARE_RAM_START:
        ld a, PE_COMMAND_STOP_SERVING_PREPARE
        out (PE_COMMAND_PORT), a

        ld a, 0b11011110            ; Select cart visible, caps lock off
        out (PSG_DATA_WRITE), a

        ld hl, (0) ;rdlow-ok
        ld de, 0x31f3               ; CART signature
        xor a
        sbc hl,de
        jp nz,.skip_cart            ; No booting cart found

        ld a, PE_WRITE_32KB_ROM     ; Write cart data to PicoExpander
        out (PE_COMMAND_PORT), a

        call copy_rom

.skip_cart:
        ld a, 0b11011111            ; Do not enable any bank selector, caps lock off
        out (PSG_DATA_WRITE), a

        ld a, PE_WRITE_BIOS         ; Write BIOS data to PicoExpander
        out (PE_COMMAND_PORT), a    ; Also, switch BIOS ROM to lower bank

        call copy_rom

        ld a, PE_WRITE_TERMINATE    ; Terminate write
        out (PE_COMMAND_PORT), a    ; Also, switch ROMDIS back on to start with emulated BIOS

        ; Floppy disk controller detection
        ld a, 0x55
        out (FDC_SECTOR_REGISTER), a
        ld b, 0
.fdc_wait1:
        djnz .fdc_wait1
        in a, (FDC_SECTOR_REGISTER)
        cp 0x55
        jr nz, .no_fdc

        ld a, 0xaa
        out (FDC_SECTOR_REGISTER), a
        ld b, 0
.fdc_wait2:
        djnz .fdc_wait2
        in a, (FDC_SECTOR_REGISTER)
        cp 0xaa
        jr nz, .no_fdc

        ld a, 0b00000000            ; FDC detected: disable FDC emulation
        jr .set_feature_flags

.no_fdc:
        ld a, 0b00000001            ; No FDC: enable FDC emulation

.set_feature_flags:
        ld c, a                     ; Save feature flags
        ld a, PE_COMMAND_FEATURE_FLAGS
        out (PE_COMMAND_PORT), a
        ld a, c
        out (PE_DATA_PORT), a

        ld a, PE_COMMAND_MEDIA_CONTROL
        out (PE_COMMAND_PORT), a
        ld a, 0b00100000            ; Copy bootsector code to BK11 (ROM cartridge)
        out (PE_DATA_PORT), a

        jp SVI_ROM_INIT_INITIO      ; Continue cold start after wait & setting banks (done already)

copy_rom:
        ld a, 0x80                  ; 128 * 256 = 32 768 bytes
        ld hl, 0
        ld bc, PE_DATA_PORT
.loop:
        otir
        dec a
        jp nz,.loop
        ret

        dephase

PREPARE_SIZE            equ $ - PREPARE_ROM_START

PSG_ADDRESS_LATCH       equ 0x88
PSG_DATA_WRITE          equ 0x8c
PSG_DATA_READ           equ 0x90

SVI_ROM_INIT_INITIO     equ 0x7b64

PE_WRITE_TERMINATE      equ 0x03
PE_WRITE_BIOS           equ 0x04
PE_WRITE_32KB_ROM       equ 0x05

PE_COMMAND_FEATURE_FLAGS equ #51
PE_COMMAND_MEDIA_CONTROL equ #52
PE_COMMAND_STOP_SERVING_PREPARE equ #6

PE_COMMAND_PORT         equ 0x13
PE_DATA_PORT            equ 0x14
PE_DEBUG_PORT           equ 0x17

FDC_SECTOR_REGISTER     equ 0x32
