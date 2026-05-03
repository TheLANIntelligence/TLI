@echo off
setlocal EnableExtensions

:: ============================================================
::  Uninstall_TLI.bat — Remove TheLANIntelligence (Windows)
::  Double-click this file to uninstall TLI completely.
:: ============================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo.
echo  TheLANIntelligence — Uninstaller
echo  ─────────────────────────────────────
echo.
echo  This will:
echo    - Stop TLI if it is running
echo    - Delete all TLI files and data from:
echo      %ROOT%
echo.
echo  This cannot be undone. Your vault, saved settings,
echo  and AI models stored in this folder will be removed.
echo.

set /p "CONFIRM=  Type YES to confirm: "
if /i not "%CONFIRM%"=="YES" (
    echo.
    echo  Cancelled. Nothing was removed.
    echo.
    pause
    exit /b 0
)

echo.
echo  Stopping TLI (if running)...

:: Kill any process on port 8000
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":8000 "') do (
    taskkill /PID %%P /F >nul 2>&1
)

:: Also kill by window title in case it's running in a named window
taskkill /fi "WINDOWTITLE eq TheLANIntelligence*" /F >nul 2>&1

echo  Removing TLI files...

:: Move out of the folder first, then delete it via a temp script
cd /d "%TEMP%"

:: Write a tiny delayed-delete script and run it in the background
set "DELSCRIPT=%TEMP%\tli_uninstall_del.bat"
(
    echo @echo off
    echo timeout /t 1 /nobreak ^>nul
    echo rd /s /q "%ROOT%"
    echo echo.
    echo echo  TLI has been removed.
    echo echo  You can close this window.
    echo echo.
    echo pause
    echo del "%%~f0"
) > "%DELSCRIPT%"

start "TLI Uninstall" cmd /c "%DELSCRIPT%"

echo.
echo  Done. TLI is being removed.
echo  You can close this window.
echo.
pause
exit /b 0
