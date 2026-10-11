@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "TLI_SETUP_ONLY="
if /i "%~1"=="--setup-only" set "TLI_SETUP_ONLY=-SetupOnly"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0TLI_Bootstrap.ps1" %TLI_SETUP_ONLY%
set "TLI_RESULT=%ERRORLEVEL%"
if not "%TLI_RESULT%"=="0" pause
exit /b %TLI_RESULT%
