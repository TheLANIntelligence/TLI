@echo off
setlocal EnableExtensions DisableDelayedExpansion
echo.
echo TLI removal guide
echo.
echo This installation:
echo "%~dp0"
echo.
echo 1. Review and verify any Settings and Vault backups you need.
echo 2. In local Setup, remove the helper sign-in shortcut, stop the helper,
echo    and choose Stop TLI. Let active file and device work finish first.
echo 3. Remove this installation's TLI Desktop and Start menu shortcuts.
echo    Also remove its older TLI Setup desktop shortcut, if present.
echo 4. After TLI has stopped, remove its folder using File Explorer.
echo    Deleting its data folder deletes saved work, credentials and Vault.
echo.
echo This guide does not kill processes or delete files automatically.
echo Older TLI instances started in a visible terminal must be stopped there.
echo.
set /p "TLI_REMOVE_CHOICE=Open local Setup now? Type YES: "
if /i not "%TLI_REMOVE_CHOICE%"=="YES" exit /b 0
call "%~dp0TLI_Setup.bat"
echo.
echo Return to the checklist above before removing the installation folder.
pause
