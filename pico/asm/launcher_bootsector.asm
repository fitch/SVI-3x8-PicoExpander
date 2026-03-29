;******************************************************************************
; Spectravideo SVI-3x8 PicoExpander
; (c) 2026 Markus Rautopuro
;
; Compiled to build/launcher_bootsector.rom -> build/launcher_bootsector.h
;
; USE_BANK4 is set by the CMake compiler when this is compiled to the Pico
;

    org 0

    di
    ld sp, 0xf21c               ; Same SP when BIOS enters call routine at 0xfac0

    ld a, PSG_REGISTER_R15
    out (PSG_ADDRESS_LATCH), a
    ld a, %11011110             ; CART low, BK02
    out (PSG_DATA_WRITE), a

    ld hl, ROM_START
    ld de, RAM_START
    ld bc, RAM_END - RAM_START
    ldir
    jp RAM_START

ROM_START:
    PHASE 0x8000
RAM_START:
    ld a, PSG_REGISTER_R15
    out (PSG_ADDRESS_LATCH), a
    IFDEF USE_BANK4
    ld a, %11010101             ; BK41, BK02
    ELSE
    ld a, %11010111             ; BK31, BK02
    ENDIF
    out (PSG_DATA_WRITE), a

    ld a, PE_COMMAND_MEDIA_CONTROL
    out (PE_COMMAND_PORT), a

    ld a, 0b00000100            ; Eject cartridge (this code)
    out (PE_DATA_PORT), a

    jp 3                        ; Entry point for bootloader in mainram.asm
RAM_END:
    DEPHASE

PSG_ADDRESS_LATCH       EQU #88
PSG_DATA_WRITE          EQU #8c
PSG_REGISTER_R15        EQU #0f

PE_COMMAND_PORT         EQU #13
PE_DATA_PORT            EQU #14
PE_DEBUG_PORT           EQU #17

PE_COMMAND_MEDIA_CONTROL EQU #52
