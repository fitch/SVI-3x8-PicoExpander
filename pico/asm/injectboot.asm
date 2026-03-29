;******************************************************************************
; SVI-3x8 PicoExpander
; (c) 2026 Markus Rautopuro
;
; Boot injection code - executed when we want to boot SVI
;
; Compiled to build/injectboot.rom -> build/injectboot.h
;
        org 0x0000

INJECT_BOOT:
        REPT 8
        di                          ; Enough dis if we hit a middle of an instruction
        ENDR
        ld a, PSG_REGISTER_R15
        out (PSG_ADDRESS_LATCH), a
        ld a, 0b11011111            ; Do not enable any bank selector, caps lock off 
        out (PSG_DATA_WRITE), a
        rst 0                       ; Jump to BIOS ROM start

PSG_ADDRESS_LATCH       equ 0x88
PSG_DATA_WRITE          equ 0x8c
PSG_REGISTER_R15        equ 0xf
