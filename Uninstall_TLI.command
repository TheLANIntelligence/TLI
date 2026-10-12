#!/usr/bin/env bash
# Double-clickable macOS entry point for the portable installation removal guide.
set -eu
tli_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bash "$tli_dir/Uninstall_TLI.sh"
if [ -t 0 ]; then
    printf '\nPress Enter to close...'
    read -r _tli_close
fi
