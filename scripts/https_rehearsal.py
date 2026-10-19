"""Exercise the production listener twice with synthetic security and no live integrations."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

from rehearsal_support import clean_environment, validate_root


def run(code, root, report_path, port=None):
    import requests
    root = validate_root(root)
    code = Path(code).resolve()
    report = {"status": "failed", "checks": {}, "scope": "actual loopback HTTPS with synthetic data and inert integrations",
              "phone_pairing": "not exercised; private-LAN origin requirement retained", "live_device_calls": 0}
    if port is None:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
    report["port"] = port
    env = clean_environment()
    child_script = Path(__file__).with_name("rehearsal_host.py")
    processes = []
    logs = []
    base = f"https://127.0.0.1:{port}"
    browser_headers = {"Origin": base, "Sec-Fetch-Site": "same-origin"}
    cert = root / "data" / "tls" / "cert.pem"
    client = requests.Session()
    client.trust_env = False
    native_client = requests.Session()
    native_client.trust_env = False

    def launch(name):
        log = (root / f"https-{name}.log").open("w", encoding="utf-8")
        logs.append(log)
        process = subprocess.Popen([sys.executable, str(child_script), "--code-dir", str(code), "--data-root", str(root),
            "--port", str(port), "--lifetime", "120"], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        processes.append(process)
        return process

    def request(method, path, **kwargs):
        # Native Companion never carries the desktop browser's cookie jar.
        selected = native_client if any(key.lower() == "authorization" for key in kwargs.get("headers", {})) else client
        return selected.request(method, base + path, verify=str(cert), timeout=8, allow_redirects=False, **kwargs)

    def ready(process):
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("Synthetic HTTPS child exited before becoming ready; inspect its local log.")
            if cert.exists():
                try:
                    if request("GET", "/system/pin/status").status_code == 200:
                        return
                except requests.RequestException:
                    pass
            time.sleep(0.15)
        raise RuntimeError("Synthetic HTTPS listener did not become ready in time.")

    def expect(response, code=200):
        if response.status_code != code:
            raise AssertionError(f"Expected HTTP {code}, received {response.status_code} on synthetic check.")
        return response.json()

    def security_hashes():
        names = ("data/tli_pin.json", "data/node_identity.json", "data/mesh/node_config.json", "data/startup.json",
                 "data/tls/cert.pem", "data/tls/key.pem", "data/companion/credentials.json", "data/memory_key.bin")
        return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names}

    def stop(process, authorization):
        expect(request("POST", "/__fixture/stop", headers={**authorization, "Connection": "close"}))
        client.close()  # close owned keep-alive connections before graceful shutdown
        native_client.close()
        if process.wait(timeout=45) != 0:
            raise RuntimeError("Synthetic listener did not stop cleanly.")

    try:
        first = launch("first")
        ready(first)
        report["checks"]["production_https_listener"] = True
        expect(request("GET", "/api/intelligence/memory"), 401)
        # The browser login contract requires an explicit matching Origin even
        # over loopback. Rejected origins must not become PIN authentication.
        expect(request("POST", "/system/pin/verify", json={"pin": "739182"}), 403)
        expect(request("POST", "/system/pin/verify", headers={"Origin": "https://unrelated.invalid"},
                       json={"pin": "739182"}), 403)
        assert not client.cookies.get("tli_session")
        report["checks"]["browser_origin_enforced"] = True
        expect(request("POST", "/system/pin/verify", headers=browser_headers, json={"pin": "incorrect"}), 403)
        expect(request("POST", "/system/pin/verify", headers=browser_headers, json={"pin": "739182"}))
        assert client.cookies.get("tli_session")
        initial = expect(request("GET", "/api/companion/v1/startup"))
        assert initial["running"] == {"host": "127.0.0.1", "port": port, "https": True}
        assert initial["effective_next"] == initial["running"]
        report["checks"]["real_pin_authentication"] = True
        fixture = json.loads((root / ".fixture-initialized.json").read_text())
        bearer = {"Authorization": "Bearer " + fixture["credential"]}
        baseline = expect(request("GET", "/api/companion/v1/bootstrap", headers=bearer))
        assert baseline["ai"]["status"] == "unavailable" and baseline["capabilities"]["chat"] is False
        report["checks"]["connected_with_ai_unavailable"] = True
        expect(request("GET", "/api/ai/conversations", headers=bearer))
        expect(request("GET", "/api/ai/conversations", headers={**bearer,
            "Cookie": "tli_session=" + client.cookies.get("tli_session")}), 403)
        assert not native_client.cookies
        report["checks"]["native_history_rejects_browser_cookie"] = True
        expect(request("GET", "/api/companion/v1/bootstrap", headers={"Authorization": "Bearer tlic_invalid"}), 401)
        report["checks"]["invalid_bearer_does_not_fall_back"] = True
        activity = expect(request("GET", "/dashboard/activity-summary", headers=bearer))
        assert any(event["title"] == "Synthetic acceptance host ready" for event in activity["events"])
        reviewed = expect(request("POST", "/dashboard/activity-summary/review", headers=bearer, json=activity["cursor"]))
        assert expect(request("GET", "/dashboard/activity-summary", headers=bearer))["total"] == 0
        report["checks"]["synthetic_today_review"] = True
        note = expect(request("POST", "/api/intelligence/memory", headers=bearer,
            json={"title": "HTTPS persistence sample", "text": "Synthetic fixture only: spare SSD in the drawer."}))
        expect(request("POST", "/__fixture/control", headers=bearer, json={"ai_available": True}))
        reply = expect(request("POST", "/api/ai/chat", headers=bearer, json={"message": "Where is the sample SSD?", "note_refs": [{"id": note["id"], "revision": note["revision"]}]}))
        assert reply.get("note_context", {}).get("actions_performed") is False
        conversation = reply.get("session_id") or reply.get("conversation_id")
        assert conversation
        before = security_hashes()
        # Keep a real TLS response outstanding through shutdown. The fixture
        # inherits production's drain limit and normal lifespan; no event-loop
        # internals or authentication dependencies are replaced for this check.
        held = request("GET", "/__fixture/hold", headers=bearer, stream=True)
        try:
            assert held.status_code == 200 and held.raw.read(8) == b"started\n"
            started = time.monotonic()
            stop(first, bearer)
            elapsed = time.monotonic() - started
            assert 25 <= elapsed < 45, "Outstanding HTTPS request did not exercise the bounded drain."
            shutdown_log = (root / "https-first.log").read_text(encoding="utf-8", errors="replace")
            assert "timeout graceful shutdown exceeded" in shutdown_log
            assert "Application shutdown complete." in shutdown_log
            report["checks"]["bounded_request_drain_and_lifespan_cleanup"] = True
        finally:
            held.close()
        second = launch("restart")
        ready(second)
        # Browser sessions are intentionally in memory; the saved phone credential persists.
        expect(request("GET", "/api/intelligence/memory"), 401)
        again = expect(request("GET", "/api/companion/v1/bootstrap", headers=bearer))
        assert again["node"]["id"] == baseline["node"]["id"], "The synthetic host identity changed across restart."
        after = security_hashes()
        changed = [name for name in before if after.get(name) != before[name]]
        assert not changed, "Synthetic security files changed across restart: " + ", ".join(changed)
        activity_after = expect(request("GET", "/dashboard/activity-summary", headers=bearer))
        assert activity_after["cursor"]["stream_id"] != activity["cursor"]["stream_id"], "The restarted listener reused its live activity stream identity."
        assert activity_after["reviewed_at"] == reviewed["reviewed_at"], "The saved activity review position was not retained."
        if activity_after.get("history"):
            # Retained generic summaries survive restarts. They do not restore
            # the previous live details or establish observations while stopped.
            assert activity_after["coverage"] == "retained_partial", "Retained activity must expose the restart gap; received " + str(activity_after.get("coverage"))
            assert "TLI restarted" in activity_after["coverage_note"] and "detailed events from earlier sessions are unavailable" in activity_after["coverage_note"], "Retained activity omitted the restart/detail-coverage explanation."
        else:
            assert activity_after["coverage"] == "restarted", "Live-only activity must expose the restart gap; received " + str(activity_after.get("coverage"))
        report["checks"]["activity_review_and_restart_gap_preserved"] = True
        facts = expect(request("GET", "/api/intelligence/memory", headers=bearer))["facts"]
        assert any(f["id"] == note["id"] and f["revision"] == note["revision"] for f in facts), "The synthetic note or its revision changed across restart."
        history = expect(request("GET", f"/api/ai/conversations/{conversation}", headers=bearer))
        assert any(message.get("note_context", {}).get("actions_performed") is False for message in history["messages"]), "The saved note-context receipt was not reopened after restart."
        expect(request("POST", "/system/pin/verify", headers=browser_headers, json={"pin": "739182"}))
        restarted = expect(request("GET", "/api/companion/v1/startup"))
        assert restarted["running"] == initial["running"]
        report["checks"].update(normal_stop_restart=True, saved_bearer_and_identity=True,
            pin_tls_startup_bytes_preserved=True, notebook_and_receipt_persisted=True)
        stop(second, bearer)
        valid_certificate = cert.read_bytes()
        try:
            cert.write_bytes(b"Synthetic invalid certificate for failure testing")
            failed = launch("invalid-tls")
            assert failed.wait(timeout=25) != 0
            assert cert.read_bytes() == b"Synthetic invalid certificate for failure testing"
            with socket.socket() as probe:
                if os.name == "nt":
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                probe.bind(("127.0.0.1", port))
            report["checks"]["invalid_tls_stops_without_http_fallback"] = True
        finally:
            cert.write_bytes(valid_certificate)
        report["status"] = "passed"
    except Exception as error:
        report["error"] = str(error)
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()  # only a Popen child owned by this rehearsal
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        for log in logs:
            log.close()
        client.close()
        native_client.close()
        report["owned_processes_stopped"] = all(process.poll() is not None for process in processes)
        path = Path(report_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--code-dir", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--report-path", type=Path, required=True)
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    result = run(args.code_dir, args.data_root, args.report_path, args.port)
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
