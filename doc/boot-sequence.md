# Boot Sequence

When the SVI-328 is powered on with the PicoExpander installed, the following boot sequence occurs:

## 1. Initial Hardware State (Power-On)

- The PicoExpander holds both **RAMDIS** and **ROMDIS** signals **LOW** (disabled)
- This disables the SVI-328's internal boot ROM and internal RAM
- The Z80 CPU starts executing from address `0x0000`, with the PicoExpander providing all code and memory

## 2. PicoExpander Initialization (Core 1)

The PicoExpander's second core (`core1_entry()`) initializes the system:

- Sets `inject_type = INJECT_TYPE_PREPARE` to enter prepare mode
- Calls `launcher_initialization()` which:
  - Sets `boot_to_launcherrom = true`
  - Copies `LAUNCHER_BOOTSECTOR` into the disk track buffer
  - Copies `LAUNCHER_BK3X` into RAM3 (BK31/BK32 memory banks)
- Calls `boot_initialization()` to configure initial system state
- **Copies the [PREPARE code](../rom/asm/prepare.asm) into the BIOS buffer** - this is what the Z80 will execute first

## 3. Prepare Phase Execution

The `prepare()` function runs while in `INJECT_TYPE_PREPARE` mode:

### What the Z80 CPU sees:

- The PicoExpander initially feeds `0xC7` (RST 00h) instructions until the CPU reads from address `0x0000`
- Once at `0x0000`, the PicoExpander provides the **[PREPARE.ASM](../rom/asm/prepare.asm)** code from the BIOS buffer
- The PREPARE code executes from the lower memory bank (0x0000-0x7FFF)

### What PREPARE.ASM does:

1. Configures PSG register 15 for bank selection (CAPS LOCK off, no memory banks enabled initially)
2. Moves itself from the ROM area to RAM at `0x8000`
3. Checks if a cartridge ROM is present and if it is, backs it up by sending it to PicoExpander with command `0x05` (PE_WRITE_32KB_ROM)
4. Signals Pico with command `0x04` (PE_WRITE_BIOS) to I/O port `0x13`, which:
   - Signals the PicoExpander to expect BIOS data on port `0x14`
   - **Temporarily sets /ROMDIS HIGH** to expose the built-in BIOS
5. **Sets /ROMDIS LOW** to disable the built-in BIOS and switch to PicoExpander-emulated BIOS
6. Jumps to address `0x7B64` in the (now PicoExpander-hosted) BIOS to continue the normal cold start sequence

## 4. Normal Emulation Mode

After the prepare phase completes, the `floppy_and_ram_emulation()` function takes over on Core 1:

The PicoExpander now fully emulates:

- **Memory banks**:
  - Lower bank (0x0000-0x7FFF): The uploaded BIOS ROM
  - Upper bank (0x8000-0xFFFF): RAM0 (BK02)
- **Floppy disk controller**: FDC I/O ports 0x30-0x38
- **Cassette tape emulation**: I/O ports 0x64-0x65
- **Video Display Processor (VDP)**: I/O ports 0x80, 0x81, 0x84, 0x85
- **Programmable Sound Generator (PSG)**: I/O ports 0x88, 0x8C
- **Custom PicoExpander control ports**: 0x13-0x18

## 5. Launcher Boot Sector Emulation

When the BIOS attempts to boot from the floppy disk:

- Because `boot_to_launcherrom = true`, the PicoExpander serves the **LAUNCHER_BOOTSECTOR** instead of a real disk
- This minimal bootsector code:
  - Configures PSG register 15 to select BK31 and BK02 memory banks
  - Jumps to address `0x0003`, which is now in RAM3 (BK31) where LAUNCHER_BK3X was copied
- The launcher menu code in RAM3 takes control and displays the PicoExpander menu
- After the first sector read completes, `boot_to_launcherrom` is set to `false`, so subsequent disk I/O operations use actual disk data from flash memory
