#!/bin/bash
# Check if a CMSIS-DAP debug probe is connected via USB.
# Exits 0 if found, 1 if not (aborting the debug launch).

if ioreg -p IOUSB -l 2>/dev/null | grep -qi "CMSIS-DAP"; then
    echo "✔ Debug probe detected (CMSIS-DAP)"
    exit 0
else
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "  ✘  No CMSIS-DAP debug probe detected!"
    echo ""
    echo "  Please connect your debug probe and try again."
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    # Machine-readable line for VS Code problemMatcher
    echo "error: .vscode/launch.json: No CMSIS-DAP debug probe detected - please connect your debug probe and try again"
    exit 1
fi
