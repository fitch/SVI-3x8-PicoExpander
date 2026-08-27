# Boot Sequence

When the SVI-328 is powered on with the PicoExpander installed, the following boot sequence occurs.

There are two distinct bootstrap phases that are easy to confuse, so they are
called out explicitly below:

- **PREPARE** — a one-time, low-level bootstrap that installs the emulated BIOS
  (and snapshots a real cartridge, if present). It runs entirely from the
  emulated `BIOS`/`RAM0` buffers and never touches `ROM_CARTRIDGE`.
- **ROM_CARTRIDGE launcher boot** — how the PicoExpander menu is started: a tiny
  bootstrap is placed in the emulated cartridge slot (`ROM_CARTRIDGE`) so the
  SVI's native cartridge-autostart runs it, and it jumps into the real launcher
  living in `RAM4` (BK4X).

## 1. Initial Hardware State (Power-On)

- The PicoExpander holds both **RAMDIS** and **ROMDIS** signals **LOW** (disabled).
- This disables the SVI-328's internal boot ROM and internal RAM.
- The Z80 CPU starts executing from address `0x0000`, with the PicoExpander
  providing all code and memory.

## 2. PicoExpander Initialization (Core 1)

The PicoExpander's second core (`core1_entry()` in
[svi-328-expander-bus.c](../pico/c/svi-328-expander-bus.c)) initializes the system:

- Disables interrupts and gives Core 1 priority on the bus.
- Calls `launcher_initialization()`, which:
  - Copies `LAUNCHER_BK4X` (~48 KB) into **RAM4** (the BK41/BK42 banks) — this is
    the actual launcher menu program.
  - Writes the Pico's unique device ID into `RAM4` at `DEVICE_ID_ADDRESS`.
- Calls `boot_initialization()`, which:
  - Ejects the cartridge (clears `ROM_CARTRIDGE`) so a stale/loaded ROM doesn't
    auto-boot.
  - Marks disk and tape as empty.
  - Sets the initial banks: lower bank = `BIOS`, upper bank = `RAM0` (BK02).
- Sets `inject_type = INJECT_TYPE_PREPARE`.
- **Copies the [PREPARE code](../pico/asm/prepare.asm) into the `BIOS` buffer** —
  this is what the Z80 will execute first.

Core 1 then runs a dispatch loop that calls, based on `inject_type`:

| `inject_type`         | Function                     | Purpose                              |
| --------------------- | ---------------------------- | ------------------------------------ |
| `INJECT_TYPE_PREPARE` | `prepare()`                  | One-time bootstrap (section 3)       |
| `INJECT_TYPE_NONE`    | `floppy_and_ram_emulation()` | Normal full emulation (section 4)    |
| `INJECT_TYPE_BOOT`    | `inject_boot()`              | Re-boot into launcher (section 6)    |

## 3. PREPARE Phase Execution

The `prepare()` function runs while `inject_type == INJECT_TYPE_PREPARE`.

### What the Z80 CPU sees

- The PicoExpander initially feeds `0xC7` (RST 00h) instructions until the CPU
  reads from address `0x0000`.
- Once at `0x0000`, the PicoExpander serves the
  **[PREPARE.ASM](../pico/asm/prepare.asm)** code from the `BIOS` buffer for the
  lower bank (`0x0000`–`0x7FFF`), while `serve_prepare` is `true`.
- Upper-bank (`0x8000`–`0xFFFF`) reads/writes are served from `RAM0`.

> **Note:** `prepare()` never reads, writes, or executes `ROM_CARTRIDGE`. The
> code runs from the `BIOS` buffer (lower bank) and then from `RAM0` (upper bank,
> after it relocates itself — see below).

### What PREPARE.ASM does

1. Configures PSG register 15 for bank selection (CAPS LOCK off, no memory banks
   enabled initially).
2. **Relocates itself** from the lower bank to RAM at `0x8000` and continues
   executing there (from `RAM0`).
3. Sends `PE_COMMAND_STOP_SERVING_PREPARE` (`0x06`) to port `0x13`. The
   PicoExpander stops serving the lower bank and drops **/ROMDIS LOW = 0**, so the
   real hardware drives the lower bank.
4. Checks for a real cartridge (CART signature at address 0). **If present**, it
   sends `PE_WRITE_32KB_ROM` (`0x05`) then streams the cartridge's 32 KB out port
   `0x14`; the PicoExpander captures those bytes into the `BK11` buffer.
5. Sends `PE_WRITE_BIOS` (`0x04`) to port `0x13` and streams the BIOS image out
   port `0x14`, which the PicoExpander stores into the emulated `BIOS` buffer.
6. Sends `PE_WRITE_TERMINATE` (`0x03`); on terminate of the BIOS write the
   PicoExpander raises **/ROMDIS** back and sets `inject_type = INJECT_TYPE_NONE`,
   switching to the emulated BIOS.
7. Performs floppy-disk-controller detection and reports the result via
   `PE_COMMAND_FEATURE_FLAGS` (`0x51`).
8. Sends `PE_COMMAND_MEDIA_CONTROL` (`0x52`) with value `0x20`
   (`LOAD_BOOTSECTOR_TO_CARTRIDGE`), which copies the 45-byte
   `LAUNCHER_BOOTSECTOR` into `ROM_CARTRIDGE` (see section 5).
9. Jumps to address `0x7B64` in the (now PicoExpander-hosted) BIOS to continue the
   normal cold-start sequence.

## 4. Normal Emulation Mode

Once `inject_type == INJECT_TYPE_NONE`, the dispatch loop calls
`floppy_and_ram_emulation()` on Core 1. The PicoExpander now fully emulates:

- **Memory banks** via a lookup table indexed by PSG register 15
  (`initialize_bank_lookup_table`). Each configuration maps a lower and upper
  bank pointer plus a "ROM?" flag; writes to ROM banks are dropped:
  - Cartridge: `ROM_CARTRIDGE` (BK11 low / BK12 high), read-only.
  - BIOS: `BIOS`, read-only.
  - RAM banks: `RAM0` (BK02), `RAM2` (BK21/22), `RAM3` (BK31/32), `RAM4` (BK41/42).
- **Floppy disk controller**: FDC I/O ports `0x30`–`0x38`.
- **Cassette tape emulation**: I/O ports `0x64`–`0x65`.
- **Video Display Processor (VDP)**: I/O ports `0x80`, `0x81`, `0x84`, `0x85`.
- **Programmable Sound Generator (PSG)**: I/O ports `0x88`, `0x8C`.
- **Custom PicoExpander control ports**: `0x13`–`0x18`.

## 5. ROM_CARTRIDGE Launcher Boot

The PicoExpander menu is **not** served as a floppy boot sector. Instead it uses
the SVI's native cartridge-autostart:

- During PREPARE (step 8) the 45-byte
  [`LAUNCHER_BOOTSECTOR`](../pico/asm/launcher_bootsector.asm) is copied into the
  emulated cartridge slot, `ROM_CARTRIDGE[0..45]`, with the cartridge selected.
- The BIOS cold start finds a cartridge present and runs it.
- The bootsector code:
  - Relocates itself to `0xC000` and continues executing there.
  - Selects **BK41 (RAM4)** + BK02 via PSG register 15.
  - Sends `PE_COMMAND_MEDIA_CONTROL` (`0x52`) value `0x04`
    (`EJECT_CARTRIDGE`) — this **clears the entire 64 KB `ROM_CARTRIDGE`**,
    removing the bootsector once it is no longer needed.
  - Jumps to address `0x0003`, which is now in `RAM4` (BK41) where `LAUNCHER_BK4X`
    was copied during initialization.
- The launcher menu code in `RAM4` takes control and displays the PicoExpander menu.

> **Important:** because the launcher bootstrap **wipes `ROM_CARTRIDGE`** on every
> boot, `ROM_CARTRIDGE` cannot be used to hold anything that must persist across
> the launcher start (e.g. a captured cartridge). That is why the real-cartridge
> capture (step 4) uses a separate `BK11` buffer.

## 6. Re-Booting Into the Launcher (Menu Exit)

After a game/program has been running, the system returns to the launcher via
`inject_boot()` (triggered by the launcher's boot request / the server `boot`
command). This does **not** repeat the PREPARE phase; it:

- Re-runs `launcher_initialization()` and `boot_initialization()`.
- Calls `load_bootsector_to_cartridge()` to place the launcher bootsector back
  into `ROM_CARTRIDGE`.
- Pulses **RST** and injects the `INJECTBOOT` stub so the CPU restarts and runs
  the cartridge bootstrap again (section 5), landing back in the `RAM4` launcher.

## Memory Bank Reference

| Buffer          | Size  | Role                                                        |
| --------------- | ----- | ---------------------------------------------------------- |
| `BIOS`          | 32 KB | Emulated BASIC BIOS ROM (lower bank); PREPARE runs here first |
| `ROM_CARTRIDGE` | 64 KB | Cartridge slot (BK11 low / BK12 high); holds the launcher bootsector transiently; wiped on launcher boot |
| `RAM0`          | 32 KB | BK02 (default upper RAM)                                    |
| `RAM2`          | 64 KB | BK21 / BK22                                                 |
| `RAM3`          | 64 KB | BK31 / BK32                                                 |
| `RAM4`          | 64 KB | BK41 / BK42 — hosts the launcher (`LAUNCHER_BK4X`)          |
| `BK11`          | 32 KB | Capture buffer for a real cartridge snapshot (see PREPARE step 4) |
