# run_backend_dev.py
# UTF-8 safe backend launcher for Windows consoles.
# Fixes a Python 3.12+ dataclasses edge case by registering the loaded module in sys.modules
# BEFORE executing it (dataclasses looks up sys.modules[__module__]).
#
import os, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAIN_PATH = HERE / "main.py"

print("TLI BACKEND DEV LAUNCHER (module-registered)")
print("Python:", sys.version.replace("\n"," "))
print("Launcher:", __file__)
print("Expecting main.py at:", MAIN_PATH)

if not MAIN_PATH.exists():
    print("ERROR: main.py not found next to launcher.")
    sys.exit(1)

os.chdir(str(HERE))
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import importlib.util
module_name = "tli_main"
spec = importlib.util.spec_from_file_location(module_name, str(MAIN_PATH))
if spec is None or spec.loader is None:
    print("ERROR: could not load spec for main.py")
    sys.exit(1)

mod = importlib.util.module_from_spec(spec)

# ✅ CRITICAL: register module before exec_module so dataclasses can resolve types
sys.modules[module_name] = mod

spec.loader.exec_module(mod)

app = getattr(mod, "app", None)
if app is None:
    print("ERROR: 'app' not found in main.py")
    sys.exit(1)

print("\nROUTES (sanity):")
found_any = False
for r in getattr(app, "routes", []):
    path = getattr(r, "path", "")
    methods = ",".join(sorted(getattr(r, "methods", []) or []))
    if path.startswith("/visualizer") or path.startswith("/debug") or path.startswith("/health"):
        print(f"  {path:<30} {methods}")
        found_any = True
if not found_any:
    print("  (no /visualizer /debug /health routes found)")

import uvicorn
host = os.environ.get("TLI_HOST", "0.0.0.0")
port = int(os.environ.get("TLI_PORT", "8000"))
print(f"\nStarting uvicorn at http://{host}:{port}")
uvicorn.run(app, host=host, port=port, log_level="info")
