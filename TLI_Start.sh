#!/usr/bin/env bash
# Source-based macOS/Linux launcher. Dependencies stay in this installation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
VENV_DIR="$BACKEND_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"
SETUP_ONLY=0
OPEN_BROWSER="${TLI_OPEN_BROWSER:-1}"

fail() { printf '\nTLI: %s\n' "$*" >&2; exit 1; }
for argument in "$@"; do
    case "$argument" in
        --setup-only) SETUP_ONLY=1 ;;
        --no-browser) OPEN_BROWSER=0 ;;
        --help|-h)
            printf 'Usage: bash TLI_Start.sh [--setup-only] [--no-browser]\n'
            printf 'Requires Python 3.10+. First setup downloads Python dependencies.\n'
            exit 0 ;;
        *) fail "Unknown option: $argument" ;;
    esac
done

printf '\nTheLANIntelligence — private AI and connected tools\n\n'
if [ "$(uname -s)" = "Darwin" ]; then
    mac_version="$(sw_vers -productVersion)"
    mac_arch="$(uname -m)"
    [[ "$mac_version" =~ ^([0-9]+)\.([0-9]+) ]] || fail "Could not determine this Mac's version."
    mac_major="${BASH_REMATCH[1]}"; mac_minor="${BASH_REMATCH[2]}"
    case "$mac_arch" in
        arm64) (( 10#$mac_major >= 14 )) || fail "This release requires macOS 14 or newer on Apple Silicon (found $mac_version)." ;;
        x86_64) (( 10#$mac_major > 13 || (10#$mac_major == 13 && 10#$mac_minor >= 3) )) || fail "This release requires macOS 13.3 or newer on Intel (found $mac_version)." ;;
        *) fail "Unsupported Mac architecture: $mac_arch. This release supports Apple Silicon and Intel Macs." ;;
    esac
fi
[ -f "$BACKEND_DIR/main.py" ] && [ -f "$BACKEND_DIR/requirements.txt" ] && \
    [ -f "$BACKEND_DIR/launch_checks.py" ] && [ -f "$BACKEND_DIR/host_launcher.py" ] || \
    fail "This folder is incomplete. Extract the complete TLI release into a new folder."

# Avoid an unrelated Python environment choosing this installation's modules.
unset PYTHONHOME PYTHONPATH
export TLI_ROOT="$SCRIPT_DIR"

if [ ! -e "$VENV_DIR" ] && [ ! -L "$VENV_DIR" ]; then
    PYTHON=""
    # Finder's PATH may omit Homebrew or the python.org framework installation.
    for candidate in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 \
            /Library/Frameworks/Python.framework/Versions/Current/bin/python3 python; do
        executable="$(command -v "$candidate" 2>/dev/null || true)"
        if [ -n "$executable" ] && "$executable" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
            PYTHON="$executable"
            break
        fi
    done
    [ -n "$PYTHON" ] || fail "Install Python 3.10 or newer from https://www.python.org/downloads/ and open TLI again. No software was installed automatically."
    printf 'Preparing the Python environment in this TLI folder...\n'
    "$PYTHON" -m venv "$VENV_DIR" || fail "Python could not create this installation's environment. On Linux, install your distribution's python3-venv package. Existing files were preserved."
fi

[ -x "$VENV_PYTHON" ] || fail "The existing backend/.venv is incomplete or belongs to another platform. Keep your data and use a freshly extracted TLI folder; this launcher will not delete the old environment."
"$VENV_PYTHON" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))' || \
    fail "This installation's environment needs Python 3.10 or newer. Use a new TLI folder with a supported Python installation."

if ! "$VENV_PYTHON" "$BACKEND_DIR/host_launcher.py" --check-dependencies >/dev/null 2>&1; then
    printf 'Installing missing TLI components. Internet is only needed if these components must be downloaded.\n'
    "$VENV_PYTHON" -m pip --disable-pip-version-check install -r "$BACKEND_DIR/requirements.txt" || \
        fail "Dependencies could not be installed. Check the error and connection, then reopen TLI. No backend was started."
    "$VENV_PYTHON" "$BACKEND_DIR/host_launcher.py" --check-dependencies || \
        fail "Dependencies are not ready. No backend was started."
fi

if [ "$SETUP_ONLY" -eq 1 ]; then
    printf '\nTLI dependencies are ready. No backend or AI model was started.\n'
    exit 0
fi

printf '\nStarting TLI. The browser will use the address printed by the host.\n'
printf 'Use Quit TLI inside the app to stop the background host. You may close Terminal after startup completes.\n'
printf 'AI model weights are separate: configure a model in TLI or a local provider such as LM Studio.\n\n'
cd "$BACKEND_DIR"
# The managed launcher verifies the exact installation/process before reusing
# a host, and records its child so reviewed quit/restart/update can stop it.
if [ "$OPEN_BROWSER" = "0" ]; then
    exec "$VENV_PYTHON" "$BACKEND_DIR/host_launcher.py" --no-browser
fi
exec "$VENV_PYTHON" "$BACKEND_DIR/host_launcher.py"
