#!/usr/bin/env bash
# Run from a separately extracted, updater-equipped release.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { printf '\nTLI: %s\n' "$*" >&2; exit 1; }
if [ "${1:-}" = '--help' ] || [ "${1:-}" = '-h' ]; then
    printf 'Usage: bash TLI_Update.sh [existing-TLI-folder]\n'
    printf 'Stop TLI first. The updater verifies the release and asks for confirmation.\n'
    exit 0
fi
[ "$#" -le 1 ] || fail 'Pass just the existing TLI folder, or omit it to choose interactively.'
[ -f "$SCRIPT_DIR/TLI_RELEASE.json" ] && [ -f "$SCRIPT_DIR/backend/update_install.py" ] || \
    fail 'This package has no update inventory. Download an updater-equipped release and extract the entire ZIP into a separate folder.'
unset PYTHONHOME PYTHONPATH TLI_ROOT

find_python() {
    local candidate executable
    for candidate in "$@" python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 \
        /Library/Frameworks/Python.framework/Versions/Current/bin/python3 python; do
        executable="$(command -v "$candidate" 2>/dev/null || true)"
        if [ -n "$executable" ] && "$executable" -I -c 'import sys; raise SystemExit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
            printf '%s\n' "$executable"
            return 0
        fi
    done
    return 1
}

printf '\nUpdate an existing TLI installation\n'
printf 'Finish active work and stop TLI and its optional host-start helper first.\n'
printf 'Select your ORIGINAL TLI folder. Keep this extracted update in a separate folder.\n'
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
    DEFAULT_TARGET=''
    HINT_PYTHON="$(find_python "$SCRIPT_DIR/backend/.venv/bin/python" || true)"
    if [ -n "$HINT_PYTHON" ] && [ -f "$SCRIPT_DIR/update-target.json" ]; then
        DEFAULT_TARGET="$("$HINT_PYTHON" -I -c 'import json, pathlib, sys
try:
    p = pathlib.Path(sys.argv[1])
    value = json.loads(p.read_text(encoding="utf-8")) if p.stat().st_size <= 4096 else {}
    target = value.get("target", "")
    if isinstance(target, str) and "\n" not in target and "\r" not in target: print(target)
except (OSError, ValueError, TypeError, AttributeError): pass' "$SCRIPT_DIR/update-target.json")"
    fi
    if [ -n "$DEFAULT_TARGET" ]; then printf 'Suggested existing folder: %s\n' "$DEFAULT_TARGET"; fi
    read -r -p 'Existing TLI folder (Enter accepts the suggested folder): ' TARGET || fail 'No folder was selected. Nothing was updated.'
    TARGET="${TARGET:-$DEFAULT_TARGET}"
fi
[ -n "$TARGET" ] || fail 'No existing installation was selected. Nothing was updated.'
# Accept a pasted quoted path; expand only a leading ~/ without evaluating input.
TARGET="${TARGET#\"}"; TARGET="${TARGET%\"}"
case "$TARGET" in '~/'*) TARGET="$HOME/${TARGET:2}" ;; esac
[ -d "$TARGET" ] || fail 'The selected existing TLI folder does not exist. Nothing was updated.'
TARGET="$(cd "$TARGET" && pwd)"
printf 'Selected existing folder: %s\n' "$TARGET"
printf 'The updater will verify this package and ask you to type UPDATE before applying it.\n'
PYTHON="$(find_python "$TARGET/backend/.venv/bin/python" "$SCRIPT_DIR/backend/.venv/bin/python" || true)"
[ -n "$PYTHON" ] || fail 'Python 3.10 or newer is required. Install it from python.org, then run this updater again. Existing files have not been changed.'
"$PYTHON" -I "$SCRIPT_DIR/backend/update_install.py" --source "$SCRIPT_DIR" --target "$TARGET"
printf '\nOpen TLI_Start.command from your ORIGINAL folder to finish. First start may prepare updated components and need internet access.\n'
