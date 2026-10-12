# backend/routers/mesh_routes.py
from __future__ import annotations

import asyncio
import json
import platform
import re
import socket
import time
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional
from urllib.parse import urlsplit

import os

import shutil

import requests
import peer_trust
import peer_pairing
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

import tli_state as S
from tli_state import NodeConfig

from routers.system_routes import require_session
from license_gate import gate as _gate

router = APIRouter(tags=["mesh"], route_class=peer_trust.BoundedPeerRoute)

MESH_CHAT_DIR = S.MESH_DATA_DIR / "chat"
MESH_TRANSFERS_DIR = S.MESH_DATA_DIR / "transfers"
MESH_TRANSFERS_DIR.mkdir(parents=True, exist_ok=True)
PRESENCE_TIMEOUT_SEC = 90  # seconds without heartbeat before node is offline


# ============================================
#  Reviewed node-to-node HTTPS transport
# ============================================
#
# No discovery auto-trust, unchecked certificate or HTTP downgrade.

def _node_get(base: str, path: str, **kw):
    return peer_trust.request(peer_trust.by_address(base), "GET", path, params=kw.get("params"))


def _node_post(base: str, path: str, **kw):
    return peer_trust.request(peer_trust.by_address(base), "POST", path, json_body=kw.get("json"))

# ============================================
#  Presence pub/sub (SSE broadcast)
# ============================================
_presence_loop: Optional[asyncio.AbstractEventLoop] = None
_presence_subs: List[asyncio.Queue] = []
_presence_lock = threading.Lock()


def _set_presence_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _presence_loop
    _presence_loop = loop


def _broadcast_presence(event: dict) -> None:
    loop = _presence_loop
    if not loop or not loop.is_running():
        return
    data = json.dumps(event)
    with _presence_lock:
        dead = []
        for q in _presence_subs:
            try:
                loop.call_soon_threadsafe(q.put_nowait, data)
            except Exception:
                dead.append(q)
        for q in dead:
            try:
                _presence_subs.remove(q)
            except ValueError:
                pass
MESH_CHAT_DIR.mkdir(parents=True, exist_ok=True)


# ============================================
#  Pydantic models
# ============================================

class MeshDeviceStatus(str):
    pass

# Use string enum equivalent
from enum import Enum

class MeshDeviceStatusEnum(str, Enum):
    pending = "pending"
    allowed = "allowed"
    blocked = "blocked"

class MeshDeviceEntry(BaseModel):
    device_id: str
    display_name: str
    ip: Optional[str] = None
    tli_port: int = 8000
    status: MeshDeviceStatusEnum = MeshDeviceStatusEnum.pending
    is_host: bool = False
    last_seen: Optional[str] = None
    labels: List[str] = []
    notes: Optional[str] = None
    identity_fingerprint: Optional[str] = None
    trust_state: str = "review_required"
    trust_revision: Optional[str] = None
    origin: Optional[str] = None
    peer_profile: Optional[str] = None
    messaging: Optional[Dict[str, Any]] = None
    discovered_name: Optional[str] = None

class MeshDirectoryResponse(BaseModel):
    mode: str
    this_device_id: str
    host_device_id: Optional[str] = None
    devices: List[MeshDeviceEntry]

class MeshDeviceStatusUpdate(BaseModel):
    status: MeshDeviceStatusEnum

class MeshJoinStartRequest(BaseModel):
    host_address: str

class MeshJoinRequest(BaseModel):
    device_id: str
    display_name: str
    ip: Optional[str] = None
    tli_port: int = 8000
    identity_fingerprint: Optional[str] = None   # Ed25519 public key fingerprint

class MeshDirectoryAction(BaseModel):
    action: Literal["allow", "block", "remove"]

class AgentHeartbeatRequest(BaseModel):
    device_id: str
    status: str = "online"
    tli_port: int = 8000
    agent_version: Optional[str] = None
    capabilities: Optional[Dict[str, Any]] = None

class AgentTaskEnqueueRequest(BaseModel):
    type: str = "ping"
    payload: Optional[Dict[str, Any]] = None

class AgentTaskNextRequest(BaseModel):
    device_id: str

class AgentTaskReportRequest(BaseModel):
    device_id: str
    task_id: str
    success: bool
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

class MeshTaskRunRequest(BaseModel):
    task_id: str
    payload: Optional[Dict[str, Any]] = None

class ChatMessageRequest(BaseModel):
    message_id: Optional[str] = None
    thread_id: str
    from_id: str
    from_name: str
    to_id: str
    to_ip: Optional[str] = None   # remote node IP for forwarding
    body: str
    ts: float                     # epoch ms from sender


# ============================================
#  Helpers
# ============================================

def _refresh_own_host_address(cfg: NodeConfig) -> bool:
    """Update only this host's address; a member's address names a remote host."""
    if cfg.role != "host" or not cfg.host_address:
        return False
    address = cfg.host_address.strip()
    explicit_scheme = "://" in address
    try:
        parsed = urlsplit(address if explicit_scheme else "//" + address)
        hostname = parsed.hostname
        if not hostname or parsed.username is not None or parsed.password is not None:
            return False
        authority = f"[{hostname}]" if ":" in hostname else hostname
        refreshed = parsed._replace(netloc=f"{authority}:{S.server_port()}").geturl()
        if not explicit_scheme:
            refreshed = refreshed.removeprefix("//")
    except ValueError:
        return False
    if refreshed == cfg.host_address:
        return False
    cfg.host_address = refreshed
    cfg.updated_at = S.now_iso()
    return True


@peer_trust.directory_locked
def _ensure_host_in_mesh_directory() -> None:
    try:
        node_cfg = S.load_node_config()
    except Exception:
        return
    if _refresh_own_host_address(node_cfg):
        S.save_node_config(node_cfg)
    devices = S.load_mesh_directory()

    # Names and IP addresses are not identities. Preserve all other records.
    entry = devices.get(node_cfg.node_id, {})
    entry["display_name"] = node_cfg.node_name
    # Auto-detect and persist the host's own IP
    if not entry.get("ip") and node_cfg.role == "host":
        try:
            entry["ip"] = socket.gethostbyname(socket.gethostname())
        except Exception:
            entry["ip"] = None
    else:
        entry.setdefault("ip", None)
    entry.setdefault("status", "allowed" if node_cfg.role == "host" else "pending")
    entry.setdefault("is_host", node_cfg.role == "host")
    entry["tli_port"] = S.server_port()
    entry["last_seen"] = S.now_iso()
    devices[node_cfg.node_id] = entry
    S.save_mesh_directory(devices)


# ============================================
#  Node identity
# ============================================

@router.get("/mesh/node")
def get_node_identity(_session=Depends(require_session)):
    cfg = S.load_node_config()
    _refresh_own_host_address(cfg)
    if cfg.role == "host":
        join_mode = "host"
    elif cfg.role == "member":
        join_mode = "member"
    else:
        join_mode = "standalone"
    now = S.now_iso()
    cfg.updated_at = now
    S.save_node_config(cfg)
    return {
        "node_id": cfg.node_id, "display_name": cfg.node_name, "role": cfg.role,
        "join_mode": join_mode, "host_address": cfg.host_address,
        "created_at": cfg.created_at, "last_seen": cfg.updated_at, "is_host": cfg.role == "host",
    }


@router.get("/mesh/status")
def mesh_health_status(_session=Depends(require_session)):
    """Smoke-test endpoint: returns full presence picture for a single node."""
    cfg = S.load_node_config()
    directory = S.load_mesh_directory()
    now = time.time()
    online_ids = []
    offline_ids = []
    for dev_id, d in directory.items():
        last_seen_str = d.get("last_seen")
        if not last_seen_str:
            offline_ids.append(dev_id)
            continue
        try:
            ls = datetime.fromisoformat(last_seen_str.replace("Z", "+00:00")).timestamp()
            if (now - ls) < PRESENCE_TIMEOUT_SEC:
                online_ids.append(dev_id)
            else:
                offline_ids.append(dev_id)
        except Exception:
            offline_ids.append(dev_id)
    self_in_dir = cfg.node_id in directory
    self_entry  = directory.get(cfg.node_id, {})
    return {
        "node_id":         cfg.node_id,
        "node_name":       cfg.node_name,
        "role":            cfg.role,
        "mesh_status":     cfg.mesh_status,
        "host_address":    cfg.host_address,
        "self_in_directory": self_in_dir,
        "self_last_seen":  self_entry.get("last_seen"),
        "directory_total": len(directory),
        "online_count":    len(online_ids),
        "offline_count":   len(offline_ids),
        "online_nodes":    online_ids,
        "offline_nodes":   offline_ids,
    }


class UpdateNodeIdentityRequest(BaseModel):
    node_name: Optional[str] = None
    role: Optional[str] = None


@router.post("/mesh/node/identity")
def update_node_identity(body: UpdateNodeIdentityRequest, _session=Depends(require_session)):
    cfg = S.load_node_config()
    if body.node_name is not None:
        name = body.node_name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="node_name cannot be empty")
        cfg.node_name = name[:64]
    if body.role is not None:
        role = body.role.strip().lower()
        if role not in ("standalone", "host", "member"):
            raise HTTPException(status_code=400, detail="Invalid role; must be standalone, host, or member")
        cfg.role = role
    cfg.updated_at = S.now_iso()
    S.save_node_config(cfg)
    return {"ok": True, "node_id": cfg.node_id, "node_name": cfg.node_name, "role": cfg.role}


@router.post("/mesh/node/become_host")
@peer_trust.directory_locked
def become_host(_session=Depends(require_session), _l=Depends(_gate("peer_nodes"))):
    cfg = S.load_node_config()
    cfg.role = "host"
    cfg.mesh_status = "approved"
    hostname = socket.gethostname()
    host_ip = socket.gethostbyname(hostname)
    host_address = f"{host_ip}:{S.server_port()}"
    cfg.host_address = host_address
    cfg.updated_at = S.now_iso()
    S.save_node_config(cfg)
    directory = S.load_mesh_directory()
    if cfg.node_id not in directory:
        directory[cfg.node_id] = {
            "display_name": cfg.node_name, "ip": host_ip, "status": "allowed",
            "is_host": True, "tli_port": S.server_port(),
            "last_seen": cfg.updated_at, "labels": ["Host"], "notes": "",
        }
    else:
        directory[cfg.node_id]["tli_port"] = S.server_port()
    S.save_mesh_directory(directory)
    return {"ok": True, "message": "This node is now the Host.", "host_address": cfg.host_address}


# ============================================
#  Agent heartbeat + task endpoints
# ============================================

@router.post("/mesh/agent_heartbeat")
@peer_trust.directory_locked
def mesh_agent_heartbeat(body: AgentHeartbeatRequest, access=Depends(peer_trust.coordinate_access)):
    _peer_body(access, body.device_id)
    cfg = S.load_node_config()
    if cfg.role != "host":
        raise HTTPException(status_code=403, detail="This node is not a Mesh host.")
    directory = S.load_mesh_directory()
    if body.tli_port != directory[body.device_id].get("tli_port"):
        raise HTTPException(409, "Peer listener changed; review its new card.")
    now = S.now_iso()
    state = S.load_agent_state()
    entry = state.get(body.device_id, {})
    entry.update({
        "device_id": body.device_id, "last_status": body.status,
        "last_heartbeat": now, "agent_version": body.agent_version or "0.1.0",
        "capabilities": body.capabilities or {},
    })
    state[body.device_id] = entry
    S.save_agent_state(state)
    directory = S.load_mesh_directory()
    if body.device_id in directory:
        directory[body.device_id]["last_seen"] = now
        S.save_mesh_directory(directory)
    S.log_debug("mesh", "INFO", "Agent heartbeat received", device_id=body.device_id, status=body.status)
    # Broadcast live presence update
    dir_entry = directory.get(body.device_id, {})
    _broadcast_presence({
        "type": "node_online",
        "node_id": body.device_id,
        "name": dir_entry.get("display_name", body.device_id),
        "ip": dir_entry.get("ip"),
        "tli_port": body.tli_port,
        "status": body.status,
    })
    return {"ok": True}


@router.post("/agent/tasks/{device_id}/enqueue")
@peer_trust.directory_locked
def agent_enqueue_task(device_id: str, body: AgentTaskEnqueueRequest, _session=Depends(require_session), _l=Depends(_gate("peer_nodes"))):
    cfg = S.load_node_config()
    if cfg.role != "host":
        raise HTTPException(status_code=403, detail="This node is not a Mesh host.")
    directory = S.load_mesh_directory()
    if device_id not in directory:
        raise HTTPException(status_code=404, detail="Unknown device_id for tasks.")
    peer_trust.trusted(device_id, "coordinate")
    if body.type != "ping" or body.payload:
        raise HTTPException(409, {"code": "capability_required", "message": "This peer queue supports an explicit read-only ping only."})
    task = S.enqueue_agent_task(device_id, body.type, {})
    return {"ok": True, "task": task}


@router.post("/agent/tasks/next")
@peer_trust.directory_locked
def agent_get_next_task(body: AgentTaskNextRequest, access=Depends(peer_trust.coordinate_access)):
    _peer_body(access, body.device_id)
    cfg = S.load_node_config()
    if cfg.role != "host":
        raise HTTPException(status_code=403, detail="This node is not a Mesh host.")
    directory = S.load_mesh_directory()
    if body.device_id not in directory:
        raise HTTPException(status_code=404, detail="Unknown device_id for tasks.")
    task = S.get_next_agent_task_for(body.device_id)
    return {"ok": True, "task": task}


@router.post("/agent/tasks/report")
@peer_trust.directory_locked
def agent_report_task(body: AgentTaskReportRequest, access=Depends(peer_trust.coordinate_access)):
    _peer_body(access, body.device_id)
    cfg = S.load_node_config()
    if cfg.role != "host":
        raise HTTPException(status_code=403, detail="This node is not a Mesh host.")
    updated = S.update_agent_task_result(body.device_id, body.task_id, body.success, body.result, body.error)
    S.log_debug("mesh", "INFO", "Agent task report", device_id=body.device_id, task_id=body.task_id, success=body.success)
    if not updated:
        raise HTTPException(status_code=404, detail="Task not found for device.")
    return {"ok": True}


# ============================================
#  Mesh directory CRUD
# ============================================

def _discovered_peer_name(entry):
    discovery = entry.get("discovery")
    name = discovery.get("name") if isinstance(discovery, dict) else None
    return name if isinstance(name, str) and 1 <= len(name.strip()) <= 128 else None


def _peer_display_name(device_id, entry):
    # Older installations saved the first pre-setup hostname indefinitely.
    # Project the latest hint for pending discoveries even before a new beacon.
    # Reviewed/blocked labels stay bound to their saved identity and review.
    if entry.get("status", "pending") == "pending" and not entry.get("peer_trust"):
        return _discovered_peer_name(entry) or entry.get("display_name") or device_id
    return entry.get("display_name") or device_id


@router.get("/mesh/directory", response_model=MeshDirectoryResponse)
def get_mesh_directory(_session=Depends(require_session)):
    node_cfg = S.load_node_config()
    _ensure_host_in_mesh_directory()
    raw = S.load_mesh_directory()
    devices = []
    for dev_id, d in raw.items():
        # Never include this node itself in the peer list — it's identified by this_device_id
        if dev_id == node_cfg.node_id:
            continue
        try:
            status_enum = MeshDeviceStatusEnum(d.get("status", "pending"))
        except Exception:
            status_enum = MeshDeviceStatusEnum.pending
        devices.append(MeshDeviceEntry(
            device_id=dev_id, display_name=_peer_display_name(dev_id, d), ip=d.get("ip"),
            tli_port=int(d.get("tli_port", 8000)),
            status=status_enum, is_host=bool(d.get("is_host", False)), last_seen=d.get("last_seen"),
            labels=d.get("labels") or [], notes=d.get("notes"),
            messaging=peer_trust.message_readiness(dev_id), discovered_name=_discovered_peer_name(d),
            **peer_trust.public_trust(dev_id),
        ))
    host_device_id = node_cfg.node_id if node_cfg.role == "host" else None
    return MeshDirectoryResponse(mode=node_cfg.role, this_device_id=node_cfg.node_id, host_device_id=host_device_id, devices=devices)


@router.get("/api/mesh/health")
def mesh_health(_session=Depends(require_session)):
    """
    Collective dashboard endpoint.
    Returns live health stats for this node + all known mesh peers.
    Each peer is fetched via GET /agent/health (single round-trip).
    Peers that don't respond in 2s are marked offline.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # ── Self ───────────────────────────────────────────────────
    self_health: dict = {"is_self": True, "online": True}
    try:
        from routers.system_routes import agent_health as _ah
        self_health.update(_ah())
    except Exception as e:
        self_health["error"] = str(e)

    nodes = [self_health]

    # ── Peers ──────────────────────────────────────────────────
    raw_dir = S.load_mesh_directory()
    seen_ids: set[str] = set()

    # Friendly names and addresses are not identities. Two TLI installations
    # may share either; keep distinct registry identities visible to the user.
    peer_list: list[dict] = []
    for dev_id, d in raw_dir.items():
        try:
            self_cfg = S.load_node_config()
            if dev_id == self_cfg.node_id:
                continue
        except Exception:
            pass
        ip = d.get("ip", "")
        ident = str(d.get("node_id") or d.get("device_id") or dev_id)
        if not ip or ident in seen_ids:
            continue
        seen_ids.add(ident)
        peer_list.append({"peer_id": dev_id, "ip": ip, "port": int(d.get("tli_port", 8000)),
                          "display_name": _peer_display_name(dev_id, d),
                          "pairing_available": d.get("status", "pending") == "pending" and not d.get("peer_trust")})

    def _friendly_error(exc: Exception) -> str:
        msg = str(exc)
        if "timed out" in msg or "ConnectTimeout" in msg or "connect timeout" in msg:
            return "Connection timed out"
        if "Max retries exceeded" in msg or "ConnectionError" in msg:
            return "Not reachable"
        if "Connection refused" in msg:
            return "Connection refused"
        if "Name or service not known" in msg or "getaddrinfo" in msg:
            return "Host not found"
        return "Not reachable"

    def _fetch_peer(p: dict) -> dict:
        base = {"is_self": False, "peer_id": p["peer_id"],
                "node_name": p["display_name"], "ip": p["ip"], "port": p["port"],
                "pairing_available": p["pairing_available"]}
        trust = peer_trust.public_trust(p["peer_id"])
        if trust.get("peer_profile") == "inference_node":
            return {**base, **trust, "online": None, "connection_state": "inference_only",
                    "error": None, "reason": "This Node shares AI compute only. Check its models in Ask TLI when needed."}
        try:
            peer_trust.trusted(p["peer_id"], "coordinate")
        except HTTPException as exc:
            base.update({"online": None, "connection_state": "review_required", "trust_state": "review_required",
                         "reason": exc.detail, "error": None})
            return base
        try:
            data = peer_trust.health(p["peer_id"])
            data.update({"is_self": False, "online": True, "peer_id": p["peer_id"]})
            return data
        except Exception as e:
            base.update({"online": False, "error": _friendly_error(e)})
        return base

    if peer_list:
        with ThreadPoolExecutor(max_workers=min(len(peer_list), 20)) as ex:
            futures = {ex.submit(_fetch_peer, p): p for p in peer_list}
            for fut in as_completed(futures):
                try:
                    nodes.append(fut.result())
                except Exception:
                    pass

    return {"nodes": nodes, "ts": S.now_iso()}


@router.get("/api/lan/peers")
def get_lan_peers(_session=Depends(require_session)):
    """Return distinct recorded LAN identities and reported presence.

    Discovery lists computers without granting permission. Messaging readiness
    describes the local review only; the recipient must also review the sender.
    """
    try:
        node_cfg = S.load_node_config()
    except Exception:
        return {"peers": [], "self_id": "unknown"}

    raw = S.load_mesh_directory()
    now = time.time()

    peers = []

    for dev_id, d in raw.items():
        if dev_id == node_cfg.node_id:
            continue  # skip self
        ip = d.get("ip") or ""
        if not ip:
            continue  # skip ghost entries with no IP

        last_seen_str = d.get("last_seen")
        online = False
        if last_seen_str:
            try:
                ls = datetime.fromisoformat(last_seen_str.replace("Z", "+00:00")).timestamp()
                online = (now - ls) < PRESENCE_TIMEOUT_SEC
            except Exception:
                pass

        peers.append({
            "id":        dev_id,
            "name":      _peer_display_name(dev_id, d),
            "discovered_name": _discovered_peer_name(d),
            "ip":        ip,
            "port":      int(d.get("tli_port", 8000)),
            "last_seen": last_seen_str,
            "online":    online,
            "status":    d.get("status", "pending"),
            "messaging": peer_trust.message_readiness(dev_id),
            **peer_trust.public_trust(dev_id),
        })

    # Sort: online first, then by name
    peers.sort(key=lambda p: (0 if p["online"] else 1, p["name"].lower()))

    return {"peers": peers, "self_id": node_cfg.node_id}


@router.post("/mesh/devices/{device_id}/status", response_model=MeshDeviceEntry)
@peer_trust.directory_locked
def update_mesh_device_status(device_id: str, body: MeshDeviceStatusUpdate, _session=Depends(require_session)):
    node_cfg = S.load_node_config()
    if node_cfg.role != "host":
        raise HTTPException(status_code=403, detail="Only the Host node may change mesh device status.")
    if body.status == MeshDeviceStatusEnum.allowed:
        raise HTTPException(409, {"code": "review_required", "message": "Import and review this computer’s signed card to allow it."})
    directory = S.load_mesh_directory()
    if device_id not in directory:
        raise HTTPException(404, "Computer not found")
    entry = directory[device_id]
    is_host = bool(entry.get("is_host", False))
    entry.setdefault("display_name", device_id)
    entry.setdefault("ip", None)
    entry["status"] = body.status.value
    entry["is_host"] = is_host
    entry["last_seen"] = S.now_iso()
    entry.setdefault("labels", [])
    entry.setdefault("notes", "")
    directory[device_id] = entry
    S.save_mesh_directory(directory)
    return MeshDeviceEntry(
        device_id=device_id, display_name=entry["display_name"], ip=entry.get("ip"),
        status=body.status, is_host=is_host, last_seen=entry.get("last_seen"),
        labels=entry.get("labels") or [], notes=entry.get("notes"),
    )


@router.post("/mesh/join", response_model=MeshDeviceEntry)
@peer_trust.directory_locked
def host_receive_join(req: MeshJoinRequest, request: Request, access=Depends(peer_trust.coordinate_access), _l=Depends(_gate("peer_nodes"))):
    if S.load_node_config().role != "host":
        raise HTTPException(403, "Only a Host node may receive mesh join requests.")
    _peer_body(access, req.device_id)
    entry, card, _ = peer_trust.trusted(req.device_id, "coordinate")
    if req.tli_port != urlsplit(card["origin"]).port or (req.identity_fingerprint and req.identity_fingerprint != card["identity_fingerprint"]):
        raise HTTPException(409, "The joining computer's address or identity changed. Review its card again.")
    # The reviewed record is authoritative; unsigned names/IPs never migrate approval.
    return MeshDeviceEntry(device_id=req.device_id, display_name=card["name"], ip=entry["ip"], tli_port=entry["tli_port"],
                           status=MeshDeviceStatusEnum.allowed, labels=entry.get("labels") or [], notes=entry.get("notes"),
                           **peer_trust.public_trust(req.device_id))


@router.delete("/mesh/devices/{device_id}")
@peer_trust.directory_locked
def delete_mesh_device(device_id: str, _session=Depends(require_session)):
    node_cfg = S.load_node_config()
    if node_cfg.role != "host":
        raise HTTPException(status_code=403, detail="Only the Host node may remove mesh devices.")
    directory = S.load_mesh_directory()
    existed = device_id in directory
    if existed:
        directory.pop(device_id, None)
        S.save_mesh_directory(directory)
    return {"ok": True, "removed": existed}


@router.post("/mesh/directory/{device_id}/action")
@peer_trust.directory_locked
def mesh_directory_action(device_id: str, body: MeshDirectoryAction, _session=Depends(require_session)):
    node_cfg = S.load_node_config()
    if node_cfg.role != "host":
        raise HTTPException(status_code=403, detail="Only the Host node may manage the Home Mesh directory.")
    directory = S.load_mesh_directory()
    if body.action == "remove":
        if device_id == node_cfg.node_id:
            raise HTTPException(status_code=400, detail="The Host node cannot remove itself from the mesh directory.")
        existed = device_id in directory
        if existed:
            directory.pop(device_id, None)
            S.save_mesh_directory(directory)
        return {"ok": True, "action": body.action, "removed": existed}
    if body.action == "allow":
        raise HTTPException(409, {"code": "review_required", "message": "Import and review this computer’s signed card to allow it."})
    elif body.action == "block":
        new_status = MeshDeviceStatusEnum.blocked
    else:
        raise HTTPException(status_code=400, detail="Unsupported action")
    entry = directory.get(device_id, {})
    is_host = bool(entry.get("is_host", False))
    entry.setdefault("display_name", device_id)
    entry.setdefault("ip", None)
    entry["status"] = new_status.value
    entry["is_host"] = is_host
    entry["last_seen"] = S.now_iso()
    entry.setdefault("labels", [])
    entry.setdefault("notes", "")
    directory[device_id] = entry
    S.save_mesh_directory(directory)
    return {"ok": True, "action": body.action, "device": {
        "device_id": device_id, "display_name": entry["display_name"], "ip": entry.get("ip"),
        "status": new_status.value, "is_host": is_host, "last_seen": entry["last_seen"],
        "labels": entry.get("labels", []), "notes": entry.get("notes", ""),
    }}


@router.post("/mesh/kill_all")
@peer_trust.directory_locked
def mesh_kill_all(_session=Depends(require_session)):
    node_cfg = S.load_node_config()
    if node_cfg.role != "host":
        raise HTTPException(status_code=403, detail="Only the Host node may activate the kill switch.")
    directory = S.load_mesh_directory()
    new_directory = {dev_id: entry for dev_id, entry in directory.items() if dev_id == node_cfg.node_id}
    removed_count = len(directory) - len(new_directory)
    S.save_mesh_directory(new_directory)
    S.log_debug("mesh", "WARN", "Kill Switch activated — all nodes disconnected", removed_count=removed_count)
    return {"ok": True, "message": f"Kill switch activated — disconnected {removed_count} node(s).", "disconnected": removed_count}


@router.get("/mesh/devices/{device_id}", response_model=MeshDeviceEntry)
def get_mesh_device(device_id: str, _session=Depends(require_session)):
    directory = S.load_mesh_directory()
    entry = directory.get(device_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Device not found in mesh directory.")
    try:
        status_enum = MeshDeviceStatusEnum(entry.get("status", "pending"))
    except Exception:
        status_enum = MeshDeviceStatusEnum.pending
    return MeshDeviceEntry(
        device_id=device_id, display_name=entry.get("display_name", device_id), ip=entry.get("ip"),
        tli_port=int(entry.get("tli_port", 8000)),
        status=status_enum, is_host=bool(entry.get("is_host", False)), last_seen=entry.get("last_seen"),
        labels=entry.get("labels") or [], notes=entry.get("notes"),
    )


# ============================================
#  Mesh proxy endpoints (host → remote node)
# ============================================

def _resolve_mesh_target(device_id: str) -> tuple[str, int]:
    """Shared helper: look up a device and return (ip, tli_port)."""
    node_cfg = S.load_node_config()
    _, card, _ = peer_trust.trusted(device_id, "coordinate")
    parsed = urlsplit(card["origin"])
    return parsed.hostname, parsed.port



@router.post("/mesh/directory/{device_id}/ping")
def mesh_ping_device(device_id: str, _session=Depends(require_session), _l=Depends(_gate("peer_nodes"))):
    return {"ok": True, "device_id": device_id, "ping": peer_trust.health(device_id)}


@router.post("/mesh/directory/{device_id}/info")
def mesh_node_info(device_id: str, _session=Depends(require_session), _l=Depends(_gate("peer_nodes"))):
    return {"ok": True, "device_id": device_id, "info": peer_trust.health(device_id)}


@router.post("/mesh/directory/{device_id}/diagnostics")
def mesh_node_diagnostics(device_id: str, _session=Depends(require_session), _l=Depends(_gate("peer_nodes"))):
    cap = peer_trust.capability(device_id)
    return {"ok": True, "device_id": device_id, "diagnostics": peer_trust.observe(device_id, cap["revision"])}


_MESH_PROXY_ALLOWED_PATHS: frozenset = frozenset({
    "/agent/disk",
    "/agent/cpu",
    "/agent/ram",
    "/agent/uptime",
    "/agent/system_summary",
    "/agent/maintenance/refresh",
    "/agent/maintenance/clean_temp",
    "/agent/logs/recent",
    "/agent/tasks/run",
})


def _proxy_post(device_id: str, path: str, json_body=None):
    if path not in _MESH_PROXY_ALLOWED_PATHS:
        raise HTTPException(status_code=403, detail=f"Proxy path not permitted: {path}")
    ip, tli_port = _resolve_mesh_target(device_id)
    try:
        resp = _node_post(f"{ip}:{tli_port}", path, json=json_body, timeout=(S.HTTP_CONNECT_TIMEOUT, S.HTTP_READ_TIMEOUT))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to contact node Agent: {e!r}")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail="Node Agent request failed.")
    try:
        return resp.json()
    except Exception:
        return {"raw": resp.text}


def _proxy_get(device_id: str, path: str, params=None):
    if path not in _MESH_PROXY_ALLOWED_PATHS:
        raise HTTPException(status_code=403, detail=f"Proxy path not permitted: {path}")
    ip, tli_port = _resolve_mesh_target(device_id)
    try:
        resp = _node_get(f"{ip}:{tli_port}", path, params=params, timeout=(S.HTTP_CONNECT_TIMEOUT, S.HTTP_READ_TIMEOUT))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to contact node Agent: {e!r}")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail="Node Agent request failed.")
    try:
        return resp.json()
    except Exception:
        return {"raw": resp.text}


@router.post("/mesh/directory/{device_id}/maintenance/refresh")
def mesh_node_maintenance_refresh(device_id: str, _session=Depends(require_session)):
    cap = peer_trust.capability(device_id)
    data = peer_trust.observe(device_id, cap["revision"])
    return {"ok": True, "device_id": device_id, "action": "maintenance_refresh", "data": data}


@router.post("/mesh/directory/{device_id}/maintenance/clean_temp")
def mesh_node_maintenance_clean_temp(device_id: str, _session=Depends(require_session)):
    raise HTTPException(409, {"code": "review_required", "message": "Open Free Space on the selected computer and review its file selection there. No cleanup ran."})


@router.get("/mesh/directory/{device_id}/logs/recent")
def mesh_node_logs_recent(device_id: str, limit: int = Query(default=100, ge=1, le=1000), _session=Depends(require_session)):
    raise HTTPException(409, {"code": "review_required", "message": "Open this computer’s authenticated console to review its logs. Peer observation does not grant log access."})


@router.post("/mesh/directory/{device_id}/tasks/run")
def mesh_node_tasks_run(device_id: str, body: MeshTaskRunRequest, _session=Depends(require_session)):
    if body.task_id != "refresh_status":
        raise HTTPException(409, {"code": "capability_required", "message": "This peer grant permits read-only refresh only. Review other actions on that computer."})
    if not body.task_id:
        raise HTTPException(status_code=400, detail="task_id is required.")
    cap = peer_trust.capability(device_id)
    data = peer_trust.observe(device_id, cap["revision"])
    return {"ok": True, "device_id": device_id, "task_id": body.task_id, "data": data}


# ============================================
#  SSE Presence stream
# ============================================

@router.get("/mesh/presence/stream")
async def mesh_presence_stream(request: Request, _session=Depends(require_session)):
    """SSE stream — pushes node_online / node_offline events in real-time."""
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    with _presence_lock:
        _presence_subs.append(q)

    async def generate():
        try:
            # Send a snapshot of currently-online nodes immediately on connect.
            # Each saved node ID is independent, including shared IPs.
            try:
                _self_id = S.load_node_config().node_id
            except Exception:
                _self_id = None
            raw = S.load_mesh_directory()
            now_epoch = time.time()
            for dev_id, d in raw.items():
                if dev_id == _self_id:
                    continue  # skip self
                ip = d.get("ip") or ""
                if not ip:
                    continue
                last_seen_str = d.get("last_seen")
                is_online = False
                if last_seen_str:
                    try:
                        ls = datetime.fromisoformat(last_seen_str.replace("Z", "+00:00")).timestamp()
                        is_online = (now_epoch - ls) < PRESENCE_TIMEOUT_SEC
                    except Exception:
                        is_online = False
                if is_online:
                    payload = json.dumps({
                        "type": "node_online",
                        "node_id": dev_id,
                        "name": d.get("display_name", dev_id),
                        "ip": ip,
                        "tli_port": int(d.get("tli_port", 8000)),
                        "status": d.get("status", "pending"),
                    })
                    yield f"data: {payload}\n\n"

            # Stream live events
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=20.0)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            with _presence_lock:
                try:
                    _presence_subs.remove(q)
                except ValueError:
                    pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ============================================
#  Join flow (member side)
# ============================================

@router.post("/mesh/join_request")
def start_join_request(body: MeshJoinStartRequest, _session=Depends(require_session), _l=Depends(_gate("peer_nodes"))):
    cfg = S.load_node_config()
    try:
        ip = socket.gethostbyname(socket.gethostname())
    except Exception:
        ip = None
    tli_port = S.server_port()
    payload = {"device_id": cfg.node_id, "display_name": cfg.node_name, "ip": ip, "tli_port": tli_port}
    host_address = body.host_address.strip()
    if not host_address:
        raise HTTPException(status_code=400, detail="Host address cannot be empty.")
    try:
        r = _node_post(host_address, "/mesh/join", json=payload, timeout=(S.HTTP_CONNECT_TIMEOUT, S.HTTP_READ_TIMEOUT))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not contact host at {host_address}: {e}")
    if r.status_code != 200:
        raise HTTPException(status_code=r.status_code, detail=f"Host join endpoint error: {r.text}")
    cfg.role = "member"
    cfg.mesh_status = "pending"
    cfg.host_address = host_address
    cfg.updated_at = S.now_iso()
    S.save_node_config(cfg)
    S.log_debug("mesh", "INFO", "Join request sent to host", host_address=host_address, device_id=cfg.node_id)
    return {"ok": True, "message": "Join request sent to host.", "host_address": host_address,
            "mesh_status": cfg.mesh_status, "role": cfg.role}


@router.get("/mesh/join_status")
def get_join_status(_session=Depends(require_session)):
    cfg = S.load_node_config()
    if not cfg.host_address:
        return {"mesh_status": "not_joined", "role": cfg.role, "host_address": None}
    host_base = cfg.host_address.strip()
    try:
        r = _node_get(host_base, "/mesh/peer/self-status", timeout=(S.HTTP_CONNECT_TIMEOUT, S.HTTP_READ_TIMEOUT))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not contact host: {e}")
    if r.status_code == 404:
        cfg.mesh_status = "removed"
        cfg.role = "standalone"
        cfg.host_address = None
        cfg.host_device_id = None
        cfg.host_name = None
        cfg.updated_at = S.now_iso()
        S.save_node_config(cfg)
        return {"mesh_status": cfg.mesh_status, "role": cfg.role, "host_address": cfg.host_address}
    if r.status_code != 200:
        raise HTTPException(status_code=r.status_code, detail=f"Host status endpoint error: {r.text}")
    data = r.json()
    status_str = (data.get("status") or "pending").lower()
    if status_str == "allowed":
        cfg.mesh_status = "approved"
    elif status_str == "blocked":
        cfg.mesh_status = "blocked"
    else:
        cfg.mesh_status = "pending"
    cfg.updated_at = S.now_iso()
    S.save_node_config(cfg)
    return {"mesh_status": cfg.mesh_status, "role": cfg.role, "host_address": cfg.host_address, "host_view": data}


# ============================================
#  Background loops (started by main.py)
# ============================================

def _hb_sleep():
    try:
        return int(S.get_active_system_limits().get("heartbeat_interval_sec", 30))
    except Exception:
        return 30


def _task_sleep():
    try:
        return int(S.get_active_system_limits().get("scan_interval_sec", 10))
    except Exception:
        return 10


def agent_heartbeat_loop():
    while True:
        try:
            cfg = S.load_node_config()
        except Exception:
            time.sleep(_hb_sleep())
            continue
        if cfg.mesh_status != "approved" or not cfg.host_address:
            time.sleep(_hb_sleep())
            continue
        payload = {
            "device_id": cfg.node_id, "status": "online", "agent_version": "0.1.0",
            "tli_port": S.server_port(),
            "capabilities": {"system_observation_v1": True, "coordination_v1": True},
        }
        try:
            resp = _node_post(cfg.host_address, "/mesh/agent_heartbeat", json=payload, timeout=(S.HTTP_CONNECT_TIMEOUT, S.HTTP_READ_TIMEOUT))
            if resp.status_code != 200:
                S.log_debug("mesh", "ERROR", "Heartbeat non-200", status_code=resp.status_code)
        except Exception as e:
            S.log_debug("mesh", "ERROR", "Heartbeat error", error=str(e))
        time.sleep(_hb_sleep())


def agent_task_worker_loop():
    while True:
        try:
            cfg = S.load_node_config()
        except Exception:
            time.sleep(10)
            continue
        if cfg.mesh_status != "approved" or not cfg.host_address:
            time.sleep(10)
            continue
        try:
            resp = _node_post(cfg.host_address, "/agent/tasks/next", json={"device_id": cfg.node_id},
                                  timeout=(S.HTTP_CONNECT_TIMEOUT, S.HTTP_READ_TIMEOUT))
            if resp.status_code != 200:
                time.sleep(5)
                continue
            task = resp.json().get("task")
        except Exception:
            time.sleep(10)
            continue
        if not task:
            time.sleep(5)
            continue
        task_id = task.get("task_id")
        task_type = task.get("type")
        success = False
        result = {}
        error = None
        try:
            if task_type == "ping":
                result = {
                    "message": "pong", "node_id": cfg.node_id, "node_name": cfg.node_name,
                    "hostname": socket.gethostname(), "os": platform.system(), "ts": S.now_iso(),
                }
                success = True
            else:
                error = f"Unsupported task type: {task_type}"
        except Exception as e:
            error = f"Task execution error: {e!r}"
        try:
            _node_post(cfg.host_address, "/agent/tasks/report", json={
                "device_id": cfg.node_id, "task_id": task_id, "success": success,
                "result": result if success else None, "error": error,
            }, timeout=(S.HTTP_CONNECT_TIMEOUT, S.HTTP_READ_TIMEOUT))
        except Exception:
            pass
        time.sleep(2)


# ============================================
#  LAN Chat
# ============================================

def _safe_thread_path(thread_id: str):
    safe = re.sub(r"[^\w\-]", "_", thread_id)[:80]
    return MESH_CHAT_DIR / f"{safe}.jsonl"


def _append_chat_msg(thread_id: str, msg: dict) -> None:
    path = _safe_thread_path(thread_id)
    encrypted = S.encrypt_jsonl_line(msg)
    with open(path, "a", encoding="utf-8") as f:
        f.write(encrypted + "\n")
        f.flush()
        os.fsync(f.fileno())


def _forward_to_remote(to_ip: str, msg: dict):
    peer_trust.validate_message(msg)
    entry, card, _ = peer_trust.trusted(msg["to_id"], "messages")
    if to_ip and to_ip != entry["ip"]:
        raise HTTPException(409, "The selected message recipient changed.")
    response = peer_trust.request(msg["to_id"], "POST", "/mesh/chat/receive", json_body=msg, grant="messages")
    try:
        ack = response.json()
        if (response.status_code != 200 or not isinstance(ack, dict) or ack.get("ok") is not True
                or any(ack.get(key) != msg[key] for key in ("message_id", "thread_id", "from_id", "to_id"))
                or type(ack.get("duplicate")) is not bool):
            raise ValueError("Unmatched acknowledgment")
    except Exception:
        raise HTTPException(502, {"code": "message_acknowledgment_uncertain", "delivery": "uncertain",
                            "message": "The recipient did not supply a matching acknowledgment. It may already have received this message; inspect the thread or deliberately retry the same message. No automatic retry was sent."})
    return ack


@router.post("/mesh/chat/send")
def mesh_chat_send(body: ChatMessageRequest, bg: BackgroundTasks, _session=Depends(require_session)):
    cfg = S.load_node_config()
    if not body.message_id:
        raise HTTPException(409, {"code": "message_review_required", "message": "Refresh LAN Messages to prepare a stable delivery identifier. No message was sent."})
    if not body.body.strip() or len(body.body.encode("utf-8")) > 32768:
        raise HTTPException(422, "Supply a text message up to 32 KiB.")
    if body.from_id != cfg.node_id:
        raise HTTPException(409, "Message sender must be this computer.")
    _safe_thread_path(body.thread_id)
    peer_trust.trusted(body.to_id, "messages")
    msg = {"thread_id": body.thread_id, "from_id": cfg.node_id, "from_name": cfg.node_name,
           "to_id": body.to_id, "body": body.body, "ts": body.ts, "message_id": body.message_id, "server_ts": time.time() * 1000}
    peer_trust.validate_message(msg)
    _forward_to_remote(body.to_ip or "", msg)
    duplicate = peer_trust.record_message_once(msg, "sent", lambda: _append_chat_msg(body.thread_id, msg))
    return {"ok": True, "delivery": "acknowledged", "duplicate": duplicate, "automatic_retry": False}


@router.post("/mesh/chat/receive")
@peer_trust.directory_locked
def mesh_chat_receive(body: ChatMessageRequest, request: Request, access=Depends(peer_trust.message_access)):
    _peer_body(access, body.from_id)
    _, card, _ = peer_trust.trusted(body.from_id, "messages")
    if body.to_id != S.load_node_config().node_id or body.from_name != card["name"]:
        raise HTTPException(409, "Message identities do not match the reviewed computers.")
    if not body.body.strip() or len(body.body.encode("utf-8")) > 32768:
        raise HTTPException(422, "Supply a text message up to 32 KiB.")
    if body.body.startswith(("__TLI_FILE__", "__FILE_OFFER__:")):
        raise HTTPException(409, {"code": "capability_required", "message": "Peer file transfer requires a separate reviewed capability."})
    peer_trust.revalidate(access)
    msg = {"thread_id": body.thread_id, "from_id": body.from_id, "from_name": card["name"], "to_id": body.to_id,
           "body": body.body, "ts": body.ts, "message_id": body.message_id, "server_ts": time.time() * 1000}
    peer_trust.validate_message(msg)
    duplicate = peer_trust.record_message_once(msg, "received", lambda: _append_chat_msg(body.thread_id, msg))
    _broadcast_presence({"type": "message_incoming", "from_id": body.from_id, "from_name": card["name"],
                         "thread_id": body.thread_id, "ts": body.ts})
    return {"ok": True, "message_id": body.message_id, "thread_id": body.thread_id,
            "from_id": body.from_id, "to_id": body.to_id, "duplicate": duplicate}


@router.get("/mesh/chat/messages", dependencies=[Depends(require_session)])
def mesh_chat_messages(
    thread_id: str = Query(...),
    since: float = Query(0),
):
    path = _safe_thread_path(thread_id)
    if not path.exists():
        return {"messages": []}
    msgs = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                m = S.decrypt_jsonl_line(line)
                if m is None:
                    continue
                if m.get("ts", 0) > since:
                    msgs.append(m)
    except HTTPException:
        raise
    except Exception:
        return {"messages": []}
    return {"messages": msgs}


# ============================================
#  Typing indicators (volatile, in-memory)
# ============================================

_typing_state: dict = {}   # thread_id -> {from_id, from_name, ts}
_typing_lock  = threading.Lock()


@router.post("/mesh/chat/typing", dependencies=[Depends(require_session)])
def chat_typing_send(
    thread_id: str = Query(...),
    from_id:   str = Query(...),
    from_name: str = Query(""),
):
    with _typing_lock:
        _typing_state[thread_id] = {"from_id": from_id, "from_name": from_name, "ts": time.time()}
    _broadcast_presence({"type": "typing", "thread_id": thread_id, "from_id": from_id, "from_name": from_name})
    return {"ok": True}


@router.get("/mesh/chat/typing", dependencies=[Depends(require_session)])
def chat_typing_get(thread_id: str = Query(...)):
    with _typing_lock:
        entry = _typing_state.get(thread_id)
    if not entry or (time.time() - entry["ts"]) > 5:
        return {"typing": False}
    return {"typing": True, "from_id": entry["from_id"], "from_name": entry["from_name"]}


# ============================================
#  Read receipts (volatile, in-memory)
# ============================================

_read_state: dict = {}   # thread_id -> {reader_id: up_to_ts}
_read_lock  = threading.Lock()


@router.post("/mesh/chat/read", dependencies=[Depends(require_session)])
def chat_read_send(
    thread_id:  str   = Query(...),
    reader_id:  str   = Query(...),
    up_to_ts:   float = Query(...),
):
    with _read_lock:
        if thread_id not in _read_state:
            _read_state[thread_id] = {}
        existing = _read_state[thread_id].get(reader_id, 0)
        if up_to_ts > existing:
            _read_state[thread_id][reader_id] = up_to_ts
    _broadcast_presence({"type": "read_receipt", "thread_id": thread_id, "reader_id": reader_id, "up_to_ts": up_to_ts})
    return {"ok": True}


@router.get("/mesh/chat/read_status", dependencies=[Depends(require_session)])
def chat_read_status(thread_id: str = Query(...)):
    with _read_lock:
        receipts = dict(_read_state.get(thread_id, {}))
    return {"thread_id": thread_id, "receipts": receipts}


def _prune_ghost_entries() -> None:
    """Legacy hook retained; missing IP/name similarity never deletes identities."""
    return None


def _presence_timeout_watcher() -> None:
    """Background thread: broadcasts node_offline for nodes that stop heartbeating."""
    known_online: Dict[str, float] = {}  # device_id → last_seen epoch

    while True:
        try:
            now = time.time()
            directory = S.load_mesh_directory()
            cfg = S.load_node_config()

            for dev_id, d in directory.items():
                if not d.get("ip"):
                    continue
                last_seen_str = d.get("last_seen")
                if not last_seen_str:
                    continue
                try:
                    ls = datetime.fromisoformat(last_seen_str.replace("Z", "+00:00")).timestamp()
                except Exception:
                    continue

                was_online = dev_id in known_online
                is_online = (now - ls) < PRESENCE_TIMEOUT_SEC

                if is_online and not was_online:
                    known_online[dev_id] = ls
                    _broadcast_presence({
                        "type": "node_online",
                        "node_id": dev_id,
                        "name": d.get("display_name", dev_id),
                        "ip": d.get("ip"),
                        "status": d.get("status", "pending"),
                    })
                elif not is_online and was_online:
                    del known_online[dev_id]
                    _broadcast_presence({
                        "type": "node_offline",
                        "node_id": dev_id,
                        "name": d.get("display_name", dev_id),
                    })
                elif is_online:
                    known_online[dev_id] = ls
        except Exception:
            pass
        time.sleep(15)


@peer_trust.directory_locked
def _ensure_self_registered() -> None:
    """On startup: guarantee this node has an entry in its own mesh directory."""
    try:
        cfg = S.load_node_config()
        if _refresh_own_host_address(cfg):
            S.save_node_config(cfg)
        directory = S.load_mesh_directory()
        if cfg.node_id in directory:
            if directory[cfg.node_id].get("tli_port") != S.server_port():
                directory[cfg.node_id]["tli_port"] = S.server_port()
                S.save_mesh_directory(directory)
            return  # already registered
        host_ip = "127.0.0.1"
        try:
            hostname = socket.gethostname()
            host_ip = socket.gethostbyname(hostname)
        except Exception:
            pass
        directory[cfg.node_id] = {
            "display_name": cfg.node_name,
            "ip": host_ip,
            "status": "allowed",
            "is_host": cfg.role == "host",
            "tli_port": S.server_port(),
            "last_seen": S.now_iso(),
            "labels": ["Host"] if cfg.role == "host" else [],
            "notes": "",
        }
        S.save_mesh_directory(directory)
        S.log_debug("mesh", "INFO", "Self-registered in mesh directory", node_id=cfg.node_id, role=cfg.role)
    except Exception as e:
        S.log_debug("mesh", "ERROR", "Failed to self-register in directory", error=str(e))


def _self_presence_loop() -> None:
    """Background thread: keeps this node's own last_seen fresh (all roles)."""
    import node_identity as _ni
    while True:
        try:
            cfg = S.load_node_config()
            if _refresh_own_host_address(cfg):
                S.save_node_config(cfg)
            with S.MESH_DIRECTORY_LOCK:
                directory = S.load_mesh_directory()
                now = S.now_iso()
                fp = _ni.fingerprint()
                if cfg.node_id in directory:
                    directory[cfg.node_id]["last_seen"] = now
                    directory[cfg.node_id]["is_host"] = (cfg.role == "host")
                    directory[cfg.node_id]["identity_fingerprint"] = fp
                    directory[cfg.node_id]["tli_port"] = S.server_port()
                else:
                    # Re-register if the entry was somehow removed
                    host_ip = "127.0.0.1"
                    try:
                        hostname = socket.gethostname()
                        host_ip = socket.gethostbyname(hostname)
                    except Exception:
                        pass
                    directory[cfg.node_id] = {
                        "display_name": cfg.node_name,
                        "ip": host_ip,
                        "status": "allowed",
                        "is_host": cfg.role == "host",
                        "tli_port": S.server_port(),
                        "last_seen": now,
                        "labels": ["Host"] if cfg.role == "host" else [],
                        "notes": "",
                        "identity_fingerprint": fp,
                    }
                S.save_mesh_directory(directory)
        except Exception as e:
            S.log_debug("mesh", "ERROR", "Self-presence loop error", error=str(e))
        time.sleep(30)


# ============================================
#  File Transfer
# ============================================

@router.post("/mesh/transfer/store")
async def transfer_store(request: Request, _session=Depends(require_session)):
    raise HTTPException(409, {"code": "capability_required", "message": "File transfer is not available through trusted computer connections yet. Existing transfer files were preserved."})


@router.get("/mesh/transfer/serve/{filename}", dependencies=[Depends(require_session)])
async def transfer_serve(filename: str):
    """
    Serve a file that was stored by the sender for a peer to download.
    No session required — the receiver's browser fetches this directly.
    """
    safe_name = os.path.basename(filename)
    dest = MESH_TRANSFERS_DIR / safe_name
    if not dest.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        path=str(dest),
        filename=safe_name,
        media_type="application/octet-stream",
    )


def start_background_loops():
    """Called by main.py at startup."""
    _ensure_self_registered()
    _prune_ghost_entries()
    threading.Thread(target=agent_heartbeat_loop, daemon=True).start()
    threading.Thread(target=agent_task_worker_loop, daemon=True).start()
    threading.Thread(target=_presence_timeout_watcher, daemon=True).start()
    threading.Thread(target=_self_presence_loop, daemon=True).start()


class PeerCardRequest(BaseModel):
    origin: str

class PeerReviewRequest(BaseModel):
    card: dict
    grants: List[str]

class PeerApproveRequest(BaseModel):
    review_id: str
    identity_fingerprint: str
    certificate_sha256: str

@router.get("/mesh/trust/setup")
def mesh_trust_setup(request: Request, response: Response, _session=Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return peer_trust.local_setup(request)


@router.post("/mesh/trust/card")
def mesh_trust_card(body: PeerCardRequest, _session=Depends(require_session)):
    return {"ok": True, "protocol": peer_trust.PROTOCOL, "card": peer_trust.local_card(body.origin)}

@router.post("/mesh/trust/preview")
def mesh_trust_preview(body: PeerReviewRequest, request: Request, _session=Depends(peer_pairing.browser_owner)):
    return peer_trust.preview(body.card, body.grants, _session, request)

@router.post("/mesh/trust/approve")
def mesh_trust_approve(body: PeerApproveRequest, request: Request, _session=Depends(peer_pairing.browser_owner)):
    return peer_trust.approve(body.review_id, body.identity_fingerprint, body.certificate_sha256, _session, request)

@router.get("/mesh/peer/self-status")
def mesh_peer_self_status(access=Depends(peer_trust.coordinate_access)):
    entry, card, _ = peer_trust.trusted(access["device_id"], "coordinate")
    return {"device_id": access["device_id"], "status": entry["status"], "identity_fingerprint": card["identity_fingerprint"]}

@router.get("/mesh/directory/{device_id}/capabilities")
def mesh_peer_capabilities(device_id: str, _session=Depends(require_session)):
    return peer_trust.capability(device_id)


@router.post("/mesh/trust/{device_id}/revoke")
@peer_trust.directory_locked
def mesh_trust_revoke(device_id: str, _session=Depends(peer_pairing.browser_owner)):
    if device_id == S.load_node_config().node_id:
        raise HTTPException(422, "This computer cannot revoke itself.")
    directory = S.load_mesh_directory()
    if device_id not in directory:
        raise HTTPException(404, "Computer not found")
    directory[device_id]["status"] = "blocked"
    S.save_mesh_directory(directory)
    return {"ok": True, "device_id": device_id, "status": "blocked", "actions_performed": False}


def _peer_body(access, device_id):
    if not isinstance(access, dict) or access.get("device_id") != device_id:
        raise HTTPException(403, "The request body must identify its authenticated peer.")
    peer_trust.revalidate(access)
