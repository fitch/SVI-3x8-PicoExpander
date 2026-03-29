# SVI-3x8 PicoExpander v1.4.3 Release Notes

## New Features
- **Hard disk emulation** — Full HDD emulation support, including server-based (network-backed) hard disk emulation
- **Menu launching from keyboard** — Launch menu items directly via keyboard shortcuts (F3 for HDD boot)
- **Media control system** — New doorbell-based media control for managing media ejects, BIOS patching, and data copying between banks
- **SuperExpander adapter PCB** — New adapter board design added
- **Cheat console** — In-system cheat console
- **CP/M 2.27 analysis & tools** — HDD sysgen script, CPM file extractor, disk dumper

## Improvements
- **New memory bank handling** — Completely rewritten memory bank management
- **Reworked boot procedure** — Changed to use ROM cartridge boot from BIOS
- **Wi-Fi stability** — Simplified and stabilized Wi-Fi connection procedure
- **Build system** — Simplified compiling, release firmware stored in Git, cleaned up unused files

## Bug Fixes
- CHGET register corruption fix
- File server file count notification fix
- Flash write comparison fix
- Wi-Fi credential reset no longer clears configuration
- BK4X upload fix
- Various real-hardware fixes
