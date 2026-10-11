"""Run one isolated installation/rollback stage in a fresh process.

Only accepts a synthetic data directory marked by verify_release.py.
All network, subprocess, discovery and inference effects are disabled before imports.
"""
import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import urllib.request
from unittest.mock import patch

from rehearsal_support import activate_root, validate_root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--code-dir", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--stage", choices=["import", "seed", "upgrade", "rollback", "return", "restore"], required=True)
    args = parser.parse_args()
    code = args.code_dir.resolve()
    root = validate_root(args.data_root)
    code = activate_root(code, root)
    security_names = ("data/tli_pin.json", "data/node_identity.json", "data/mesh/node_config.json", "data/startup.json",
                      "data/tls/cert.pem", "data/tls/key.pem", "data/companion/credentials.json")
    def security_fingerprints():
        return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in security_names if (root / name).is_file()}
    def fingerprints():
        folder = root / "data" / "intelligence"
        return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.glob("*.json")}
    sidecars_before = fingerprints()  # Include import/startup/shutdown in preservation checks.
    security_before = security_fingerprints()
    memory_path = root / "data" / "memory_release-fixture-user.json"
    memory_before = hashlib.sha256(memory_path.read_bytes()).hexdigest() if memory_path.exists() else None
    feature_scope = {"companion": (code / "backend" / "companion_auth.py").exists(),
                     "notebook": (code / "backend" / "intelligence" / "notebook.py").exists(),
                     "saved_startup": (code / "backend" / "startup_config.py").exists()}

    def blocked(*a, **kw):
        raise RuntimeError("Live side effects disabled in release rehearsal")

    # Windows asyncio builds its internal socket pair using a loopback connect.
    # Permit only that thread-local operation, while blocking application sockets.
    pair_context = threading.local()
    original_pair = socket.socketpair
    original_connect = socket.socket.connect
    def private_pair(*a, **kw):
        pair_context.active = True
        try:
            return original_pair(*a, **kw)
        finally:
            pair_context.active = False
    def guarded_connect(sock, address):
        if getattr(pair_context, "active", False) and address[0] in ("127.0.0.1", "::1"):
            return original_connect(sock, address)
        return blocked()

    with ExitStack() as effects:
        effects.enter_context(patch.object(subprocess, "Popen", blocked))
        effects.enter_context(patch.object(socket, "socketpair", private_pair))
        effects.enter_context(patch.object(socket.socket, "connect", guarded_connect))
        effects.enter_context(patch.object(socket.socket, "connect_ex", blocked))
        effects.enter_context(patch.object(socket.socket, "sendto", blocked))
        effects.enter_context(patch.object(urllib.request, "urlopen", blocked))
        import requests
        effects.enter_context(patch.object(requests.sessions.Session, "request", blocked))
        with patch.object(threading.Thread, "start", lambda self: None):
            import data_protection
            effects.enter_context(patch.object(data_protection, "is_windows", lambda: False))
            import tli_state as S
            assert Path(S.DATA_DIR).resolve() == root / "data"
            S.FRONTEND_DIR = str(code / "frontend")
            S.ASSETS_DIR = str(code / "frontend" / "assets")
            from ai import ai_manager
            runtime = root / "backend" / "ai"
            runtime.mkdir(parents=True, exist_ok=True)
            effects.enter_context(patch.object(ai_manager, "_ai_base_dir", lambda: runtime))
            for name in ("AI_DIR", "ACTIVE_MODEL_PATH", "_STORAGE_CONFIG_PATH"):
                original = getattr(ai_manager, name)
                effects.enter_context(patch.object(ai_manager, name, runtime if name == "AI_DIR" else runtime / original.name))
            effects.enter_context(patch.object(ai_manager.BundledAIManager, "ensure_running", lambda self: False))
            effects.enter_context(patch.object(ai_manager.BundledAIManager, "is_healthy", lambda self: False))
            effects.enter_context(patch.object(ai_manager.BundledAIManager, "stop", lambda self: None))
            effects.enter_context(patch.object(ai_manager, "urlopen", blocked))
            import main as application

        if args.stage == "import":
            from PIL import Image
            Image.new("RGB", (1, 1)).close()
            assert "/api/intelligence/devices" in application.app.openapi()["paths"]
            print(json.dumps({"stage": "import", "passed": True, "code": str(code), "runtime_dependencies_only": True,
                              "features": feature_scope, "live_device_calls": 0}))
            return

        import httpx
        from fastapi.testclient import TestClient
        effects.enter_context(patch.object(httpx.HTTPTransport, "handle_request", blocked))
        effects.enter_context(patch.object(httpx.AsyncHTTPTransport, "handle_async_request", blocked))
        for name in ("start_background_loops", "_cleanup_start", "_cleanup_stop"):
            effects.enter_context(patch.object(application, name, lambda: None))
        effects.enter_context(patch.object(application.lan_discovery, "start", lambda: None))
        effects.enter_context(patch.object(application.lan_discovery, "stop", lambda: None))
        async def no_ambient():
            return
        effects.enter_context(patch.object(application, "run_ambient_loop", no_ambient))
        from routers import dashboard_presence as dp, system_routes, actions_engine as actions
        effects.enter_context(patch.object(dp, "_probe_metrics", lambda: {
            "cpu_pct": 15, "ram_pct": 30, "disk_pct_by_drive": {"fixture": 40}}))
        effects.enter_context(patch.object(dp, "_score_disk_actions", lambda state: None))
        user = "release-fixture-user"
        password = "Synthetic-Rehearsal-Only-123!"
        application.app.dependency_overrides[system_routes.require_session] = lambda: user
        from routers import vault_routes

        def expect(response):
            assert response.status_code == 200, (response.status_code, response.text[:300])
            return response.json()

        with TestClient(application.app) as client:
            expect(client.get("/dashboard/state"))
            assert client.get("/").status_code in (200, 307)
            if args.stage == "seed":
                # Real persisted security fixtures. Functional legacy endpoints
                # below retain their explicit auth override; actual HTTPS/PIN
                # enforcement is exercised separately by https_rehearsal.py.
                salt = "b" * 64
                S.save_pin_config(hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 260000).hex(), salt)
                cfg = S.load_node_config()
                cfg.node_name = "Synthetic rollback host"
                S.save_node_config(cfg)
                import tls_cert
                if hasattr(tls_cert, "_local_ipv4_addresses"):
                    effects.enter_context(patch.object(tls_cert, "_local_ipv4_addresses", lambda: ["127.0.0.1"]))
                assert tls_cert.ensure_tls_cert(S.TLS_CERT_PATH, S.TLS_KEY_PATH)
                # The old baseline ignores this additive file. Equivalent
                # environment settings are still needed for an actual rollback.
                (root / "data" / "startup.json").write_text(json.dumps({"version": 1, "host": "127.0.0.1", "port": 18443, "https": True}))
                expect(client.post("/vault/setup", json={"password": password}))
                expect(client.post("/vault/unlock", json={"password": password}))
                expect(client.post("/vault/secret/rehearsal", json={"value": "synthetic-secret"}))
                vault_routes._write_vault_file(user, "rehearsal-document", b"Synthetic vault document")
                S.save_conversations({"rehearsal": {"id": "rehearsal", "user_id": user,
                    "messages": [{"role": "user", "content": "Synthetic conversation"}]}})
                S.save_shelly_registry([{"id": "fixture-relay", "name": "Fixture lamp", "ip": "192.0.2.10", "relay": 1}])
                S.save_json_file(Path(S.DEVICES_FILE), [{"id": "fixture-device", "name": "Fixture device"}])
                S.add_fact(user, "Synthetic remembered fact")
                actions._save_json(actions._paths()[0], {"actions": [{"id": "fixture-action", "name": "Fixture action",
                    "steps": [{"type": "shelly.switch", "device": "Fixture lamp", "value": "off"}]}], "triggers": []})
                S.save_model_config_to_disk()
                S.save_system_profile_to_disk()
                (root / "settings-before.json").write_text(json.dumps({
                    "node_id": S.load_node_config().node_id,
                    "model": S.MODEL_CONFIG_FILE.read_text(encoding="utf-8") if S.MODEL_CONFIG_FILE.exists() else None,
                    "profile": S.SYSTEM_PROFILE_FILE.read_text(encoding="utf-8") if S.SYSTEM_PROFILE_FILE.exists() else None,
                    "security": security_fingerprints(),
                }), encoding="utf-8")
            else:
                expect(client.post("/vault/lock"))
                wrong = client.post("/vault/unlock", json={"password": "wrong-synthetic-password"})
                assert wrong.status_code == 403
                expect(client.post("/vault/unlock", json={"password": password}))
                assert expect(client.get("/vault/secret/rehearsal"))["value"] == "synthetic-secret"
                assert vault_routes._read_vault_file(user, "rehearsal-document") == b"Synthetic vault document"
                conversations = S.load_conversations()
                assert conversations["rehearsal"]["messages"][0]["content"] == "Synthetic conversation"
                assert S.load_shelly_registry()[0]["relay"] == 1
                assert S.load_json_file(Path(S.DEVICES_FILE), [])[0]["id"] == "fixture-device"
                assert any(f["text"] == "Synthetic remembered fact" for f in S.load_memory(user)["facts"])
                assert expect(client.get("/actions/list"))["actions"][0]["id"] == "fixture-action"
                settings = json.loads((root / "settings-before.json").read_text(encoding="utf-8"))
                assert S.load_node_config().node_id == settings["node_id"]
                assert S.load_pin_config()["enabled"] is True
                assert system_routes._hash_pin(password, S.load_pin_config()["salt"]) == S.load_pin_config()["hash"]
                for name, digest in settings["security"].items():
                    assert security_fingerprints()[name] == digest, f"Saved security changed: {name}"
                if feature_scope["saved_startup"]:
                    import startup_config
                    assert startup_config.resolve(root)["effective_next"] == {"host": "127.0.0.1", "port": 18443, "https": True}
                for name, path in (("model", S.MODEL_CONFIG_FILE), ("profile", S.SYSTEM_PROFILE_FILE)):
                    if settings[name] is not None:
                        assert json.loads(path.read_text(encoding="utf-8")) == json.loads(settings[name])
                if args.stage == "upgrade":
                    conversations["rehearsal"]["messages"].append({"role": "assistant", "content": "Written by anniversary code"})
                    S.save_conversations(conversations)
                    from intelligence.store import write_private
                    write_private(user, "reports", [{"id": "fixture-report", "summary": "Synthetic report"}])
                    S.add_fact(user, "Fact written by anniversary code")
                    actions._append_receipt({"kind": "action_run", "ok": False, "summary": "Synthetic failed receipt", "results": [{"ok": False}]})
                    if feature_scope["notebook"]:
                        from intelligence import memory
                        note = memory.save_fact(user, "Synthetic Notebook fact retained across rollback.", title="Synthetic Notebook title")
                        # Save only a nonsecret note reference, never its content
                        # or a provider token in the machine-readable stage report.
                        (root / "notebook-reference.json").write_text(json.dumps({"id": note["id"], "revision": note["revision"]}))
                    if feature_scope["companion"]:
                        import companion_auth, tls_cert
                        certificate = tls_cert.certificate_bundle(S.TLS_CERT_PATH, S.TLS_KEY_PATH, "127.0.0.1")
                        origin = "https://127.0.0.1:18443"
                        token, _ = companion_auth.create_pairing(user, origin, certificate["fingerprint"])
                        credential = companion_auth.redeem_pairing(token, origin, certificate["fingerprint"], "Synthetic rollback phone", "android")
                        (root / "synthetic-client.json").write_text(json.dumps(credential))
                elif args.stage != "restore":
                    assert conversations["rehearsal"]["messages"][1]["content"] == "Written by anniversary code"
                    assert any(f["text"] == "Fact written by anniversary code" for f in S.load_memory(user)["facts"])
                    assert expect(client.get("/actions/receipts"))["items"][0]["ok"] is False
                    assert fingerprints() == sidecars_before
                    if args.stage == "rollback":
                        expect(client.post("/vault/secret/rollback-write", json={"value": "written-by-previous-code"}))
                    else:
                        assert expect(client.get("/vault/secret/rollback-write"))["value"] == "written-by-previous-code"
                        from intelligence.store import read_private
                        assert read_private(user, "reports", [])[0]["id"] == "fixture-report"
                        if feature_scope["notebook"]:
                            from intelligence import memory
                            reference = json.loads((root / "notebook-reference.json").read_text())
                            note = next(f for f in memory.list_facts(user) if f["id"] == reference["id"])
                            assert note["revision"] == reference["revision"] and note["title"] == "Synthetic Notebook title"
                        if feature_scope["companion"]:
                            import companion_auth
                            credential = json.loads((root / "synthetic-client.json").read_text())
                            assert companion_auth.credential_owner(credential["credential"]) == user
            expect(client.post("/vault/lock"))
        dp.stop_polling()
        if args.stage in ("rollback", "return", "restore"):
            assert fingerprints() == sidecars_before
            assert security_fingerprints() == security_before
            assert hashlib.sha256(memory_path.read_bytes()).hexdigest() == memory_before
        print(json.dumps({"stage": args.stage, "passed": True, "code": str(code),
                          "data_root": str(root), "sidecars": len(fingerprints()), "live_device_calls": 0,
                          "features": feature_scope,
                          "authentication_scope": "Legacy functional data checks use a dependency override; real PIN and HTTPS checks are separate.",
                          "compatibility_limits": ["Older code does not expose Companion or Notebook features.",
                              "Older memory writes may discard new note metadata; rollback checks preserve and read those files without editing them.",
                              "Older launchers require explicit equivalent HTTPS, bind and port environment settings.",
                              "Native Companion secure-storage rollback requires its separate client tests."]}))


if __name__ == "__main__":
    main()
