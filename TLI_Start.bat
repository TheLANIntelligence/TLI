@echo off
setlocal EnableExtensions DisableDelayedExpansion
title TLI - Starting
echo.
echo  Starting TLI...
echo  Checking this installation's dependencies.
echo.
set "TLI_LAUNCH_PY=%~dp0backend\.venv\Scripts\python.exe"
if not exist "%TLI_LAUNCH_PY%" (
    echo First-time setup needs this installation's Python environment.
    echo The one-time setup will prepare dependencies, then open TLI.
    call "%~dp0TLI_Diagnostics.bat" --setup-only
    if errorlevel 1 exit /b 1
)
if not exist "%TLI_LAUNCH_PY%" exit /b 1
"%TLI_LAUNCH_PY%" "%~dp0backend\host_launcher.py" --check-dependencies
if errorlevel 1 (
    echo Preparing missing or updated dependencies for this installation...
    "%TLI_LAUNCH_PY%" -m pip install -r "%~dp0backend\requirements.txt"
    if errorlevel 1 (
        echo Dependencies could not be prepared. No backend was started.
        pause
        exit /b 1
    )
)
if exist "%~dp0TLI.exe" (
    "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0TLI_Setup.ps1" -Action CreateShortcuts
    if errorlevel 1 echo Shortcuts could not be created. You can still open TLI.exe from this folder.
)
"%TLI_LAUNCH_PY%" "%~dp0backend\host_launcher.py"
if errorlevel 1 (
    pause
    exit /b 1
)
exit /b 0
