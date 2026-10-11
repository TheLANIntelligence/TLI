"""Disposable real-SPA workflow trial with synthetic hardware, devices and model.

Run with backend/.venv/Scripts/python.exe backend/tests/experience_preview.py.
Open http://127.0.0.1:8791/?desktop=1. All saved work uses a temporary TLI_ROOT;
network access from application providers is blocked by the shared test fixture.
"""
import conftest as isolation
import json
from types import SimpleNamespace

import license
import psutil
import pytest
import uvicorn
import tli_state as S
from ai import ai_manager
from builder import llm_client
from routers import dashboard_presence as dp, home_power, shelly_routes, system_routes


def app_answer(messages, temperature, max_tokens):
    request = json.loads(messages[1]["content"])
    step = 2 if request.get("requested_changes_or_failures") else 1
    return json.dumps({
        "name": "Sample counter", "summary": f"A synthetic counter adding {step} per click.",
        "files": {
            "index.html": '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Sample counter</title><link rel="stylesheet" href="style.css"></head><body><main><h1>Sample counter</h1><p id="count" aria-live="polite">0</p><button id="add" type="button">Add</button><p>State lasts until reload.</p></main><script src="app.js"></script></body></html>',
            "style.css": 'body{font-family:system-ui;background:#f4f6fa;color:#17243b;padding:24px}main{max-width:420px;margin:auto}button{padding:12px 22px}#count{font-size:48px}',
            "app.js": f"let count=0; document.getElementById('add').addEventListener('click',()=>{{count+={step};document.getElementById('count').textContent=String(count);}});",
        },
        "checks": [{"name": "Adding updates the count", "steps": [{"action": "click", "selector": "#add"}, {"action": "text", "selector": "#count", "contains": str(step)}]}],
        "manual_checks": ["Press Add twice and verify the total.", "Reload to confirm that this sample resets."],
    }), "synthetic-local-model"


if __name__ == "__main__":
    patches = pytest.MonkeyPatch()
    isolation.isolated_background_services.__wrapped__(patches)
    system_routes._ONBOARDING_COMPLETE_FILE.write_text('{}')
    patches.setattr(license, "has_feature", lambda *a: True)
    patches.setattr(S, "load_pin_config", lambda: {"enabled": False})
    cfg = S.NodeConfig(node_id="sample-host", node_name="Sample TLI computer", created_at=S.now_iso(), updated_at=S.now_iso())
    patches.setattr(S, "load_node_config", lambda: cfg)
    patches.setattr(S, "load_mesh_directory", lambda: {})
    S.save_shelly_registry([{"id": "sample-lamp", "name": "Sample Lamp", "ip": "192.0.2.44", "relay": 0}])
    lamp = {"on": False}
    def status(ip, relay):
        return {"raw": {"switch:0": {"output": lamp["on"], "apower": 7 if lamp["on"] else 0}}, "summary": "Synthetic switch reading"}
    def command(action, **kwargs):
        previous = lamp["on"]
        lamp["on"] = not previous if action == "toggle" else action == "on"
        return {"raw": {"was_on": previous}, "summary": "Synthetic acknowledgement"}
    driver = SimpleNamespace(get_status=status, turn_on=lambda **kw: command("on", **kw), turn_off=lambda **kw: command("off", **kw), toggle=lambda **kw: command("toggle", **kw))
    patches.setattr(S, "shelly_driver", driver)
    patches.setattr(shelly_routes, "shelly_device_info_cached", lambda ip: {"ok": True, "model": "Synthetic switch"})
    patches.setattr(home_power, "get_runtime", lambda: SimpleNamespace(load_devices=lambda: [], load_scenes=lambda: [], load_automations=lambda: [], read_receipts=lambda **kw: []))
    patches.setattr(psutil, "cpu_percent", lambda **kw: 12)
    patches.setattr(psutil, "virtual_memory", lambda: SimpleNamespace(total=16*1024**3, used=5*1024**3, available=11*1024**3, percent=31))
    patches.setattr(psutil, "disk_partitions", lambda **kw: [])
    patches.setattr(psutil, "net_if_addrs", lambda: {})
    patches.setattr(dp, "_probe_metrics", lambda: {"cpu_pct": 12, "ram_pct": 31, "disk_pct_by_drive": {}})
    patches.setattr(dp, "_score_disk_actions", lambda _: None)
    manager = ai_manager.BundledAIManager.get()
    patches.setattr(manager, "status", lambda: {"healthy": False, "running": False, "model_exists": False, "active_preset": "standard", "base_url": "http://127.0.0.1:19998", "model_name": "Synthetic provider only"})
    patches.setattr(llm_client, "_chat", app_answer)
    print(f"Synthetic everyday-workflow preview: {isolation.TEST_ROOT}", flush=True)
    uvicorn.run(isolation._main.app, host="127.0.0.1", port=8791, log_level="warning")
