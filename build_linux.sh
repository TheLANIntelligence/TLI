#!/usr/bin/env bash
# ============================================================
#  TLI — Linux Build Script
#  Produces: TLI_Installer/dist/TLI-v{VERSION}-linux/
#  Requires: Python 3.10+, pip, PyInstaller
#  Usage: bash build_linux.sh
#
#  Also installs an optional systemd service for headless
#  auto-start on boot. Run with --install-service to enable.
# ============================================================

set -e

VERSION="0.9.9.1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$SCRIPT_DIR/backend"
FRONTEND="$SCRIPT_DIR/frontend"
DIST_ROOT="$SCRIPT_DIR/TLI_Installer/dist/TLI-v${VERSION}-linux"
VENV="$BACKEND/.venv"

GRN='\033[0;32m'; CYN='\033[0;36m'; YLW='\033[1;33m'; RST='\033[0m'

echo ""
echo -e "${CYN}=== TLI Build  v${VERSION}  (Linux) ===${RST}"
echo ""

# ── Activate venv ────────────────────────────────────────────
if [ ! -d "$VENV" ]; then
    echo -e "${YLW}Creating virtual environment...${RST}"
    python3 -m venv "$VENV"
fi
source "$VENV/bin/activate"

pip install --quiet pyinstaller
pip install --quiet -r "$BACKEND/requirements.txt" 2>/dev/null || \
pip install --quiet fastapi uvicorn requests cryptography python-multipart psutil send2trash

# ── Step 1: Prepare dist folder ──────────────────────────────
echo -e "[1/3] Preparing dist folder..."
rm -rf "$DIST_ROOT"
mkdir -p "$DIST_ROOT"

cp -r "$FRONTEND" "$DIST_ROOT/frontend"
cp -r "$SCRIPT_DIR/ai" "$DIST_ROOT/ai" 2>/dev/null || true
cp    "$SCRIPT_DIR/start_tli.sh" "$DIST_ROOT/"
chmod +x "$DIST_ROOT/start_tli.sh"

# systemd service unit
cat > "$DIST_ROOT/tli.service" << EOF
[Unit]
Description=TheLegatoIntelligence LAN Console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIST_ROOT
ExecStart=$DIST_ROOT/tli_backend
Restart=on-failure
RestartSec=5
Environment=TLI_PORT=8000

[Install]
WantedBy=multi-user.target
EOF

cat > "$DIST_ROOT/README.txt" << EOF
=============================================
  TheLANIntelligence (TLI)  v${VERSION}
  Your local AI-powered home console.
=============================================

QUICK START (Linux)
---------------------
Option A — Standalone binary (no Python needed):
  ./tli_backend

Option B — Python source:
  bash start_tli.sh

Option C — systemd auto-start service:
  sudo cp tli.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now tli

Then open:  http://localhost:8000

EOF

echo -e "      Frontend copied."

# ── Step 2: PyInstaller ──────────────────────────────────────
echo -e "[2/3] Building backend binary with PyInstaller..."
cd "$BACKEND"

pyinstaller \
    --onefile \
    --name tli_backend \
    --distpath "$DIST_ROOT" \
    --workpath "$BACKEND/build_work_linux" \
    --specpath "$BACKEND" \
    --add-data "../frontend:frontend" \
    --add-data "../data:data" \
    --hidden-import uvicorn.logging \
    --hidden-import uvicorn.loops \
    --hidden-import uvicorn.loops.auto \
    --hidden-import uvicorn.protocols \
    --hidden-import uvicorn.protocols.http \
    --hidden-import uvicorn.protocols.http.auto \
    --hidden-import uvicorn.lifespan \
    --hidden-import uvicorn.lifespan.on \
    main.py

chmod +x "$DIST_ROOT/tli_backend"
echo -e "      tli_backend binary built."

# ── Step 3: Tar + Zip ────────────────────────────────────────
echo -e "[3/3] Packaging..."
cd "$SCRIPT_DIR/TLI_Installer/dist"
tar -czf "TLI-v${VERSION}-linux.tar.gz" "TLI-v${VERSION}-linux/"
echo -e "      TLI-v${VERSION}-linux.tar.gz created."

echo ""
echo -e "${GRN}=== Build complete ===${RST}"
echo -e "  Folder : $DIST_ROOT"
echo -e "  Archive: $SCRIPT_DIR/TLI_Installer/dist/TLI-v${VERSION}-linux.tar.gz"
echo ""

# ── Optional: install systemd service ────────────────────────
if [[ "$1" == "--install-service" ]]; then
    echo -e "${YLW}Installing systemd service...${RST}"
    sudo cp "$DIST_ROOT/tli.service" /etc/systemd/system/tli.service
    # Update the path to match actual install location
    sudo sed -i "s|$DIST_ROOT|$(pwd)/TLI-v${VERSION}-linux|g" /etc/systemd/system/tli.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now tli
    echo -e "${GRN}Service installed. TLI will start on boot.${RST}"
    echo "  Status: sudo systemctl status tli"
    echo "  Logs:   sudo journalctl -u tli -f"
fi
