# SVI-3x8 PicoExpander PCB

## Overview

This directory contains the KiCad hardware design files for the SVI-3x8 PicoExpander and the SuperExpander adapter board.

## Projects

### PicoExpander (main board)

The main expansion board that connects to the SVI-3x8 expansion port via a 50-pin edge connector.

- **KiCad project:** [SVI-3x8-PicoExpander.kicad_pro](SVI-3x8-PicoExpander.kicad_pro)
- **Schematic:** [SVI-3x8-PicoExpander.kicad_sch](SVI-3x8-PicoExpander.kicad_sch)
- **PCB layout:** [SVI-3x8-PicoExpander.kicad_pcb](SVI-3x8-PicoExpander.kicad_pcb)
- **Schematics PDF:** [schematics.pdf](../photos/schematics.pdf)

### SuperExpander Adapter

A simple passive adapter board that allows the PicoExpander to be connected to the Spectravideo SuperExpander (SVI-605) instead of directly to the computer's expansion port.

- **KiCad project:** [SVI-3x8-PicoExpander-SuperExpander-adapter.kicad_pro](SVI-3x8-PicoExpander-SuperExpander-adapter.kicad_pro)
- **PCB layout:** [SVI-3x8-PicoExpander-SuperExpander-adapter.kicad_pcb](SVI-3x8-PicoExpander-SuperExpander-adapter.kicad_pcb)

### Gerber Files

Manufacturing-ready Gerber files are available in the [gerber/](gerber/) directory:

- [gerber/PicoExpander/](gerber/PicoExpander/) — Main board Gerbers
- [gerber/SuperExpander adapter/](gerber/SuperExpander%20adapter/) — Adapter board Gerbers

## Schematics Overview

The PicoExpander circuit consists of:

- **Raspberry Pi Pico 2 W (A1)** — The main microcontroller running the emulation firmware at 300 MHz. Connects to the SVI bus through level shifters and handles all emulation logic, Wi-Fi connectivity, and flash storage.

- **4x 74LVC245A level shifters (U1, U2, U4, U5)** — Bidirectional bus transceivers that translate between the SVI's 5V bus and the Pico's 3.3V logic levels:
  - **U5** — Data bus write (SVI → Pico, active during bus writes)
  - **U1** — Data bus read (Pico → SVI, active during bus reads)
  - **U2** — Lower address bus A0–A7
  - **U4** — Higher address bus A8–A15

- **74HC14 Schmitt trigger (U3, 7 gates used)** — Provides clean signal conditioning for active-low control signals from the SVI bus: `/RST`, `/ROMDIS`, `/RD`, `/WR`, `/MREQ`, `/P_AE` (address enable), and `/P_RD_DE`/`/P_WR_DE` (data direction enable).

- **50-pin edge connector (J1)** — Interfaces directly with the SVI-3x8 expansion bus, providing access to the full address bus, data bus, and control signals.

- **Reset button (SW1)** — Short press returns to the PicoExpander menu. Long press (3+ seconds) resets the SVI.

- **Pull-up resistor (R1, 10kΩ)** — Pull-up on the reset line.

- **Decoupling capacitors (C2–C5, 0.1μF)** — One per level shifter IC for power supply filtering.

## Parts List

| Ref | Qty | Description | DigiKey Part | DigiKey # |
|-----|-----|-------------|-------------|-----------|
| A1 | 1 | Raspberry Pi Pico 2 W (RP2350) | [SC1634](https://www.digikey.com/en/products/detail/raspberry-pi/SC1634/26241087) | 2648-SC1634-ND |
| U1, U2, U4, U5 | 4 | 74LVC245A — Bidirectional level shifter, 3.6V, 20-PDIP | [SN74LVC245AN](https://www.digikey.com/en/products/detail/texas-instruments/SN74LVC245AN/377483) | 296-8503-5-ND |
| U3 | 1 | 74HC14 — Hex Schmitt trigger inverter, 14-DIP | [SN74AHCT14N](https://www.digikey.com/en/products/detail/texas-instruments/SN74AHCT14N/375854) | 296-4674-5-ND |
| C2–C5 | 4 | 0.1μF ceramic capacitor, 50V, X7R, radial | [K104K15X7RF5TL2](https://www.digikey.com/en/products/detail/vishay-beyschlag-draloric-bc-components/K104K15X7RF5TL2/286538) | BC1084CT-ND |
| R1 | 1 | 10kΩ resistor, 1/4W, 1%, axial | [MFR-25FRF52-10K](https://www.digikey.com/en/products/detail/yageo/MFR-25FRF52-10K/14626) | 13-MFR-25FRF52-10KCT-ND |
| J1 | 1 | 50-pin (2x25) card edge connector, dual female, 0.100" pitch | [395-050-524-202](https://www.digikey.com/en/products/detail/edac-inc/395-050-524-202/1297302) | 395-050-524-202-ND |
| SW1 | 1 | Tactile push button switch, SPST-NO, 0.05A, 12V | [PTS636 SP43 LFS](https://www.digikey.com/product-detail/en/c-k/PTS636-SP43-LFS/CKN12304-ND/10071717) | CKN12304-ND |
