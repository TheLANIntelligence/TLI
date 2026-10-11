"""Disposable component fixture with synthetic owner data; no live TLI calls."""
import conftest as isolation  # Establish all paths/network guards before imports.
import argparse
from pathlib import Path

from fastapi import FastAPI, Depends
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

import tli_state as S
from intelligence import data_health, store
from routers import backup_routes
from routers.system_routes import require_session

app = FastAPI()
app.dependency_overrides[require_session] = lambda: "preview-owner"
app.include_router(backup_routes.router)


@app.get("/api/intelligence/data-health")
def inspect_data(user=Depends(require_session)):
    return data_health.inspect(user)


@app.get("/", response_class=HTMLResponse)
def page():
    return """<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Notebook & history backup — disposable preview</title>
    <link rel="stylesheet" href="/files/style.css"><link rel="stylesheet" href="/files/settings_enhanced.css">
    <link rel="stylesheet" href="/files/data-recovery.css">
    <style>body{margin:0;background:#0b1220;color:#e8edf7;font-family:system-ui}main{max-width:1060px;margin:24px auto;padding:0 16px;box-sizing:border-box}p{line-height:1.5}</style>
    </head><body><main id="panel-settings"><h1>TLI Settings</h1><p>Disposable preview. All saved records are synthetic; this is not your live TLI.</p></main>
    <script src="/files/js/data-recovery.js"></script>
    </body></html>"""


app.mount("/files", StaticFiles(directory=Path(__file__).resolve().parents[2] / "frontend"), name="files")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8792)
    args = parser.parse_args()
    S.save_memory("preview-owner", {"facts": [{"id": "preview-note", "text": "Synthetic warranty information", "title": "Sample warranty", "category": "general"}]})
    S.save_conversations({"preview-chat": {"id": "preview-chat", "user_id": "preview-owner", "title": "Synthetic conversation", "messages": [{"role": "user", "content": "Where is the spare cable?"}, {"role": "assistant", "content": "The saved note says it is in the drawer."}]}})
    store.write_private("preview-owner", "diagnostics", [{"id": "preview-report", "kind": "system", "checks": []}])
    print(f"Disposable backup preview data: {isolation.TEST_ROOT}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
