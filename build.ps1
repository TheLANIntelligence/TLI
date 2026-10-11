# TLI Build Script
# Run from J:\TheLegatoIntelligence\ in PowerShell (no admin needed)
# Usage: .\build.ps1

$ErrorActionPreference = "Stop"

$ROOT      = $PSScriptRoot
$BACKEND   = "$ROOT\backend"
$FRONTEND  = "$ROOT\frontend"
$INSTALLER = "$ROOT\TLI_Installer"
$VERSION   = "0.9.9.1"
$DIST_DIR  = "$INSTALLER\dist\TLI-v$VERSION"

Write-Host ""
Write-Host "=== TLI Build  v$VERSION ===" -ForegroundColor Cyan
Write-Host "Root: $ROOT"
Write-Host ""

# ── Step 1: Prepare dist folder ───────────────────────────────────────
Write-Host "[1/3] Preparing dist folder..." -ForegroundColor Yellow

if (Test-Path $DIST_DIR) { Remove-Item $DIST_DIR -Recurse -Force }
New-Item -ItemType Directory -Path "$DIST_DIR\frontend" -Force | Out-Null

# Copy frontend
Copy-Item "$FRONTEND\*" "$DIST_DIR\frontend\" -Recurse -Force
Write-Host "      Frontend copied." -ForegroundColor Green

# Copy AI runtime (llama_server.exe + DLLs) — required for bundled AI
$AI_RUNTIME = "$BACKEND\ai\runtime"
if (Test-Path $AI_RUNTIME) {
    New-Item -ItemType Directory -Path "$DIST_DIR\ai\runtime" -Force | Out-Null
    Copy-Item "$AI_RUNTIME\*" "$DIST_DIR\ai\runtime\" -Recurse -Force
    Write-Host "      AI runtime copied." -ForegroundColor Green
} else {
    Write-Host "      WARNING: ai\runtime not found - bundled AI will not work." -ForegroundColor Red
}

# Copy AI prompts (system_default.txt etc.)
$AI_PROMPTS = "$BACKEND\ai\prompts"
if (Test-Path $AI_PROMPTS) {
    New-Item -ItemType Directory -Path "$DIST_DIR\ai\prompts" -Force | Out-Null
    Copy-Item "$AI_PROMPTS\*" "$DIST_DIR\ai\prompts\" -Recurse -Force
    Write-Host "      AI prompts copied." -ForegroundColor Green
}

# Create empty ai\models placeholder so the path exists on first run
New-Item -ItemType Directory -Path "$DIST_DIR\ai\models" -Force | Out-Null
Write-Host "      AI models placeholder created." -ForegroundColor Green

# Copy installer scripts + readme
Copy-Item "$INSTALLER\install.bat"   $DIST_DIR -Force
Copy-Item "$INSTALLER\uninstall.bat" $DIST_DIR -Force
Copy-Item "$INSTALLER\start_tli.bat" $DIST_DIR -Force
Copy-Item "$INSTALLER\README.txt"    $DIST_DIR -Force
Write-Host "      Installer scripts copied." -ForegroundColor Green

# ── Step 2: Build backend EXE with PyInstaller ────────────────────────
Write-Host "[2/3] Building backend EXE with PyInstaller..." -ForegroundColor Yellow

Push-Location $BACKEND
try {
    & ".\.venv\Scripts\pyinstaller.exe" tli_backend.spec --distpath "$BACKEND\dist_build" --workpath "$BACKEND\build_work" --noconfirm
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

$newExe = "$BACKEND\dist_build\tli_backend.exe"
if (!(Test-Path $newExe)) { throw "tli_backend.exe not found at $newExe" }
Copy-Item $newExe $DIST_DIR -Force
Write-Host "      tli_backend.exe copied." -ForegroundColor Green

# ── Step 3: Zip it up ────────────────────────────────────────────────
Write-Host "[3/3] Zipping package..." -ForegroundColor Yellow

$zipPath = "$INSTALLER\dist\TLI-v$VERSION.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $DIST_DIR -DestinationPath $zipPath
Write-Host "      TLI-v$VERSION.zip created." -ForegroundColor Green

Write-Host ""
Write-Host "=== Build complete ===" -ForegroundColor Cyan
Write-Host "Folder : $DIST_DIR" -ForegroundColor Green
Write-Host "Zip    : $zipPath"   -ForegroundColor Green
Write-Host ""
Write-Host "To install: copy TLI-v$VERSION.zip to the target machine, extract, run install.bat" -ForegroundColor Yellow
Write-Host ""
