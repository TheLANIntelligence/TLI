#!/usr/bin/env bash
# ============================================================
#  Uninstall_TLI.sh — Remove TheLANIntelligence (Linux)
#  Run: bash Uninstall_TLI.sh
# ============================================================

GRN='\033[0;32m'; YLW='\033[1;33m'; RED='\033[0;31m'; RST='\033[0m'

TLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "  TheLANIntelligence — Uninstaller"
echo "  ─────────────────────────────────────"
echo ""
echo "  This will:"
echo "    - Stop TLI if it is running"
echo "    - Delete all TLI files and data from:"
echo "      $TLI_DIR"
echo ""
echo "  This cannot be undone. Your vault, saved settings,"
echo "  and AI models stored in this folder will be removed."
echo ""
read -r -p "  Type YES to confirm: " CONFIRM

if [ "$CONFIRM" != "YES" ]; then
    echo ""
    echo "  Cancelled. Nothing was removed."
    echo ""
    exit 0
fi

echo ""
echo "  Stopping TLI (if running)..."

# Kill any process holding port 8000
if command -v lsof &>/dev/null; then
    lsof -ti tcp:8000 | xargs kill -TERM 2>/dev/null || true
    sleep 1
    lsof -ti tcp:8000 | xargs kill -KILL 2>/dev/null || true
elif command -v fuser &>/dev/null; then
    fuser -k 8000/tcp 2>/dev/null || true
fi

echo "  Removing TLI files..."

# Move to a safe directory before deleting, then remove
cd /tmp
rm -rf "$TLI_DIR"

echo ""
echo -e "${GRN}  TLI has been removed.${RST}"
echo ""
echo "  If you installed the browser extension, remove it from:"
echo "  Chrome/Edge → Extensions → TheLANIntelligence → Remove"
echo ""
