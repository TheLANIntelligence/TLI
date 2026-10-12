@echo off
setlocal EnableExtensions DisableDelayedExpansion
title TLI - Update an existing installation
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0TLI_Update.ps1" %*
set "TLI_UPDATE_RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %TLI_UPDATE_RESULT%
