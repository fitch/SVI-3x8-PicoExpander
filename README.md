# SVI-3x8 PicoExpander

## Overview

The SVI-3x8 PicoExpander is a Raspberry Pico 2 W based expansion device for Spectravideo 318 and 328 computers.

The device emulates (when plugged into the SVI-3x8 expansion port):
 - **96 kB of additional RAM (BK22, BK31, BK32) to SVI-328**, to be used for example with BASIC SWITCH command or CP/M
 - **144 kB more RAM to SVI-318**, converting it to a SVI-328 and allowing games designed for SVI-328 to be run on a 318
 - **Disk emulation (.dsk)** so you can load and save disk images via Wi-Fi
 - **Cassette drive emulation (.cas)** with auto-running, allowing you to finally send and run .CAS images via Wi-Fi
 - **Support for 64 kB ROM game cartridges**, without using the game cartridge slot and finally fixing the 64 kB ROM support in SVI-328 MKII devices
 - **Save states** to save computer state and load it at later time, making it possible to save your progress in a game and continue later
 - **Remote launch** allowing you to pick up a game image from PC/Mac and launch it from the SVI via Wi-Fi

![PicoExpander](photos/picoexpander.jpg)
![SVI](photos/svi.jpg)

## Limitations

Limitations of the current software (1.4.2):
 - Supports only one disk drive, two-disk drive support coming up

## The project

This repository will later include the full software and the hardware design later as open source. Now you can access the 1.4 PCB version in [pcb](pcb/) directory.

If you can't build one yourself, you can order an assembled version from [here](https://svi-328-dev.company.site/products/svi-3x8-picoexpander-1-4). Current shipping estimate in 1-4 weeks depending on the order volumes.

<b>Important note:</b>

This is ”bleeding edge” hardware, so it might not last 40 years as the SVI did. The Pico pins are used with level shifters and within the limits of the voltage thresholds, but the actual Pico CPU is running overclocked at 300 MHz (normally 150 MHz). This might cause the Pico to wear out sooner than Raspberry has designed it to. However, the Pico can be replaced on the board if needed.

Also, note that device is a prototype and therefore has very limited warranty: you can test it when it arrives and if you're not satisfied, we'll figure out if we ship a new one or you get your money back or something else. But everything else is at your own risk. If the device stops working after 3-12 months, you'll need to fix it yourself or get a new one.

## Quick Start

### 1. Flash the Firmware

When you've built the PCB you can flash the .UF2 file provided in the [release](release/) directory. For the assembled devices, the Pico has already been flashed with the latest firmware.

1. Hold the **BOOTSEL** button on the Pico W while connecting it to your computer via USB
2. The Pico will appear as a USB mass storage device
3. Copy the `.uf2` firmware file from the `release/` directory to the Pico USB drive. Wait until Pico disconnects (displays Disk Not Ejected Properly in macOS) and the green LED light turns on to signal that the firmware booted correctly.
4. Finally, remove the USB cable.

### 2. Install Node.js

The file server requires Node.js to run. This project includes an `.nvmrc` file specifying Node.js v22.20.0.

**macOS (using nvm):**

Install [nvm](https://github.com/nvm-sh/nvm) if you don't have it, then:
```bash
# Install and use the correct Node.js version
nvm install
nvm use
```

**Windows:**
Download and install from [nodejs.org](https://nodejs.org/)

### 3. Run the File Server

Start the server with a directory containing your disk images, ROMs, and cassette files:

```bash
node js/server.js ./images
```

The server will:
- Scan the directory for supported files (.rom, .dsk, .cas, .sta)
- Connect to the PicoExpander over Wi-Fi
- Serve files to the SVI-328 on demand

Press **H** in the server to see available commands.

## Documentation

For detailed documentation, see the `doc/` directory:

| Document | Description |
|----------|-------------|
| [server.md](doc/server.md) | File server usage and interactive commands |
| [send_command.md](doc/send_command.md) | Command-line tool for scripting and automation |
| [boot-sequence.md](doc/boot-sequence.md) | Technical details of the PicoExpander boot process |
| [io-ports.md](doc/io-ports.md) | I/O port reference for developers |
| [save-state-format.md](doc/save-state-format.md) | Save state file format specification |
| [development.md](doc/development.md) | Building the ROM and development setup |


