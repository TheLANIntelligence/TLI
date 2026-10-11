"""Local setup and HTTPS inference worker for a separately installed TLI Node.

Importing this entry point is deliberately standard-library only. Every command
requires its own explicit state directory before any shared TLI module loads.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import stat
import sys
from types import SimpleNamespace
from urllib.parse import urlsplit

PURPOSE = "tli-inference-node-v1"
MARKER = "node.json"
MAX_CARD = 24576
_MARKER_KEYS = {"version", "purpose", "node_id", "name", "origin", "lm_studio_url",
                "identity_fingerprint", "certificate_sha256"}
_REQUIRED = ("data/node_identity.json", "data/mesh/node_config.json",
             "data/mesh/mesh_directory.json", "data/tls/cert.pem", "data/tls/key.pem")


class NodeError(ValueError):
    pass


def _root(value):
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise NodeError("Use an absolute --state-dir path dedicated to this Node.")
    # A linked state directory can unexpectedly alias the full host installation.
    for candidate in (path, *path.parents):
        if candidate.exists() or candidate.is_symlink():
            info = candidate.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
                raise NodeError("The Node state directory must not use symlinks or Windows junctions.")
    return path.resolve()


def _origin(value):
    try:
        url = urlsplit(value)
        address = ipaddress.IPv4Address(url.hostname)
        port = url.port if url.port is not None else 443
        private = any(address in ipaddress.ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
        if (url.scheme != "https" or not private or not 1 <= port <= 65535
                or url.username is not None or url.password is not None or url.path not in ("", "/") or url.query or url.fragment):
            raise ValueError()
        return f"https://{address}:{port}"
    except (ValueError, TypeError, AttributeError):
        raise NodeError("Use an HTTPS origin with this computer's private LAN IPv4 address and port.") from None


def _model_origin(value):
    try:
        url = urlsplit(value)
        host = "127.0.0.1" if url.hostname == "localhost" else url.hostname
        address = ipaddress.ip_address(host)
        port = url.port if url.port is not None else (443 if url.scheme == "https" else 80)
        if (url.scheme not in ("http", "https") or not address.is_loopback or not 1 <= port <= 65535
                or url.username is not None or url.password is not None or url.path not in ("", "/") or url.query or url.fragment):
            raise ValueError()
        host = f"[{address}]" if address.version == 6 else str(address)
        return f"{url.scheme}://{host}:{port}"
    except (ValueError, TypeError, AttributeError):
        raise NodeError("LM Studio must use a literal loopback origin, such as http://127.0.0.1:1234.") from None


def _local_addresses():
    import psutil
    return {str(ipaddress.IPv4Address(item.address)) for addresses in psutil.net_if_addrs().values()
            for item in addresses if item.family == socket.AF_INET}


def _require_local(origin):
    if urlsplit(origin).hostname not in _local_addresses():
        raise NodeError("The saved private LAN address is not assigned to this computer. Restore that address before starting or exchanging cards.")


@contextmanager
def _lock(root, name):
    """OS-released process lock; never delete a lock another process may hold."""
    path = root / name
    _root(path)
    stream = path.open("a+b")
    acquired = False
    try:
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise NodeError("Another Node process owns this operation. No second runtime or concurrent setup was started.") from None
        acquired = True
        yield
    finally:
        if acquired:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()


def _read_marker(root):
    try:
        _root(root / MARKER)
        with (root / MARKER).open("rb") as stream:
            raw = stream.read(8193)
        value = json.loads(raw)
        if len(raw) > 8192 or not isinstance(value, dict) or set(value) != _MARKER_KEYS:
            raise ValueError()
        if (type(value["version"]) is not int or value["version"] != 1 or value["purpose"] != PURPOSE
                or value["origin"] != _origin(value["origin"]) or value["lm_studio_url"] != _model_origin(value["lm_studio_url"])
                or any(not isinstance(value[key], str) or not 1 <= len(value[key]) <= 128 for key in ("node_id", "name", "identity_fingerprint", "certificate_sha256"))):
            raise ValueError()
        for relative in _REQUIRED:
            path = root / relative
            _root(path)
            if not path.is_file() or path.is_symlink():
                raise ValueError()
        # A full host's data must never be adopted by this smaller runtime.
        for relative in ("data/tli_pin.json", "data/conversations.json", "data/companion/credentials.json", "data/vault/vault_meta.json"):
            if (root / relative).exists():
                raise ValueError()
        return value
    except (OSError, ValueError, TypeError, KeyError):
        raise NodeError("This is not a complete TLI Node state directory. Existing files were preserved; use a matching backup or initialize a separate empty directory.") from None


def _bootstrap(root):
    existing = sys.modules.get("tli_state")
    if existing is not None and Path(existing.BASE_DIR).resolve() != root:
        raise NodeError("TLI Node must run in its own process, separate from the full TLI host.")
    os.environ["TLI_ROOT"] = str(root)
    import tli_state as S
    import node_identity
    import peer_trust as P
    import security_state
    return S, node_identity, P, security_state


def _load(root, *, local_address=False):
    marker = _read_marker(root)  # before imports or writes
    if local_address:
        _require_local(marker["origin"])
    S, identity, P, security = _bootstrap(root)
    config = S.read_node_config()
    persisted = identity.read_existing(S.DATA_DIR)
    from tls_cert import certificate_bundle
    bundle = certificate_bundle(S.TLS_CERT_PATH, S.TLS_KEY_PATH, urlsplit(marker["origin"]).hostname)
    if (config is None or persisted is None or config.node_id != marker["node_id"] or config.node_name != marker["name"]
            or persisted["fingerprint"] != marker["identity_fingerprint"] or bundle["fingerprint"] != marker["certificate_sha256"]):
        raise NodeError("The saved Node identity or HTTPS certificate changed. Restore the matching Node state before continuing.")
    directory = S.load_mesh_directory()
    for entry in directory.values():
        if entry.get("peer_trust", {}).get("grants") != ["inference"]:
            raise NodeError("The Node directory contains unsupported permissions. Only inference is supported here.")
    identity.init(S.DATA_DIR)
    S.SERVER_BIND_PORT = urlsplit(marker["origin"]).port
    S.TLS_ENABLED = True
    S.lm_provider = SimpleNamespace(chat_url=marker["lm_studio_url"] + "/v1/chat/completions",
                                    models_url=marker["lm_studio_url"] + "/v1/models")
    return marker, S, identity, P, security


def initialize(args):
    root = _root(args.state_dir)
    origin, model = _origin(args.origin), _model_origin(args.lm_studio_url)
    if not isinstance(args.name, str) or not args.name.strip() or len(args.name) > 128 or any(ord(c) < 32 for c in args.name):
        raise NodeError("Use a Node name of 1 to 128 printable characters.")
    if root.exists() and (not root.is_dir() or any(root.iterdir())):
        raise NodeError("Initialization requires a new or empty dedicated state directory. Existing state was not changed.")
    _require_local(origin)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        # Non-Windows node_identity stores its signing key without DPAPI. The
        # dedicated fresh directory protects every identity and TLS descendant.
        root.chmod(0o700)
    with _lock(root, ".node-admin.lock"):
        if any(path.name != ".node-admin.lock" for path in root.iterdir()):
            raise NodeError("The state directory changed during initialization. Existing files were preserved.")
        S, identity, P, security = _bootstrap(root)
        config = S.load_node_config()
        config.node_name = args.name.strip()
        S.save_node_config(config)
        identity.init(S.DATA_DIR)
        S.save_mesh_directory({})
        from tls_cert import ensure_tls_cert
        if not ensure_tls_cert(S.TLS_CERT_PATH, S.TLS_KEY_PATH):
            raise NodeError("Node HTTPS initialization failed. Partial state was preserved; do not initialize over it.")
        S.SERVER_BIND_PORT = urlsplit(origin).port
        S.TLS_ENABLED = True
        card = P.local_card(origin, capabilities=["inference_v1"])
        security.write_json(root / MARKER, {"version": 1, "purpose": PURPOSE, "node_id": config.node_id,
                            "name": config.node_name, "origin": origin, "lm_studio_url": model,
                            "identity_fingerprint": card["identity_fingerprint"],
                            "certificate_sha256": card["certificate_sha256"]}, "Node configuration", new=True)
    print("TLI Node initialized. No listener or model was started. Export its public card and review the host's card before running.")


def export_card(args):
    root = _root(args.state_dir)
    marker, _, _, P, _ = _load(root, local_address=True)
    value = P.local_card(marker["origin"], capabilities=["inference_v1"])
    text = json.dumps(value, indent=2) + "\n"
    if args.out:
        with Path(args.out).open("x", encoding="utf-8") as stream:
            stream.write(text)
        print("Public Node card exported. It contains no private key.")
    else:
        print(text, end="")


def trust(args):
    root = _root(args.state_dir)
    _read_marker(root)
    with _lock(root, ".node-admin.lock"):
        _, _, _, P, _ = _load(root)
        with Path(args.card).open("rb") as stream:
            raw = stream.read(MAX_CARD + 1)
        if len(raw) > MAX_CARD:
            raise NodeError("The public card is too large.")
        try:
            card = json.loads(raw)
        except (ValueError, UnicodeError):
            raise NodeError("The public card is not valid JSON.") from None
        card = P.validate_card(card)
        if args.identity_fingerprint != card["identity_fingerprint"] or args.certificate_sha256 != card["certificate_sha256"]:
            raise NodeError("The separately supplied fingerprints do not match this card. No permission was granted.")
        from starlette.requests import Request
        request = Request({"type": "http", "method": "POST", "path": "/local-cli", "scheme": "https",
                           "headers": [(b"cookie", ("tli_session=" + secrets.token_hex(32)).encode())], "query_string": b""})
        review = P.preview(card, ["inference"], "local-node-admin", request)
        P.approve(review["review_id"], args.identity_fingerprint, args.certificate_sha256, "local-node-admin", request)
    print("Inference permission saved for " + card["name"] + ". Review the Node's card on that host too.")


def peers(args):
    _, S, _, _, _ = _load(_root(args.state_dir))
    value = [{"id": ident, "name": row.get("display_name"), "status": row.get("status"),
              "grants": row.get("peer_trust", {}).get("grants", [])} for ident, row in S.load_mesh_directory().items()]
    print(json.dumps({"peers": value}, indent=2))


def revoke(args):
    root = _root(args.state_dir)
    _read_marker(root)
    with _lock(root, ".node-admin.lock"):
        _, S, _, _, _ = _load(root)
        directory = S.load_mesh_directory()
        if args.peer_id not in directory:
            raise NodeError("That peer is not in this Node's directory.")
        directory[args.peer_id]["status"] = "blocked"
        S.save_mesh_directory(directory)
    print("Peer permission revoked. Active inference checks will stop accepting that peer.")


def run(args):
    root = _root(args.state_dir)
    _read_marker(root)
    with _lock(root, ".node-runtime.lock"):
        marker, S, _, _, _ = _load(root, local_address=True)
        import uvicorn
        from fastapi import FastAPI
        import lan_inference as L
        from peer_inference_routes import make_peer_router
        app = FastAPI(title="TLI Node", docs_url=None, redoc_url=None, openapi_url=None)
        app.include_router(make_peer_router(resource_loader=lambda **kw: L._resources(include_bundled=False, **kw)))
        address = urlsplit(marker["origin"])
        print("Starting TLI Node at " + marker["origin"] + ". Press Ctrl+C to stop. Only reviewed inference peers are accepted.", flush=True)
        uvicorn.run(app, host=address.hostname, port=address.port, ssl_certfile=S.TLS_CERT_PATH,
                    ssl_keyfile=S.TLS_KEY_PATH, proxy_headers=False, access_log=False,
                    timeout_keep_alive=5, limit_concurrency=16)


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    commands = value.add_subparsers(dest="command", required=True)
    for name, handler in (("init", initialize), ("card", export_card), ("trust", trust), ("peers", peers), ("revoke", revoke), ("run", run)):
        command = commands.add_parser(name)
        command.add_argument("--state-dir", required=True, help="Absolute dedicated Node state directory; never the full TLI installation")
        command.set_defaults(handler=handler)
        if name == "init":
            command.add_argument("--name", required=True)
            command.add_argument("--origin", required=True, help="HTTPS private LAN IPv4 origin, e.g. https://192.168.1.20:8444")
            command.add_argument("--lm-studio-url", default="http://127.0.0.1:1234")
        elif name == "card":
            command.add_argument("--out", help="Create a new public JSON file; never overwrite an existing file")
        elif name == "trust":
            command.add_argument("--card", required=True)
            command.add_argument("--identity-fingerprint", required=True, help="Fingerprint compared on the other computer")
            command.add_argument("--certificate-sha256", required=True, help="Certificate fingerprint compared on the other computer")
        elif name == "revoke":
            command.add_argument("--peer-id", required=True)
    return value


def main(argv=None):
    # Windows redirected consoles may use a legacy code page; a diagnostic from
    # the shared certificate helper must not turn successful creation into error.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    args = parser().parse_args(argv)
    try:
        args.handler(args)
        return 0
    except KeyboardInterrupt:
        return 130
    except NodeError as error:
        print("TLI Node: " + str(error), file=sys.stderr)
        return 1
    except Exception:
        # Never print a request, model payload, private key, or saved secret.
        print("TLI Node could not complete this operation. Existing state was preserved. Check the dedicated state, local address, dependencies and original Windows account.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
