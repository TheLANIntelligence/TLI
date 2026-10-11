@echo off
setlocal EnableExtensions

set INSTALL_DIR=%LOCALAPPDATA%\TheLANIntelligence
set TASK_NAME=TheLANIntelligence
set SHORTCUT=%USERPROFILE%\Desktop\TheLANIntelligence.url

echo.
echo  Uninstalling TheLANIntelligence...
echo.

:: Stop the backend process
taskkill /f /im tli_backend.exe >nul 2>&1

:: Remove scheduled task
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1
echo  [OK]  Startup task removed.

:: Remove desktop shortcut
if exist "%SHORTCUT%" del /q "%SHORTCUT%"
echo  [OK]  Desktop shortcut removed.

:: Remove install directory (keeps data\ so vault/settings are preserved)
if exist "%INSTALL_DIR%\tli_backend.exe" del /q "%INSTALL_DIR%\tli_backend.exe"
if exist "%INSTALL_DIR%\start_tli.bat"   del /q "%INSTALL_DIR%\start_tli.bat"
if exist "%INSTALL_DIR%\uninstall.bat"   del /q "%INSTALL_DIR%\uninstall.bat"
if exist "%INSTALL_DIR%\frontend"        rd /s /q "%INSTALL_DIR%\frontend"
echo  [OK]  Files removed.
echo        (Your data and vault at %INSTALL_DIR%\data\ were preserved.)

echo.
echo  Uninstall complete.
echo.
pause
