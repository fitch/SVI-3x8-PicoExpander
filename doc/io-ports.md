# I/O Ports

## List of Currently Emulated I/O Ports

- Ports **0x13-0x18** are custom Pico control/debug ports
- Ports **0x30-0x38** emulate the floppy disk controller (FDC)
- Ports **0x64-0x65** emulate cassette tape operations
- Ports **0x80, 0x81, 0x84, 0x85** interface with the VDP (Video Display Processor)
- Ports **0x88, 0x8C** interface with the PSG (Programmable Sound Generator)
- PSG Register 15 handling includes special code injection for CAPS LOCK state management

## Pico Status and Command Ports

| Port | Direction | Function | Description |
|------|-----------|----------|-------------|
| **0x13** | Read | Pico State | Returns the current state of the Pico (see state codes below) |
| **0x13** | Write | Pico Command | Sends commands to Pico (see command codes below) |
| **0x14** | Read | Pico Data | Reads data from Pico (context depends on the last command sent to **0x13**) |
| **0x14** | Write | Pico Data | Writes data to Pico (context depends on the last command sent to **0x13**) |
| **0x18** | Read | Status Flags | Network connection status, file serving status, and other flags |

### Port 0x13 Read - Pico State Codes

| Code | Hex | Description |
|------|-----|-------------|
| 100 | 0x64 | Waiting for credentials |
| 101 | 0x65 | Credentials received |
| 102 | 0x66 | Credentials stored |
| 103 | 0x67 | Wi-Fi connecting |
| 104 | 0x68 | Wi-Fi connected |
| 105 | 0x69 | Wi-Fi error |
| 106 | 0x6A | Client connected |
| 107 | 0x6B | Receiving ROM |
| 108 | 0x6C | ROM ready |
| 109 | 0x6D | Receiving disk |
| 110 | 0x6E | Disk ready |
| 111 | 0x6F | Dumping log |
| 112 | 0x70 | Client disconnected |
| 113 | 0x71 | Receiving tape |
| 114 | 0x72 | Tape ready |
| 115 | 0x73 | Boot BIOS |
| 116 | 0x74 | Receiving BK3X |
| 117 | 0x75 | BK3X ready |
| 200 | 0xC8 | Injecting boot |
| 201 | 0xC9 | Boot success |
| 230 | 0xE6 | Wi-Fi bad auth |
| 231 | 0xE7 | Wi-Fi timeout |
| 251 | 0xFB | Dump log |
| 252 | 0xFC | Boot fail |
| 253 | 0xFD | Memory error |
| 254 | 0xFE | Error |
| 255 | 0xFF | Unknown |

### Port 0x13 Write - Command Codes

| Code | Hex | Description |
|------|-----|-------------|
| 0x01 | | Write Wi-Fi credentials mode |
| 0x02 | | Write save state mode |
| 0x03 | | Terminate write mode |
| 0x04 | | Write BIOS mode (only in prepare mode) |
| 0x05 | | Write 32 kB ROM mode (only in prepare mode) |
| 0x10 | | Boot BIOS with cassette emulation |
| 0x11 | | Boot normal BIOS |
| 0x12 | | Dump Pico text log |
| 0x13 | | Erase Wi-Fi credentials |
| 0x14 | | Clear Pico hardware log |
| 0x20 | | Get file count |
| 0x21 | | Get file information |
| 0x22 | | Request file send |
| 0x30 | | Disable short press boot (disabled by default) |
| 0x31 | | Enable short press boot |
| 0x40 | | Set file type filters in file server (no filter applied by default) |
| 0x50 | | Access stored configuration |

### Port 0x18 Read - Status Flags

**Bits 0-2: Network connection status**
| Value | Binary | Description |
|-------|--------|-------------|
| 0x00 | 0b00000000 | Not connected to Wi-Fi, idle |
| 0x01 | 0b00000001 | Connecting to Wi-Fi |
| 0x02 | 0b00000010 | Error connecting |
| 0x03 | 0b00000011 | Connected to Wi-Fi |

**Bits 3-5: File serving status**
| Value | Binary | Description |
|-------|--------|-------------|
| 0x00 | 0b00000000 | PC/Mac not connected to Pico |
| 0x08 | 0b00001000 | PC/Mac connected, but no file list yet available |
| 0x10 | 0b00010000 | Pico is busy updating the file list |
| 0x18 | 0b00011000 | File serving is active and ready for commands |
| 0x20 | 0b00100000 | PC/Mac is sending an image, and file serving is busy |
| 0x28 | 0b00101000 | Pico has an updated file list (changes back to 0x18 when you request file count) |

**Bit 6: Short press boot flag**
| Value | Binary | Description |
|-------|--------|-------------|
| 0x40 | 0b01000000 | Reset button has been pressed shortly (resets to 0 when this register is read) |

**Bit 7**: Reserved for future use

---

## Command Details

### Command 0x01: Write Wi-Fi Credentials Mode

1. **Write to 0x13**: `0x01` - Enters Wi-Fi credentials write mode
2. **Write to 0x14**: Write credential data bytes:
   - First 32 bytes: SSID (SSID_MAX_LENGTH = 32)
   - Next 63 bytes: Password (PASSWORD_MAX_LENGTH = 63)
3. **Write to 0x13**: `0x03` (WRITE_TERMINATE) - Stores credentials and exits write mode

Maximum write record size: 256 bytes

### Command 0x02: Write Save State Mode

This command works the same way as writing Wi-Fi credentials (command `0x01`). The maximum write record size is 256 bytes.

**Usage:**
1. **Write to 0x13**: `0x02` - Enters save state write mode
2. **Write to 0x14**: Write the save state filename bytes (without extension), one byte at a time
3. **Write to 0x13**: `0x03` (WRITE_TERMINATE) - Completes the operation

**Behavior:**
- The WRITE_TERMINATE command (`0x03`) stores the filename to Pico memory and immediately initiates a request to the PC to download the save state
- If you supply WRITE_TERMINATE immediately without providing any filename, the Pico defaults to `"saved_state.sta"`
- If you've previously provided a filename and then supply WRITE_TERMINATE immediately (without writing a new filename), it will reuse the same filename as before

### Command 0x20: Get File Count

1. **Write to 0x13**: `0x20`
2. **Write to 0x14**: File type filter (see command `0x40`). If you supply `0xff`, the file count will use the previously set filter.
3. **Read from 0x14**:
   - Byte 0: **Status code**
     - `0x80` = Data not ready, read status code again
     - `0x00` = Request successful, file information available
     - `0x01` = Request failed and cannot recover
   - Byte 1: **Low byte** of the 16-bit file count
   - Byte 2: **High byte** of the 16-bit file count

If port `0x18` status was `0x28` (updated file list), the status changes back to `0x18` (file serving ready).

**Example**: If file count is 200 (0x00C8), first read returns 0x80 because it will take a while for the Pico to fetch the data. Keep polling port 0x14 until you get 0x00 (status: ok), then read 0xC8 (low byte), and finally get 0x00 (high byte).

### Command 0x21: Get File Information

1. **Write to 0x13**: `0x21`
2. **Write to 0x14**:
   - Write **low byte** of the 16-bit file index
   - Write **high byte** of the 16-bit file index
3. **Read from 0x14**:
   - Byte 0: **Status code** (`0x80` = not ready, `0x00` = success, `0x01` = failed)
   - Byte 1: **File type** (see File Types section)
   - Bytes 2-31: ASCII filename (30 bytes), null-padded

**Example**: To get info for file #5, write 0x05 then 0x00 to **0x14**, then poll `0x14` until you get `0x00`, then read the file type and 30 bytes of ASCII filename.

### Command 0x22: Request File Send

1. **Write to 0x13**: `0x22`
2. **Write to 0x14**:
   - Write **low byte** of the 16-bit file index
   - Write **high byte** of the 16-bit file index
3. **Read from 0x14**: Status byte (`0x80` = not ready, `0x00` = success, `0x01` = failed)

**Example**: To request file #100, write 0x64 then 0x00 to **0x14**, then read status.

### Command 0x40: Set File Type Filter

1. **Write to 0x13**: `0x40`
2. **Write to 0x14**: File main type filter byte
   - `0b00000000` (0): No filter (default)
   - `0b00000001` (1): Filter only tape images
   - `0b00000010` (2): Filter only ROM images
   - `0b00000011` (3): Filter only disk images
   - `0b00000100` (4): Filter only save states

### Command 0x50: Access Stored Configuration

This command provides access to read or write 16 bytes of persistent configuration data stored in the PicoExpander's flash memory.

1. **Write to 0x13**: `0x50` - Enter configuration access mode
2. **Read or Write to 0x14**: Access 16 bytes of configuration data sequentially
   - For reading: Read 16 bytes from port `0x14`, one byte at a time
   - For writing: Write 16 bytes to port `0x14`, one byte at a time
3. The configuration is automatically saved to flash after writing completes

---

## File Types

The lower 4 bits are the main type (see command `0x40`). The higher bits specify the subtype.

| Code | Binary | Main Type | Subtype | Description |
|------|--------|-----------|---------|-------------|
| 0x11 | 0b00010001 | Tape (1) | 1 | .CAS cassette image |
| 0x12 | 0b00010010 | ROM (2) | 1 | 32 kB SVI-3x8 ROM (lower bank only) |
| 0x22 | 0b00100010 | ROM (2) | 2 | 64 kB SVI-3x8 ROM (requires ROMEN0/1 for upper part) |
| 0x13 | 0b00010011 | Disk (3) | 1 | SVI-3x8 Disk basic, 40 track single-sided |
| 0x23 | 0b00100011 | Disk (3) | 2 | SVI-3x8 Disk basic, 40 track double-sided |
| 0x33 | 0b00110011 | Disk (3) | 3 | SVI-3x8 Disk basic, 80 track single-sided |
| 0x43 | 0b01000011 | Disk (3) | 4 | SVI-3x8 CP/M, 40 track single-sided |
| 0x53 | 0b01010011 | Disk (3) | 5 | SVI-3x8 CP/M, 40 track double-sided |
| 0x63 | 0b01100011 | Disk (3) | 6 | SVI-3x8 CP/M, 80 track single-sided (not yet implemented) |
| 0x14 | 0b00010100 | Savestate (4) | 1 | SVI-3x8 Save State |

---

## Cassette Emulation Ports

| Port | Direction | Function | Description |
|------|-----------|----------|-------------|
| **0x64** | Read | Cassette Data | Reads byte from cassette buffer |
| **0x65** | Read | Cassette Status | Cassette tape status (see below) |
| **0x65** | Write | Cassette Control | Cassette control commands (see below) |

**Cassette Status (Port 0x65 Read):**
| Value | Description |
|-------|-------------|
| 0x00 | No tape |
| 0x01 | Tape at start |
| 0x02 | Tape at end |
| 0x03 | Tape in middle |
| 0xFF | Tape not ready |

**Cassette Control (Port 0x65 Write):**
| Value | Command |
|-------|---------|
| 0x01 | Rewind |
| 0x02 | Start write (not yet implemented) |
| 0x03 | Stop write (not yet implemented) |

---

## Timer Ports

| Port | Direction | Function | Description |
|------|-----------|----------|-------------|
| **0x15** | Read | Timer High Byte | Returns high 8 bits of timestamp counter |
| **0x15** | Write | Timer Reset | Resets the timestamp counter |
| **0x16** | Read | Timer Low Byte | Returns low 8 bits of timestamp counter |
| **0x17** | Write | Debug | Writes debug values to hardware log |

### Timer Implementation

The timer is a 16-bit microsecond counter (0-65535 μs, wraps in ~65.5ms). Reading port 0x15 returns elapsed microseconds since last reset (high byte), and port 0x16 returns the low byte. Writing to port 0x15 resets the counter. The timer increments at 1 MHz from the Pico's hardware timer.
