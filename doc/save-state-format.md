# Save State File Format

Save state files (`.sta`) capture the machine state for later restoration. The file format includes a header followed by memory bank data.

## File Header (32 bytes)

| Offset | Size | Description |
|--------|------|-------------|
| 0-20 | 21 bytes | Magic string: `"PicoExpanderSaveState"` |
| 21 | 1 byte | Version number (`0x01`) |
| 22 | 1 byte | Reserved (filled with `0x00`) |
| 23 | 1 byte | Bank configuration (see below) |
| 24-31 | 8 bytes | Reserved (filled with `0x00`) |

## Bank Configuration Byte

The bank configuration byte at offset 23 specifies which memory banks are included in the save state file. Each bit corresponds to a specific bank:

| Bit | Bank | Description |
|-----|------|-------------|
| 0 | BK01 | RAM0 lower 32KB |
| 1 | BK02 | RAM0 upper 32KB |
| 2 | BK11 | RAM1 lower 32KB |
| 3 | BK12 | RAM1 upper 32KB |
| 4 | BK21 | RAM2 lower 32KB |
| 5 | BK22 | RAM2 upper 32KB |
| 6 | BK31 | RAM3 lower 32KB |
| 7 | BK32 | RAM3 upper 32KB |

### Example Bank Configurations

| Value | Binary | Banks Included | Description |
|-------|--------|----------------|-------------|
| 0x02 | 0b00000010 | BK02 | 32KB save state |
| 0x12 | 0b00010010 | BK02 + BK21 | 64KB save state |
| 0x32 | 0b00110010 | BK02 + BK21 + BK22 | 96KB save state |
| 0xF2 | 0b11110010 | BK02 + BK21 + BK22 + BK31 + BK32 | 160KB save state |

## Data Layout

After the 32-byte header, the data is stored with RAM4 first, followed by banks in order according to the bank configuration byte:

1. **RAM4 area (0xB000-0xF03F)**: 16,448 bytes - Always present first
2. **BK01**: 32,768 bytes - Present if bit 0 is set
3. **BK02**: 32,768 bytes - Present if bit 1 is set
4. **BK11**: 32,768 bytes - Present if bit 2 is set
5. **BK12**: 32,768 bytes - Present if bit 3 is set
6. **BK21**: 32,768 bytes - Present if bit 4 is set
7. **BK22**: 32,768 bytes - Present if bit 5 is set
8. **BK31**: 32,768 bytes - Present if bit 6 is set
9. **BK32**: 32,768 bytes - Present if bit 7 is set

Banks are stored in ascending order (BK01, BK02, BK11, BK12, BK21, BK22, BK31, BK32), but only those indicated by the bank configuration byte are included.

## Example File Sizes

The file size is calculated as: `32 + 16,448 + (number_of_banks × 32,768)` bytes.

| Banks | Header | Data | Total File Size |
|-------|--------|------|-----------------|
| 1 bank | 32 bytes | 49,216 bytes | 49,248 bytes |
| 2 banks | 32 bytes | 81,984 bytes | 82,016 bytes |
| 3 banks | 32 bytes | 114,752 bytes | 114,784 bytes |
| 5 banks | 32 bytes | 180,288 bytes | 180,320 bytes |

## Usage

From the server.js interactive interface, press **0** to capture the current machine state. The save state will be saved to `saved_state.sta` in the current directory.

The RAM4 area (0xB000-0xF03F) is always included as it contains important launcher and system state that may be needed for proper restoration.
