#!/bin/bash
# ============================================================
#  TheLANIntelligence — macOS Installer
#  Usage: curl -fsSL https://thelanintelligence.com/install_mac.sh | bash
# ============================================================

set -e

MANIFEST_URL="https://thelanintelligence.com/latest.json"
INSTALL_DIR="$HOME/TLI"

GRN='\033[0;32m'; CYN='\033[0;36m'; YLW='\033[1;33m'; RED='\033[0;31m'; RST='\033[0m'

echo ""
echo -e "${CYN}  ╔══════════════════════════════════════╗${RST}"
echo -e "${CYN}  ║   TheLANIntelligence  Installer      ║${RST}"
echo -e "${CYN}  ║   LAN Console · Local · No cloud     ║${RST}"
echo -e "${CYN}  ╚══════════════════════════════════════╝${RST}"
echo ""

# ── Check dependencies ────────────────────────────────────────
for cmd in curl python3 unzip; do
    if ! command -v $cmd &>/dev/null; then
        echo -e "${RED}  '$cmd' is required but not installed.${RST}"
        if [ "$cmd" = "python3" ]; then
            echo "  Install Python 3.10+ from https://python.org/downloads"
        fi
        exit 1
    fi
done

PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo -e "  Python $PY_VER detected"

# ── Fetch manifest ────────────────────────────────────────────
echo "  Fetching latest version info..."
MANIFEST=$(curl -fsSL "$MANIFEST_URL")
VERSION=$(echo "$MANIFEST" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['version'])")
DOWNLOAD_URL=$(echo "$MANIFEST" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['download_url'])")

echo -e "  Latest version: ${GRN}$VERSION${RST}"

# ── Check existing install ────────────────────────────────────
if [ -d "$INSTALL_DIR" ]; then
    echo ""
    echo -e "  ${YLW}TLI is already installed at $INSTALL_DIR${RST}"
    read -r -p "  Update to $VERSION? [y/N] " confirm < /dev/tty
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "  Cancelled."
        exit 0
    fi
fi

# ── Download ──────────────────────────────────────────────────
ZIP_PATH="/tmp/TLI_install_$VERSION.zip"
echo ""
echo "  Downloading TLI $VERSION..."
curl -fsSL --progress-bar "$DOWNLOAD_URL" -o "$ZIP_PATH"
echo "  Download complete."

# ── Extract ───────────────────────────────────────────────────
echo "  Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# Unzip and strip the top-level folder if there is one
FIRST_ENTRY=$(unzip -Z1 "$ZIP_PATH" | head -1)
if [[ "$FIRST_ENTRY" == */ ]]; then
    # Zip has a top-level folder — extract and rename
    EXTRACT_TMP="/tmp/TLI_extract_$$"
    mkdir -p "$EXTRACT_TMP"
    unzip -q "$ZIP_PATH" -d "$EXTRACT_TMP"
    mv "$EXTRACT_TMP/$FIRST_ENTRY"/* "$INSTALL_DIR/" 2>/dev/null || \
    mv "$EXTRACT_TMP/$(ls "$EXTRACT_TMP")"/* "$INSTALL_DIR/"
    rm -rf "$EXTRACT_TMP"
else
    unzip -q "$ZIP_PATH" -d "$INSTALL_DIR"
fi

rm -f "$ZIP_PATH"

# ── Fix permissions & quarantine ──────────────────────────────
echo "  Setting permissions..."
xattr -dr com.apple.quarantine "$INSTALL_DIR" 2>/dev/null || true
chmod +x "$INSTALL_DIR/TLI_Start.command"  2>/dev/null || true
chmod +x "$INSTALL_DIR/TLI_Start.sh"       2>/dev/null || true
if [ -f "$INSTALL_DIR/TLI_Start.app/Contents/MacOS/TLI_Start" ]; then
    chmod +x "$INSTALL_DIR/TLI_Start.app/Contents/MacOS/TLI_Start"
fi

# ── Done ──────────────────────────────────────────────────────
echo ""
echo -e "${GRN}  TLI $VERSION installed to $INSTALL_DIR${RST}"
echo ""
echo "  To start TLI:"
echo -e "    ${CYN}Double-click:${RST}  $INSTALL_DIR/TLI_Start.command"
echo -e "    ${CYN}Or run:${RST}        bash \"$INSTALL_DIR/TLI_Start.command\""
echo ""

read -r -p "  Launch TLI now? [Y/n] " launch < /dev/tty
if [[ ! "$launch" =~ ^[Nn]$ ]]; then
    echo ""
    echo "  Launching TLI..."
    bash "$INSTALL_DIR/TLI_Start.command"
fi
