@echo off
setlocal EnableExtensions DisableDelayedExpansion

:: ============================================================
::  TLI_Start.bat - TheLANIntelligence Windows Launcher
::  Double-click this from the TLI root folder.
:: ============================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "BACKEND=%ROOT%\backend"
set "VENV=%BACKEND%\.venv"
set "REQS=%BACKEND%\requirements.txt"

echo.
echo  TheLANIntelligence v1.5
echo  LAN Console - Local - No cloud
echo.

:: ── Find Python ──────────────────────────────────────────────
set "PY="

py --version >nul 2>&1
if not errorlevel 1 set "PY=py"

if "%PY%"=="" (
    python --version >nul 2>&1
    if not errorlevel 1 set "PY=python"
)

if not "%PY%"=="" goto :python_found

:: ── Python not found — install automatically ─────────────────
echo  Python not found. Installing automatically...
echo.

:: Try winget first (built into Windows 10/11 — gets the latest Python)
winget --version >nul 2>&1
if not errorlevel 1 (
    echo  Using winget to install Python...
    winget install --id Python.Python.3 --source winget --silent --accept-source-agreements --accept-package-agreements
    if not errorlevel 1 (
        echo  winget install complete.
        goto :find_after_install
    )
    echo  winget install failed. Falling back to direct download...
    echo.
)

:: Fallback: download Python 3.12.9 installer with curl (built-in since Win10 1803)
set "PY_VERSION=3.12.9"
set "PY_INSTALLER=%TEMP%\tli_python_setup.exe"
echo  Downloading Python %PY_VERSION% installer...
curl -L --progress-bar -o "%PY_INSTALLER%" "https://www.python.org/ftp/python/%PY_VERSION%/python-%PY_VERSION%-amd64.exe"
if errorlevel 1 (
    echo.
    echo  ERROR: Could not download Python installer.
    echo  Please install Python 3.10+ manually from https://python.org
    echo  Check "Add Python to PATH" during install, then run this file again.
    echo.
    pause
    exit /b 1
)

echo  Running Python installer (may take a minute)...
"%PY_INSTALLER%" /quiet InstallAllUsers=0 PrependPath=1 Include_test=0 Include_pip=1
del "%PY_INSTALLER%" >nul 2>&1

:: ── Locate Python after install (PATH not yet refreshed in this shell) ──
:find_after_install
set "PY="

:: Check py launcher (placed by installer in C:\Windows or user local bin)
if exist "C:\Windows\py.exe" set "PY=C:\Windows\py.exe"

:: Check user-mode Python install locations (3.13, 3.12, 3.11, 3.10)
if "%PY%"=="" (
    for %%V in (313 312 311 310) do (
        if "%PY%"=="" (
            if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" (
                set "PY=%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
            )
        )
    )
)

:: Check system-wide install locations
if "%PY%"=="" (
    for %%V in (313 312 311 310) do (
        if "%PY%"=="" (
            if exist "C:\Python%%V\python.exe" (
                set "PY=C:\Python%%V\python.exe"
            )
        )
    )
)

:: Refresh PATH from registry and try again
if "%PY%"=="" (
    for /f "skip=2 tokens=2*" %%A in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "PATH=%%B;%PATH%"
    for /f "skip=2 tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul') do set "PATH=%%B;%PATH%"
    py --version >nul 2>&1
    if not errorlevel 1 set "PY=py"
)
if "%PY%"=="" (
    python --version >nul 2>&1
    if not errorlevel 1 set "PY=python"
)

if "%PY%"=="" (
    echo.
    echo  Python installed but this window cannot see it yet.
    echo  Please close this window and run TLI_Start.bat again.
    echo.
    pause
    exit /b 0
)

:python_found
echo  Python found: %PY%

:: ── Create venv if missing ────────────────────────────────────
if not exist "%VENV%\Scripts\python.exe" (
    echo  Creating virtual environment...
    "%PY%" -m venv "%VENV%"
    if errorlevel 1 (
        echo ERROR: Could not create virtual environment.
        pause
        exit /b 1
    )
    echo  Virtual environment created.
)

:: ── Use venv python directly (no activate needed) ────────────
set "PYTHON=%VENV%\Scripts\python.exe"

:: ── Install dependencies ──────────────────────────────────────
echo  Checking dependencies...
if exist "%REQS%" (
    "%PYTHON%" -m pip install --quiet -r "%REQS%"
) else (
    echo ERROR: Missing backend requirements.txt. Extract a complete TLI package.
    pause
    exit /b 1
)
if errorlevel 1 (
    echo ERROR: Dependency installation failed. TLI has not been started.
    pause
    exit /b 1
)

:: Check the address without stopping an existing server.
set "TLI_ROOT=%ROOT%"
"%PYTHON%" "%BACKEND%\launch_checks.py"
if errorlevel 1 (
    pause
    exit /b 1
)

:: Backend opens the browser only after listening, using the resolved settings.
set "TLI_OPEN_BROWSER=1"

:: ── Launch TLI ────────────────────────────────────────────────
echo  Starting TLI with saved settings and explicit environment overrides.
echo  Close this window to stop TLI.
echo.

cd /d "%BACKEND%"
set "TLI_ROOT=%ROOT%"
"%PYTHON%" main.py

echo.
echo  TLI has stopped.
pause
