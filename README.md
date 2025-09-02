# SVI-3x8-PicoExpander

## Overview

This is SVI-3x8 PicoExpander - a Raspberry Pico 2 W based expansion device for Spectravideo 318 and 328 computers.

The device emulates (when plugged into the SVI-3x8 expansion port):
 - 96 kB of additional RAM (BK22, BK31, BK32) to SVI-328, to be used for example with BASIC SWITCH command or CP/M
 - 144 kB more RAM to SVI-318, converting it to a SVI-328 and allowing games designed for MSX1* and SVI-328 to be run on a 318
 - Two disk drives** so you can load and save disk images via Wi-Fi
 - Cassette drive with auto-running, allowing you to finally send and run .CAS images via Wi-Fi
 - Support for 64 kB ROM game cartridges*, without using the game cartridge slot and finally fixing the 64 kB ROM support in SVI-328 MKII devices

## Limitations

Limitations of the current software (1.4.0):
 - Requires converting MSX ROMs with, for example, Nyyrikki's MSX loader for SVI
 - Supports only one disk drive, two-disk drive support coming up
 - Most of the 64 kB ROMs work, but for some demos there are still some software bugs to solve

## The project

This repository will later include the full software and the hardware design later as open source. Now you can access the 1.4 PCB version in [pcb](pcb/) directory.

If you can't build one yourself, you can order an assembled version from [here](https://svi-328-dev.company.site/products/svi-3x8-picoexpander-1-4). Current shipping estimate in 1-4 weeks depending on the order volumes.

<b>Important note:</b>

This is ”bleeding edge” hardware, so it might not last 40 years as the SVI did. The Pico pins are used with level shifters and within the limits of the voltage thresholds, but the actual Pico CPU is running overclocked at 300 MHz (normally 150 MHz). This might cause the Pico to wear out sooner than Raspberry has designed it to. However, the Pico can be replaced on the board if needed.

Also, note that device is a prototype and therefore has very limited warranty: you can test it when it arrives and if you're not satisfied, we'll figure out if we ship a new one or you get your money back or something else. But everything else is at your own risk. If the device stops working after 3-12 months, you'll need to fix it yourself or get a new one.

## Small how-to

### Flashing the newest software

When you've built the PCB you can flash the .UF2 file provided in the [release](release/) directory. For the assembled devices, the Pico has already been flashed with the latest firmware.

Press Pico's BOOTSEL button (the only button on the board, see the board picture above) and while pressing plug it in to your computer via USB.

Then, find the UF2 flash binary file from release/svi-328-picorom.uf2.

Next, flash the Raspberry Pico 2 W by dragging the UF2 file on to the Pico USB drive and wait until Pico disconnects (displays Disk Not Ejected Properly in macOS) and the green LED light turns on to signal that the firmware booted correctly. Finally, remove the USB cable.

### Controlling the PicoExpander

You need to install Node.js to run the controller:
 - [Node.js](https://nodejs.org/en) version 22.14.0 or newer
 - [Node Version Manager](https://github.com/nvm-sh/nvm) 22.14.0 or newer (it's easier to manage Node versions with this, but you can omit this you install Node.js some other way)

To use the script, type in the Terminal:
```
node js/send_command.js
```