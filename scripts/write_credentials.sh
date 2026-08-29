#!/bin/bash

HEADER_FILE="wifi-credentials.config"
OUTPUT_BIN="release/wifi-credentials.bin"
FLASH_OFFSET="0x103FC000"

OUTPUT_DIR="$(dirname $OUTPUT_BIN)"
if [ ! -d "$OUTPUT_DIR" ]; then
    echo "Creating directory $OUTPUT_DIR"
    mkdir -p "$OUTPUT_DIR"
fi

if [ "$1" = "--clear" ]; then
    echo "Clearing WiFi credentials in flash memory..."
    head -c 4 /dev/zero > "$OUTPUT_BIN"
    head -c 32 /dev/zero >> "$OUTPUT_BIN"
    head -c 63 /dev/zero >> "$OUTPUT_BIN"
    head -c 16 /dev/zero >> "$OUTPUT_BIN"
    printf '\xFF' >> "$OUTPUT_BIN"
    picotool load "$OUTPUT_BIN" -f -o $FLASH_OFFSET
    exit 0
fi

if [ ! -f "$HEADER_FILE" ]; then
    echo "Error: Header file '$HEADER_FILE' not found."
    exit 1
fi

ssid=$(grep 'WIFI_SSID' "$HEADER_FILE" | sed 's/.*"\(.*\)"/\1/')
password=$(grep 'WIFI_PASSWORD' "$HEADER_FILE" | sed 's/.*"\(.*\)"/\1/')

if [ ${#ssid} -lt 3 ]; then
    echo "Error: SSID must be at least 3 characters long."
    exit 1
fi

echo "SSID: [$ssid]"
echo "Password: [$password]"

# Write magic number 0xDEADBEEF
printf '\xEF\xBE\xAD\xDE' > "$OUTPUT_BIN"

# Write SSID with explicit zero-padding
printf '%s' "$ssid" | head -c 32 >> "$OUTPUT_BIN"
head -c $((32 - ${#ssid})) /dev/zero >> "$OUTPUT_BIN"

# Write Password with explicit zero-padding
printf '%s' "$password" | head -c 63 >> "$OUTPUT_BIN"
head -c $((63 - ${#password})) /dev/zero >> "$OUTPUT_BIN"

# Write SVI_CONFIG
head -c 16 /dev/zero >> "$OUTPUT_BIN"

# Write Wi-Fi auth mode
printf '\xFF' >> "$OUTPUT_BIN"

echo "Created binary file: $OUTPUT_BIN (116 bytes)"

picotool load "$OUTPUT_BIN" -f -o $FLASH_OFFSET
