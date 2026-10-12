#!/usr/bin/env bash
# Double-click in Finder, or run: bash TLI_Update.command
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
bash "$SCRIPT_DIR/TLI_Update.sh" "$@"
status=$?
if [ -t 0 ]; then
    printf '\nReview the update result above.\n'
    read -r -p 'Press Enter to close...' _reply
fi
exit "$status"
