# SVI-3x8 PicoExpander v1.4.4 Release Notes

## New Features
- **New realtime protocol** — The custom 10-byte header protocol has been replaced with a layered design
- **Streamed logging** — Text and hardware logs stream to the server over a dedicated log channel with level filtering and a boot ring buffer, replacing the old dump-on-demand log feature
- **PCB 1.4.1** — New board revision added (it's a little bit wider), and the `pcb/` tree restructured so each revision lives in its own directory

## Improvements
- **Memory headroom** — BK11 bank dropped, RAM3 restored, and the hardware log snapshot removed to cut log size
- **Wi-Fi robustness** — Power saving disabled, heartbeat kill switch given a retry and a longer delay, and `wifi.c` restructured with dead code removed
- **File server operations** — File server requests and Wi-Fi operations reorganised; redundant BK4X save command and an extra tape data fetch removed
- **Save state handshake** — The SVI now waits for a "save state sent" status before exiting the menu
- **Command Center** — Progress bars restored, terminology and output formatting cleaned up, Node.js updated
- **Launcher** — Some UI fixes to the SVI launcher

## Bug Fixes
- Wi-Fi crash where `frame_queue_drain` allocated a 16,517-byte buffer on core 0's 2,048-byte stack
- Core 1 crash while saving Wi-Fi credentials
- Cheat console memory sweep crash and an off-by-one error in the cheat finder
- Protocol failures on slow network connections, and a ping facility error that caused uploads to fail
- Connection-lost detection, and connection errors in the JavaScript implementation
- HDD mount states left stale when the server connection is killed
- `.CAS` autoload causing a Syntax error
- Dump disk reappearing after a long-press boot; long-press boot now boots to the launcher
- Catalog filter not resetting after a long-press boot
- Media state change now triggers properly when loading media into the Pico, so the SVI can react
- Wi-Fi icon misplacement — the VDP address is parked in unused space and the icon repositioned
- HD logo appearing too soon
- Pico `0x0037` menu-exit trap now disarmed before entering the cartridge
- SSID text overflow in the bottom bar, and an erroneous prompt in `server.js`
- Wi-Fi credential write script fixed