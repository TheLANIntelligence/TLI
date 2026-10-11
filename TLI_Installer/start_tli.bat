@echo off
:: TLI silent backend launcher
:: Called by the Windows startup scheduled task
set TLI_ROOT=%~dp0
start "" /b "%~dp0tli_backend.exe"
