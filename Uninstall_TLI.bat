@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem A native review opens without starting TLI or requiring Python.
set "TLI_UNINSTALL_SCRIPT=%~dp0TLI_Uninstall.ps1"
cd /d "%TEMP%"
start "" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%TLI_UNINSTALL_SCRIPT%"
exit /b
