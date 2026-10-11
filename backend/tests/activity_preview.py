"""Disposable home-awareness UI fixture; no real devices, files or inference."""
import conftest as isolation  # establish temporary persistence before imports
import pytest
import uvicorn
from collections import deque
from types import SimpleNamespace
import time
import psutil
import event_bus
import activity_summary
from routers import dashboard_presence as dp, system_routes


if __name__ == "__main__":
    patches = pytest.MonkeyPatch()
    isolation.isolated_background_services.__wrapped__(patches)
    system_routes._ONBOARDING_COMPLETE_FILE.write_text("{}")
    psutil.cpu_percent = lambda **kw: 15
    psutil.virtual_memory = lambda: SimpleNamespace(total=16*1024**3, used=6*1024**3, available=10*1024**3, percent=37)
    psutil.disk_partitions = lambda **kw: []
    dp._probe_metrics = lambda: {"cpu_pct": 15, "ram_pct": 37, "disk_pct_by_drive": {"C:\\": 40}}
    dp._score_disk_actions = lambda _: None
    event_bus._events = deque(maxlen=200)
    event_bus._sequence = 0
    # The real endpoint and review store operate against these simulated events.
    activity_summary.mark_reviewed("local", event_bus.activity_snapshot()["cursor"])
    fixtures = [
        ("device", "warn", "Desk lamp did not respond", "The last command did not complete. Check its current state in Devices.", "Office"),
        ("device", "ok", "Desk lamp responded", "A later status request received a response.", "Office"),
        ("system", "warn", "Storage scan partially completed", "28 files inspected. Some folders could not be read; no files were changed.", "Preview host"),
        ("ai", "ok", "Model installation finished", "All required files validated. Installation did not change the selection.", "Preview host"),
        ("system", "info", "Diagnostic checks completed", "4 passed, 1 unavailable. Open Diagnostics for the measured scope.", "Preview host"),
        ("device", "info", "A device with a long name to check wrapping on a narrow phone screen", "A recorded change for this configured device.", "Upstairs hallway"),
    ]
    for category, level, title, body, node in fixtures:
        event_bus.emit_event(category, level, title, body, node=node)
    for _ in range(2):
        event_bus.emit_event(*fixtures[0][:4], node=fixtures[0][4])
    dp._write_state({"cpu_pct": 15, "ram_pct": 37, "disk_pct_by_drive": {"C:\\": 40}, "probed_ts": time.time()})
    print(f"Disposable activity preview: {isolation.TEST_ROOT}", flush=True)
    uvicorn.run(isolation._main.app, host="127.0.0.1", port=8766, log_level="warning")
