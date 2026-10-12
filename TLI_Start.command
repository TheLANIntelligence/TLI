#!/usr/bin/env bash
# Double-click in Finder, or run: bash TLI_Start.command
# If Apple could not verify this launcher from the official release you trust:
# Done > System Settings > Privacy & Security > Security > Open Anyway > Open.
# This script cannot handle a Finder warning before it runs; see START_HERE.md.
# It never removes quarantine or disables Gatekeeper.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
bash "$SCRIPT_DIR/TLI_Start.sh" "$@"
status=$?
if [ "$status" -ne 0 ] && [ -t 0 ]; then
    printf '\nTLI did not start. Review the message above.\n'
    read -r -p "Press Enter to close..." _reply
fi
exit "$status"
