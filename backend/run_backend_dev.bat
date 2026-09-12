@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d %~dp0
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

echo Starting TLI backend launcher...
echo Folder: %cd%
echo.

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  set PY=py -3
) else (
  set PY=python
)

REM Prefer the project's installed dependencies when the virtual environment exists.
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"

echo Using: %PY%
%PY% --version
echo.

REM Clear old log so we're not reading stale output
if exist backend_launch.log del /q backend_launch.log

echo Launching backend (logging to backend_launch.log)...
echo.

REM Start python in background, keep logging to file
start "TLI Backend" /b cmd /c "%PY% run_backend_dev.py 1>> backend_launch.log 2>&1"

REM Give it a moment to start
timeout /t 2 >nul

echo ======================================
echo LIVE LOG (press Ctrl+C to stop tailing)
echo ======================================

REM Live-tail the log file (PowerShell is standard on Win10/11)
powershell -NoProfile -Command ^
  "if(!(Test-Path 'backend_launch.log')){New-Item -ItemType File -Path 'backend_launch.log'|Out-Null};" ^
  "Get-Content -Path 'backend_launch.log' -Wait"

REM If user stops tailing, show proof checks
echo.
echo ======================================
echo PROOF CHECKS
echo ======================================

echo Checking port 8000 listener...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8000 .*LISTENING"') do (
  set PID=%%P
)

if defined PID (
  echo OK: Port 8000 is LISTENING. PID=!PID!
  for /f "tokens=1,*" %%A in ('tasklist /FI "PID eq !PID!" ^| findstr /I "!PID!"') do (
    echo Process: %%A
  )
) else (
  echo FAIL: Nothing is listening on port 8000.
)

echo.
echo Checking /docs endpoint...
powershell -NoProfile -Command ^
  "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8000/docs; 'OK: /docs returned HTTP ' + $r.StatusCode } catch { 'FAIL: /docs not reachable: ' + $_.Exception.Message }"

echo.
echo ===== Last 60 lines of backend_launch.log =====
powershell -NoProfile -Command ^
  "if(Test-Path 'backend_launch.log'){ Get-Content 'backend_launch.log' -Tail 60 } else { 'No log file found.' }"

echo.
pause
