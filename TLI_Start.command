#!/usr/bin/env bash
# Double-click in Finder, or run: bash TLI_Start.command
# If macOS blocks this unsigned launcher, review it before allowing it in
# System Settings > Privacy & Security. This script never removes quarantine.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
bash "$SCRIPT_DIR/TLI_Start.sh" "$@"
status=$?
if [ "$status" -ne 0 ] && [ -t 0 ]; then
    printf '\nTLI did not start. Review the message above.\n'
    read -r -p "Press Enter to close..." _reply
fi
exit "$status"
