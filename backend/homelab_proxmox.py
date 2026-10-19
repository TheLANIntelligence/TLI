"""One explicit Proxmox resource observation; no saved credentials or control API.

Schema/auth references: proxmox/pve-manager PVE/API2/Cluster.pm and
proxmox/pve-docs pveum.adoc. CPU is a fraction; memory/disk are reported bytes.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import ipaddress
import json
import math
import re
import socket
import ssl
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fastapi import HTTPException

PROTOCOL = "tli-homelab-proxmox-v1"
MAX_RESPONSE = 2 * 1024 * 1024
MAX_RESOURCES = 2000
REQUEST_TIMEOUT = 8
IO_TIMEOUT = 3
HTTP_SLOTS = threading.BoundedSemaphore(4)
PATH = "/api2/json/cluster/resources"
NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "fc00::/7", "::1/128"))
RESOURCE_TYPES = {"node", "qemu", "lxc", "storage", "pool", "sdn", "network", "openvz"}
SCOPE = ("One Proxmox-reported observation of resources visible to this API token. "
         "Token visibility may exclude parts of the lab. Reported status is not a service-health "
         "check, backup verification or proof of current guest operation. No changes were requested.")


def _access(check):
    if not callable(check):
        raise HTTPException(403, "Current browser authority is required for this observation.")
    try:
        check()
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(403, "Browser authority is unavailable. Unlock and start a new observation.") from None


def _configuration(payload):
    if not isinstance(payload, dict) or set(payload) != {"origin", "token_id", "token_secret", "certificate_sha256"}:
        raise HTTPException(422, "Supply only the Proxmox origin, API token ID, token secret and optional certificate fingerprint.")
    value = payload["origin"]
    try:
        if (not isinstance(value, str) or len(value) > 256 or
                not re.fullmatch(r"https://(?:\[[0-9a-fA-F:]+\]|[0-9.]+)(?::[0-9]{1,5})?", value, re.I)):
            raise ValueError()
        parsed = urlsplit(value)
        address = ipaddress.ip_address(parsed.hostname)
        if not any(address.version == network.version and address in network for network in NETWORKS):
            raise ValueError()
        port = parsed.port if parsed.port is not None else 8006
        if not 1 <= port <= 65535:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, "Use an HTTPS private LAN or loopback literal IP origin, with its port. Hostnames, paths, credentials, queries and public or link-local addresses are unsupported.") from None
    token_id, secret, fingerprint = (payload[key] for key in ("token_id", "token_secret", "certificate_sha256"))
    if (not isinstance(token_id, str) or len(token_id) > 200 or
            not re.fullmatch(r"[A-Za-z0-9_.+\-]+@[A-Za-z0-9_.\-]+![A-Za-z0-9_.\-]+", token_id)):
        raise HTTPException(422, "Use an API token ID in user@realm!token-name form.")
    if not isinstance(secret, str) or not 1 <= len(secret) <= 512 or any(not 33 <= ord(c) <= 126 for c in secret):
        raise HTTPException(422, "Supply a valid API token secret without whitespace or control characters.")
    if not isinstance(fingerprint, str) or (fingerprint and not (
            re.fullmatch(r"[0-9a-fA-F]{64}", fingerprint) or re.fullmatch(r"(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}", fingerprint))):
        raise HTTPException(422, "Use an independently checked SHA-256 certificate fingerprint, or leave it empty for system certificate verification.")
    host = str(address)
    authority = f"[{host}]" if address.version == 6 else host
    return {"origin": f"https://{authority}:{port}", "host": host, "port": port,
            "family": socket.AF_INET6 if address.version == 6 else socket.AF_INET,
            "token_id": token_id, "token_secret": secret,
            "fingerprint": fingerprint.replace(":", "").lower()}


def _json(raw):
    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise ValueError("Duplicate field")
            result[key] = value
        return result

    def number(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError("Nonfinite number")
        return parsed

    def invalid(_):
        raise ValueError("Invalid number")

    return json.loads(raw, object_pairs_hook=pairs, parse_float=number, parse_constant=invalid)


def _fetch(config, check):
    """Connect to a literal address, authenticate TLS, then send one fixed GET."""
    _access(check)
    if not HTTP_SLOTS.acquire(False):
        _access(check)
        raise HTTPException(429, "Four Proxmox observations are active. Start another explicitly when one finishes.")
    sockets = []
    connection = None
    response = None
    timer = None
    timed_out = threading.Event()
    deadline = time.monotonic() + REQUEST_TIMEOUT

    def checkpoint(sock=None):
        _access(check)
        remaining = deadline - time.monotonic()
        if timed_out.is_set() or remaining <= 0:
            raise TimeoutError()
        if sock is not None:
            sock.settimeout(min(IO_TIMEOUT, remaining))

    def stop():
        timed_out.set()
        for sock in tuple(sockets):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    try:
        checkpoint()
        timer = threading.Timer(REQUEST_TIMEOUT, stop)
        timer.daemon = True
        timer.start()
        # socket.connect on a validated literal IP does not invoke DNS or proxies.
        raw = socket.socket(config["family"], socket.SOCK_STREAM)
        sockets.append(raw)
        checkpoint(raw)
        raw.connect((config["host"], config["port"]))
        checkpoint(raw)
        if ipaddress.ip_address(raw.getpeername()[0]) != ipaddress.ip_address(config["host"]):
            raise ValueError("Unexpected peer")
        if config["fingerprint"]:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        else:
            context = ssl.create_default_context()
        secure = context.wrap_socket(raw, server_hostname=config["host"], do_handshake_on_connect=False)
        sockets.append(secure)
        checkpoint(secure)
        secure.do_handshake()
        checkpoint(secure)
        if config["fingerprint"] and not hmac.compare_digest(
                hashlib.sha256(secure.getpeercert(binary_form=True)).hexdigest(), config["fingerprint"]):
            raise HTTPException(502, "The Proxmox certificate fingerprint did not match. No API token was sent.")
        # HTTPConnection supplies framing only. An absent/closed socket cannot reconnect.
        connection = http.client.HTTPConnection(config["host"], config["port"])
        connection.auto_open = 0
        connection.sock = secure
        checkpoint(secure)
        connection.request("GET", PATH, headers={
            "Authorization": f"PVEAPIToken={config['token_id']}={config['token_secret']}",
            "Accept": "application/json", "Accept-Encoding": "identity", "Connection": "close"})
        checkpoint(secure)
        response = connection.getresponse()
        checkpoint(secure)
        if 300 <= response.status < 400:
            raise HTTPException(502, "Proxmox redirected the request. Redirects and token forwarding are disabled.")
        if response.status in (401, 403):
            raise HTTPException(502, "Proxmox rejected the API token or its permissions. The TLI browser session is separate.")
        if response.status != 200:
            raise HTTPException(502, "Proxmox did not return its resource inventory. No automatic retry ran.")
        if response.getheader("Content-Encoding", "identity").lower() not in ("", "identity"):
            raise ValueError("Encoded response")
        if response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ValueError("Unexpected content type")
        length = response.getheader("Content-Length")
        if length is not None and (not re.fullmatch(r"[0-9]{1,10}", length) or int(length) > MAX_RESPONSE):
            raise ValueError("Response too large")
        if length is not None and response.getheader("Transfer-Encoding") is not None:
            raise ValueError("Ambiguous framing")
        data = bytearray()
        while True:
            checkpoint(secure)
            chunk = response.read1(min(65536, MAX_RESPONSE + 1 - len(data)))
            checkpoint()
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > MAX_RESPONSE:
                raise ValueError("Response too large")
            if response.isclosed():
                break
        if length is not None and len(data) != int(length):
            raise ValueError("Incomplete response")
        result = _json(data)
        checkpoint()
        return result
    except HTTPException:
        _access(check)
        raise
    except (TimeoutError, socket.timeout):
        _access(check)
        raise HTTPException(504, "The Proxmox observation exceeded its request window. No automatic retry ran.") from None
    except (OSError, ValueError, http.client.HTTPException, RecursionError):
        _access(check)
        if timed_out.is_set() or time.monotonic() >= deadline:
            raise HTTPException(504, "The Proxmox observation exceeded its request window. No automatic retry ran.") from None
        raise HTTPException(502, "Proxmox could not be verified or returned an unreadable resource response. Check its address, certificate and access; no retry ran.") from None
    finally:
        if timer:
            timer.cancel()
        try:
            for resource in (response, connection, *sockets):
                if resource is not None:
                    try:
                        resource.close()
                    except OSError:
                        pass
        finally:
            HTTP_SLOTS.release()


def _resources(value, config, check):
    if (not isinstance(value, dict) or "errors" in value or not isinstance(value.get("data"), list)
            or len(value["data"]) > MAX_RESOURCES):
        raise ValueError("Invalid inventory")
    rows, identities = [], set()
    for source in value["data"]:
        _access(check)
        if not isinstance(source, dict):
            raise ValueError("Invalid resource")
        row = {}
        for key in ("id", "type", "name", "node", "status", "storage", "content"):
            text = source.get(key)
            if (isinstance(text, str) and 0 < len(text) <= 256 and
                    not any(ord(char) < 32 or ord(char) == 127 for char in text) and
                    config["token_id"] not in text and config["token_secret"] not in text):
                row[key] = text
        if not row.get("id") or row.get("type") not in RESOURCE_TYPES or row["id"] in identities:
            raise ValueError("Invalid resource identity")
        identities.add(row["id"])
        for key in ("vmid", "mem", "maxmem", "disk", "maxdisk", "uptime"):
            number = source.get(key)
            if type(number) is int and 0 <= number <= 2**53 - 1:
                row[key] = number
        for key in ("cpu", "maxcpu"):
            number = source.get(key)
            if type(number) in (int, float) and 0 <= number <= (1 if key == "cpu" else 2**20) and math.isfinite(number):
                row[key] = number
        shared = source.get("shared")
        if type(shared) is bool or type(shared) is int and shared in (0, 1):
            row["shared"] = bool(shared)
        rows.append(row)
    return rows


def inspect(payload, check):
    """Observe token-visible resources once under the original browser authority."""
    _access(check)
    try:
        config = _configuration(payload)
        value = _fetch(config, check)
        rows = _resources(value, config, check)
        counts = {"nodes": 0, "virtual_machines": 0, "containers": 0, "storage": 0, "other": 0, "total": len(rows)}
        names = {"node": "nodes", "qemu": "virtual_machines", "lxc": "containers", "storage": "storage"}
        for row in rows:
            counts[names.get(row["type"], "other")] += 1
        result = {"ok": True, "protocol": PROTOCOL, "provider": "proxmox", "origin": config["origin"],
                  "checked_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                  "tls_verification": "certificate_pin" if config["fingerprint"] else "system_trust",
                  "resources": rows, "counts": counts, "scope": SCOPE, "actions_performed": False}
    except HTTPException:
        _access(check)
        raise
    except (ValueError, TypeError, RecursionError, OverflowError):
        _access(check)
        raise HTTPException(502, "Proxmox returned an unsupported resource inventory. No result was substituted and no retry ran.") from None
    _access(check)
    return result
