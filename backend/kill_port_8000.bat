\
@echo off
setlocal
echo 🔎 Finding processes on port 8000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do (
  echo 🧨 Killing PID %%a (port 8000)
  taskkill /PID %%a /F >nul 2>nul
)
echo ✅ Done. Now start backend with run_backend_dev.bat
pause
