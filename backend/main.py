# backend/main.py
# TheLANIntelligence (TLI) — FastAPI backend (refactored)
#
# This file is the ORCHESTRATOR. All endpoint logic lives in routers/.
# Shared state (paths, config, providers) lives in tli_state.py.

from __future__ import annotations

import os
import sys
# Frozen scan children must dispatch before FastAPI, state, providers or startup.
if "--tli-storage-worker" in sys.argv:
    if sys.argv[1:] != ["--tli-storage-worker"]:
        raise SystemExit(2)
    from storage_scan_worker import main as _storage_worker_main
    _storage_worker_main()
    raise SystemExit(0)
import time
from pathlib import Path

import release_identity
release_identity.capture()

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import tli_state as S


def _validate_startup():
    from startup_config import resolve, local_only
    from security_state import validate_existing_security
    settings = resolve(S.BASE_DIR)
    validate_existing_security()
    if settings["configured"] and not local_only(settings["effective_next"]["host"]) and not S.load_pin_config()["enabled"]:
        raise RuntimeError("Saved secure LAN startup requires a readable, enabled desktop PIN. Restore the matching configuration before restarting.")
    return settings["effective_next"]


# Validate persisted security before identity initialization, relay/update startup
# or any other application worker. Invalid files must not become a fresh setup.
try:
    _validate_startup()
except Exception as error:
    if __name__ == "__main__" or getattr(sys, "frozen", False):
        print(f"[TLI] Startup stopped: {getattr(error, 'detail', str(error))}", flush=True)
        raise SystemExit(1) from error
    raise

# ============================================
#  FastAPI App
# ============================================

app = FastAPI(title="TheLANIntelligence Backend")


def _cors_origins() -> list[str]:
    raw = os.environ.get("TLI_CORS_ORIGINS", "").strip()
    if raw:
        return [item.strip() for item in raw.split(",") if item.strip()]
    if os.environ.get("TLI_ALLOW_ANY_CORS") == "1":
        return ["*"]
    return [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
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
    # Only the authenticated Builder preview renderer sets this internal state.
    # Its response policy forces an opaque sandbox even on a top-level visit.
    # A srcdoc frame would inherit TLI's no-inline-script policy and cannot run.
    isolated_preview = getattr(request.state, "tli_isolated_app_preview", False) is True
    response.headers["X-Content-Type-Options"]  = "nosniff"
    # App iframes are same-origin — allow framing for /apps/* paths only
    response.headers["X-Frame-Options"] = (
        "SAMEORIGIN" if isolated_preview or request.url.path.startswith("/apps/") else "DENY"
    )
    response.headers["X-XSS-Protection"]         = "1; mode=block"
    response.headers["Referrer-Policy"]          = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"]       = "camera=(), microphone=(), geolocation=()"
    if isolated_preview:
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        # Fail closed if the renderer ever omits its required sandbox policy.
        policy = response.headers.get("Content-Security-Policy", "")
        if not policy.startswith("sandbox allow-scripts;"):
            response.headers["Content-Security-Policy"] = "sandbox; default-src 'none'; frame-ancestors 'self'"
        return response
    # Only the fixed Companion landing route sets this internal marker.
    # Its fragment contains a short-lived invitation; preserve the stricter
    # response policy without trusting request headers or relaxing the SPA.
    if getattr(request.state, "tli_companion_pair_landing", False) is True:
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = (
            "default-src 'none'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; font-src 'self'; connect-src 'none'; "
            "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        )
        return response
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
from routers.intelligence_routes import router as intelligence_router
app.include_router(intelligence_router)
from routers.places_routes import router as places_router
app.include_router(places_router)
from routers.memory_tools_routes import router as memory_tools_router
app.include_router(memory_tools_router)
from routers.conversation_search_routes import router as conversation_search_router
app.include_router(conversation_search_router)
from routers.backup_routes import router as backup_router
app.include_router(backup_router)
from routers.vault_backup_routes import router as vault_backup_router
app.include_router(vault_backup_router)
from routers.cases_routes import router as cases_router
app.include_router(cases_router)
from routers.case_export_routes import router as case_export_router
app.include_router(case_export_router)
from routers.document_extraction_routes import router as document_extraction_router
app.include_router(document_extraction_router)
from routers.note_search_routes import router as note_search_router
app.include_router(note_search_router)
from routers.mcp_routes import router as mcp_router
app.include_router(mcp_router)
from routers.home_assistant_routes import router as home_assistant_router
app.include_router(home_assistant_router)
from routers.mcp_client_routes import router as mcp_client_router
app.include_router(mcp_client_router)
from routers.performance_routes import router as performance_router
app.include_router(performance_router)
from routers.companion_routes import router as companion_router
app.include_router(companion_router)
from routers.host_control_routes import router as host_control_router
app.include_router(host_control_router)
from routers.peer_transfer_routes import router as peer_transfer_router
app.include_router(peer_transfer_router)
from routers.lan_inference_routes import router as lan_inference_router
app.include_router(lan_inference_router)
from companion_auth import validate_authorization as _validate_companion_authorization
app.middleware("http")(_validate_companion_authorization)

from routers.cleanup_routes import router as cleanup_router, start_cleanup_scanner as _cleanup_start, stop_cleanup_scanner as _cleanup_stop
app.include_router(cleanup_router)


# ============================================
#  Mesh AI peer discovery endpoints
#  Called by OTHER nodes' frontends to discover and use this node's AI.
#  Legacy read-only advertisement; generation requires signed peer inference.
# ============================================

@app.get("/tli/capabilities")
def tli_capabilities():
    """
    Advertise this node's capabilities to LAN peers.
    Legacy clients may inspect this; inference uses the signed peer protocol.
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
                "serve":     False,  # unsigned legacy generation is retired
                "models":    [model_name] if (ai_healthy and model_name) else [],
                "provider":  "tli-bundled",
                "streaming": False,
            }
        },
    }


@app.post("/tli/ai/chat")
def tli_ai_chat_peer(payload: dict):
    """The previous unauthenticated generation endpoint is deliberately retired."""
    from fastapi import HTTPException
    raise HTTPException(410, "Legacy LAN chat is retired. Pair TLI peers, review the inference grant, and select a LAN model in Ask TLI.")


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
    _validate_startup()
    _event_bus.start_activity_history(S.DATA_DIR)
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
    if getattr(sys, "frozen", False) or os.environ.get("TLI_OPEN_BROWSER") == "1":
        import threading, webbrowser, socket as _socket
        from startup_config import browser_url
        port = S.SERVER_BIND_PORT
        host = S.SERVER_BIND_HOST
        connect_host = "::1" if host in {"::", "::1"} else "127.0.0.1" if host in {"0.0.0.0", "localhost"} else host
        url = browser_url({"host": host, "port": port, "https": bool(S.TLS_ENABLED)})
        def _open_browser():
            # Wait until the server is actually accepting connections (up to 15s)
            deadline = time.time() + 15
            while time.time() < deadline:
                try:
                    with _socket.create_connection((connect_host, port), timeout=0.5):
                        break
                except OSError:
                    time.sleep(0.3)
            else:
                return  # startup never became reachable; do not open a dead page
            webbrowser.open(url)
        threading.Thread(target=_open_browser, daemon=True).start()

@app.on_event("shutdown")
def on_shutdown():
    from storage_jobs import shutdown as _storage_jobs_shutdown
    _storage_jobs_shutdown()
    _event_bus.unregister_post_emit_hook(_dp_on_event)
    _event_bus.set_event_loop(None)
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
    _event_bus.stop_activity_history()


# ============================================
#  Packaged EXE entrypoint (PyInstaller)
# ============================================

def _tli_run_server():
    import uvicorn
    from launch_checks import check_port
    from tls_cert import ensure_tls_cert

    settings = _validate_startup()
    host, port = settings["host"], settings["port"]
    check_port(host, port)
    S.SERVER_BIND_HOST = host
    S.SERVER_BIND_PORT = port

    ssl_certfile = None
    ssl_keyfile = None

    # HTTPS remains opt-in through saved settings or explicit environment values.
    S.TLS_ENABLED = False
    if settings["https"]:
        if ensure_tls_cert(S.TLS_CERT_PATH, S.TLS_KEY_PATH):
            ssl_certfile = S.TLS_CERT_PATH
            ssl_keyfile = S.TLS_KEY_PATH
            S.TLS_ENABLED = True
            print(f"[TLS] HTTPS enabled  cert={S.TLS_CERT_PATH}", flush=True)
        else:
            raise RuntimeError("HTTPS was requested but the certificate/key is unavailable or invalid. Repair TLS before restarting; HTTP was not started.")
    else:
        print("[TLS] Running HTTP (set TLI_ENABLE_TLS=1 to enable HTTPS)", flush=True)

    from startup_config import browser_url
    print(f"[TLI] Starting at {browser_url(settings)}", flush=True)

    from startup_config import local_only
    if not local_only(host):
        print(
            "[TLI] LAN bind enabled. Use TLI_HOST=127.0.0.1 for local-only or set a PIN before exposing on LAN.",
            flush=True,
        )
    else:
        print("[TLI] Local-only bind. Set TLI_LAN_MODE=1 or TLI_HOST=0.0.0.0 for LAN access.", flush=True)

    uvicorn.run(
        app, host=host, port=port, log_level="info",
        ssl_certfile=ssl_certfile,
        ssl_keyfile=ssl_keyfile,
        # Bound active-request/transport draining, then run normal lifespan
        # cleanup even if a disconnected browser leaves a transport waiting.
        timeout_graceful_shutdown=30,
    )


if __name__ == "__main__" or getattr(sys, "frozen", False):
    _tli_run_server()
