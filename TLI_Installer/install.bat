@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1

set "INSTALL_DIR=%LOCALAPPDATA%\TheLANIntelligence"
set "TASK_NAME=TheLANIntelligence"
set "SHORTCUT=%USERPROFILE%\Desktop\TheLANIntelligence.url"
set "SRC=%~dp0"

echo.
echo  +--------------------------------------------------+
echo  ^|   TheLANIntelligence  --  Installer  v0.9.9.1   ^|
echo  +--------------------------------------------------+
echo.

:: ── Verify required files ─────────────────────────────────────────────
if not exist "%SRC%tli_backend.exe" (
    echo  ERROR: tli_backend.exe not found.
    echo  Make sure you extracted the entire zip before running this.
    echo.
    pause
    exit /b 1
)
if not exist "%SRC%frontend" (
    echo  ERROR: frontend folder not found.
    echo  Make sure you extracted the entire zip before running this.
    echo.
    pause
    exit /b 1
)

:: ── Copy files ────────────────────────────────────────────────────────
echo  [1/4]  Copying files...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
xcopy /E /I /Y /Q "%SRC%frontend" "%INSTALL_DIR%\frontend\"
if exist "%SRC%ai" xcopy /E /I /Y /Q "%SRC%ai" "%INSTALL_DIR%\ai\"
copy /Y "%SRC%tli_backend.exe" "%INSTALL_DIR%\tli_backend.exe"
copy /Y "%SRC%start_tli.bat"   "%INSTALL_DIR%\start_tli.bat"
copy /Y "%SRC%uninstall.bat"   "%INSTALL_DIR%\uninstall.bat"
if exist "%SRC%README.txt" copy /Y "%SRC%README.txt" "%INSTALL_DIR%\README.txt"
echo         Done.

:: ── Scheduled task ────────────────────────────────────────────────────
echo  [2/4]  Creating startup task...
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1
schtasks /create /tn "%TASK_NAME%" /tr "cmd.exe /c \"\"%INSTALL_DIR%\start_tli.bat\"\"" /sc onlogon /delay 0000:20 /rl limited /f >nul 2>&1
if %ERRORLEVEL%==0 (
    echo         Startup task created.
) else (
    echo         WARNING: Could not create startup task.
    echo         TLI will still work but won't auto-start on login.
    echo         To fix: right-click install.bat and choose "Run as administrator".
)

:: ── Firewall rules (required for LAN discovery between devices) ────────
echo  [3/5]  Adding firewall rules...
netsh advfirewall firewall delete rule name="TLI-Web"       >nul 2>&1
netsh advfirewall firewall delete rule name="TLI-Discovery" >nul 2>&1
netsh advfirewall firewall add rule name="TLI-Web"       dir=in action=allow protocol=TCP localport=8000  >nul 2>&1
netsh advfirewall firewall add rule name="TLI-Discovery" dir=in action=allow protocol=UDP localport=47474 >nul 2>&1
if %ERRORLEVEL%==0 (
    echo         Firewall rules added.
) else (
    echo         NOTE: Firewall rules need admin rights.
    echo         If other TLI devices don't appear in Chat, right-click
    echo         install.bat and choose "Run as administrator".
)

:: ── Desktop shortcut ──────────────────────────────────────────────────
echo  [4/5]  Creating desktop shortcut...
(
    echo [InternetShortcut]
    echo URL=http://localhost:8000
) > "%SHORTCUT%"
echo         Done.

:: ── Start TLI ─────────────────────────────────────────────────────────
echo  [5/5]  Starting TLI...
set "TLI_ROOT=%INSTALL_DIR%"
start "TLI Backend" "%INSTALL_DIR%\tli_backend.exe"
timeout /t 4 >nul
start "" "http://localhost:8000"

echo.
echo  +--------------------------------------------------+
echo  ^|   Install complete!                              ^|
echo  ^|   TLI is opening in your browser now.           ^|
echo  ^|   It will auto-start on every login.            ^|
echo  +--------------------------------------------------+
echo.
pause
