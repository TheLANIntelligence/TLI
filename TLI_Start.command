#!/usr/bin/env bash
# ============================================================
#  TLI — macOS / Linux launcher
#  Double-click TLI_Start.command (macOS) or run ./TLI_Start.sh
#
#  First-run note (macOS): if macOS blocks this file,
#  right-click → Open → Open to allow it once.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
VENV_DIR="$BACKEND_DIR/.venv"

# ── Colours ──────────────────────────────────────────────────
GRN='\033[0;32m'; CYN='\033[0;36m'; YLW='\033[1;33m'; RED='\033[0;31m'; RST='\033[0m'

# ── Keep terminal open on any error ──────────────────────────
_on_error() {
    echo ""
    echo -e "${RED}  TLI failed to start. See the error above.${RST}"
    echo ""
    echo "  Common fixes:"
    echo "    - Python 3.10+ not installed: https://python.org/downloads"
    echo "    - macOS blocked the file: right-click → Open → Open"
    echo "    - Address in use: choose a free TLI_PORT and try again"
    echo ""
    read -r -p "  Press Enter to close..."
}
trap '_on_error' ERR

echo ""
echo -e "${CYN}  ╔══════════════════════════════════════╗${RST}"
echo -e "${CYN}  ║   TheLANIntelligence                 ║${RST}"
echo -e "${CYN}  ║   Private AI and connected tools     ║${RST}"
echo -e "${CYN}  ╚══════════════════════════════════════╝${RST}"
echo ""

# ── Auto-install Python if missing ───────────────────────────
_install_python() {
    local OS
    OS="$(uname -s)"
    echo -e "  ${YLW}Python 3 not found — attempting automatic install…${RST}"

    if [ "$OS" = "Darwin" ]; then
        if command -v brew &>/dev/null; then
            echo "  Installing Python via Homebrew…"
            brew install python3
        else
            echo -e "  ${YLW}Homebrew not found. Installing Homebrew first…${RST}"
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            if [ -f /opt/homebrew/bin/brew ]; then
                eval "$(/opt/homebrew/bin/brew shellenv)"
            fi
            brew install python3
        fi
    elif command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y python3 python3-pip python3-venv
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y python3 python3-pip
    elif command -v pacman &>/dev/null; then
        sudo pacman -Sy --noconfirm python python-pip
    elif command -v zypper &>/dev/null; then
        sudo zypper install -y python3 python3-pip
    else
        echo -e "${RED}  Could not auto-install Python. Please install Python 3.10+ from https://python.org${RST}"
        exit 1
    fi
}

# ── Auto-download bundled AI runtime (Mac / Linux) ───────────
_setup_llama_runtime() {
    local RUNTIME="$BACKEND_DIR/ai/runtime/llama-server"

    # Already present and executable — nothing to do
    if [ -f "$RUNTIME" ] && [ -x "$RUNTIME" ]; then
        return 0
    fi

    local ARCH OS
    ARCH="$(uname -m)"
    OS="$(uname -s)"

    echo ""
    echo -e "  ${YLW}Bundled AI runtime not found.${RST}"
    echo "  Without it TLI can't run a local AI model (LM Studio still works)."
    echo ""
    read -r -p "  Download AI runtime now? [Y/n] " _dl < /dev/tty
    _dl="${_dl:-Y}"
    if [[ "$_dl" =~ ^[Nn] ]]; then
        echo "  Skipped — configure LM Studio in Settings → AI."
        return 0
    fi

    # Pick the right asset name for this platform / arch
    local ASSET_PAT
    if [ "$OS" = "Darwin" ]; then
        [ "$ARCH" = "arm64" ] && ASSET_PAT="macos-arm64" || ASSET_PAT="macos-x64"
    else
        ( [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ] ) && \
            ASSET_PAT="ubuntu-arm64" || ASSET_PAT="ubuntu-x64"
    fi

    echo -e "  Fetching latest llama.cpp release info (${ARCH})..."
    local ASSET_URL
    ASSET_URL=$(curl -fsSL "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" 2>/dev/null | \
        $PYTHON -c "
import json, sys
data = json.load(sys.stdin)
pat  = '$ASSET_PAT'
for a in data.get('assets', []):
    n = a.get('name', '')
    if pat in n and (n.endswith('.zip') or n.endswith('.tar.gz')):
        print(a['browser_download_url'])
        break
" 2>/dev/null)

    if [ -z "$ASSET_URL" ]; then
        echo -e "  ${RED}Could not find a release for ${ASSET_PAT}.${RST}"
        echo "  Download manually: https://github.com/ggml-org/llama.cpp/releases"
        echo "  Place 'llama-server' in: $BACKEND_DIR/ai/runtime/"
        return 1
    fi

    local TMP_DIR ARCHIVE
    TMP_DIR="$(mktemp -d)"
    ARCHIVE="$TMP_DIR/runtime_pkg"

    echo -e "  Downloading $(basename "$ASSET_URL")..."
    curl -L --progress-bar -o "$ARCHIVE" "$ASSET_URL"

    mkdir -p "$BACKEND_DIR/ai/runtime" "$TMP_DIR/extracted"

    if [[ "$ASSET_URL" == *.zip ]]; then
        unzip -q -o "$ARCHIVE" -d "$TMP_DIR/extracted" 2>/dev/null
    else
        tar -xzf "$ARCHIVE" -C "$TMP_DIR/extracted" 2>/dev/null
    fi

    local FOUND
    FOUND="$(find "$TMP_DIR/extracted" -type f -name "llama-server" 2>/dev/null | head -1)"

    if [ -n "$FOUND" ]; then
        cp "$FOUND" "$RUNTIME"
        chmod +x "$RUNTIME"
        echo -e "  ${GRN}AI runtime installed successfully.${RST}"
    else
        echo -e "  ${RED}Could not find llama-server in the archive.${RST}"
        echo "  Download manually: https://github.com/ggml-org/llama.cpp/releases"
    fi

    rm -rf "$TMP_DIR"
}

# ── Check Python ─────────────────────────────────────────────
PYTHON=""
if command -v python3 &>/dev/null; then
    PYTHON=python3
elif command -v python &>/dev/null && python -c "import sys; assert sys.version_info >= (3,8)" 2>/dev/null; then
    PYTHON=python
fi

if [ -z "$PYTHON" ]; then
    _install_python
    if command -v python3 &>/dev/null; then
        PYTHON=python3
    elif command -v python &>/dev/null; then
        PYTHON=python
    else
        echo -e "${RED}  Python still not found after install attempt. Please install manually from https://python.org${RST}"
        read -r -p "  Press Enter to close..."
        exit 1
    fi
fi

PY_VER=$($PYTHON -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo -e "  Python $PY_VER detected"

# ── Create venv if missing ────────────────────────────────────
if [ ! -d "$VENV_DIR" ]; then
    echo -e "  ${YLW}Setting up virtual environment (first run — takes ~30 seconds)…${RST}"
    $PYTHON -m venv "$VENV_DIR"
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# ── Install / update dependencies ────────────────────────────
REQ="$BACKEND_DIR/requirements.txt"
if [ ! -f "$REQ" ]; then
    pip install --quiet fastapi uvicorn requests cryptography python-multipart psutil send2trash
else
    pip install --quiet -r "$REQ"
fi

# ── Download AI runtime if missing ───────────────────────────
_setup_llama_runtime

# ── Free port if busy ─────────────────────────────────────────
TLI_ROOT="$SCRIPT_DIR" "$PYTHON" "$BACKEND_DIR/launch_checks.py" || exit 1

# ── Launch ────────────────────────────────────────────────────
echo ""
echo -e "  ${GRN}Starting TLI with saved settings and explicit environment overrides.${RST}"
echo "  Press Ctrl+C to stop."
echo ""


cd "$BACKEND_DIR"
TLI_ROOT="$SCRIPT_DIR" TLI_OPEN_BROWSER=1 "$PYTHON" main.py
