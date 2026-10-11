"""Explicit synthetic HTTPS host. Never point this at a real TLI installation.

Loopback is the default. Phone serving additionally requires --serve-lan, an
explicit private IPv4 --host, and a .tli-phone-fixture marker. No cloud services,
model processes, outgoing network, filesystem tools or real devices are enabled.
The ordinary production launch function, PIN and paired authentication remain in
use. This developer harness is never part of a shipped TLI installation.
"""
import argparse
from contextlib import ExitStack
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import threading
import time
from types import SimpleNamespace
import urllib.request
from unittest.mock import patch

from rehearsal_support import activate_root, validate_root

PIN = "739182"
NOTICE = "SYNTHETIC TLI ACCEPTANCE FIXTURE — no real AI, devices or personal host data"


def check_host(host, phone):
    ip = ipaddress.ip_address(host)
    if not phone and str(ip) != "127.0.0.1":
        raise ValueError("Loopback rehearsal must bind 127.0.0.1.")
    allowed = tuple(ipaddress.ip_network(s) for s in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"))
    if phone and (ip.version != 4 or not any(ip in net for net in allowed)):
        raise ValueError("Phone fixture requires an explicitly selected private LAN IPv4 address.")
    return str(ip)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--code-dir", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8778)
    parser.add_argument("--serve-lan", action="store_true")
    parser.add_argument("--lifetime", type=int, default=7200, help="Owned host lifetime in seconds (30–14400).")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 30 <= args.lifetime <= 14400:
        parser.error("Use a valid port and a bounded lifetime from 30 to 14400 seconds.")
    host = check_host(args.host, args.serve_lan)
    root = validate_root(args.data_root, phone=args.serve_lan)
    code = activate_root(args.code_dir, root)
    control = {"ai_available": args.serve_lan, "delay_seconds": 0.0, "calls": 0, "actions": 0}
    server = {}

    def blocked(*a, **kw):
        raise RuntimeError("Disabled in the synthetic acceptance fixture.")

    pair_context = threading.local()
    original_pair, original_connect = socket.socketpair, socket.socket.connect
    def private_pair(*a, **kw):
        pair_context.active = True
        try:
            return original_pair(*a, **kw)
        finally:
            pair_context.active = False
    def connect(sock, address):
        if getattr(pair_context, "active", False) and address[0] in ("127.0.0.1", "::1"):
            return original_connect(sock, address)
        return blocked()

    with ExitStack() as effects:
        for module, name, replacement in ((subprocess, "Popen", blocked), (os, "system", blocked),
                (socket, "socketpair", private_pair), (socket.socket, "connect", connect),
                (socket.socket, "connect_ex", blocked), (socket.socket, "sendto", blocked),
                (urllib.request, "urlopen", blocked)):
            effects.enter_context(patch.object(module, name, replacement))
        import requests
        effects.enter_context(patch.object(requests.sessions.Session, "request", blocked))
        import httpx
        effects.enter_context(patch.object(httpx.HTTPTransport, "handle_request", blocked))
        effects.enter_context(patch.object(httpx.AsyncHTTPTransport, "handle_async_request", blocked))
        # Real DPAPI can bind test files to an account. This synthetic identity
        # uses the supported raw format; wrong-account coverage is in unit tests.
        import data_protection
        effects.enter_context(patch.object(data_protection, "is_windows", lambda: False))
        with patch.object(threading.Thread, "start", lambda self: None):
            import tli_state as S
            assert Path(S.DATA_DIR).resolve() == root / "data"
            S.FRONTEND_DIR, S.ASSETS_DIR = str(code / "frontend"), str(code / "frontend" / "assets")
            import startup_config
            initialized = root / ".fixture-initialized.json"
            if not initialized.exists():
                # Refuse to initialize over pre-existing synthetic security too.
                for path in (S.PIN_CONFIG_FILE, S.NODE_CONFIG_PATH, Path(S.DATA_DIR) / "node_identity.json", Path(S.TLS_CERT_PATH), Path(S.TLS_KEY_PATH)):
                    if Path(path).exists():
                        raise ValueError("Use a fresh marked fixture root; existing security state was preserved.")
                salt = "a" * 64
                S.save_pin_config(hashlib.pbkdf2_hmac("sha256", PIN.encode(), salt.encode(), 260000).hex(), salt)
                S.save_node_config(S.NodeConfig(node_id="acceptance-" + secrets.token_hex(8), node_name=NOTICE,
                    role="standalone", created_at=S.now_iso(), updated_at=S.now_iso()))
                startup_config.write({"host": "0.0.0.0" if args.serve_lan else host, "port": args.port, "https": True}, root)
            if args.serve_lan:
                os.environ["TLI_HOST"] = host  # explicit fixture bind, not a production bypass
            import tls_cert
            effects.enter_context(patch.object(tls_cert, "_local_ipv4_addresses", lambda: [host]))
            from ai import ai_manager
            runtime = root / "backend" / "ai"
            runtime.mkdir(parents=True, exist_ok=True)
            effects.enter_context(patch.object(ai_manager, "_ai_base_dir", lambda: runtime))
            for name in ("AI_DIR", "ACTIVE_MODEL_PATH", "_STORAGE_CONFIG_PATH"):
                old = getattr(ai_manager, name)
                effects.enter_context(patch.object(ai_manager, name, runtime if name == "AI_DIR" else runtime / old.name))
            for name in ("ensure_running", "is_healthy"):
                effects.enter_context(patch.object(ai_manager.BundledAIManager, name, lambda self: control["ai_available"]))
            effects.enter_context(patch.object(ai_manager.BundledAIManager, "stop", lambda self: None))
            effects.enter_context(patch.object(ai_manager, "urlopen", blocked))
            import main as application

        # Disable all background side effects before the production lifespan.
        for name in ("start_background_loops", "_cleanup_start", "_cleanup_stop", "_dp_start_polling"):
            effects.enter_context(patch.object(application, name, lambda: None))
        for name in ("start", "stop"):
            effects.enter_context(patch.object(application.lan_discovery, name, lambda: None))
        async def no_ambient():
            return
        effects.enter_context(patch.object(application, "run_ambient_loop", no_ambient))
        from ai import ai_routes
        from intelligence import chat, diagnostics, memory, models, devices
        from routers import dashboard_presence, home_power, system_routes, chat_routes
        for name in ("_route_action_intent", "_tool_answer", "_find_mesh_ai_peer"):
            effects.enter_context(patch.object(ai_routes, name, lambda *a, **kw: None))
        effects.enter_context(patch.object(ai_routes, "_should_prefer_mesh", lambda: False))
        effects.enter_context(patch.object(chat_routes, "diagnostic_answer", lambda *a, **kw: None))
        effects.enter_context(patch.object(diagnostics, "run", blocked))
        effects.enter_context(patch.object(S, "load_shelly_registry", lambda: []))
        effects.enter_context(patch.object(S, "load_mesh_directory", lambda: {}))
        effects.enter_context(patch.object(dashboard_presence, "_probe_metrics", lambda: {"cpu_pct": 12, "ram_pct": 31, "disk_pct_by_drive": {}}))
        effects.enter_context(patch.object(dashboard_presence, "_score_disk_actions", lambda _: None))
        import ambient
        effects.enter_context(patch.object(ambient, "get_home_snapshot", lambda: {"fixture": NOTICE}))
        manager = ai_manager.BundledAIManager.get()
        manager._active_preset = "synthetic-fixture"
        provider = {"provider": "lmstudio", "model": "Synthetic response simulator", "url": "http://192.0.2.254:1/v1/chat/completions"}
        def image_provider():
            if not control["ai_available"]:
                from fastapi import HTTPException
                raise HTTPException(409, "Synthetic AI is unavailable; no real model is configured.")
            return dict(provider)
        effects.enter_context(patch.object(models, "image_provider", image_provider))

        def answer(messages):
            control["calls"] += 1
            time.sleep(control["delay_seconds"])
            question = str(messages[-1].get("content", "")) if messages else ""
            if not control["ai_available"] or "simulate failure" in question.lower():
                raise RuntimeError("Synthetic provider failure; no real inference was attempted.")
            return "Synthetic acceptance response. The sample spare SSD is in the studio drawer. This fixture did not inspect a real computer, analyze the image contents, or perform a repair."
        def post(url, **kw):
            if url not in (provider["url"], manager.base_url.rstrip("/") + "/v1/chat/completions"):
                return blocked()
            value = answer(kw["json"]["messages"])
            return SimpleNamespace(status_code=200, raise_for_status=lambda: None,
                json=lambda: {"choices": [{"message": {"content": value}}]})
        effects.enter_context(patch.object(requests, "post", post))
        effects.enter_context(patch.object(ai_routes, "_llama_post", lambda base, payload, **kw: {"choices": [{"message": {"content": answer(payload["messages"])}}]}))
        def stream(url, payload):
            try:
                result = answer(payload["messages"])
            except RuntimeError as error:
                yield json.dumps({"type": "error", "detail": str(error)})
                return
            for word in result.split(" "):
                yield json.dumps({"choices": [{"delta": {"content": word + " "}}]})
                time.sleep(0.05)
        effects.enter_context(patch.object(ai_routes, "_llama_stream_raw", stream))
        S.lm_provider = SimpleNamespace(_report_cache={"ts": time.time(), "report": {"ok": False, "chat_ok": False, "checked_at": S.now_iso()}},
            health_check=lambda: control["ai_available"], list_models=lambda: {"models": [{"id": "synthetic-fixture"}]},
            health_report=lambda: {"ok": control["ai_available"], "model": "Synthetic response simulator"},
            complete=lambda **kw: {"text": answer(kw["messages"]), "model": "Synthetic response simulator"})

        class FakeDriver:
            state = False
            def execute(self, device, capability):
                control["actions"] += 1
                time.sleep(control["delay_seconds"])
                if device["device_id"] == "fixture-failure":
                    return {"ok": False, "summary": "Synthetic failure. No real device was contacted."}
                self.state = capability != "switch.off"
                return {"ok": True, "summary": "Synthetic command acknowledged; no real device was contacted."}
            def get_status(self, device):
                return {"ok": True, "on": self.state, "summary": "Synthetic fixture state"}
        rt = home_power.HomePowerRuntime(Path(S.DATA_DIR), None, lambda *a, **kw: None, {"fixture": FakeDriver()})
        rt.save_devices([{"device_id": identifier, "name": title, "vendor": "fixture", "ip": "192.0.2.50", "relay": index,
            "capabilities": ["switch.on", "switch.off"], "room": "Synthetic room"}
            for index, (identifier, title) in enumerate((("fixture-lamp", "Sample lamp"), ("fixture-failure", "Sample failed device")))])
        rt.save_scenes([{"scene_id": "fixture-partial", "name": "Sample mixed result", "enabled": True,
            "actions": [{"device_id": "fixture-lamp", "capability": "switch.on"}, {"device_id": "fixture-failure", "capability": "switch.on"}]}])
        effects.enter_context(patch.object(home_power, "get_runtime", lambda: rt))
        S.save_json_file(devices.root() / "printer_cache.json", {"checked_at": S.now_iso(), "printers": [{"name": "Sample printer", "system_name": "fixture-printer", "location": "Synthetic room"}]})
        if not initialized.exists():
            memory.save_fact("local", "The sample spare SSD is in the studio drawer.", title="Sample spare SSD")
            if not tls_cert.ensure_tls_cert(S.TLS_CERT_PATH, S.TLS_KEY_PATH):
                raise RuntimeError("Synthetic TLS initialization failed.")
            import companion_auth
            cert = tls_cert.certificate_bundle(S.TLS_CERT_PATH, S.TLS_KEY_PATH, host)
            origin = f"https://{host}:{args.port}"
            token, _ = companion_auth.create_pairing("local", origin, cert["fingerprint"])
            credential = companion_auth.redeem_pairing(token, origin, cert["fingerprint"], "Synthetic saved client", "android")
            initialized.write_text(json.dumps({"notice": NOTICE, "host": host, "port": args.port,
                "phone": args.serve_lan, "credential": credential["credential"]}), encoding="utf-8")
        else:
            previous = json.loads(initialized.read_text())
            if previous.get("phone") is not args.serve_lan or previous.get("host") != host:
                raise ValueError("Use the original fixture mode and bind address when restarting.")

        # Today reads the real retained event stream and owner-scoped review
        # cursor. This record describes the fixture, not a hardware observation.
        from event_bus import emit_event
        emit_event("system", "info", "Synthetic acceptance host ready",
            "Sample retained activity only. No live system checks were performed.", node=NOTICE)

        from fastapi import Depends, HTTPException, Request
        from fastapi.responses import JSONResponse, StreamingResponse
        from pydantic import BaseModel, Field
        class Controls(BaseModel):
            ai_available: bool | None = None
            delay_seconds: float = Field(default=0, ge=0, le=20)
        @application.app.get("/__fixture/status")
        def fixture_status(user=Depends(system_routes.require_session)):
            return {"notice": NOTICE, **control, "live_calls": 0, "port": S.server_port()}
        @application.app.post("/__fixture/control")
        def fixture_control(value: Controls, user=Depends(system_routes.require_session)):
            if value.ai_available is not None:
                control["ai_available"] = value.ai_available
            control["delay_seconds"] = value.delay_seconds
            return {"ok": True, "notice": NOTICE}
        @application.app.post("/__fixture/stop")
        def stop(user=Depends(system_routes.require_session)):
            if server.get("instance"):
                server["instance"].should_exit = True
            return {"ok": True}
        @application.app.get("/__fixture/hold")
        def held_request(user=Depends(system_routes.require_session)):
            async def body():
                import asyncio
                yield b"started\n"
                # An intentionally outstanding, read-only request exercises the
                # production drain limit. It has its own finite upper bound.
                await asyncio.sleep(60)
                yield b"finished\n"
            return StreamingResponse(body(), media_type="text/plain")
        fixture_routes = [route for route in application.app.router.routes if getattr(route, "path", "").startswith("/__fixture/")]
        application.app.router.routes[:] = fixture_routes + [route for route in application.app.router.routes if route not in fixture_routes]
        @application.app.middleware("http")
        async def fixture_boundary(request: Request, call_next):
            path, method = request.url.path, request.method
            allowed = path.startswith(("/__fixture/", "/api/companion/v1/", "/api/intelligence/memory", "/api/ai/conversations", "/conversations"))
            allowed |= path in ("/chat", "/api/ai/chat", "/api/ai/chat/stream")
            allowed |= path == "/system/pin/verify" and method == "POST"
            allowed |= path == "/dashboard/activity-summary" and method == "GET"
            allowed |= path == "/dashboard/activity-summary/review" and method == "POST"
            allowed |= path.startswith("/api/intelligence/diagnostics/") and method == "GET"
            allowed |= method == "GET" and path in ("/system/pin/status", "/api/intelligence/devices", "/api/intelligence/data-health", "/api/intelligence/screenshots/context", "/api/intelligence/diagnostics", "/homepower/status", "/homepower/devices", "/homepower/scenes", "/homepower/receipts")
            allowed |= path.startswith("/homepower/devices/") and (path.endswith("/execute") or path.endswith("/status"))
            allowed |= path == "/homepower/scenes/run" and method == "POST"
            static = (code / "frontend" / path.lstrip("/")).resolve()
            allowed |= method == "GET" and (path == "/" or (static.is_relative_to((code / "frontend").resolve()) and static.is_file()))
            if not allowed:
                return JSONResponse({"detail": "This operation is disabled in the synthetic acceptance fixture."}, status_code=403, headers={"X-TLI-Fixture": "synthetic"})
            response = await call_next(request)
            response.headers["X-TLI-Fixture"] = "synthetic"
            response.headers["Cache-Control"] = "no-store"
            return response

        import uvicorn
        def run(app, **kwargs):
            instance = uvicorn.Server(uvicorn.Config(app, **kwargs))
            server["instance"] = instance
            timer = threading.Timer(args.lifetime, lambda: setattr(instance, "should_exit", True))
            timer.daemon = True
            timer.start()
            try:
                instance.run()
            finally:
                timer.cancel()
        effects.enter_context(patch.object(uvicorn, "run", run))
        print(f"{NOTICE}\nFixture URL: https://{host}:{args.port}/?desktop=1\nSynthetic PIN: {PIN}\nStops after {args.lifetime} seconds. Use only sample photos and notes.", flush=True)
        application._tli_run_server()


if __name__ == "__main__":
    main()
