# lan_discovery.py — TLI LAN auto-discovery
#
# Two complementary discovery mechanisms:
#
#   1. UDP broadcast beacon (passive, low-overhead)
#      Broadcasts to 255.255.255.255:47474 every 30 s.
#      Works when Windows Firewall allows UDP 47474 inbound.
#
#   2. TCP subnet scan (active, firewall-proof)
#      Probes every IP on the /24 subnet on port 8000 via TCP connect.
#      This fallback finds peers using the legacy web port. Custom listener
#      ports are announced by UDP beacons. Runs on startup + every 2 minutes.
#
# Both mechanisms write to the same mesh directory and emit SSE presence events.

from __future__ import annotations

import ipaddress
import json
import os
import platform
import socket
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import tli_state as S
from process_utils import hidden_process_kwargs

BEACON_PORT     = 47474   # UDP port all TLI instances share
BEACON_INTERVAL = 30      # seconds between UDP broadcasts
BEACON_VERSION  = "1"
SCAN_INTERVAL   = 120     # seconds between TCP subnet scans
TLI_HTTP_PORT   = 8000    # well-known TLI web port

_stop_event = threading.Event()
_broadcast_thread: Optional[threading.Thread] = None
_listen_thread:    Optional[threading.Thread] = None
_scan_thread:      Optional[threading.Thread] = None

# Injected by mesh_routes so we can push SSE presence events on discovery
_presence_broadcast_fn = None


def set_presence_broadcast(fn) -> None:
    global _presence_broadcast_fn
    _presence_broadcast_fn = fn


def _get_lan_ip() -> str:
    """Best-effort: return the LAN-facing IP of this machine."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _make_beacon() -> bytes:
    cfg = S.load_node_config()
    port = S.server_port()
    payload = {
        "tli":  1,
        "v":    BEACON_VERSION,
        "id":   cfg.node_id,
        "name": cfg.node_name,
        "port": port,
    }
    return json.dumps(payload, separators=(",", ":")).encode()


def _broadcast_loop() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.settimeout(1.0)
    S.log_debug("mesh", "INFO", "LAN discovery: broadcaster started", port=BEACON_PORT)
    while not _stop_event.is_set():
        try:
            data = _make_beacon()
            sock.sendto(data, ("255.255.255.255", BEACON_PORT))
        except Exception as e:
            S.log_debug("mesh", "WARN", "LAN discovery: broadcast error", error=str(e))
        _stop_event.wait(BEACON_INTERVAL)
    sock.close()


def _handle_beacon(data: bytes, sender_ip: str) -> None:
    try:
        if len(data) > 4096:
            return
        payload = json.loads(data.decode())
        if not isinstance(payload, dict) or payload.get("tli") != 1:
            return
        peer_id, peer_name, peer_port = payload.get("id"), payload.get("name", "Unknown TLI Node"), payload.get("port", 8000)
        is_new = _upsert_peer(peer_id, peer_name, sender_ip, peer_port)
        if peer_id == S.load_node_config().node_id:
            return
    except (ValueError, TypeError, AttributeError):
        return
    if is_new:
        S.log_debug("mesh", "INFO", "Unreviewed LAN computer discovered", peer_id=peer_id, name=peer_name, ip=sender_ip, port=peer_port)
    # Discovery is a hint to refresh the local registry, never authenticated
    # online status for a reviewed identity.
    if _presence_broadcast_fn:
        _presence_broadcast_fn({"type": "directory_changed"})


def _push_node_online(peer_id: str, peer_name: str, ip: str, port: int) -> None:
    """Broadcast an SSE node_online event so the frontend chat list updates instantly."""
    if _presence_broadcast_fn:
        try:
            _presence_broadcast_fn({
                "type":     "node_online",
                "node_id":  peer_id,
                "name":     peer_name,
                "ip":       ip,
                "tli_port": port,
                "status":   "online",
            })
        except Exception:
            pass


def _upsert_peer(peer_id: str, peer_name: str, ip: str, port: int, ai_advertisement: dict | None = None) -> bool:
    """Record unsigned discovery separately; never replace reviewed authority."""
    import ipaddress
    if (not isinstance(peer_id, str) or not 1 <= len(peer_id) <= 128
            or not isinstance(peer_name, str) or not 1 <= len(peer_name) <= 128
            or type(port) is not int or not 1 <= port <= 65535):
        raise ValueError("Invalid discovery identity or port")
    ip = str(ipaddress.IPv4Address(ip))
    with S.MESH_DIRECTORY_LOCK:
        if peer_id == S.load_node_config().node_id:
            return False
        directory = S.load_mesh_directory()
        existing = directory.get(peer_id, {})
        is_new = not bool(existing)
        observed = {"name": peer_name, "ip": ip, "port": port, "observed_at": S.now_iso(), "verified": False}
        if ai_advertisement is not None:
            observed.update({"ai_healthy": ai_advertisement.get("ai_healthy") is True,
                             "has_ai": ai_advertisement.get("has_ai") is True})
        existing["discovery"] = observed
        # Preserve every prior trust/status/label and reviewed address, even
        # when a beacon claims the same node ID at another IP or listener.
        if not existing.get("peer_trust"):
            existing.update({"device_id": peer_id, "display_name": existing.get("display_name") or peer_name,
                             "ip": ip, "tli_port": port, "last_seen": S.now_iso()})
            existing.setdefault("status", "pending")
            existing.setdefault("is_host", False)
            existing.setdefault("labels", [])
        directory[peer_id] = existing
        S.save_mesh_directory(directory)
        return is_new


# ── TCP subnet scanner ─────────────────────────────────────────────────────────

def _probe_ip(ip_str: str, my_ip: str, port: int = TLI_HTTP_PORT) -> None:
    """TCP-connect to ip_str:port; if open, verify it's TLI via /agent/ping."""
    if ip_str == my_ip or _stop_event.is_set():
        return
    try:
        # Phase 1: fast TCP connect (0.4 s timeout — barely any latency on LAN)
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(0.4)
        connected = sock.connect_ex((ip_str, port)) == 0
        sock.close()
        if not connected:
            return

        # Phase 2: confirm it's TLI
        import requests as _req
        r = _req.get(f"http://{ip_str}:{port}/agent/ping", timeout=2.0, verify=False)
        if not r.ok:
            return
        data = r.json()
        if not data.get("ok"):
            return

        peer_id   = (data.get("node_id") or "").strip()
        peer_name = (data.get("node_name") or data.get("hostname") or ip_str).strip()
        if not peer_id:
            return

        is_new = _upsert_peer(peer_id, peer_name, ip_str, port, ai_advertisement=data)
        if is_new:
            S.log_debug("mesh", "INFO", "LAN scan: found TLI peer",
                        ip=ip_str, peer_id=peer_id, name=peer_name)
        # Always push SSE so frontend reflects current online status
        _presence_broadcast_fn({"type": "directory_changed"}) if _presence_broadcast_fn else None

    except Exception:
        pass


def _scan_loop() -> None:
    """Scan the local /24 subnet for TLI peers on startup and every SCAN_INTERVAL seconds."""
    # Give the server a moment to finish starting before the first scan
    _stop_event.wait(3)

    while not _stop_event.is_set():
        try:
            my_ip = _get_lan_ip()
            parts = my_ip.split(".")
            if len(parts) == 4:
                subnet = ".".join(parts[:3]) + ".0/24"
                hosts  = [str(h) for h in ipaddress.IPv4Network(subnet, strict=False).hosts()]
                S.log_debug("mesh", "INFO", "LAN scan: probing subnet",
                            subnet=subnet, hosts=len(hosts))
                with ThreadPoolExecutor(max_workers=50) as ex:
                    ex.map(lambda ip: _probe_ip(ip, my_ip), hosts)
                S.log_debug("mesh", "INFO", "LAN scan: complete")
        except Exception as e:
            S.log_debug("mesh", "WARN", "LAN scan error", error=str(e))

        _stop_event.wait(SCAN_INTERVAL)


def _listen_loop() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("0.0.0.0", BEACON_PORT))
    except Exception as e:
        S.log_debug("mesh", "ERROR", "LAN discovery: failed to bind UDP listener", error=str(e))
        return
    sock.settimeout(1.0)
    S.log_debug("mesh", "INFO", "LAN discovery: listener started", port=BEACON_PORT)
    while not _stop_event.is_set():
        try:
            data, (sender_ip, _) = sock.recvfrom(1024)
            _handle_beacon(data, sender_ip)
        except socket.timeout:
            continue
        except Exception as e:
            if not _stop_event.is_set():
                S.log_debug("mesh", "WARN", "LAN discovery: recv error", error=str(e))
    sock.close()


def _try_open_firewall() -> None:
    """Best-effort Windows Firewall rules for TLI ports. Silent on failure."""
    if platform.system() != "Windows":
        return
    rules = [
        ("TLI-Web",       "TCP", str(S.server_port())),
        ("TLI-Discovery", "UDP", str(BEACON_PORT)),
    ]
    for name, proto, port in rules:
        try:
            result = subprocess.run(
                [
                    "netsh", "advfirewall", "firewall", "add", "rule",
                    f"name={name}",
                    "dir=in", "action=allow",
                    f"protocol={proto}",
                    f"localport={port}",
                ],
                capture_output=True, timeout=5, **hidden_process_kwargs(),
            )
            if result.returncode == 0:
                S.log_debug("mesh", "INFO", f"Firewall rule added: {name} {proto}/{port}")
            # If it already exists Windows returns non-zero — that's fine
        except Exception:
            pass  # No admin rights or not Windows — skip silently


def start() -> None:
    """Start LAN discovery: UDP broadcast + TCP subnet scan."""
    global _broadcast_thread, _listen_thread, _scan_thread

    _stop_event.clear()

    # Best-effort firewall rules (works when run as admin; silent otherwise)
    threading.Thread(target=_try_open_firewall, daemon=True, name="tli-fw").start()

    _broadcast_thread = threading.Thread(
        target=_broadcast_loop, daemon=True, name="tli-lan-broadcast"
    )
    _listen_thread = threading.Thread(
        target=_listen_loop, daemon=True, name="tli-lan-listen"
    )
    _scan_thread = threading.Thread(
        target=_scan_loop, daemon=True, name="tli-lan-scan"
    )

    _broadcast_thread.start()
    _listen_thread.start()
    _scan_thread.start()

    my_ip = _get_lan_ip()
    S.log_debug("mesh", "INFO", "LAN discovery started",
                lan_ip=my_ip, beacon_port=BEACON_PORT,
                scan_interval=SCAN_INTERVAL)


def stop() -> None:
    _stop_event.set()
