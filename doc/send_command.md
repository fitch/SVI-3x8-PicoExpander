# send_command.js - Command-Line Interface

A standalone CLI tool for sending individual commands to the PicoExpander.

## Usage

```bash
node js/send_command.js <command> <path/to/file> [options]
```

## Available Commands

### File Loading Commands

- **`load_rom <path/to/romfile.rom>`**  
  Upload a ROM file (2KB, 16KB, 32KB, 48KB, or 64KB) to the SVI-328. The ROM will be inserted into the cartridge slot.

- **`load_disk <path/to/diskimage.dsk>`**  
  Upload a disk image (172032 or 346112 bytes) to the PicoExpander for floppy disk emulation.

- **`load_cas <path/to/file.cas>`**  
  Upload a cassette tape file (max 524KB) for cassette emulation.

- **`load_bk4x <path/to/romfile.rom>`**  
  Upload a BK31/BK32 launcher ROM file to the PicoExpander's memory banks.

### Boot Commands

- **`launcher`**  
  Reboot the SVI-328 to the PicoExpander launcher menu.

### Logging Commands

- **`get_log`**  
  Retrieve and display both text and hardware logs from the PicoExpander.

- **`get_text_log`**  
  Retrieve and display only the text log from the PicoExpander.

- **`get_hardware_log`**  
  Retrieve and display only the hardware log from the PicoExpander, including PSG register access and memory bank control information.

## How It Works

1. Broadcasts a UDP discovery message to find the PicoExpander on the local network
2. Establishes a TCP connection on port 4242
3. Executes the requested command
4. Closes the connection and exits

## Difference from server.js

While `send_command.js` is designed for one-off commands (scripts/automation), `server.js` provides:
- A persistent file serving system that the PicoExpander can query
- Interactive file selection from the parsed catalog (not raw filesystem)
- Smart file filtering by type (ROM, disk, cassette)
- Metadata extraction and display
- Automatic reconnection on connection loss
- Watch mode for file changes
