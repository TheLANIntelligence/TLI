@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "PYTHONUTF8=1"
set "TLI_NODE_PY=%~dp0node\.venv\Scripts\python.exe"
if not exist "%TLI_NODE_PY%" (
    echo TLI Node needs its dedicated Python environment. Run these commands locally once:
    echo   py -3 -m venv "%~dp0node\.venv"
    echo   "%~dp0node\.venv\Scripts\python.exe" -m pip install -r "%~dp0node\requirements.txt"
    echo Then run TLI_Node.bat with a command and an explicit --state-dir.
    exit /b 1
)
"%TLI_NODE_PY%" "%~dp0backend\tli_node.py" %*
exit /b %ERRORLEVEL%
