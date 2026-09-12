<# 
  TLI Backend Sentinel
  - Auto-kill anything on port 8000
  - Prefer virtualenv Python if found
  - Start uvicorn backend.main:app
  - Auto-restart on crash
  - Log stdout/stderr to logs\tli_backend.log
#>

param(
    [int]$Port = 8000,
    [string]$Host = "0.0.0.0",
    [switch]$NoRestart  # if set, run once and exit
)

$ErrorActionPreference = "Stop"

Write-Host "=== TheLegatoIntelligence Backend Sentinel ===" -ForegroundColor Cyan
Write-Host "Port : $Port" -ForegroundColor Gray
Write-Host "Host : $Host" -ForegroundColor Gray
Write-Host "Mode : " -NoNewline
if ($NoRestart) { Write-Host "single run (no auto-restart)" -ForegroundColor Yellow }
else           { Write-Host "watchdog (auto-restart enabled)" -ForegroundColor Green }

# ---------- Helpers ----------

function Get-PortPid {
    param([int]$Port)

    netstat -ano |
        Select-String ":$Port" |
        Where-Object { $_ -match "LISTENING" } |
        ForEach-Object {
            ($_ -split "\s+")[-1]
        } |
        Select-Object -Unique
}

function Kill-Port {
    param([int]$Port)

    $pids = Get-PortPid -Port $Port
    if (-not $pids) {
        Write-Host "No process currently listening on port $Port." -ForegroundColor DarkGray
        return
    }

    foreach ($pid in $pids) {
        Write-Host "Killing PID $pid on port $Port..." -ForegroundColor Yellow
        try {
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        } catch {
            Write-Host "  Failed to kill PID $pid: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

function Resolve-Python {
    # Prefer virtualenvs in common folders
    $candidates = @(
        ".venv\Scripts\python.exe",
        "venv\Scripts\python.exe",
        "env\Scripts\python.exe"
    )

    foreach ($c in $candidates) {
        $full = Join-Path (Get-Location) $c
        if (Test-Path $full) {
            Write-Host "Using virtualenv Python: $full" -ForegroundColor Green
            return $full
        }
    }

    # Fallback to system python
    Write-Host "No venv found, using system 'python' from PATH." -ForegroundColor Yellow
    return "python"
}

# ---------- Setup ----------

$Python = Resolve-Python

$logsDir = Join-Path (Get-Location) "logs"
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir | Out-Null
}
$logFile = Join-Path $logsDir "tli_backend.log"

Write-Host "Log file: $logFile" -ForegroundColor Gray
Write-Host ""
Write-Host "Press Ctrl + C to stop the sentinel." -ForegroundColor Cyan
Write-Host ""

# ---------- Main loop ----------

while ($true) {
    Write-Host "---------- cycle start ----------" -ForegroundColor DarkCyan
    Kill-Port -Port $Port

    $startTime = Get-Date
    Write-Host "Starting uvicorn backend.main:app at $startTime ..." -ForegroundColor Cyan

    $args = @(
        "-m", "uvicorn",
        "backend.main:app",
        "--host", $Host,
        "--port", $Port
    )

    try {
        & $Python $args 2>&1 | Tee-Object -FilePath $logFile -Append
        $exitCode = $LASTEXITCODE
    } catch {
        $exitCode = -1
        $_ | Out-String | Add-Content -Path $logFile
        Write-Host "Error launching backend: $($_.Exception.Message)" -ForegroundColor Red
    }

    $endTime = Get-Date
    $duration = New-TimeSpan -Start $startTime -End $endTime

    Write-Host "Backend exited with code $exitCode after $([int]$duration.TotalSeconds)s." -ForegroundColor Yellow

    if ($NoRestart) {
        Write-Host "NoRestart flag set; exiting sentinel." -ForegroundColor Gray
        break
    }

    Write-Host "Restarting in 3 seconds... (Ctrl + C to abort)" -ForegroundColor DarkYellow
    Start-Sleep -Seconds 3
}
