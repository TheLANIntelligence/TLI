"""Owned loopback TLS rehearsal, never a production listener or LAN probe.

Synthetic private IPv4 origins are mapped to the two owned loopback sockets.
Certificate name/pin checks, signatures, PIN sessions and transfer code are real.
This deliberately does not establish physical LAN routing or phone acceptance.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
from unittest.mock import patch

PIN = "739182"
MARKER = "synthetic peer transfer fixture only"


def clean():
    allowed = {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE"}
    result = {name: value for name, value in os.environ.items() if name.upper() in allowed}
    result.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", TLI_OPEN_BROWSER="0")
    return result


def connection_target(address, ports):
    destinations = {(f"192.168.248.{10+i}", port): ("127.0.0.1", port) for i, port in enumerate(ports)}
    if isinstance(address, tuple) and len(address) == 2:
        if address in {("127.0.0.1", port) for port in ports}:
            return address
        if address in destinations:
            return destinations[address]
    raise RuntimeError("Only the two owned fixture sockets may be contacted.")


def allowed_route(method, path):
    exact = {("GET", "/system/pin/status"), ("POST", "/system/pin/verify"),
             ("POST", "/system/pin/lock"), ("GET", "/__fixture/card"),
             ("POST", "/__fixture/stop"), ("POST", "/mesh/trust/preview"),
             ("POST", "/mesh/trust/approve"), ("GET", "/mesh/files"),
             ("POST", "/mesh/files/outgoing")}
    if (method, path) in exact:
        return True
    if method == "GET":
        return bool(re.fullmatch(r"/mesh/files/[a-f0-9]{32}(?:/download)?", path))
    return method == "POST" and bool(re.fullmatch(
        r"(?:/mesh/files/[a-f0-9]{32}/(?:stage|offer|review|accept|peer-status|send-next|complete|cancel|decline)|/agent/peer/files/(?:offer|status|chunk|complete|cancel))", path))


def watch_parent(parent_pid, parent_start):
    import psutil
    if type(parent_pid) is not int or parent_pid <= 0 or parent_start is None:
        raise ValueError("Exact fixture parent identity is required.")
    def watch():
        while True:
            try:
                parent = psutil.Process(parent_pid)
                alive = parent.is_running() and parent.create_time() == parent_start and parent.status() != psutil.STATUS_ZOMBIE
            except psutil.Error:
                alive = False
            if not alive:
                # Synthetic-only process: immediately close every owned socket,
                # including if startup or graceful shutdown is still blocked.
                os._exit(90)
            time.sleep(.1)
    worker = threading.Thread(target=watch, daemon=True, name="fixture-parent-watch")
    worker.start()


def child(root, label, ports, parent_pid, parent_start):
    root = root.resolve()
    if (root / ".fixture").read_text(encoding="utf-8") != MARKER or (root / "data").exists():
        raise ValueError("A new marked synthetic root is required.")
    environment = clean()
    os.environ.clear()
    os.environ.update(environment)
    os.environ["TLI_ROOT"] = str(root)
    os.environ["TLI_ENABLE_TLS"] = "1"
    os.chdir(root)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    watch_parent(parent_pid, parent_start)
    connect = socket.socket.connect

    def bounded_connect(sock, address):
        return connect(sock, connection_target(address, ports))

    def blocked(*args, **kwargs):
        raise RuntimeError("Processes and device actions are disabled in this fixture.")

    native_socketpair = socket.socketpair
    def internal_socketpair(*args, **kwargs):
        if os.name != "nt":
            return native_socketpair(*args, **kwargs)
        # Windows asyncio builds its self-pipe with a loopback socketpair.
        # Connect only to this factory's still-owned listener; never broadly
        # exempt loopback traffic or temporarily remove the connect guard.
        if args or kwargs:
            raise RuntimeError("Only the default internal socketpair is supported.")
        client = None
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0)); listener.listen(1)
            try:
                client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                connect(client, listener.getsockname())
                accepted, _ = listener.accept()
                return accepted, client
            except Exception:
                if client is not None:
                    client.close()
                raise

    with ExitStack() as scope:
        scope.enter_context(patch.object(socket.socket, "connect", bounded_connect))
        scope.enter_context(patch.object(socket.socket, "connect_ex", blocked))
        scope.enter_context(patch.object(socket.socket, "sendto", blocked))
        scope.enter_context(patch.object(socket, "socketpair", internal_socketpair))
        scope.enter_context(patch.object(subprocess, "Popen", blocked))
        scope.enter_context(patch.object(os, "system", blocked))
        import data_protection
        scope.enter_context(patch.object(data_protection, "is_windows", lambda: False))
        with patch.object(threading.Thread, "start", lambda self: None):
            import tli_state as S
            import node_identity
            import peer_trust as P
            from routers import system_routes, mesh_routes, peer_transfer_routes
        assert Path(S.DATA_DIR).resolve() == root / "data"
        salt = "a" * 64
        S.save_pin_config(hashlib.pbkdf2_hmac("sha256", PIN.encode(), salt.encode(), 260000).hex(), salt)
        S.save_node_config(S.NodeConfig(node_id=f"fixture-{label}", node_name=f"Synthetic {label}",
                           created_at=S.now_iso(), updated_at=S.now_iso()))
        node_identity.init(S.DATA_DIR)
        S.TLS_ENABLED = True

        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        number = 0 if label == "a" else 1
        address, port = f"192.168.248.{10+number}", ports[number]
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"Synthetic {label}")])
        now = datetime.now(timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1))
                .not_valid_after(now+timedelta(hours=1)).add_extension(x509.SubjectAlternativeName([
                    x509.IPAddress(ipaddress.ip_address(address)), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), False)
                .sign(key, hashes.SHA256()))
        (root / "cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        (root / "key.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        der = cert.public_bytes(serialization.Encoding.DER)
        card = {"protocol": P.PROTOCOL, "node_id": f"fixture-{label}", "name": f"Synthetic {label}",
                "origin": f"https://{address}:{port}", "public_key": node_identity.public_key_hex(),
                "identity_fingerprint": node_identity.fingerprint(), "certificate_der": base64.b64encode(der).decode(),
                "certificate_sha256": hashlib.sha256(der).hexdigest(),
                "capabilities": ["system_observation_v1", "coordination_v1", "messages_v1"], "issued_at": now.isoformat()}
        card["signature"] = node_identity.sign(P.canonical(card))
        P.validate_card(card)
        from fastapi import FastAPI, Depends
        from fastapi.responses import JSONResponse
        import uvicorn
        app = FastAPI()
        app.include_router(system_routes.router)
        app.include_router(mesh_routes.router)
        app.include_router(peer_transfer_routes.router)

        @app.middleware("http")
        async def fixture_scope(request, call_next):
            if request.url.query or not allowed_route(request.method, request.url.path):
                return JSONResponse({"detail": "Outside the isolated fixture scope."}, status_code=403)
            return await call_next(request)

        @app.get("/__fixture/card")
        def public_card(owner=Depends(system_routes.require_session)):
            return card

        @app.post("/__fixture/stop")
        def stop(owner=Depends(system_routes.require_session)):
            server.should_exit = True
            return {"ok": True}

        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
            ssl_certfile=str(root / "cert.pem"), ssl_keyfile=str(root / "key.pem"), log_level="warning",
            timeout_graceful_shutdown=3))
        deadline = threading.Timer(100, lambda: setattr(server, "should_exit", True))
        deadline.daemon = True
        deadline.start()
        try:
            server.run()
        finally:
            deadline.cancel()


def run(root, report_path, *, wait_for_parent_death=False):
    import requests
    import psutil
    if getattr(sys, "frozen", False):
        raise RuntimeError("The isolated fixture requires a Python source installation.")
    # A Windows venv executable may be a redirector. If a test timeout kills
    # that outer process, stop this interpreter, then its explicitly bound
    # server children, instead of leaving the grandchildren alive.
    parent_pid = os.getppid()
    watch_parent(parent_pid, psutil.Process(parent_pid).create_time())
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    report = {"status": "failed", "scope": "two owned loopback TLS processes with synthetic private-address socket mapping",
              "physical_lan": "not_run", "phone_acceptance": "not_run", "checks": {}, "production_contacted": False}
    processes, streams, sessions = [], [], []
    ports = []
    with ExitStack() as held:
        for _ in range(2):
            sock = held.enter_context(socket.socket())
            sock.bind(("127.0.0.1", 0))
            ports.append(sock.getsockname()[1])

    def call(index, method, path, expected=200, **kwargs):
        if path.startswith('/system/pin/') and method == 'POST':
            kwargs['headers'] = {**kwargs.get('headers', {}), 'Origin': f'https://127.0.0.1:{ports[index]}'}
        response = sessions[index].request(method, f"https://127.0.0.1:{ports[index]}"+path,
            verify=str(root / str(index) / "cert.pem"), timeout=15, allow_redirects=False, **kwargs)
        if response.status_code != expected:
            raise AssertionError(f"{index} {method} {path}: expected {expected}, got {response.status_code}: {response.text[:700]}")
        return response

    def operation(index, transfer, op, body=None, expected=200):
        return call(index, "POST", f"/mesh/files/{transfer}/{op}", expected, json=body or {}).json()

    def prepare(content):
        row = call(0, "POST", "/mesh/files/outgoing", json={"request_id": secrets.token_hex(16),
            "peer_id": "fixture-b", "filename": "synthetic-file.bin", "size": len(content)}).json()
        for number, offset in enumerate(range(0, len(content), 65536)):
            chunk = content[offset:offset+65536]
            operation(0, row["id"], "stage", {"index": number, "data": base64.b64encode(chunk).decode(), "sha256": hashlib.sha256(chunk).hexdigest()})
        operation(0, row["id"], "offer")
        return row["id"]

    def accept(transfer):
        reviewed = operation(1, transfer, "review")
        assert reviewed["consent_label"] == "Receive into TLI Inbox (encrypted on host)"
        operation(1, transfer, "accept", {"review_id": reviewed["review_id"]})
        assert operation(0, transfer, "peer-status")["state"] == "accepted"

    try:
        for index, label in enumerate(("a", "b")):
            area = root / str(index)
            area.mkdir()
            (area / ".fixture").write_text(MARKER, encoding="utf-8")
            stream = (root / f"host-{label}.log").open("w", encoding="utf-8")
            streams.append(stream)
            process = subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()), "--child", label,
                "--root", str(area), "--ports", *map(str, ports), "--parent-pid", str(os.getpid()),
                "--parent-start", str(psutil.Process().create_time())], cwd=area, env=clean(),
                stdout=stream, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            processes.append(process)
            session = requests.Session()
            session.trust_env = False
            sessions.append(session)
            limit = time.monotonic()+30
            while time.monotonic() < limit:
                if process.poll() is not None:
                    raise RuntimeError(f"Synthetic host {label} exited; inspect its log.")
                if (area / "cert.pem").exists():
                    try:
                        call(index, "GET", "/system/pin/status")
                        break
                    except requests.RequestException:
                        pass
                time.sleep(.1)
            else:
                raise RuntimeError("Synthetic TLS host did not become ready.")
            call(index, "GET", "/mesh/files", 401)
            call(index, "POST", "/system/pin/verify", 403, json={"pin": "incorrect"})
            call(index, "POST", "/system/pin/verify", json={"pin": PIN})
            # These real mounted handlers must be inaccessible even to the
            # synthetic authorized session: neither is part of this rehearsal.
            call(index, "GET", "/debug/selftest", 403)
            call(index, "POST", "/system/lm_studio/test", 403, json={"url": "http://127.0.0.1:1234"})
        report["checks"]["unrelated_handlers_blocked"] = True
        if wait_for_parent_death:
            descendants = {}
            for process in processes:
                parent = psutil.Process(process.pid)
                for owned_process in [parent, *parent.children(recursive=True)]:
                    descendants[owned_process.pid] = {"pid": owned_process.pid, "created_at": owned_process.create_time()}
            owned = {"orchestrator": {"pid": os.getpid(), "created_at": psutil.Process().create_time()},
                     "children": list(descendants.values()),
                     "ports": ports}
            (root / "parent-death-ready.json").write_text(json.dumps(owned), encoding="utf-8")
            time.sleep(60)
            raise RuntimeError("The explicit parent-death probe was not terminated.")
        report["checks"]["real_pin_and_https"] = True
        cards = [call(i, "GET", "/__fixture/card").json() for i in (0, 1)]
        for i in (0, 1):
            card = cards[1-i]
            reviewed = call(i, "POST", "/mesh/trust/preview", json={"card": card, "grants": ["messages"]}).json()
            call(i, "POST", "/mesh/trust/approve", json={"review_id": reviewed["review_id"],
                "identity_fingerprint": card["identity_fingerprint"], "certificate_sha256": card["certificate_sha256"]})
        report["checks"]["actual_bilateral_trust_review"] = True
        payload = b"SYNTHETIC TRANSFER ONLY\n" * 7200
        transfer = prepare(payload)
        assert not list((root / "1/data/mesh/secure_transfers").glob("*.blob"))
        operation(0, transfer, "send-next", expected=409)
        report["checks"]["metadata_only_before_receiver_consent"] = True
        accept(transfer)
        for _ in range((len(payload)+65535)//65536):
            operation(0, transfer, "send-next")
        delivered = operation(0, transfer, "complete")
        assert delivered["verified"] is True and delivered["state"] == "delivered"
        got = call(1, "GET", f"/mesh/files/{transfer}/download")
        assert got.content == payload and hashlib.sha256(got.content).hexdigest() == delivered["sha256"]
        assert got.headers["cache-control"] == "no-store"
        report["checks"]["signed_tls_chunks_and_final_verified_download"] = True
        declined = prepare(b"Declined synthetic content")
        operation(1, declined, "decline")
        assert operation(0, declined, "peer-status")["state"] == "declined"
        report["checks"]["explicit_receiver_refusal"] = True
        interrupted = prepare(b"Synthetic partial bytes\n" * 8000)
        accept(interrupted)
        operation(0, interrupted, "send-next")
        call(1, "POST", "/system/pin/lock")
        operation(0, interrupted, "send-next", expected=502)
        assert call(0, "GET", f"/mesh/files/{interrupted}").json()["state"] == "uncertain"
        call(1, "POST", "/system/pin/verify", json={"pin": PIN})
        before = call(1, "GET", f"/mesh/files/{interrupted}").json()["staged_bytes"]
        assert before == 65536
        operation(1, interrupted, "cancel")
        assert operation(0, interrupted, "peer-status")["state"] == "cancelled"
        assert call(1, "GET", f"/mesh/files/{interrupted}").json()["staged_bytes"] == before
        report["checks"]["receiver_lock_stops_future_chunks_preserves_partial_receipt"] = True
        report["status"] = "passed"
    except Exception as error:
        report["error"] = str(error)
    finally:
        for index, process in enumerate(processes):
            if process.poll() is None:
                try:
                    call(index, "POST", "/__fixture/stop")
                    sessions[index].close()
                    process.wait(timeout=8)
                except Exception:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
        for stream in streams:
            stream.close()
        for session in sessions:
            session.close()
        report["owned_children_stopped"] = all(p.poll() is not None for p in processes)
        report["owned_processes"] = len(processes)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--child", choices=["a", "b"])
    parser.add_argument("--ports", type=int, nargs=2)
    parser.add_argument("--parent-pid", type=int)
    parser.add_argument("--parent-start", type=float)
    parser.add_argument("--wait-for-parent-death", action="store_true")
    args = parser.parse_args()
    if args.child:
        child(args.root, args.child, args.ports, args.parent_pid, args.parent_start)
    else:
        if not args.report:
            parser.error("--report is required")
        result = run(args.root, args.report, wait_for_parent_death=args.wait_for_parent_death)
        print(json.dumps(result))
        raise SystemExit(0 if result["status"] == "passed" and result["owned_children_stopped"] else 1)
