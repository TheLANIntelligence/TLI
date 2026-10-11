@echo off
setlocal EnableExtensions DisableDelayedExpansion
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0TLI_Setup.ps1" %*
if errorlevel 1 pause
