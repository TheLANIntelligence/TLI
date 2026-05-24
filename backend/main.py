# backend/main.py
# TheLANIntelligence (TLI) — FastAPI backend (refactored)
#
# This file is the ORCHESTRATOR. All endpoint logic lives in routers/.
# Shared state (paths, config, providers) lives in tli_state.py.

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import tli_state as S

# ============================================
#  FastAPI App
# ============================================

app = FastAPI(title="TheLANIntelligence Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,   # wildcard + credentials=True is a CSRF vector; same-origin cookies work without this
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)

# ============================================
#  Security response headers
# ============================================
#
# Applied to every response.
#
# CSP notes:
#   script-src 'unsafe-inline' — required because index.html uses inline onclick="..." handlers.
#   connect-src 'self'         — all API calls go to the same origin (LM Studio is proxied by the backend).
#   object-src 'none'          — no Flash / plugins ever.
#   base-uri 'self'            — prevents <base> tag injection attacks.
#   form-action 'self'         — forms may only POST back to this origin.

@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"]  = "nosniff"
    # App iframes are same-origin — allow framing for /apps/* paths only
    response.headers["X-Frame-Options"] = (
        "SAMEORIGIN" if request.url.path.startswith("/apps/") else "DENY"
    )
    response.headers["X-XSS-Protection"]         = "1; mode=block"
    response.headers["Referrer-Policy"]          = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"]       = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"]  = (
        "default-src 'self'; "
        "script-src 'self'; "                       # no unsafe-inline — handlers moved to app.js
        "style-src 'self' 'unsafe-inline'; "        # inline styles used by components
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "font-src 'self'; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "form-action 'self';"
    )
    return response

# ============================================
#  Initialise providers + config
# ============================================

from providers import LMStudioProvider
from drivers import ShellyDriver, DRIVER_REGISTRY

S.lm_provider = LMStudioProvider(
    chat_url=S.LM_STUDIO_URL,
    models_url=S.LM_STUDIO_MODELS_URL,
    connect_timeout=S.HTTP_CONNECT_TIMEOUT,
    read_timeout=S.HTTP_READ_TIMEOUT_GEN,
    debug_log=S.log_debug,
)
S.shelly_driver = ShellyDriver(
    connect_timeout=S.HTTP_CONNECT_TIMEOUT,
    read_timeout=S.HTTP_READ_TIMEOUT,
    debug_log=S.log_debug,
)

# Load persisted config
S.load_model_config_from_disk()
S.load_system_profile_from_disk()
S.load_lm_studio_config_from_disk()

# Configure vault session persistence and restore any live sessions
import vault_security as _vault_sec
_vault_sec.configure(S.DATA_DIR)
_vault_sec.load_persisted_sessions()

# Initialise node cryptographic identity
import node_identity as _node_id
_node_id.init(S.DATA_DIR)
S.log_debug("identity", "INFO", "Node identity loaded",
            node_id=_node_id.node_id(), fingerprint=_node_id.fingerprint())

# Start built-in WebSocket relay if previously enabled
from routers.relay_routes import autostart as _relay_autostart
_relay_autostart()

# Schedule background update check (runs 5 s after startup if URL is configured)
import auto_update as _auto_update
_auto_update.auto_check_on_startup()

# Load node identity
NODE_CONFIG = S.load_node_config()
S.log_debug("mesh", "INFO", "Node config loaded",
            node_id=NODE_CONFIG.node_id, node_name=NODE_CONFIG.node_name,
            role=NODE_CONFIG.role, mesh_status=NODE_CONFIG.mesh_status)

# Bootstrap license cache
import license as _L
if not os.environ.get("TLI_LICENSE_SECRET"):
    S.log_debug("license", "WARN",
                "TLI_LICENSE_SECRET not set — using dev fallback secret. "
                "Set this env var before shipping a production build.")
_stored_lic = S.load_license()
_lic_result = _L.refresh_cache(_stored_lic.get("key"), NODE_CONFIG.node_id)
S.log_debug("license", "INFO", "License cache initialised",
            tier=_lic_result.get("tier", "free"), valid=_lic_result.get("valid", False))


# ============================================
#  Initialise actions engine + home power
# ============================================

from routers.actions_engine import router as actions_router, init_actions_engine
from routers.home_power import home_power_router, init_home_power_runtime, get_runtime as _get_hp_runtime

_hp_runtime = None
try:
    _hp_runtime = init_home_power_runtime(
        data_dir=Path(S.DATA_DIR),
        shelly_driver=S.shelly_driver,
        debug_log=S.log_debug,
        driver_registry=DRIVER_REGISTRY,
    )
except Exception as _e:
    S.log_debug("homepower", "warn", f"init_home_power_runtime failed: {_e}")

try:
    init_actions_engine(
        data_dir=Path(S.DATA_DIR),
        shelly_registry_path=S.SHELLY_REGISTRY_PATH,
        shelly_driver=S.shelly_driver,
        log_debug=S.log_debug,
        home_power_runtime=_hp_runtime,
    )
except Exception as _e:
    S.log_debug("actions", "warn", f"init_actions_engine failed: {_e}")


# ============================================
#  Bundled AI bootstrap
# ============================================

from ai.ai_manager import BundledAIManager

try:
    BundledAIManager.get().ensure_running()
except Exception:
    pass


# ============================================
#  Mount ALL routers
# ============================================

# --- New split routers ---
from routers.vault_routes import router as vault_router
from routers.mesh_routes import router as mesh_router
from routers.chat_routes import router as chat_router
from routers.system_routes import router as system_router
from routers.file_routes import router as file_router
from routers.device_routes import router as device_router
from routers.tool_routes import router as tool_router
from routers.shelly_routes import router as shelly_router
from routers.search_routes import router as search_router
from routers.license_routes import router as license_router
from routers.satellite_routes import router as satellite_router
from routers.hub_routes import router as hub_router
from routers.federation_routes import router as federation_router
from routers.identity_routes import router as identity_router
from routers.relay_routes import router as relay_router
from routers.update_routes import router as update_router
from routers.builder import router as builder_router
# ai_model_routes consolidated into ai/ai_routes.py

app.include_router(identity_router)
app.include_router(relay_router)
app.include_router(update_router)
app.include_router(builder_router)
app.include_router(vault_router)
app.include_router(satellite_router)
app.include_router(hub_router)
app.include_router(federation_router)
app.include_router(mesh_router)
app.include_router(chat_router)
app.include_router(system_router)
app.include_router(file_router)
app.include_router(device_router)
app.include_router(tool_router)
app.include_router(shelly_router)
app.include_router(search_router)
app.include_router(license_router)
# app.include_router(ai_model_router)  # consolidated

# --- Existing routers (unchanged) ---
from routers.games import games_router
from routers.printers import printer_router
from routers.visualizer import visualizer_router
from routers.debug import debug_router
from routers.printshop import printshop_router
from ai.ai_routes import router as bundled_ai_router
from routers.node_routes import router as node_agent_router

app.include_router(printer_router)
app.include_router(printshop_router)
app.include_router(games_router)
app.include_router(visualizer_router)
app.include_router(debug_router)
app.include_router(actions_router, tags=["actions"])
app.include_router(home_power_router)
app.include_router(bundled_ai_router)
app.include_router(node_agent_router, tags=["node"])

import event_bus as _event_bus
app.include_router(_event_bus.router)

from routers.dashboard_presence import router as dashboard_presence_router, start_polling as _dp_start_polling, on_event as _dp_on_event
app.include_router(dashboard_presence_router)

from routers.cleanup_routes import router as cleanup_router, start_cleanup_scanner as _cleanup_start, stop_cleanup_scanner as _cleanup_stop
app.include_router(cleanup_router)


# ============================================
#  Mesh AI peer discovery endpoints
#  Called by OTHER nodes' frontends to discover and use this node's AI.
#  No session required — peer-to-peer, unauthenticated by design.
# ============================================

@app.get("/tli/capabilities")
def tli_capabilities():
    """
    Advertise this node's capabilities to LAN peers.
    The frontend's refreshLanAI() calls this on each mesh peer.
    """
    from ai.ai_manager import BundledAIManager
    mgr = BundledAIManager.get()
    st = mgr.status()
    ai_healthy = bool(st.get("healthy"))
    model_name = st.get("active_model") or st.get("active_preset") or ""
    cfg = S.load_node_config()
    return {
        "nodeId":   cfg.node_id,
        "name":     cfg.node_name or cfg.node_id,
        "version":  S.TLI_VERSION,
        "capabilities": {
            "ai": {
                "serve":     ai_healthy,
                "models":    [model_name] if (ai_healthy and model_name) else [],
                "provider":  "tli-bundled",
                "streaming": False,
            }
        },
    }


@app.post("/tli/ai/chat")
def tli_ai_chat_peer(payload: dict):
    """
    Accept a chat request from a LAN peer's frontend.
    Expects { messages: [{role, content}], requestId?, fromNodeId?, sessionId? }.
    Returns { message: { content: str }, requestId? }.
    """
    import urllib.request, urllib.error, json as _json, time as _time
    from fastapi import HTTPException
    from ai.ai_manager import BundledAIManager

    mgr = BundledAIManager.get()
    if not mgr.ensure_running():
        raise HTTPException(status_code=503, detail="AI not available on this node.")

    messages = payload.get("messages") or []
    if not messages:
        raise HTTPException(status_code=400, detail="No messages in payload.")

    req_id = payload.get("requestId", "")

    llm_payload = {
        "model": "tli-bundled",
        "messages": messages,
        "max_tokens": 512,
        "temperature": 0.2,
        "stream": False,
    }
    url = mgr.base_url + "/v1/chat/completions"
    data = _json.dumps(llm_payload).encode("utf-8")
    req = urllib.request.Request(url, data=data,
        headers={"Content-Type": "application/json"}, method="POST")

    t0 = _time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = _json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise HTTPException(status_code=502, detail=f"AI error {e.code}: {body}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI request failed: {e}")

    elapsed = int((_time.time() - t0) * 1000)
    reply_text = ""
    try:
        reply_text = result["choices"][0]["message"]["content"]
    except Exception:
        pass

    return {
        "requestId": req_id,
        "message": {"role": "assistant", "content": (reply_text or "").strip()},
        "elapsed_ms": elapsed,
        "provider": "tli-bundled",
    }


# ============================================
#  Legacy printer + game endpoints
#  (kept for backward compat with frontend)
# ============================================

# Games legacy endpoints — /games/detect, /games/recommend
# These are already in games_router. If your frontend calls paths
# that aren't on games_router, add aliases here.

# Printer aliases — multiple paths that map to the same handler
# Already handled by printer_router (/api/printers, etc.)
# Add any extra aliases your frontend expects:

@app.get("/devices/printers")
def _alias_devices_printers():
    from routers.printers import get_printers
    return get_printers()

@app.get("/printers")
def _alias_printers():
    from routers.printers import get_printers
    return get_printers()

@app.get("/devices/printers/discover")
def _alias_devices_printers_discover():
    from routers.system_routes import _run_pwsh_json
    # Forward to printers router if it has discover, otherwise return stub
    return {"ok": True, "note": "Use /api/printers/discover for full discovery."}

@app.post("/devices/quick/fix_printer")
def _alias_devices_quick_fix_printer():
    return {"ok": True, "note": "Use /api/quick/fix_printer for full flow."}

# Visualizer aliases — frontend calls /scan_directory, router is at /visualizer/treemap
@app.get("/scan_directory")
def _alias_scan_directory(path: str, max_depth: int = 6, max_entries: int = 120_000):
    from routers.visualizer import treemap
    return treemap(path=path, max_depth=max_depth, max_entries=max_entries)


@app.post("/open_path")
def _alias_open_path(payload: dict):
    """Open a file/folder with the OS default application."""
    from routers.visualizer import _open_path_handler
    path = payload.get("path", "")
    if not path:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="path is required")
    return _open_path_handler(path)


@app.post("/open_reveal")
def _alias_open_reveal(payload: dict):
    """Reveal a file/folder in Explorer/Finder with it selected."""
    from routers.visualizer import _reveal_path_handler
    path = payload.get("path", "")
    if not path:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="path is required")
    return _reveal_path_handler(path)


# ============================================
#  Static file serving
# ============================================

_MOBILE_UA_RE = None

def _is_mobile_ua(ua: str) -> bool:
    """Return True if the User-Agent string looks like a phone/tablet browser."""
    import re
    global _MOBILE_UA_RE
    if _MOBILE_UA_RE is None:
        _MOBILE_UA_RE = re.compile(
            r"android|iphone|ipad|ipod|mobile|blackberry|windows phone|opera mini",
            re.IGNORECASE,
        )
    return bool(_MOBILE_UA_RE.search(ua or ""))


@app.get("/")
def serve_index(request: Request, desktop: str = ""):
    # If ?desktop=1 is set, always serve the full UI regardless of UA
    if not desktop:
        ua = request.headers.get("user-agent", "")
        if _is_mobile_ua(ua):
            companion_path = os.path.join(S.FRONTEND_DIR, "companion.html")
            if os.path.exists(companion_path):
                return FileResponse(companion_path)
    index_path = os.path.join(S.FRONTEND_DIR, "index.html")
    if not os.path.exists(index_path):
        return {"ok": True, "name": "TLI Backend"}
    return FileResponse(index_path)


@app.get("/companion")
def serve_companion():
    path = os.path.join(S.FRONTEND_DIR, "companion.html")
    if not os.path.exists(path):
        from fastapi.responses import RedirectResponse
        return RedirectResponse("/")
    return FileResponse(path)

@app.get("/manifest.json")
def serve_manifest():
    path = os.path.join(S.FRONTEND_DIR, "manifest.json")
    if not os.path.exists(path):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="manifest.json not found")
    return FileResponse(path, media_type="application/manifest+json")

@app.get("/service-worker.js")
def serve_service_worker():
    path = os.path.join(S.FRONTEND_DIR, "service-worker.js")
    if not os.path.exists(path):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="service-worker.js not found")
    # Service workers must be served with no-cache so updates are picked up immediately
    return FileResponse(
        path,
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )

@app.get("/tli-icon.svg")
def serve_icon():
    path = os.path.join(S.FRONTEND_DIR, "tli-icon.svg")
    if not os.path.exists(path):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="tli-icon.svg not found")
    return FileResponse(path, media_type="image/svg+xml")

@app.get("/style.css")
def serve_style():
    css_path = os.path.join(S.FRONTEND_DIR, "style.css")
    if not os.path.exists(css_path):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="style.css not found")
    return FileResponse(css_path, media_type="text/css")

@app.get("/app.js")
def serve_app_js():
    js_path = os.path.join(S.FRONTEND_DIR, "app.js")
    if not os.path.exists(js_path):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="app.js not found")
    return FileResponse(
        js_path,
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )

@app.get("/sw-init.js")
def serve_sw_init():
    path = os.path.join(S.FRONTEND_DIR, "sw-init.js")
    if not os.path.exists(path):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="sw-init.js not found")
    return FileResponse(
        path,
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )

# Mount static directories (MUST be last)
try:
    if os.path.isdir(S.ASSETS_DIR):
        app.mount("/assets", StaticFiles(directory=S.ASSETS_DIR), name="assets")

    # TLI Apps: serve installed app files at /apps/{app_id}/…
    # The directory is created on first run so StaticFiles never fails.
    _apps_static_dir = os.path.join(S.DATA_DIR, "apps")
    os.makedirs(_apps_static_dir, exist_ok=True)
    app.mount("/apps", StaticFiles(directory=_apps_static_dir), name="tli-apps")

    if os.path.isdir(S.FRONTEND_DIR):
        app.mount("/", StaticFiles(directory=S.FRONTEND_DIR, html=True), name="frontend")
except Exception as e:
    S.log_debug("static", "ERROR", "Failed to mount frontend/assets", error=str(e))


# ============================================
#  Startup / Shutdown hooks
# ============================================

from routers.mesh_routes import start_background_loops, _set_presence_loop, _broadcast_presence
from ambient import run_ambient_loop
import lan_discovery

@app.on_event("startup")
async def on_startup():
    import asyncio as _asyncio
    loop = _asyncio.get_running_loop()
    # Capture running event loop for SSE presence broadcasts
    _set_presence_loop(loop)
    # Capture loop for live event feed SSE
    _event_bus.set_event_loop(loop)
    # Dashboard Presence Layer — start background poller + register classification hook
    _event_bus.register_post_emit_hook(_dp_on_event)
    _dp_start_polling()
    # Safe Cleanup Analyzer — schedule background scan (runs 15s after startup)
    _cleanup_start()
    # Mesh background heartbeat + task worker + presence timeout watcher
    start_background_loops()
    # Ambient awareness loop (disk, shelly, mesh health checks)
    _asyncio.create_task(run_ambient_loop())
    # LAN auto-discovery: UDP beacon + listener + firewall rules
    try:
        lan_discovery.set_presence_broadcast(_broadcast_presence)
        lan_discovery.start()
    except Exception as e:
        S.log_debug("mesh", "WARN", "LAN discovery failed to start", error=str(e))
    # Bundled AI auto-start
    try:
        BundledAIManager.get().ensure_running()
    except Exception as e:
        try:
            S.log_debug("ai", "ERROR", "Bundled AI startup failed", error=str(e))
        except Exception:
            pass

    # Auto-open browser when running as packaged EXE
    if getattr(sys, "frozen", False):
        import threading, webbrowser, socket as _socket
        port = int(os.environ.get("TLI_PORT", "8000"))
        scheme = "https" if S.TLS_ENABLED else "http"
        def _open_browser():
            # Wait until the server is actually accepting connections (up to 15s)
            deadline = time.time() + 15
            while time.time() < deadline:
                try:
                    with _socket.create_connection(("127.0.0.1", port), timeout=0.5):
                        break
                except OSError:
                    time.sleep(0.3)
            webbrowser.open(f"{scheme}://localhost:{port}")
        threading.Thread(target=_open_browser, daemon=True).start()

@app.on_event("shutdown")
def on_shutdown():
    lan_discovery.stop()
    try:
        from routers.dashboard_presence import stop_polling as _dp_stop
        _dp_stop()
    except Exception:
        pass
    try:
        _cleanup_stop()
    except Exception:
        pass
    try:
        BundledAIManager.get().stop()
    except Exception:
        pass


# ============================================
#  Packaged EXE entrypoint (PyInstaller)
# ============================================

def _free_port(port: int) -> None:
    """
    If another process is already listening on `port`, terminate it gracefully
    before we try to bind.  This prevents the WinError 10048 / EADDRINUSE crash
    that happens when a previous TLI instance wasn't cleanly shut down.
    Cross-platform: uses psutil (already a TLI dependency).
    """
    try:
        import psutil
        my_pid = os.getpid()
        for conn in psutil.net_connections(kind="tcp"):
            if conn.laddr.port != port:
                continue
            if conn.status not in ("LISTEN", psutil.CONN_LISTEN):
                continue
            pid = conn.pid
            if not pid or pid == my_pid:
                continue
            try:
                proc = psutil.Process(pid)
                name = proc.name()
                print(
                    f"[TLI] Port {port} held by '{name}' (PID {pid}) — "
                    "terminating previous instance…",
                    flush=True,
                )
                proc.terminate()
                proc.wait(timeout=4)
                print(f"[TLI] Previous instance (PID {pid}) stopped.", flush=True)
            except psutil.NoSuchProcess:
                pass
            except psutil.TimeoutExpired:
                try:
                    proc.kill()
                except Exception:
                    pass
            except Exception as _e:
                print(f"[TLI] Could not free port {port}: {_e}", flush=True)
    except Exception:
        pass  # psutil unavailable or permission denied — let uvicorn surface the error naturally


def _tli_run_server():
    import uvicorn
    from tls_cert import ensure_tls_cert

    host = os.environ.get("TLI_HOST", "0.0.0.0")
    port = int(os.environ.get("TLI_PORT", "8000"))
    _free_port(port)

    ssl_certfile = None
    ssl_keyfile = None

    # HTTPS is opt-in only — self-signed certs cause scary browser warnings for new users.
    # Set TLI_ENABLE_TLS=1 to turn it on (advanced / server deployments).
    if os.environ.get("TLI_ENABLE_TLS"):
        if ensure_tls_cert(S.TLS_CERT_PATH, S.TLS_KEY_PATH):
            ssl_certfile = S.TLS_CERT_PATH
            ssl_keyfile = S.TLS_KEY_PATH
            S.TLS_ENABLED = True
            print(f"[TLS] HTTPS enabled  cert={S.TLS_CERT_PATH}", flush=True)
        else:
            print("[TLS] Certificate unavailable — falling back to HTTP", flush=True)
    else:
        print("[TLS] Running HTTP (set TLI_ENABLE_TLS=1 to enable HTTPS)", flush=True)

    uvicorn.run(
        app, host=host, port=port, log_level="info",
        ssl_certfile=ssl_certfile,
        ssl_keyfile=ssl_keyfile,
    )


if __name__ == "__main__" or getattr(sys, "frozen", False):
    _tli_run_server()
