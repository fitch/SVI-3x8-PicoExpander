# server.js - File Server & Interactive Control

A comprehensive file server that indexes and serves disk images, ROMs, and cassette files to the PicoExpander, with an integrated interactive control interface.

## Usage

```bash
node js/server.js <directory>
```

**Example:**
```bash
node js/server.js ./images
```

## Features

### File Server Functionality

- Automatically scans and catalogs all supported files in the specified directory
- Parses and validates ROM files (.rom), disk images (.dsk), and cassette tapes (.cas)
- Extracts metadata from files (CAS headers, disk file lists, etc.)
- Watches for file changes and automatically updates the catalog
- Serves file catalog to PicoExpander on demand via persistent TCP connection
- Allows PicoExpander to request files by index for loading

## Interactive Commands

### Catalog & Search Commands

| Key | Command | Description |
|-----|---------|-------------|
| **D** | Display catalog | Display full catalog (all files grouped by type) |
| **C** | Clear & redisplay | Clear screen and redisplay catalog |
| **R** | Rescan | Rescan directory (force refresh) |
| **I** | Show invalid | Show invalid/unparseable files |
| **S** | Search | Search files (by name, metadata, or contents) |

### File Loading & Boot Commands

| Key | Command | Description |
|-----|---------|-------------|
| **1** | Load ROM | Load ROM file (catalog-based selection with autocomplete) |
| **2** | Load BK4X ROM | Load BK4X ROM file (catalog-based selection) |
| **3** | Save BK4X RAM4 | Save BK4X RAM4 data (download 64KB from PicoExpander) |
| **4** | Load Disk | Load Disk image (catalog-based selection) |
| **5** | Load CAS | Load CAS tape file (catalog-based selection) |
| **6** | Boot Launcher | Boot to Launcher |
| **7** | Save BIOS | Save BIOS data |
| **8** | Save State | Save machine state (save state capture) |

### Logging Commands

| Key | Command | Description |
|-----|---------|-------------|
| **L** | Request logs | Request both logs from PicoExpander |
| **T** | Text log | Request text log from PicoExpander |
| **W** | Hardware log | Request hardware log from PicoExpander |

### Other Commands

| Key | Command | Description |
|-----|---------|-------------|
| **H** | Help | Show help |
| **Q** | Quit | Quit server |

## Difference from send_command.js

While `send_command.js` is designed for one-off commands (scripts/automation), `server.js` provides:

- A persistent file serving system that the PicoExpander can query
- Interactive file selection from the parsed catalog (not raw filesystem)
- Smart file filtering by type (ROM, disk, cassette)
- Metadata extraction and display
- Automatic reconnection on connection loss
- Watch mode for file changes
