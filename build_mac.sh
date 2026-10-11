#!/usr/bin/env bash
# ============================================================
#  TLI — macOS Build Script
#  Produces: TLI_Installer/dist/TLI-v{VERSION}-mac/
#  Requires: Python 3.10+, pip, PyInstaller
#  Usage: bash build_mac.sh
# ============================================================

set -e

VERSION="0.9.9.1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$SCRIPT_DIR/backend"
FRONTEND="$SCRIPT_DIR/frontend"
DIST_ROOT="$SCRIPT_DIR/TLI_Installer/dist/TLI-v${VERSION}-mac"
VENV="$BACKEND/.venv"

GRN='\033[0;32m'; CYN='\033[0;36m'; YLW='\033[1;33m'; RST='\033[0m'

echo ""
echo -e "${CYN}=== TLI Build  v${VERSION}  (macOS) ===${RST}"
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

cp -r "$FRONTEND"      "$DIST_ROOT/frontend"
cp -r "$SCRIPT_DIR/ai" "$DIST_ROOT/ai"             2>/dev/null || true
cp    "$SCRIPT_DIR/start_tli.sh" "$DIST_ROOT/"
chmod +x "$DIST_ROOT/start_tli.sh"

cat > "$DIST_ROOT/README.txt" << EOF
=============================================
  TheLANIntelligence (TLI)  v${VERSION}
  Your local AI-powered home console.
=============================================

QUICK START (macOS)
---------------------
Option A — Standalone binary (no Python needed):
  Double-click  tli_backend
  or run:  ./tli_backend

Option B — Python source:
  bash start_tli.sh

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
    --workpath "$BACKEND/build_work_mac" \
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

echo -e "      tli_backend binary built."

# ── Step 3: Zip ──────────────────────────────────────────────
echo -e "[3/3] Zipping package..."
cd "$SCRIPT_DIR/TLI_Installer/dist"
zip -r "TLI-v${VERSION}-mac.zip" "TLI-v${VERSION}-mac/"
echo -e "      TLI-v${VERSION}-mac.zip created."

echo ""
echo -e "${GRN}=== Build complete ===${RST}"
echo -e "  Folder : $DIST_ROOT"
echo -e "  Zip    : $SCRIPT_DIR/TLI_Installer/dist/TLI-v${VERSION}-mac.zip"
echo ""
