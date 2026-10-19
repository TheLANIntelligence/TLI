"""Capture synthetic installed-app HTTP responses for an intercepted browser trial.

No server, operational startup, network connection or installed data is used.
The shared test bootstrap establishes a temporary TLI_ROOT before any imports.
"""
import contextlib
import io
import json
from pathlib import Path


with contextlib.redirect_stdout(io.StringIO()):
    import conftest as isolation
    import tli_state as S
    from fastapi.testclient import TestClient

    S.load_pin_config = lambda: {"enabled": False}
    root = Path(S.DATA_DIR)
    app_dir = root / "apps" / "isolation-fixture"
    app_dir.mkdir(parents=True)
    metadata = {"id": "isolation-fixture", "name": "Synthetic local counter", "type": "app",
                "version": "1.0", "author": "Isolated test"}
    (root / "hub_installed.json").write_text(json.dumps([metadata]), encoding="utf-8")
    (app_dir / "manifest.json").write_text(json.dumps({**metadata, "entry": "index.html",
        "permissions": ["mesh.devices", "settings.read", "storage.local", "notifications", "shell.badge"]}), encoding="utf-8")
    source = """<!doctype html><html><head><meta charset="utf-8"><title>Local counter</title>
<script src="/tli-bridge.js"></script></head><body><h1>Local counter</h1>
<button id="add">Add</button><p id="count">0</p><form action="/forbidden-form"><input name="secret" value="synthetic"></form>
<script>
window.probe = {ready: false, permissions: null};
let total = 0;
document.getElementById('add').addEventListener('click', () => { document.getElementById('count').textContent = String(++total); });
TLIBridge.ready(permissions => { probe.ready = true; probe.permissions = permissions; });
for (const [name, operation] of Object.entries({
  parent: () => parent.document.getElementById('private-parent').textContent,
  cookie: () => document.cookie,
  storage: () => localStorage.getItem('tli_settings'),
})) { try { probe[name] = {allowed: true, value: operation()}; } catch (error) { probe[name] = {allowed: false, error: error.name}; } }
window.probeDone = Promise.all([
  fetch('/forbidden-fetch', {credentials: 'include'}).then(() => probe.fetch = 'allowed', () => probe.fetch = 'blocked'),
  TLIBridge.call('mesh.devices').then(() => probe.bridge = 'allowed', error => probe.bridge = error.message),
  TLIBridge.storage('clear').then(() => probe.bridgeStorage = 'allowed', error => probe.bridgeStorage = error.message),
]);
const img = new Image(); img.src = '/forbidden-image'; document.body.append(img);
const script = document.createElement('script'); script.src = '/forbidden-script'; document.body.append(script);
parent.postMessage({type:'tli-bridge', id:'forged', method:'storage.local', params:{action:'clear'}}, '*');
parent.postMessage({type:'tli-bridge', id:'forged-read', method:'settings.read', params:{}}, '*');
parent.postMessage({type:'tli-bridge', id:'forged-toast', method:'notifications', params:{text:'forged'}}, '*');
</script></body></html>"""
    (app_dir / "index.html").write_text(source, encoding="utf-8")
    client = TestClient(isolation._main.app, base_url="http://localhost:8000",
                        client=("127.0.0.1", 1234), headers={"Origin": "http://localhost:8000"})
    paths = ["/hub/apps", "/apps/isolation-fixture/index.html", "/apps/isolation-fixture/manifest.json"]
    responses = {}
    for path in paths:
        response = client.get(path)
        responses[path] = {"status": response.status_code, "headers": dict(response.headers), "body": response.text}
    client.close()
    assert (app_dir / "index.html").read_text(encoding="utf-8") == source

print(json.dumps(responses))
