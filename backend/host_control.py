"""Optional host-start authority. No app imports, discovery, or writes on import.

The independent helper may start exactly this installation. Provisioning is local;
remote callers get status/start only and cannot supply a command or filesystem path.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import stat
import tempfile
import threading
import time

import startup_config
import tls_cert

HEX = re.compile(r"^[0-9a-f]{64}$")
REQUEST = re.compile(r"^[0-9a-f]{32,64}$")
PREFIX = "/host-control/v1"


class HostControlError(Exception):
    def __init__(self, status, detail):
        self.status, self.detail = status, detail
        super().__init__(detail)


def _fail(detail, status=409):
    raise HostControlError(status, detail)


def root_path(root):
    root = Path(root).absolute()
    # Root and authority files must not be redirected through a junction/symlink.
    for part in [root, *root.parents]:
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            _fail("Linked installation paths are not supported by host start.")
    return root.resolve()


def path_for(root, name):
    root = root_path(root)
    path = root / "data" / "host_control" / name
    for part in [path, path.parent, path.parent.parent]:
        if part.exists() or part.is_symlink():
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                _fail("Linked host-start state is not supported.")
    return path


def decode_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate field")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-finite JSON number')))


def read_json(path, limit=1024 * 1024):
    try:
        with Path(path).open("rb") as stream:
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("Oversized state")
        return decode_json(raw)
    except FileNotFoundError:
        raise
    except Exception as error:
        raise HostControlError(503, "Saved host-start authority is unreadable; no files were replaced.") from error


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".host-control-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class FileLock:
    """Same-user cross-process lease; a file's existence is never a PID proof."""
    def __init__(self, path):
        self.path, self.stream = Path(path), None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open("a+b")
        try:
            if self.path.stat().st_size == 0:
                self.stream.write(b"0"); self.stream.flush()
            self.stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self.stream.close(); self.stream = None
            raise HostControlError(409, "Another operation owns this installation's launch lock.") from error
        return self

    def __exit__(self, *args):
        if self.stream:
            self.stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
            self.stream.close(); self.stream = None


def installation(root, *, create=False):
    root = root_path(root)
    path = path_for(root, "installation.json")
    try:
        value = read_json(path, 16384)
    except FileNotFoundError:
        if not create:
            _fail("Run TLI_Setup.ps1 locally to prepare this installation.")
        # Setup and desktop launch have separate operation leases, but share
        # this one creation lease; neither can replace the other's identity.
        with FileLock(path_for(root, 'identity.lock')):
            try:
                value = read_json(path, 16384)
            except FileNotFoundError:
                value = {"version": 1, "root": str(root), "installation_id": secrets.token_hex(16), "secret": secrets.token_hex(32)}
                write_json(path, value)
    if (not isinstance(value, dict) or value.get("version") != 1 or value.get("root") != str(root)
            or not re.fullmatch(r"[0-9a-f]{32}", str(value.get("installation_id", "")))
            or not HEX.fullmatch(str(value.get("secret", "")))):
        _fail("Installation identity changed or is invalid. Review setup locally.")
    return value


def proof(identity, challenge):
    if not REQUEST.fullmatch(challenge):
        _fail("Invalid identity challenge.", 422)
    message = "tli-installation-v1:" + identity["installation_id"] + ":" + challenge
    return hmac.new(bytes.fromhex(identity["secret"]), message.encode(), hashlib.sha256).hexdigest()


def local_stop_requested(root, pid, created, *, now=None):
    """Read-only validation of a short-lived, process-generation-bound local stop."""
    try:
        identity = installation(root)
        value = read_json(path_for(root, 'stop-backend.json'), 16384)
        if (value.get('pid') != pid or value.get('created_at') != created
                or not isinstance(value.get('at'), (int, float)) or not 0 <= (time.time() if now is None else now) - value['at'] < 60
                or not REQUEST.fullmatch(str(value.get('nonce', '')))):
            return False
        message = f"stop:{pid}:{created}:{value['nonce']}:{value['at']}"
        expected = hmac.new(bytes.fromhex(identity['secret']), message.encode(), hashlib.sha256).hexdigest()
        return isinstance(value.get('proof'), str) and hmac.compare_digest(expected, value['proof'])
    except Exception:
        return False


def pin_state(root):
    value = read_json(Path(root) / "data" / "tli_pin.json", 65536)
    if (not isinstance(value, dict) or value.get("enabled", True) is not True
            or any(not HEX.fullmatch(str(value.get(key, ""))) for key in ("hash", "salt"))):
        _fail("Host start requires the existing enabled desktop PIN.")
    return value


def pin_generation(root):
    value = pin_state(root)
    return hashlib.sha256((value["salt"] + ":" + value["hash"]).encode()).hexdigest()


def verify_local_pin(root, pin):
    value = pin_state(root)
    candidate = hashlib.pbkdf2_hmac("sha256", pin.strip().encode(), value["salt"].encode(), 260000).hex()
    if not secrets.compare_digest(candidate, value["hash"]):
        _fail("Incorrect desktop PIN.", 401)


def host_identity(root):
    import node_identity
    identity = node_identity.read_existing(Path(root) / "data")
    node = read_json(Path(root) / "data" / "mesh" / "node_config.json", 65536)
    if not identity or not isinstance(node, dict) or not isinstance(node.get("node_id"), str) or not node["node_id"]:
        _fail("An existing TLI host identity is required. Start TLI normally first.")
    return node["node_id"], identity["public_key_hex"]


def config(root):
    identity = installation(root)
    value = read_json(path_for(root, "helper.json"), 16384)
    if not isinstance(value, dict) or value.get("version") != 1 or value.get("enabled") is not True:
        _fail("Phone host start is disabled. Enable it locally with TLI_Setup.ps1.")
    if value.get("installation_id") != identity["installation_id"] or not REQUEST.fullmatch(str(value.get("helper_id", ""))):
        _fail("Helper installation identity does not match.")
    settings = startup_config.resolve(root, environ={})
    if not settings["configured"] or settings["saved"] != value.get("backend") or settings["saved"]["host"] != "0.0.0.0" or not settings["saved"]["https"]:
        _fail("Saved secure LAN startup changed. Review and enable host start again locally.")
    if type(value.get("port")) is not int or not 1024 <= value["port"] <= 65535 or value["port"] == settings["saved"]["port"]:
        _fail("Helper port is invalid or conflicts with the backend.")
    if value.get("owner_id") != "local" or value.get("pin_generation") != pin_generation(root):
        _fail("The desktop PIN or owner changed. Review host start locally.")
    node_id, public_key = host_identity(root)
    if value.get("node_id") != node_id or value.get("public_key") != public_key:
        _fail("The saved host identity changed. Review host start locally.")
    certificate = tls_cert.certificate_bundle(str(Path(root) / "data/tls/cert.pem"), str(Path(root) / "data/tls/key.pem"), "localhost")
    if value.get("certificate_sha256") != certificate["fingerprint"]:
        _fail("The HTTPS identity changed. Review setup locally and reconnect the phone.")
    return value


def provision(root, port, pin):
    root = root_path(root)
    verify_local_pin(root, pin)
    settings = startup_config.resolve(root, environ={})
    if not settings["configured"] or settings["saved"]["host"] != "0.0.0.0" or not settings["saved"]["https"]:
        _fail("Save Secure LAN with HTTPS in TLI Settings and restart TLI first.")
    if type(port) is not int or not 1024 <= port <= 65535 or port == settings["saved"]["port"]:
        _fail("Choose a separate helper port from 1024 to 65535.")
    certificate = tls_cert.certificate_bundle(str(root / "data/tls/cert.pem"), str(root / "data/tls/key.pem"), "localhost")
    node_id, public_key = host_identity(root)
    with FileLock(path_for(root, "setup.lock")):
        identity = installation(root, create=True)
        value = {"version": 1, "enabled": True, "installation_id": identity["installation_id"],
                 "helper_id": secrets.token_hex(16), "owner_id": "local", "pin_generation": pin_generation(root),
                 "node_id": node_id, "public_key": public_key, "port": port, "backend": settings["saved"],
                 "certificate_sha256": certificate["fingerprint"]}
        write_json(path_for(root, "helper.json"), value)
    return value


def descriptor(root, host):
    result = {"schema_version": 1, "enabled": False, "available": False, "reason": "Phone host start is off. Run TLI_Setup.ps1 on this computer to enable it.",
              "helper_id": None, "node_id": None, "origin": None, "certificate_sha256": None,
              "status_path": PREFIX + "/status", "start_path": PREFIX + "/start",
              "mode": "same_user_sign_in", "capabilities": {"start_backend": True, "wake_host": False}}
    try:
        value = config(root)
        address = ipaddress.IPv4Address(host)
        if not address.is_private or address.is_loopback or address.is_unspecified or address.is_multicast:
            _fail("Open TLI at its certificate-covered private LAN IPv4 address to review phone host start.")
        tls_cert.certificate_bundle(str(Path(root) / "data/tls/cert.pem"), str(Path(root) / "data/tls/key.pem"), host)
        result.update(enabled=True, available=True, helper_id=value["helper_id"], node_id=value["node_id"],
                      origin=f"https://{host}:{value['port']}", certificate_sha256=value["certificate_sha256"],
                      reason="Configured; check helper availability from this phone. The host must be awake and its user signed in.")
    except FileNotFoundError:
        pass
    except Exception as error:
        result["reason"] = str(getattr(error, "detail", error))
    return result


def devices(root):
    value = read_json(Path(root) / "data/companion/credentials.json")
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("devices"), dict):
        _fail("Paired-device credentials are unavailable.", 503)
    return value["devices"]


def scoped_token(identity, cfg, entry):
    message = "tli-host-start-v1:" + cfg["helper_id"] + ":" + entry["id"] + ":" + entry["credential_hash"]
    return "tlih_" + hmac.new(bytes.fromhex(identity["secret"]), message.encode(), hashlib.sha256).hexdigest()


def grant(root, credential, helper_id, node_id):
    cfg = config(root)
    if (helper_id, node_id) != (cfg["helper_id"], cfg["node_id"]):
        _fail("The reviewed helper identity changed. Review it again.")
    candidate = hashlib.sha256(credential.encode()).hexdigest()
    for ident, entry in devices(root).items():
        if (isinstance(entry, dict) and entry.get("id") == ident and not entry.get("revoked_at")
                and entry.get("owner_id") == cfg["owner_id"] and isinstance(entry.get("credential_hash"), str)
                and secrets.compare_digest(entry["credential_hash"], candidate)):
            return scoped_token(installation(root), cfg, entry)
    _fail("Use a current paired Companion credential.", 401)


def authorize(root, token):
    cfg = config(root)
    if not isinstance(token, str) or not re.fullmatch(r"tlih_[0-9a-f]{64}", token):
        _fail("A restricted host-start credential is required.", 401)
    identity = installation(root)
    for ident, entry in devices(root).items():
        if (isinstance(entry, dict) and entry.get("id") == ident and not entry.get("revoked_at")
                and entry.get("owner_id") == cfg["owner_id"] and HEX.fullmatch(str(entry.get("credential_hash", "")))
                and secrets.compare_digest(scoped_token(identity, cfg, entry), token)):
            return cfg, ident
    _fail("Host-start access expired or this phone was revoked. Reconnect and review on the phone.", 401)


class Controller:
    def __init__(self, root, *, probe=None, launch=None, clock=time.time):
        import host_launcher
        self.root, self.lock, self.clock = root_path(root), threading.RLock(), clock
        self.probe = probe or host_launcher.inspect_backend
        self.launch = launch or host_launcher.spawn_backend

    def _ledger(self):
        try:
            value = read_json(path_for(self.root, "requests.json"), 1024 * 1024)
        except FileNotFoundError:
            return {"version": 1, "requests": []}
        if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("requests"), list) or len(value["requests"]) > 512:
            _fail("Host-start receipts are unreadable. Review locally; nothing was replayed.", 503)
        for item in value["requests"]:
            if not isinstance(item, dict) or not REQUEST.fullmatch(str(item.get("request_id", ""))) or item.get("phase") not in {"reserved", "accepted", "failed", "already_running"} or not isinstance(item.get("at"), (int, float)):
                _fail("Host-start receipts are unreadable. Review locally; nothing was replayed.", 503)
        return value

    def _status(self, cfg, ledger):
        import host_launcher
        state, reason = self.probe(self.root, cfg["backend"])
        if state == "running" and ledger["requests"] and ledger["requests"][-1]["phase"] == "reserved":
            # A later independent proof resolves launch uncertainty without replay.
            ledger["requests"][-1]["phase"] = "accepted"
            write_json(path_for(self.root, "requests.json"), ledger)
        if state == "stopped" and ledger["requests"]:
            last = ledger["requests"][-1]
            if last["phase"] == "reserved":
                state, reason = "unavailable", "An earlier start has an uncertain outcome. Open TLI locally; no start was replayed."
            elif last["phase"] == "accepted" and host_launcher.child_alive(self.root, last.get("child")):
                state, reason = "starting", "The owned backend process is starting; readiness is not confirmed."
        return {"schema_version": 1, "helper_id": cfg["helper_id"], "node_id": cfg["node_id"],
                "backend_state": state, "can_start": state == "stopped", "reason": reason}

    def status(self, token, helper_id, node_id):
        with self.lock:
            cfg, _ = authorize(self.root, token)
            if (helper_id, node_id) != (cfg["helper_id"], cfg["node_id"]):
                _fail("This request names a different helper or host.")
            return self._status(cfg, self._ledger())

    def start(self, token, payload):
        if not isinstance(payload, dict) or set(payload) != {"request_id", "node_id", "helper_id"} or not REQUEST.fullmatch(str(payload.get("request_id", ""))):
            _fail("Supply only the reviewed identities and a 32–64 character hexadecimal request ID.", 422)
        with self.lock, FileLock(path_for(self.root, "launch.lock")):
            cfg, device_id = authorize(self.root, token)
            if (payload["helper_id"], payload["node_id"]) != (cfg["helper_id"], cfg["node_id"]):
                _fail("This request names a different helper or host.")
            ledger = self._ledger()
            result = self._status(cfg, ledger)
            previous = next((item for item in ledger["requests"] if item.get("device_id") == device_id and item["request_id"] == payload["request_id"]), None)
            if previous:
                return {**result, "request_id": payload["request_id"], "duplicate": True,
                        "can_start": False, "accepted": previous["phase"] == "accepted", "reason": "Earlier request retained; no launch was replayed. " + result["reason"]}
            if len(ledger["requests"]) >= 512:
                _fail("The bounded host-start receipt store is full. Review it locally; no receipts were discarded.", 503)
            if result["backend_state"] == "running":
                # A successful no-op is still idempotent. The same request ID
                # must not start a backend later merely because it has stopped.
                ledger["requests"].append({**payload, "device_id": device_id, "at": self.clock(), "phase": "already_running"})
                write_json(path_for(self.root, "requests.json"), ledger)
                return {**result, "request_id": payload["request_id"], "duplicate": False, "accepted": False}
            if not result["can_start"]:
                _fail(result["reason"])
            now = self.clock()
            if any(now - item["at"] < 30 and item['phase'] != 'already_running' for item in ledger["requests"]):
                _fail("Wait 30 seconds before another explicit start attempt.", 429)
            if sum(now - item["at"] < 3600 and item['phase'] != 'already_running' for item in ledger["requests"]) >= 5:
                _fail("Five starts were requested in one hour. Inspect TLI locally before retrying.", 429)
            item = {**payload, "device_id": device_id, "at": now, "phase": "reserved"}
            ledger["requests"].append(item)
            write_json(path_for(self.root, "requests.json"), ledger)  # durable intent BEFORE process creation
            authorize(self.root, token)  # revocation/PIN/security changed while inspecting
            try:
                child = self.launch(self.root, cfg["backend"])
                item.update(phase="accepted", child=child)
                write_json(path_for(self.root, "requests.json"), ledger)
            except Exception as error:
                # A spawn may have succeeded before an exception. Keep reserved;
                # do not classify uncertainty as safe-to-retry or replay on restart.
                raise HostControlError(503, "Start outcome is unconfirmed. Check status or open TLI locally; no automatic retry.") from error
            return {**result, "backend_state": "starting", "can_start": False, "accepted": True,
                    "request_id": payload["request_id"], "duplicate": False,
                    "reason": "Start accepted. Wait for the original TLI connection to confirm readiness."}
