# I/O Ports Reference

This document describes the I/O ports used by the PicoExpander to communicate between the Z80 CPU and the Pico microcontroller.

## Table of Contents

- [Port Map Overview](#port-map-overview)
- [Pico Control Ports (0x13-0x18)](#pico-control-ports-0x13-0x18)
- [Cassette Emulation Ports (0x64-0x65)](#cassette-emulation-ports-0x64-0x65)
- [FDC Emulation Ports (0x30-0x38)](#fdc-emulation-ports-0x30-0x38)
- [Command Reference](#command-reference)
- [Appendix A: State Codes](#appendix-a-state-codes)
- [Appendix B: File Type Codes](#appendix-b-file-type-codes)
- [Appendix C: Status Response Codes](#appendix-c-status-response-codes)

---

## Port Map Overview

| Port Range  | Category        | Description                                      |
|-------------|-----------------|--------------------------------------------------|
| 0x13-0x18   | Pico Control    | Status, commands, data transfer, timers |
| 0x30-0x38   | FDC             | Floppy disk controller emulation |
| 0x64-0x65   | Cassette        | Tape emulation |
| 0x80-0x85   | VDP             | Video Display Processor (see note below)      |
| 0x88, 0x8C  | PSG             | Programmable Sound Generator (see note below) |

> **Note:** VDP ports are used to read VDP register status for restoring the state after exiting the menu. PSG ports are read to enable preventing actual bank switching by using a fake register injection.

---

## Pico Control Ports (0x13-0x18)

### Port 0x13 - Command & Status

| Direction | Function     | Description                                              |
|-----------|--------------|----------------------------------------------------------|
| Read      | Pico State   | Returns current Pico state (see [Appendix A](#appendix-a-state-codes)) |
| Write     | Pico Command | Sends command to Pico (see [Command Reference](#command-reference))    |

### Port 0x14 - Data Transfer

| Direction | Function   | Description                                                |
|-----------|------------|------------------------------------------------------------|
| Read      | Pico Data  | Reads data from Pico (context depends on last command)     |
| Write     | Pico Data  | Writes data to Pico (context depends on last command)      |

Data format and interpretation depend on the command previously sent to port 0x13.

### Port 0x15 - Timer High Byte

| Direction | Function     | Description                              |
|-----------|--------------|------------------------------------------|
| Read      | Timer High   | Returns high 8 bits of timestamp counter |
| Write     | Timer Reset  | Resets the timestamp counter to 0        |

### Port 0x16 - Timer Low Byte

| Direction | Function   | Description                             |
|-----------|------------|-----------------------------------------|
| Read      | Timer Low  | Returns low 8 bits of timestamp counter |

**Timer Details:** 16-bit microsecond counter (0-65535 μs, wraps in ~65.5ms). Read 0x15 first (high byte), then 0x16 (low byte). Write any value to 0x15 to reset. Increments at 1 MHz from Pico hardware timer.

### Port 0x17 - Debug Output

| Direction | Function | Description                        |
|-----------|----------|------------------------------------|
| Write     | Debug    | Writes debug values to hardware log |

### Port 0x18 - Status Flags

| Direction | Function     | Description                          |
|-----------|--------------|--------------------------------------|
| Read      | Status Flags | Network, file serving, and boot status |

**Bit Layout:**
```
┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┐
│  7  │  6  │  5  │  4  │  3  │  2  │  1  │  0  │
├─────┼─────┼─────┴─────┴─────┼─────┴─────┴─────┤
│ RSV │BOOT │  File Status    │ Network Status  │
└─────┴─────┴─────────────────┴─────────────────┘
```

#### Bits 0-2: Network Connection Status

| Value | Description                  |
|-------|------------------------------|
| 0     | Not connected to Wi-Fi, idle |
| 1     | Connecting to Wi-Fi          |
| 2     | Error connecting             |
| 3     | Connected to Wi-Fi           |

#### Bits 3-5: File Serving Status

| Value | Description                                                              |
|-------|--------------------------------------------------------------------------|
| 0     | PC/Mac not connected to Pico                                             |
| 1     | PC/Mac connected, file list not yet available                            |
| 2     | Pico busy updating file list                                             |
| 3     | File serving active and ready for commands                               |
| 4     | PC/Mac sending an image, file serving busy                               |
| 5     | Updated file list available (returns to 3 after requesting file count)   |

#### Bit 6: Short Press Boot Flag

| Value | Description                                                        |
|-------|--------------------------------------------------------------------|
| 0     | No short press detected                                            |
| 1     | Reset button was pressed shortly (clears to 0 when register is read) |

#### Bit 7: Reserved

Reserved for future use.

---

## Cassette Emulation Ports (0x64-0x65)

### Port 0x64 - Cassette Data

| Direction | Function      | Description                     |
|-----------|---------------|---------------------------------|
| Read      | Cassette Data | Reads next byte from tape buffer |

### Port 0x65 - Cassette Status & Control

| Direction | Function         | Description              |
|-----------|------------------|--------------------------|
| Read      | Cassette Status  | Current tape status      |
| Write     | Cassette Control | Tape control commands    |

#### Read Values (Status)

| Value | Description     |
|-------|-----------------|
| 0x00  | No tape loaded  |
| 0x01  | Tape at start   |
| 0x02  | Tape at end     |
| 0x03  | Tape in middle  |
| 0xFF  | Tape not ready  |

#### Write Values (Control)

| Value | Command                            |
|-------|------------------------------------|
| 0x01  | Rewind tape                        |
| 0x02  | Start write (not yet implemented)  |
| 0x03  | Stop write (not yet implemented)   |

---

## FDC Emulation Ports (0x30-0x38)

The PicoExpander emulates a WD1793-compatible floppy disk controller. Disk images are stored in PSRAM and transferred to/from the PC/Mac file server as needed.

### Port Summary

| Port | Direction | Name                  | Description                                      |
|------|-----------|-----------------------|--------------------------------------------------|
| 0x30 | Read      | Controller Status     | FDC status register                              |
| 0x30 | Write     | Controller Command    | FDC command register                             |
| 0x31 | Read/Write| Track Register        | Current track number (0-79)                      |
| 0x32 | Read/Write| Sector Register       | Current sector number                            |
| 0x33 | Read/Write| Data Register         | Data transfer byte                               |
| 0x34 | Read      | Drive Status          | Data ready and interrupt status                  |
| 0x34 | Write     | Drive Select          | Drive selection (bit 0 = drive 0, bit 1 = drive 1) |
| 0x38 | Write     | Density/Side Select   | Bit 0 = density, bit 1 = side                    |

### Controller Commands (Port 0x30 Write)

| Command | Hex   | Description                              |
|---------|-------|------------------------------------------|
| Restore | 0x0x  | Seek to track 0                          |
| Seek    | 0x1x  | Seek to track specified in data register |
| Step In | 0x5x  | Step toward higher track numbers         |
| Step Out| 0x7x  | Step toward lower track numbers          |
| Read    | 0x8x  | Read sector                              |
| Write   | 0xAx  | Write sector                             |
| Force Int| 0xDx | Force interrupt, abort current operation |

### Drive Status (Port 0x34 Read)

| Value | Meaning                          |
|-------|----------------------------------|
| 0x00  | Track data not ready (loading)   |
| 0x40  | Data ready for transfer          |
| 0x80  | INTRQ (operation complete)       |

### Notes

- Track data is cached in PSRAM for fast access
- When the track changes, the Pico fetches the new track data in the background
- Sector size is 128 bytes on track 0/side 0, 256 bytes elsewhere
- Supports 40-track and 80-track disk formats

---


## Command Reference

Commands are sent by writing to port 0x13. Data is exchanged via port 0x14.

### Command Summary

| Code | Name                    | Category      | Description                              |
|------|-------------------------|---------------|------------------------------------------|
| 0x01 | Write Wi-Fi Credentials | Configuration | Enter Wi-Fi credentials write mode       |
| 0x02 | Write Save State        | Configuration | Enter save state filename write mode     |
| 0x03 | Terminate Write         | Configuration | End write mode and process data          |
| 0x04 | Write BIOS              | Configuration | Enter BIOS write mode (prepare mode only)|
| 0x05 | Write 32KB ROM          | Configuration | Enter ROM write mode (prepare mode only) |
| 0x06 | Stop Serving Prepare    | Configuration | Stop serving prepare.asm, enable HW BIOS |
| 0x07 | Dump Disk               | Configuration | Capture real disk contents into Pico     |
| 0x10 | Boot with Cassette      | Boot          | Boot BIOS with cassette emulation        |
| 0x11 | Boot Normal             | Boot          | Boot normal BIOS                         |
| 0x12 | Dump Log                | Debug         | Dump Pico text log                       |
| 0x13 | Erase Credentials       | Configuration | Erase stored Wi-Fi credentials           |
| 0x14 | Clear Hardware Log      | Debug         | Clear Pico hardware log                  |
| 0x20 | Get File Count          | File Server   | Get count of available files             |
| 0x21 | Get File Info           | File Server   | Get information about a specific file    |
| 0x22 | Request File            | File Server   | Request file transfer from PC/Mac        |
| 0x30 | Disable Short Press     | Configuration | Disable short press boot (default)       |
| 0x31 | Enable Short Press      | Configuration | Enable short press boot                  |
| 0x40 | Set File Filter         | File Server   | Set file type filter                     |
| 0x50 | Access Configuration    | Configuration | Read/write persistent configuration      |
| 0x51 | Feature Flags           | Configuration | Enable/disable PicoExpander features     |
| 0x52 | Media Control           | Configuration | Eject media or copy BK11 to cartridge    |

---

### Configuration Commands

#### 0x01 - Write Wi-Fi Credentials

Enters Wi-Fi credentials write mode for storing network settings.

**Protocol:**
```
1. OUT 0x13, 0x01          ; Enter credentials write mode
2. OUT 0x14, <ssid bytes>  ; Write 32 bytes SSID
   OUT 0x14, <pass bytes>  ; Write 63 bytes password
3. OUT 0x13, 0x03          ; Terminate and store
```

**Data Format:**
- Bytes 0-31: SSID (32 bytes, null-padded)
- Bytes 32-94: Password (63 bytes, null-padded)
- Maximum total: 256 bytes

#### 0x02 - Write Save State Filename

Enters save state write mode to specify a filename for save/load operations.

**Protocol:**
```
1. OUT 0x13, 0x02          ; Enter save state write mode
2. OUT 0x14, <filename>    ; Write filename bytes (without .sta extension)
3. OUT 0x13, 0x03          ; Terminate and initiate download
```

**Behavior:**
- Terminate (0x03) stores filename and immediately requests download from PC
- Empty filename defaults to `"saved_state.sta"`
- Omitting new filename reuses previous filename

#### 0x03 - Terminate Write Mode

Ends any active write mode (0x01, 0x02, 0x04, 0x05) and processes the data.

#### 0x06 - Stop Serving Prepare

Used only during prepare mode. Signals the Pico to stop serving prepare.asm code from lower bank and enable the hardware BIOS ROM via ROMDIS. After this command, lower bank reads will be served by the actual hardware BIOS ROM instead of the Pico.

**Protocol:**
```
OUT 0x13, 0x06             ; Stop serving prepare code, enable HW BIOS ROM
```

This command is used internally by prepare.asm after it has copied itself to RAM and jumped to the upper bank. It allows prepare.asm to read data from the hardware BIOS ROM.

#### 0x07 - Dump Disk

Captures the contents of a real floppy disk drive and stores the data into the Pico's flash memory. This allows creating disk images from physical disks. The Z80 reads data from the real FDC and transfers it to the Pico byte by byte.

**Protocol:**
```
OUT 0x13, 0x07             ; Enter disk dump mode
OUT 0x14, 0x00             ; Select drive 0 (resets write buffer index to 0)
OUT 0x14, <byte>           ; Write disk data byte (sector buffer contents)
OUT 0x14, <byte>           ; Write disk data byte
...                        ; Continue for all sectors on all tracks/sides
OUT 0x13, 0x03             ; Terminate and flush remaining data to flash
```

| Value | Drive    |
|-------|----------|
| 0     | Drive 0  |

**Behavior:**
- Drive selection (first data byte) resets the dump write index and flash pointer to 0
- Data is written byte by byte into an 8192-byte double-buffer (2 × 4096)
- When each 4096-byte half fills, it is flashed to the disk area automatically
- On terminate (0x03), any remaining partial buffer is padded with 0xFF and flushed
- After completion, `disk_size` is set to the total number of bytes written


**Maximum size:** 346,112 bytes (fits a 40-track double-sided disk image).

#### 0x50 - Access Stored Configuration

Provides access to 16 bytes of persistent configuration in flash memory.

**Protocol:**
```
; Reading
OUT 0x13, 0x50             ; Enter config mode
IN  A, (0x14)              ; Read byte 0
IN  A, (0x14)              ; Read byte 1
...                        ; Continue for 16 bytes

; Writing
OUT 0x13, 0x50             ; Enter config mode
OUT 0x14, <byte0>          ; Write byte 0
OUT 0x14, <byte1>          ; Write byte 1
...                        ; Continue for 16 bytes (auto-saves)
```

#### 0x51 - Feature Flags

Enables or disables PicoExpander features at runtime.

**Protocol:**
```
; Reading current flags
OUT 0x13, 0x51             ; Enter feature flags mode
IN  A, (0x14)              ; Read feature flags byte

; Writing new flags
OUT 0x13, 0x51             ; Enter feature flags mode
OUT 0x14, <flags>          ; Write feature flags byte
```

**Bit Layout:**
```
┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┐
│  7  │  6  │  5  │  4  │  3  │  2  │  1  │  0  │
├─────┴─────┴─────┴─────┴─────┴─────┼─────┼─────┤
│           Reserved (0)            │TAPE │ FDC │
└───────────────────────────────────┴─────┴─────┘
```

| Bit | Name | Description                                           |
|-----|------|-------------------------------------------------------|
| 0   | FDC  | FDC emulation: 0 = disabled, 1 = enabled              |
| 1   | TAPE | Patch BIOS ROM with tape emulation code: 0 = not patched, 1 = patched |
| 2-7 | —    | Reserved for future use (always read as 0)            |

> **Note:** On cold boot, feature flags default to 0x00 (all features disabled). Software must explicitly enable FDC and/or tape emulation as needed.

#### 0x52 - Media Control

Controls media slots: eject (zero out) loaded media or copy the real BK11 ROM to the cartridge slot.

**Protocol:**
```
OUT 0x13, 0x52             ; Enter media control mode
OUT 0x14, <operation>      ; Execute operation
```

**Bit Layout:**
```
┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┐
│  7  │  6  │  5  │  4  │  3  │  2  │  1  │  0  │
├─────┴─────┼─────┼─────┼─────┼─────┼─────┼─────┤
│ Reserved  │BOOT │BK11 │TAPE │CART │DSK1 │DSK0 │
└───────────┴─────┴─────┴─────┴─────┴─────┴─────┘
```

| Bit | Name | Description                                           |
|-----|------|-------------------------------------------------------|
| 0   | DSK0 | Eject Disk 0: mark disk 0 as not loaded               |
| 1   | DSK1 | Eject Disk 1: mark disk 1 as not loaded               |
| 2   | CART | Eject Cartridge: zero out cartridge ROM memory        |
| 3   | TAPE | Eject Tape: mark tape as not loaded                   |
| 4   | BK11 | Load BK11 to Cartridge ROM                            |
| 5   | BOOT | Load Bootsector to Cartridge ROM                      |
| 6-7 | —    | Reserved (always 0)                                   |

**Operations:**

| Bit | Code | Operation          | Description                                    |
|-----|------|--------------------|------------------------------------------------|
| 0   | 0x01 | Eject Disk 0       | Mark disk 0 as not loaded |
| 1   | 0x02 | Eject Disk 1       | Mark disk 1 as not loaded |
| 2   | 0x04 | Eject Cartridge ROM| Zero out cartridge ROM memory |
| 3   | 0x08 | Eject Tape         | Mark tape as not loaded |
| 4   | 0x10 | Load BK11 to Cartridge ROM | Copy stored BK11 data to cartridge ROM emulation |
| 5   | 0x20 | Load Bootsector to Cartridge ROM | Copy bootsector code to cartridge ROM so BIOS boots it |

**Notes:**
- Operations can be combined as a bitmask (e.g., 0x03 ejects both disks)
- Eject Cartridge clears the memory area with `0xff`s
- Eject Disk/Tape sets size to 0 (flash contents unchanged)
- During boot, the prepare phase (see `prepare.asm`) detects if a real cartridge is attached and dumps its first 32 KB into the BK11 array. The 0x10 operation copies this BK11 data to the ROM_CARTRIDGE array, enabling cartridge emulation using the original physical cartridge's contents.
- The 0x20 operation copies the bootsector code to ROM_CARTRIDGE, allowing BIOS to boot from the cartridge which then boots the launcher.

---

### Boot Commands

#### 0x10 - Boot BIOS with Cassette Emulation

Boots the SVI BIOS with cassette tape emulation enabled.

#### 0x11 - Boot Normal BIOS

Boots the SVI BIOS normally without cassette emulation.

#### 0x30/0x31 - Short Press Boot Control

- **0x30**: Disable short press boot (default behavior)
- **0x31**: Enable short press boot

When enabled, a short press of the reset button triggers boot flag (bit 6 of port 0x18).

---

### File Server Commands

These commands interact with the PC/Mac file server via Wi-Fi.

#### 0x20 - Get File Count

Returns the number of files available matching the current filter.

**Protocol:**
```
OUT 0x13, 0x20             ; Send command
OUT 0x14, <filter>         ; File type filter (0xFF = use previous)
poll:
IN  A, (0x14)              ; Read status
CP  0x80
JR  Z, poll                ; 0x80 = not ready, poll again
; A = 0x00 (success) or 0x01 (failed)
IN  A, (0x14)              ; Low byte of count
IN  A, (0x14)              ; High byte of count
```

**Filter Values:**
| Value | Filter             |
|-------|--------------------|
| 0x00  | No filter (all)    |
| 0x01  | Tape images only   |
| 0x02  | ROM images only    |
| 0x03  | Disk images only   |
| 0x04  | Save states only   |
| 0xFF  | Use previous filter |

**Note:** If port 0x18 showed status 5 (updated file list), it returns to 3 (ready) after this command.

#### 0x21 - Get File Information

Returns type and filename for a specific file index.

**Protocol:**
```
OUT 0x13, 0x21             ; Send command
OUT 0x14, <index_lo>       ; Low byte of file index
OUT 0x14, <index_hi>       ; High byte of file index
poll:
IN  A, (0x14)              ; Read status
CP  0x80
JR  Z, poll                ; 0x80 = not ready
; A = 0x00 (success) or 0x01 (failed)
IN  A, (0x14)              ; File type (see Appendix B)
; Read 30 bytes: ASCII filename, null-padded
```

**Response:**
- Byte 0: Status code
- Byte 1: File type (see [Appendix B](#appendix-b-file-type-codes))
- Bytes 2-31: Filename (30 ASCII bytes, null-padded)

#### 0x22 - Request File Send

Requests the PC/Mac to send a specific file to the Pico.

**Protocol:**
```
OUT 0x13, 0x22             ; Send command
OUT 0x14, <index_lo>       ; Low byte of file index
OUT 0x14, <index_hi>       ; High byte of file index
poll:
IN  A, (0x14)              ; Read status
CP  0x80
JR  Z, poll
; A = 0x00 (success) or 0x01 (failed)
```

#### 0x40 - Set File Type Filter

Sets the file type filter for subsequent file operations.

**Protocol:**
```
OUT 0x13, 0x40             ; Send command
OUT 0x14, <filter>         ; Filter value (see 0x20 filter table)
```

---

### Debug Commands

#### 0x12 - Dump Pico Text Log

Outputs the Pico's text log for debugging purposes.

#### 0x14 - Clear Pico Hardware Log

Clears the Pico's hardware debug log.

---

## Appendix A: State Codes

State codes returned when reading port 0x13.

### Normal States (0x64-0x75)

| Dec | Hex  | State                  |
|-----|------|------------------------|
| 100 | 0x64 | Waiting for credentials |
| 101 | 0x65 | Credentials received    |
| 102 | 0x66 | Credentials stored      |
| 103 | 0x67 | Wi-Fi connecting        |
| 104 | 0x68 | Wi-Fi connected         |
| 105 | 0x69 | Wi-Fi error             |
| 106 | 0x6A | Client connected        |
| 107 | 0x6B | Receiving ROM           |
| 108 | 0x6C | ROM ready               |
| 109 | 0x6D | Receiving disk          |
| 110 | 0x6E | Disk ready              |
| 111 | 0x6F | Dumping log             |
| 112 | 0x70 | Client disconnected     |
| 113 | 0x71 | Receiving tape          |
| 114 | 0x72 | Tape ready              |
| 115 | 0x73 | Boot BIOS               |
| 116 | 0x74 | Receiving BK3X          |
| 117 | 0x75 | BK3X ready              |

### Process States (0xC8-0xC9)

| Dec | Hex  | State          |
|-----|------|----------------|
| 200 | 0xC8 | Injecting boot |
| 201 | 0xC9 | Boot success   |

### Error States (0xE6+)

| Dec | Hex  | State          |
|-----|------|----------------|
| 230 | 0xE6 | Wi-Fi bad auth |
| 231 | 0xE7 | Wi-Fi timeout  |
| 251 | 0xFB | Dump log       |
| 252 | 0xFC | Boot fail      |
| 253 | 0xFD | Memory error   |
| 254 | 0xFE | Error          |
| 255 | 0xFF | Unknown        |

---

## Appendix B: File Type Codes

File type encoding: lower 4 bits = main type, upper 4 bits = subtype.

| Code | Main Type    | Subtype | Description                                    |
|------|--------------|---------|------------------------------------------------|
| 0x11 | Tape (1)     | 1       | .CAS cassette image                            |
| 0x12 | ROM (2)      | 1       | 32 KB SVI-3x8 ROM (lower bank)                 |
| 0x22 | ROM (2)      | 2       | 64 KB SVI-3x8 ROM (requires ROMEN0/1)          |
| 0x13 | Disk (3)     | 1       | Disk BASIC, 40 track single-sided              |
| 0x23 | Disk (3)     | 2       | Disk BASIC, 40 track double-sided              |
| 0x33 | Disk (3)     | 3       | Disk BASIC, 80 track single-sided              |
| 0x43 | Disk (3)     | 4       | CP/M, 40 track single-sided                    |
| 0x53 | Disk (3)     | 5       | CP/M, 40 track double-sided                    |
| 0x63 | Disk (3)     | 6       | CP/M, 80 track single-sided (not implemented)  |
| 0x14 | Savestate (4)| 1       | SVI-3x8 Save State                             |

**Main Type Values (for filtering):**
| Value | Type      |
|-------|-----------|
| 1     | Tape      |
| 2     | ROM       |
| 3     | Disk      |
| 4     | Savestate |

---

## Appendix C: Status Response Codes

Common status codes returned by file server commands.

| Code | Meaning                              |
|------|--------------------------------------|
| 0x00 | Success, data available              |
| 0x01 | Failed, cannot recover               |
| 0x80 | Not ready, poll again                |
