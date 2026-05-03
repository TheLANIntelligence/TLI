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

import os

import shutil

import requests
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

import tli_state as S
from tli_state import NodeConfig

from routers.system_routes import require_session
from license_gate import gate as _gate

router = APIRouter(tags=["mesh"])

MESH_CHAT_DIR = S.MESH_DATA_DIR / "chat"
MESH_TRANSFERS_DIR = S.MESH_DATA_DIR / "transfers"
MESH_TRANSFERS_DIR.mkdir(parents=True, exist_ok=True)
PRESENCE_TIMEOUT_SEC = 90  # seconds without heartbeat before node is offline


# ============================================
#  Node-to-node HTTP helper (HTTPS → HTTP fallback)
# ============================================
#
# All TLI nodes run HTTPS by default (self-signed cert).  We must use
# verify=False because the cert is self-signed.  Fall back to plain HTTP
# for older/dev nodes that didn't generate a cert.

def _node_get(base: str, path: str, **kw) -> requests.Response:
    """GET a peer node endpoint.  base = 'ip:port' or full URL."""
    if base.startswith("http://") or base.startswith("https://"):
        url = base.rstrip("/") + path
        return requests.get(url, verify=False, **kw)
    for scheme in ("https", "http"):
        try:
            return requests.get(f"{scheme}://{base}{path}", verify=False, **kw)
        except requests.exceptions.ConnectionError:
            continue
    raise requests.exceptions.ConnectionError(f"Could not reach {base}{path}")


def _node_post(base: str, path: str, **kw) -> requests.Response:
    """POST to a peer node endpoint.  base = 'ip:port' or full URL."""
    if base.startswith("http://") or base.startswith("https://"):
        url = base.rstrip("/") + path
        return requests.post(url, verify=False, **kw)
    for scheme in ("https", "http"):
        try:
            return requests.post(f"{scheme}://{base}{path}", verify=False, **kw)
        except requests.exceptions.ConnectionError:
            continue
    raise requests.exceptions.ConnectionError(f"Could not reach {base}{path}")

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
    identity_fingerprint: Optional[str] = None   # Ed25519 public key fingerprint

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

def _ensure_host_in_mesh_directory() -> None:
    try:
        node_cfg = S.load_node_config()
    except Exception:
        return
    devices = S.load_mesh_directory()

    # Remove stale ghost entries that share this machine's name but have a different node_id.
    # These accumulate when node_config.json is recreated (new UUID) across restarts.
    stale_ids = [
        dev_id for dev_id, d in devices.items()
        if dev_id != node_cfg.node_id
        and (d.get("display_name") or "").strip().lower() == node_cfg.node_name.strip().lower()
    ]
    for dev_id in stale_ids:
        devices.pop(dev_id, None)
        S.log_debug("mesh", "INFO", "Removed ghost duplicate entry", ghost_id=dev_id, name=node_cfg.node_name)

    entry = devices.get(node_cfg.node_id, {})
    entry.setdefault("display_name", node_cfg.node_name)
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
    entry.setdefault("tli_port", int(os.environ.get("TLI_PORT", "8000")))
    entry["last_seen"] = S.now_iso()
    devices[node_cfg.node_id] = entry
    S.save_mesh_directory(devices)


# ============================================
#  Node identity
# ============================================

@router.get("/mesh/node")
def get_node_identity(_session=Depends(require_session)):
    cfg = S.load_node_config()
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
def become_host(_session=Depends(require_session), _l=Depends(_gate("peer_nodes"))):
    cfg = S.load_node_config()
    cfg.role = "host"
    cfg.mesh_status = "approved"
    hostname = socket.gethostname()
    host_ip = socket.gethostbyname(hostname)
    host_address = f"{host_ip}:{os.environ.get('TLI_PORT', '8000')}"
    cfg.host_address = host_address
    cfg.updated_at = S.now_iso()
    S.save_node_config(cfg)
    directory = S.load_mesh_directory()
    if cfg.node_id not in directory:
        directory[cfg.node_id] = {
            "display_name": cfg.node_name, "ip": host_ip, "status": "allowed",
            "is_host": True, "tli_port": int(os.environ.get("TLI_PORT", "8000")),
            "last_seen": cfg.updated_at, "labels": ["Host"], "notes": "",
        }
        S.save_mesh_directory(directory)
    return {"ok": True, "message": "This node is now the Host.", "host_address": cfg.host_address}


# ============================================
#  Agent heartbeat + task endpoints
# ============================================

@router.post("/mesh/agent_heartbeat")
def mesh_agent_heartbeat(body: AgentHeartbeatRequest):
    cfg = S.load_node_config()
    if cfg.role != "host":
        raise HTTPException(status_code=403, detail="This node is not a Mesh host.")
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
        directory[body.device_id]["tli_port"] = body.tli_port
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
def agent_enqueue_task(device_id: str, body: AgentTaskEnqueueRequest, _session=Depends(require_session), _l=Depends(_gate("peer_nodes"))):
    cfg = S.load_node_config()
    if cfg.role != "host":
        raise HTTPException(status_code=403, detail="This node is not a Mesh host.")
    directory = S.load_mesh_directory()
    if device_id not in directory:
        raise HTTPException(status_code=404, detail="Unknown device_id for tasks.")
    task = S.enqueue_agent_task(device_id, body.type, body.payload or {})
    return {"ok": True, "task": task}


@router.post("/agent/tasks/next")
def agent_get_next_task(body: AgentTaskNextRequest):
    cfg = S.load_node_config()
    if cfg.role != "host":
        raise HTTPException(status_code=403, detail="This node is not a Mesh host.")
    directory = S.load_mesh_directory()
    if body.device_id not in directory:
        raise HTTPException(status_code=404, detail="Unknown device_id for tasks.")
    task = S.get_next_agent_task_for(body.device_id)
    return {"ok": True, "task": task}


@router.post("/agent/tasks/report")
def agent_report_task(body: AgentTaskReportRequest):
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

@router.get("/mesh/directory", response_model=MeshDirectoryResponse)
def get_mesh_directory(_session=Depends(require_session)):
    try:
        node_cfg = S.load_node_config()
    except Exception:
        return MeshDirectoryResponse(mode="standalone", this_device_id="standalone-node", devices=[])
    _ensure_host_in_mesh_directory()
    raw = S.load_mesh_directory()
    devices = []
    for dev_id, d in raw.items():
        # Never include this node itself in the peer list — it's identified by this_device_id
        if dev_id == node_cfg.node_id:
            continue
        # Skip null-IP ghost entries for peers
        if not d.get("ip"):
            continue
        try:
            status_enum = MeshDeviceStatusEnum(d.get("status", "pending"))
        except Exception:
            status_enum = MeshDeviceStatusEnum.pending
        devices.append(MeshDeviceEntry(
            device_id=dev_id, display_name=d.get("display_name", dev_id), ip=d.get("ip"),
            tli_port=int(d.get("tli_port", 8000)),
            status=status_enum, is_host=bool(d.get("is_host", False)), last_seen=d.get("last_seen"),
            labels=d.get("labels") or [], notes=d.get("notes"),
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
    seen_ips: set[str] = set()
    seen_names: set[str] = set()

    # collect unique peers — dedup by IP and display name
    peer_list: list[dict] = []
    for dev_id, d in raw_dir.items():
        try:
            self_cfg = S.load_node_config()
            if dev_id == self_cfg.node_id:
                continue
        except Exception:
            pass
        ip = d.get("ip", "")
        display = (d.get("display_name") or dev_id).strip().lower()
        if not ip or ip in seen_ips:
            continue
        if display and display in seen_names:
            continue
        seen_ips.add(ip)
        if display:
            seen_names.add(display)
        peer_list.append({"peer_id": dev_id, "ip": ip, "port": int(d.get("tli_port", 8000)),
                          "display_name": d.get("display_name") or dev_id})

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
                "node_name": p["display_name"], "ip": p["ip"], "port": p["port"]}
        try:
            r = requests.get(f"http://{p['ip']}:{p['port']}/agent/health", timeout=2.0)
            if r.ok:
                data = r.json()
                data.update({"is_self": False, "online": True, "peer_id": p["peer_id"]})
                return data
            base.update({"online": False, "error": f"HTTP {r.status_code}"})
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
    """Return all LAN-discovered TLI peers (excludes self, deduped by IP, with online status).

    This is the lightweight endpoint TLI Chat uses — no mesh pairing required.
    Any TLI node on the same LAN that has been seen via UDP beacon shows up here.
    """
    try:
        node_cfg = S.load_node_config()
    except Exception:
        return {"peers": [], "self_id": "unknown"}

    raw = S.load_mesh_directory()
    now = time.time()

    seen_ips: set[str] = set()
    peers = []

    for dev_id, d in raw.items():
        if dev_id == node_cfg.node_id:
            continue  # skip self
        ip = d.get("ip") or ""
        if not ip:
            continue  # skip ghost entries with no IP
        if ip in seen_ips:
            continue  # dedup by IP (same machine, different node IDs)
        seen_ips.add(ip)

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
            "name":      d.get("display_name") or dev_id,
            "ip":        ip,
            "port":      int(d.get("tli_port", 8000)),
            "last_seen": last_seen_str,
            "online":    online,
            "status":    d.get("status", "allowed"),
        })

    # Sort: online first, then by name
    peers.sort(key=lambda p: (0 if p["online"] else 1, p["name"].lower()))

    return {"peers": peers, "self_id": node_cfg.node_id}


@router.post("/mesh/devices/{device_id}/status", response_model=MeshDeviceEntry)
def update_mesh_device_status(device_id: str, body: MeshDeviceStatusUpdate, _session=Depends(require_session)):
    node_cfg = S.load_node_config()
    if node_cfg.role != "host":
        raise HTTPException(status_code=403, detail="Only the Host node may change mesh device status.")
    directory = S.load_mesh_directory()
    entry = directory.get(device_id, {})
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
def host_receive_join(req: MeshJoinRequest, request: Request, _l=Depends(_gate("peer_nodes"))):
    node_cfg = S.load_node_config()
    if node_cfg.role != "host":
        raise HTTPException(status_code=403, detail="Only a Host node may receive mesh join requests.")
    directory = S.load_mesh_directory()
    now = S.now_iso()
    # Use the real connection IP — more reliable than what the client claims
    real_ip = (request.client.host if request.client else None) or req.ip

    # Block self-registration: a node must not appear as a peer in its own directory
    if req.device_id == node_cfg.node_id:
        raise HTTPException(status_code=400, detail="A node may not register itself as a mesh peer.")

    # IP deduplication: if another device_id already claims this IP, treat this as a
    # reinstall of the same physical machine.  Migrate its status/labels/notes to the
    # incoming entry and remove the stale ghost(s).
    stale_ids = [
        did for did, dev in directory.items()
        if dev.get("ip") == real_ip and did != req.device_id
    ]
    inherited_status = MeshDeviceStatusEnum.pending.value
    inherited_labels: list = []
    inherited_notes: str = ""
    if stale_ids:
        # Prefer the most-recently-seen stale entry for inheritance
        stale_ids.sort(key=lambda d: directory[d].get("last_seen", ""), reverse=True)
        best = directory[stale_ids[0]]
        inherited_status = best.get("status", inherited_status)
        inherited_labels = best.get("labels") or []
        inherited_notes = best.get("notes", "")
        for sid in stale_ids:
            directory.pop(sid, None)
        S.log_debug("mesh", "INFO", "Removed stale ghost entries on IP dedup",
                    stale_ids=stale_ids, real_ip=real_ip, new_id=req.device_id)

    entry = directory.get(req.device_id, {})
    entry["display_name"] = req.display_name or req.device_id
    entry["ip"] = real_ip
    entry["tli_port"] = req.tli_port
    # Preserve existing status/labels/notes if already known; otherwise inherit from stale entry
    if "status" not in entry:
        entry["status"] = inherited_status
    entry["is_host"] = bool(entry.get("is_host", False)) or False
    entry["last_seen"] = now
    entry.setdefault("labels", inherited_labels)
    entry.setdefault("notes", inherited_notes)
    if req.identity_fingerprint:
        entry["identity_fingerprint"] = req.identity_fingerprint
    directory[req.device_id] = entry
    S.save_mesh_directory(directory)
    S.log_debug("mesh", "INFO", "Join request received", device_id=req.device_id, display_name=req.display_name, ip=real_ip)
    # Broadcast presence — new node just appeared
    _broadcast_presence({
        "type": "node_online",
        "node_id": req.device_id,
        "name": entry["display_name"],
        "ip": real_ip,
        "tli_port": req.tli_port,
        "status": MeshDeviceStatusEnum.pending.value,
        "identity_fingerprint": entry.get("identity_fingerprint"),
    })
    try:
        import event_bus as _eb
        _eb.emit_event("mesh", "info", f"{entry['display_name']} joined the mesh", f"Node at {real_ip}")
    except Exception:
        pass
    return MeshDeviceEntry(
        device_id=req.device_id, display_name=entry["display_name"], ip=entry.get("ip"),
        tli_port=entry["tli_port"],
        status=MeshDeviceStatusEnum.pending, is_host=bool(entry.get("is_host", False)),
        last_seen=entry.get("last_seen"), labels=entry.get("labels") or [], notes=entry.get("notes"),
        identity_fingerprint=entry.get("identity_fingerprint"),
    )


@router.delete("/mesh/devices/{device_id}")
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
        new_status = MeshDeviceStatusEnum.allowed
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
    if node_cfg.role != "host":
        raise HTTPException(status_code=403, detail="Only the Host node may call this endpoint.")
    directory = S.load_mesh_directory()
    target = directory.get(device_id)
    if not target:
        raise HTTPException(status_code=404, detail=f"No device with id={device_id!r} in mesh directory.")
    ip = target.get("ip")
    if not ip:
        raise HTTPException(status_code=400, detail="No IP address recorded for this device.")
    tli_port = int(target.get("tli_port", 8000))
    return ip, tli_port


@router.post("/mesh/directory/{device_id}/ping")
def mesh_ping_device(device_id: str, _session=Depends(require_session), _l=Depends(_gate("peer_nodes"))):
    ip, tli_port = _resolve_mesh_target(device_id)
    try:
        resp = _node_get(f"{ip}:{tli_port}", "/agent/ping", timeout=5.0)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to contact node at {ip}:{tli_port}: {e!r}")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Node returned HTTP {resp.status_code}")
    try:
        ping_data = resp.json()
    except Exception:
        ping_data = {"raw": resp.text}
    return {"ok": True, "device_id": device_id, "ping": ping_data}


@router.post("/mesh/directory/{device_id}/info")
def mesh_node_info(device_id: str, _session=Depends(require_session), _l=Depends(_gate("peer_nodes"))):
    ip, tli_port = _resolve_mesh_target(device_id)
    try:
        resp = _node_get(f"{ip}:{tli_port}", "/agent/info", timeout=8.0)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to contact node: {e!r}")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Node returned HTTP {resp.status_code}")
    try:
        info_data = resp.json()
    except Exception:
        info_data = {"raw": resp.text}
    return {"ok": True, "device_id": device_id, "info": info_data}


@router.post("/mesh/directory/{device_id}/diagnostics")
def mesh_node_diagnostics(device_id: str, _session=Depends(require_session), _l=Depends(_gate("peer_nodes"))):
    ip, tli_port = _resolve_mesh_target(device_id)
    try:
        resp = _node_get(f"{ip}:{tli_port}", "/agent/system_summary", timeout=8.0)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to contact node: {e!r}")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Node returned HTTP {resp.status_code}")
    try:
        diag = resp.json()
    except Exception:
        diag = {"raw": resp.text}
    return {"ok": True, "device_id": device_id, "diagnostics": diag}


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
    data = _proxy_post(device_id, "/agent/maintenance/refresh")
    return {"ok": True, "device_id": device_id, "action": "maintenance_refresh", "data": data}


@router.post("/mesh/directory/{device_id}/maintenance/clean_temp")
def mesh_node_maintenance_clean_temp(device_id: str, _session=Depends(require_session)):
    data = _proxy_post(device_id, "/agent/maintenance/clean_temp")
    return {"ok": True, "device_id": device_id, "action": "maintenance_clean_temp", "data": data}


@router.get("/mesh/directory/{device_id}/logs/recent")
def mesh_node_logs_recent(device_id: str, limit: int = Query(default=100, ge=1, le=1000), _session=Depends(require_session)):
    data = _proxy_get(device_id, "/agent/logs/recent", params={"limit": limit})
    return {"ok": True, "device_id": device_id, "action": "logs_recent", "data": data}


@router.post("/mesh/directory/{device_id}/tasks/run")
def mesh_node_tasks_run(device_id: str, body: MeshTaskRunRequest, _session=Depends(require_session)):
    if not body.task_id:
        raise HTTPException(status_code=400, detail="task_id is required.")
    data = _proxy_post(device_id, "/agent/tasks/run", json_body=body.dict(exclude_none=True))
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
            # Mirror the /api/lan/peers dedup rules: skip self, dedup by IP.
            try:
                _self_id = S.load_node_config().node_id
            except Exception:
                _self_id = None
            raw = S.load_mesh_directory()
            now_epoch = time.time()
            _seen_ips: set = set()
            for dev_id, d in raw.items():
                if dev_id == _self_id:
                    continue  # skip self
                ip = d.get("ip") or ""
                if not ip:
                    continue
                if ip in _seen_ips:
                    continue  # same physical machine, different dev_id — skip
                last_seen_str = d.get("last_seen")
                is_online = False
                if last_seen_str:
                    try:
                        ls = datetime.fromisoformat(last_seen_str.replace("Z", "+00:00")).timestamp()
                        is_online = (now_epoch - ls) < PRESENCE_TIMEOUT_SEC
                    except Exception:
                        is_online = True
                if is_online:
                    _seen_ips.add(ip)
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
    tli_port = int(os.environ.get("TLI_PORT", "8000"))
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
        raise HTTPException(status_code=400, detail="This node is not joined to any host.")
    host_base = cfg.host_address.strip()
    try:
        r = _node_get(host_base, f"/mesh/devices/{cfg.node_id}", timeout=(S.HTTP_CONNECT_TIMEOUT, S.HTTP_READ_TIMEOUT))
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
        if cfg.mesh_status not in ("pending", "approved") or not cfg.host_address:
            time.sleep(_hb_sleep())
            continue
        payload = {
            "device_id": cfg.node_id, "status": "online", "agent_version": "0.1.0",
            "capabilities": {"visualizer": True, "tools": True},
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
            requests.post(f"{host_base}/agent/tasks/report", json={
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
    with open(path, "a", encoding="utf-8") as f:
        f.write(S.encrypt_jsonl_line(msg) + "\n")


def _forward_to_remote(to_ip: str, msg: dict) -> None:
    """Best-effort fire-and-forget to remote node. Tries HTTPS first (self-signed OK), falls back to HTTP."""
    for scheme in ("https", "http"):
        try:
            requests.post(
                f"{scheme}://{to_ip}:8000/mesh/chat/receive",
                json=msg,
                timeout=3,
                verify=False,
            )
            return
        except Exception:
            continue


@router.post("/mesh/chat/send")
def mesh_chat_send(body: ChatMessageRequest, bg: BackgroundTasks, _session=Depends(require_session)):
    if not body.body.strip():
        raise HTTPException(status_code=400, detail="Empty message")
    msg = {
        "thread_id": body.thread_id,
        "from_id": body.from_id,
        "from_name": body.from_name,
        "to_id": body.to_id,
        "body": body.body,
        "ts": body.ts,
        "server_ts": time.time() * 1000,
    }
    _append_chat_msg(body.thread_id, msg)
    if body.to_ip:
        bg.add_task(_forward_to_remote, body.to_ip, msg)
    return {"ok": True}


@router.post("/mesh/chat/receive")
def mesh_chat_receive(body: ChatMessageRequest, request: Request):
    """Called by a remote node forwarding a message to us."""
    if not body.body.strip():
        raise HTTPException(status_code=400, detail="Empty message")
    msg = {
        "thread_id": body.thread_id,
        "from_id": body.from_id,
        "from_name": body.from_name,
        "to_id": body.to_id,
        "body": body.body,
        "ts": body.ts,
        "server_ts": time.time() * 1000,
    }
    _append_chat_msg(body.thread_id, msg)

    # Auto-add sender to mesh directory so they appear in /api/lan/peers
    # This makes the sender visible in TLI Chat even without UDP beacon discovery.
    sender_ip = (request.client.host if request.client else None) or body.to_ip or ""
    if sender_ip and body.from_id:
        try:
            directory = S.load_mesh_directory()
            entry = directory.get(body.from_id, {})
            entry["device_id"]    = body.from_id
            entry["display_name"] = entry.get("display_name") or body.from_name or body.from_id
            entry["ip"]           = sender_ip
            entry["tli_port"]     = int(entry.get("tli_port", 8000))
            entry["last_seen"]    = S.now_iso()
            entry.setdefault("status", "allowed")
            entry.setdefault("is_host", False)
            entry.setdefault("labels", [])
            directory[body.from_id] = entry
            S.save_mesh_directory(directory)

            # Push SSE events so the frontend updates instantly (no polling lag)
            _broadcast_presence({
                "type":     "node_online",
                "node_id":  body.from_id,
                "name":     entry["display_name"],
                "ip":       sender_ip,
                "tli_port": entry["tli_port"],
                "status":   "online",
            })
            _broadcast_presence({
                "type":      "message_incoming",
                "from_id":   body.from_id,
                "from_name": entry["display_name"],
                "thread_id": body.thread_id,
                "ts":        body.ts,
            })
        except Exception:
            pass  # best-effort — message is already stored

    return {"ok": True}


@router.get("/mesh/chat/messages")
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
    except Exception:
        return {"messages": []}
    return {"messages": msgs}


# ============================================
#  Typing indicators (volatile, in-memory)
# ============================================

_typing_state: dict = {}   # thread_id -> {from_id, from_name, ts}
_typing_lock  = threading.Lock()


@router.post("/mesh/chat/typing")
def chat_typing_send(
    thread_id: str = Query(...),
    from_id:   str = Query(...),
    from_name: str = Query(""),
):
    with _typing_lock:
        _typing_state[thread_id] = {"from_id": from_id, "from_name": from_name, "ts": time.time()}
    _broadcast_presence({"type": "typing", "thread_id": thread_id, "from_id": from_id, "from_name": from_name})
    return {"ok": True}


@router.get("/mesh/chat/typing")
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


@router.post("/mesh/chat/read")
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


@router.get("/mesh/chat/read_status")
def chat_read_status(thread_id: str = Query(...)):
    with _read_lock:
        receipts = dict(_read_state.get(thread_id, {}))
    return {"thread_id": thread_id, "receipts": receipts}


def _prune_ghost_entries() -> None:
    """Remove null-IP entries from mesh_directory on startup (dev ghosts from restarts)."""
    try:
        cfg = S.load_node_config()
        directory = S.load_mesh_directory()
        pruned = {k: v for k, v in directory.items() if v.get("ip") or k == cfg.node_id}
        removed = len(directory) - len(pruned)
        if removed > 0:
            S.save_mesh_directory(pruned)
            S.log_debug("mesh", "INFO", "Pruned ghost directory entries", removed=removed)
    except Exception:
        pass


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


def _ensure_self_registered() -> None:
    """On startup: guarantee this node has an entry in its own mesh directory."""
    try:
        cfg = S.load_node_config()
        directory = S.load_mesh_directory()
        if cfg.node_id in directory:
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
            "tli_port": int(os.environ.get("TLI_PORT", "8000")),
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
            directory = S.load_mesh_directory()
            now = S.now_iso()
            fp = _ni.fingerprint()
            if cfg.node_id in directory:
                directory[cfg.node_id]["last_seen"] = now
                directory[cfg.node_id]["is_host"] = (cfg.role == "host")
                directory[cfg.node_id]["identity_fingerprint"] = fp
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
                    "tli_port": int(os.environ.get("TLI_PORT", "8000")),
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
async def transfer_store(
    request: Request,
    file: UploadFile = File(...),
    thread_id: str = Query(...),
    from_id:   str = Query(...),
    from_name: str = Query(""),
    to_id:     str = Query(...),
    to_ip:     str = Query(""),
    ts:        float = Query(0),
    _session=Depends(require_session),
):
    """
    Called by the LOCAL browser when the user shares a file.
    Saves the file to this node's transfers directory, then appends a
    special file-offer record to the shared chat thread so the receiver
    discovers it on their next poll (pull-based — no firewall issues).
    """
    safe_name = os.path.basename(file.filename or "file") or "file"

    dest = MESH_TRANSFERS_DIR / safe_name
    counter = 1
    stem = dest.stem
    suffix = dest.suffix
    while dest.exists():
        dest = MESH_TRANSFERS_DIR / f"{stem}_{counter}{suffix}"
        counter += 1

    with dest.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)

    size_bytes = dest.stat().st_size
    token = dest.name

    # Signal the receiver via the existing pull-based chat store.
    # Body is a machine-readable prefix + JSON so old clients degrade to plain text.
    offer_meta = json.dumps({
        "name":  token,
        "size":  size_bytes,
        "token": token,
    }, ensure_ascii=False)
    msg = {
        "thread_id":  thread_id,
        "from_id":    from_id,
        "from_name":  from_name or from_id,
        "to_id":      to_id,
        "body":       f"__FILE_OFFER__:{offer_meta}",
        "ts":         ts or (time.time() * 1000),
        "server_ts":  time.time() * 1000,
    }
    _append_chat_msg(thread_id, msg)

    # Push server-to-server to the receiver's /mesh/chat/receive — same path
    # as regular text messages, works regardless of receiver's client version.
    # to_ip is passed explicitly by the frontend (same pattern as text messages).
    _recv_ip = to_ip or ""
    if not _recv_ip:
        # Fallback: look up in directory
        try:
            _recv_ip = S.load_mesh_directory().get(to_id, {}).get("ip", "")
        except Exception:
            pass
    if _recv_ip:
        try:
            _forward_to_remote(_recv_ip, msg)
        except Exception:
            pass  # best-effort — receiver will still find it on next poll

    S.log_debug("mesh", "INFO", "File stored for sharing", filename=token, size=size_bytes)
    return {"ok": True, "token": token, "size": size_bytes}


@router.get("/mesh/transfer/serve/{filename}")
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
