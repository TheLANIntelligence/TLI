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
            printf 'Requires final standard CPython 3.10–3.14 (3.13 recommended). First setup downloads Python dependencies.\n'
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

# Use final standard CPython builds with supported dependency wheels. An
# enabled GIL at runtime does not make a free-threaded build a standard build.
supported_python() {
    "$1" -I -c 'import sys, sysconfig; raise SystemExit(not (sys.implementation.name == "cpython" and (3, 10) <= sys.version_info[:2] <= (3, 14) and sys.version_info.releaselevel == "final" and sysconfig.get_config_var("Py_GIL_DISABLED") not in (1, "1") and "t" not in getattr(sys, "abiflags", "")))' >/dev/null 2>&1
}

find_python() {
    local version candidate executable
    local candidates=("$@")
    # Versioned paths also work when Finder omits Homebrew or python.org from
    # PATH, or the generic python3/Current points at an unsupported preview.
    for version in 3.13 3.14 3.12 3.11 3.10; do
        candidates+=("python$version"
            "/Library/Frameworks/Python.framework/Versions/$version/bin/python$version"
            "/opt/homebrew/opt/python@$version/bin/python$version"
            "/usr/local/opt/python@$version/bin/python$version"
            "/opt/homebrew/bin/python$version" "/usr/local/bin/python$version")
    done
    candidates+=(python3 /opt/homebrew/bin/python3 /usr/local/bin/python3
        /Library/Frameworks/Python.framework/Versions/Current/bin/python3 python)
    for candidate in "${candidates[@]}"; do
        executable="$(command -v "$candidate" 2>/dev/null || true)"
        if [ -n "$executable" ] && supported_python "$executable"; then
            printf '%s\n' "$executable"
            return 0
        fi
    done
    return 1
}

if [ ! -e "$VENV_DIR" ] && [ ! -L "$VENV_DIR" ]; then
    PYTHON="$(find_python || true)"
    [ -n "$PYTHON" ] || fail "Install standard Python 3.13 from https://www.python.org/downloads/. TLI supports final CPython 3.10–3.14, without free-threading. Open TLI again after installation. No software was installed automatically."
    printf 'Preparing the Python environment in this TLI folder...\n'
    "$PYTHON" -m venv "$VENV_DIR" || fail "Python could not create this installation's environment. On Linux, install your distribution's python3-venv package. Existing files were preserved."
fi

[ -x "$VENV_PYTHON" ] || fail "The existing backend/.venv is incomplete or belongs to another platform. Fully quit TLI and follow docs/TLI_UPDATES.md to preserve and manually rename only backend/.venv, then reopen TLI from this ORIGINAL folder. This launcher will not delete the old environment or saved data."
supported_python "$VENV_PYTHON" || \
    fail "The existing backend/.venv uses an unsupported Python build. Install standard Python 3.13 from https://www.python.org/downloads/, fully quit TLI, and follow docs/TLI_UPDATES.md to preserve and manually rename only backend/.venv. Then reopen TLI from this ORIGINAL folder. TLI requires final CPython 3.10–3.14 without free-threading. No environment or saved data was changed."

if ! "$VENV_PYTHON" "$BACKEND_DIR/host_launcher.py" --check-dependencies >/dev/null 2>&1; then
    printf 'Installing missing TLI components. Internet is only needed if these components must be downloaded.\n'
    "$VENV_PYTHON" -m pip --disable-pip-version-check install --only-binary=cryptography -r "$BACKEND_DIR/requirements.txt" || \
        fail "Compatible prebuilt components could not be downloaded. Check the error and connection. TLI requires a prebuilt cryptography wheel and will not compile it from source. See docs/TLI_UPDATES.md for supported Python recovery. No backend was started."
    "$VENV_PYTHON" "$BACKEND_DIR/host_launcher.py" --check-dependencies || \
        fail "Installed components could not be verified. See docs/TLI_UPDATES.md for manual environment recovery. Saved data was kept. No backend was started."
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
