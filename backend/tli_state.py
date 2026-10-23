# backend/tli_state.py
# Shared state module for TLI — imported by all routers.
# No FastAPI dependencies here (no app, no router, no HTTPException).
#
# main.py initialises the mutable fields (providers, node config) at startup.
# Routers read them via  `import tli_state`  →  `tli_state.lm_provider`.

from __future__ import annotations

import base64
import json
import os
import platform
import re
import secrets as _secrets
import sys
import time
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
try:
    from typing import TypeAlias          # Python 3.10+
except ImportError:
    TypeAlias = None  # type: ignore[assignment]  # Python 3.9 compat — annotation-only

from pydantic import BaseModel
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import data_protection as _dp
import security_state as _security

# ============================================
#  Paths
# ============================================

TLI_ROOT = os.environ.get("TLI_ROOT")
if TLI_ROOT and os.path.isdir(TLI_ROOT):
    BASE_DIR = os.path.abspath(TLI_ROOT)
elif getattr(sys, "frozen", False):
    # Frozen EXE (PyInstaller onefile): __file__ points to the temp _MEIPASS dir.
    # Use the directory that contains the actual .exe instead.
    BASE_DIR = os.path.abspath(os.path.dirname(sys.executable))
else:
    BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

DATA_DIR        = os.path.join(BASE_DIR, "data")
TLS_DIR         = os.path.join(DATA_DIR, "tls")
TLS_CERT_PATH   = os.path.join(TLS_DIR, "cert.pem")
TLS_KEY_PATH    = os.path.join(TLS_DIR, "key.pem")
TLS_ENABLED: bool = False          # set True in main.py after cert is confirmed ready
SERVER_BIND_PORT: Optional[int] = None  # actual listener port, set before startup workers
FRONTEND_DIR    = os.path.join(BASE_DIR, "frontend")
VAULT_DIR       = os.path.join(DATA_DIR, "vault")
ASSETS_DIR      = os.path.join(FRONTEND_DIR, "assets")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(VAULT_DIR, exist_ok=True)

TOOLS_DIR       = Path(os.path.join(DATA_DIR, "tools"))
SCRIPTS_DIR     = TOOLS_DIR / "scripts"
TASKS_DIR       = TOOLS_DIR / "tasks"
for _d in [TOOLS_DIR, SCRIPTS_DIR, TASKS_DIR]:
    _d.mkdir(parents=True, exist_ok=True)

TOOLS_INDEX_PATH  = TOOLS_DIR / "tools_index.json"
TASKS_INDEX_PATH  = TOOLS_DIR / "tasks_index.json"

CONVERSATIONS_FILE = os.path.join(DATA_DIR, "conversations.json")
DEBUG_LOG_PATH     = Path(os.path.join(DATA_DIR, "debug_log.jsonl"))
SHELLY_REGISTRY_PATH = Path(os.path.join(DATA_DIR, "shelly_registry.json"))

LAST_FILE_OP_PATH = Path(os.path.join(DATA_DIR, "last_file_op.json"))
DEVICES_FILE      = os.path.join(DATA_DIR, "devices.json")

MODEL_CONFIG_FILE    = Path(os.path.join(DATA_DIR, "tli_model_config.json"))
SYSTEM_PROFILE_FILE  = Path(os.path.join(DATA_DIR, "tli_system_profile.json"))
PIN_CONFIG_FILE      = Path(os.path.join(DATA_DIR, "tli_pin.json"))
LICENSE_FILE         = Path(os.path.join(DATA_DIR, "tli_license.json"))

# Mesh / Node
MESH_DATA_DIR       = Path(os.path.join(DATA_DIR, "mesh"))
MESH_DATA_DIR.mkdir(parents=True, exist_ok=True)
NODE_CONFIG_PATH    = MESH_DATA_DIR / "node_config.json"
MESH_DIRECTORY_PATH = MESH_DATA_DIR / "mesh_directory.json"
AGENT_STATE_PATH    = MESH_DATA_DIR / "agent_state.json"
AGENT_TASKS_PATH    = MESH_DATA_DIR / "agent_tasks.json"


# ============================================
#  Version
# ============================================

TLI_VERSION = "1.4.9-beta"

# ============================================
#  LM Studio / HTTP config
# ============================================

LM_STUDIO_URL        = "http://localhost:1234/v1/chat/completions"
LM_STUDIO_MODELS_URL = "http://localhost:1234/v1/models"


def _new_lm_studio_provider(config):
    from providers import LMStudioProvider
    return LMStudioProvider(**config, connect_timeout=HTTP_CONNECT_TIMEOUT,
                            read_timeout=HTTP_READ_TIMEOUT_GEN, debug_log=log_debug)


def _publish_lm_studio(config, provider):
    # Replace the provider instead of mutating endpoints under an in-flight
    # request. Its new health cache starts empty; legacy URL aliases stay aligned.
    globals().update(LM_STUDIO_URL=config["chat_url"],
                     LM_STUDIO_MODELS_URL=config["models_url"], lm_provider=provider)


def load_lm_studio_config_from_disk() -> None:
    """Read validated settings before constructing the host's provider."""
    import lm_studio_config as _lm_config
    with _lm_config.LOCK:
        config = _lm_config.read(DATA_DIR)
        provider = _new_lm_studio_provider(config)
        _publish_lm_studio(config, provider)


def save_lm_studio_url(url: str, *, check=None) -> Dict[str, str]:
    import lm_studio_config as _lm_config
    _lm_config._access(check)
    try:
        config = _lm_config.from_url(url)
        _lm_config._access(check)
        with _lm_config.LOCK:
            _lm_config._access(check)
            _lm_config.read(DATA_DIR, check=check)
            # Construction is passive. Failed saves leave the running provider
            # and explicit model/LAN selections intact; known commits publish
            # before a final access denial can withhold their acknowledgement.
            provider = _new_lm_studio_provider(config)
            _lm_config._access(check)
            _lm_config.write(DATA_DIR, config, check=check,
                             on_commit=lambda: _publish_lm_studio(config, provider))
        _lm_config._access(check)
        return config
    except Exception:
        _lm_config._access(check)
        raise

HTTP_CONNECT_TIMEOUT = 2.5
HTTP_READ_TIMEOUT    = 60
HTTP_READ_TIMEOUT_GEN = 30


# ============================================
#  Providers (set by main.py at startup)
# ============================================

lm_provider   = None   # LMStudioProvider instance
shelly_driver = None   # ShellyDriver instance


# ============================================
#  Logging
# ============================================

def log_debug(subsystem: str, level: str, message: str, **extra: Any) -> None:
    try:
        event = {
            "ts": datetime.utcnow().isoformat() + "Z",
            "subsystem": subsystem,
            "level": level,
            "message": message,
            "extra": extra,
        }
        DEBUG_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with DEBUG_LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")
    except Exception:
        pass


def now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def server_port() -> int:
    """Own listener port; saved edits apply after restart, never mid-session."""
    running = SERVER_BIND_PORT
    if type(running) is int and 1 <= running <= 65535:
        return running
    from startup_config import resolve
    return resolve(BASE_DIR)["effective_next"]["port"]


# ============================================
#  Generic JSON helpers
# ============================================

def load_json_file(path: Path, default: Any = None):
    if path.exists():
        try:
            with path.open("r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return default
    return default


def save_json_file(path: Path, data: Any) -> None:
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    tmp.replace(path)


# ============================================
#  Node / Mesh Identity
# ============================================

NodeRole: TypeAlias = Literal["standalone", "host", "member"]
MeshStatus: TypeAlias = Literal["unpaired", "pending", "approved", "blocked", "removed"]


class NodeConfig(BaseModel):
    node_id: str
    node_name: str
    role: NodeRole = "standalone"
    mesh_status: MeshStatus = "unpaired"
    host_device_id: Optional[str] = None
    host_name: Optional[str] = None
    host_address: Optional[str] = None
    created_at: str
    updated_at: str
    prefer_mesh_ai: bool = False          # prefer mesh peer AI over local when peer available
    mesh_ai_cpu_threshold: int = 80       # auto-route to mesh if local CPU% exceeds this


try:
    NodeConfig.model_rebuild()
except Exception:
    pass


def _ensure_mesh_data_dir() -> None:
    try:
        MESH_DATA_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        log_debug("mesh", "ERROR", "Failed to create mesh data dir", error=str(e))


_NODE_CONFIG_LOCK = threading.RLock()


def read_node_config(*, check=None) -> Optional[NodeConfig]:
    """Read existing identity settings without initializing or repairing files."""
    _security._read_access(check)
    with _NODE_CONFIG_LOCK:
        _security._read_access(check)
        from node_settings import assert_available
        assert_available(NODE_CONFIG_PATH)
        try:
            try:
                data = _security.read_json(NODE_CONFIG_PATH, "node configuration", 65536, check=check)
            except FileNotFoundError as exc:
                if getattr(exc, "security_read_authority_failure", False):
                    raise
                _security._read_access(check)
                if _security.node_dependencies(DATA_DIR, check=check):
                    raise _security.SecurityStateUnavailable("node configuration")
                _security._read_access(check)
                return None
            _security._read_access(check)
            cfg = NodeConfig.model_validate(data, strict=True)
            if not cfg.node_id.strip() or not cfg.node_name.strip() or not cfg.created_at or not cfg.updated_at:
                raise ValueError("Missing node identity fields")
            _security._read_access(check)
            return cfg
        except Exception as exc:
            if getattr(exc, "security_read_authority_failure", False):
                raise
            _security._read_access(check)
            if isinstance(exc, _security.SecurityStateUnavailable):
                raise
            raise _security.SecurityStateUnavailable("node configuration") from exc


def update_node_settings(*, name=None, role=None, check=None):
    """Checked edits preserve the complete existing node identity document."""
    from node_settings import update_node_settings as update
    return update(name=name, role=role, check=check)


def save_node_config(cfg: NodeConfig) -> None:
    with _NODE_CONFIG_LOCK:
        existing = read_node_config()
        # Preserve additive fields written by newer versions of TLI.
        value = _security.read_json(NODE_CONFIG_PATH, "node configuration", 65536) if existing is not None else {}
        value.update(cfg.model_dump())
        _security.write_json(NODE_CONFIG_PATH, value, "node configuration", new=existing is None)


def load_node_config() -> NodeConfig:
    with _NODE_CONFIG_LOCK:
        existing = read_node_config()
        if existing is not None:
            return existing
        now = datetime.utcnow().isoformat() + "Z"
        cfg = NodeConfig(node_id=str(uuid.uuid4()), node_name=platform.node() or "TLI Node",
                         role="standalone", mesh_status="unpaired", created_at=now, updated_at=now)
        save_node_config(cfg)
        return cfg


# ============================================
#  Mesh directory / agent state persistence
# ============================================

MESH_DIRECTORY_LOCK = threading.RLock()


def _validate_mesh_directory(value):
    if (not isinstance(value, dict) or len(value) > 4096
            or any(not isinstance(k, str) or not k or len(k) > 128 or not isinstance(v, dict) for k, v in value.items())):
        raise _security.SecurityStateUnavailable("computer directory")
    return value


def load_mesh_directory(*, check=None) -> Dict[str, Any]:
    _security._read_access(check)
    with MESH_DIRECTORY_LOCK:
        _security._read_access(check)
        try:
            value = _validate_mesh_directory(_security.read_json(
                MESH_DIRECTORY_PATH, "computer directory", 32 * 1024 * 1024, check=check))
        except FileNotFoundError as exc:
            if getattr(exc, "security_read_authority_failure", False):
                raise
            _security._read_access(check)
            try:
                cfg = _security.read_json(NODE_CONFIG_PATH, "node configuration", 65536, check=check)
            except FileNotFoundError as exc:
                if getattr(exc, "security_read_authority_failure", False):
                    raise
                _security._read_access(check)
                cfg = {}
            _security._read_access(check)
            if (not isinstance(cfg, dict) or cfg.get("peer_trust_established") is True
                    or cfg.get("role") == "member" or cfg.get("host_device_id")):
                raise _security.SecurityStateUnavailable("computer directory")
            value = {}
        finally:
            _security._read_access(check)
        return value


def save_mesh_directory(devices: Dict[str, Any]) -> None:
    with MESH_DIRECTORY_LOCK:
        # An unreadable existing directory must never become an empty replacement.
        load_mesh_directory()
        _validate_mesh_directory(devices)
        if len(json.dumps(devices).encode("utf-8")) > 32 * 1024 * 1024:
            raise _security.SecurityStateUnavailable("computer directory")
        _security.write_json(MESH_DIRECTORY_PATH, devices, "computer directory")


def update_mesh_directory(callback):
    """Serialize one complete read/modify/write; callback must perform no I/O."""
    with MESH_DIRECTORY_LOCK:
        value = load_mesh_directory()
        result = callback(value)
        save_mesh_directory(value)
        return result


def load_agent_state() -> Dict[str, Any]:
    if not AGENT_STATE_PATH.exists():
        return {}
    try:
        with AGENT_STATE_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_agent_state(state: Dict[str, Any]) -> None:
    AGENT_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = Path(str(AGENT_STATE_PATH) + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    tmp_path.replace(AGENT_STATE_PATH)


def load_agent_tasks() -> Dict[str, Any]:
    if not AGENT_TASKS_PATH.exists():
        return {}
    try:
        with AGENT_TASKS_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_agent_tasks(state: Dict[str, Any]) -> None:
    AGENT_TASKS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = Path(str(AGENT_TASKS_PATH) + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    tmp_path.replace(AGENT_TASKS_PATH)


def enqueue_agent_task(device_id: str, task_type: str, payload: Optional[Dict[str, Any]] = None):
    now = datetime.utcnow().isoformat() + "Z"
    state = load_agent_tasks()
    tasks_for_node = state.get(device_id, [])
    task = {
        "task_id": f"task-{uuid.uuid4().hex[:12]}",
        "type": task_type,
        "payload": payload or {},
        "created_at": now,
        "status": "pending",
        "last_update_at": now,
        "result": None,
        "error": None,
    }
    tasks_for_node.append(task)
    state[device_id] = tasks_for_node
    save_agent_tasks(state)
    log_debug("mesh", "INFO", "Enqueued agent task", device_id=device_id, task_id=task["task_id"], task_type=task_type)
    return task


def get_next_agent_task_for(device_id: str):
    state = load_agent_tasks()
    tasks_for_node = state.get(device_id, [])
    if not tasks_for_node:
        return None
    now = datetime.utcnow().isoformat() + "Z"
    for entry in tasks_for_node:
        if entry.get("status") == "pending":
            entry["status"] = "running"
            entry["last_update_at"] = now
            save_agent_tasks(state)
            return entry
    return None


def update_agent_task_result(device_id: str, task_id: str, success: bool,
                              result: Optional[Dict[str, Any]] = None, error: Optional[str] = None):
    state = load_agent_tasks()
    tasks_for_node = state.get(device_id, [])
    if not tasks_for_node:
        return None
    now = datetime.utcnow().isoformat() + "Z"
    updated = None
    for entry in tasks_for_node:
        if entry.get("task_id") == task_id:
            entry["status"] = "completed" if success else "failed"
            entry["last_update_at"] = now
            entry["result"] = result
            entry["error"] = error
            updated = entry
            break
    if updated:
        state[device_id] = tasks_for_node
        save_agent_tasks(state)
    return updated


# ============================================
#  Device registry
# ============================================

def load_devices() -> Dict[str, Any]:
    if not os.path.exists(DEVICES_FILE):
        return {}
    try:
        with open(DEVICES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_devices(devices: Dict[str, Any]) -> None:
    tmp_path = Path(DEVICES_FILE + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(devices, f, indent=2)
    tmp_path.replace(Path(DEVICES_FILE))


# ============================================
#  Conversation history
# ============================================

# ── Conversation encryption ───────────────────────────────────────
# Chat history is encrypted at rest using a machine-local AES key
# (DPAPI-protected on Windows).  Existing plaintext files are migrated
# automatically on first save.

_CONV_KEY: Optional[bytes] = None


# ── Shared helper: encrypt/decrypt a single JSON line ────────────
# Used by both mesh chat (per-line JSONL) and any future append-style storage.

_CHAT_KEY: Optional[bytes] = None


def _saved_data_unavailable(label: str, cause: Exception):
    from fastapi import HTTPException
    return HTTPException(503, f"{label} could not be read or saved safely. Existing files were preserved. Open Data & Recovery and check this installation's storage and encryption keys before trying again.")


def _key_payloads(filename: str):
    """Only known store locations; never enumerate unrelated user folders."""
    if filename == "conversations_key.bin":
        yield Path(CONVERSATIONS_FILE), False
    elif filename == "memory_key.bin":
        for path in _known_store_paths(Path(DATA_DIR), ("memory_*.json",)):
            yield path, False
        for path in _known_store_paths(Path(DATA_DIR) / "intelligence", ("diagnostics-*.json", "images-*.json", "activity-review-*.json", "cleanup-receipts-*.json", "storage_history-*.json", "storage_history_settings-*.json", "storage_monitor-*.json", "cases-*.json")):
            yield path, False
    elif filename == "chat_key.bin":
        for path in _known_store_paths(MESH_DATA_DIR / "chat", ("*.jsonl",)):
            yield path, True
        for path in _known_store_paths(MESH_DATA_DIR / "secure_transfers", ("*.jsonl",)):
            yield path, True


def _known_store_paths(directory: Path, patterns):
    from fnmatch import fnmatchcase
    try:
        entries = os.scandir(directory)
    except FileNotFoundError:
        return
    with entries:
        for index, entry in enumerate(entries):
            if index >= 4096:
                raise ValueError("Saved-data directory is too large to establish a new key safely")
            if any(fnmatchcase(entry.name, pattern) for pattern in patterns):
                yield Path(entry.path)


def _may_create_store_key(filename: str) -> bool:
    """Missing keys must not silently divide an existing encrypted store.

    This runs only when its key is missing. Bounded known-file inspection
    permits legacy plaintext migration; unknown/oversized data fails closed.
    """
    remaining = 8 * 1024 * 1024
    for index, (path, jsonl) in enumerate(_key_payloads(filename)):
        if index >= 512:
            return False
        try:
            with path.open("rb") as stream:
                raw = stream.read(remaining + 1)
        except FileNotFoundError:
            continue
        except OSError:
            return False
        remaining -= len(raw)
        if remaining < 0:
            return False
        try:
            values = [json.loads(line) for line in raw.splitlines() if line.strip()] if jsonl else [json.loads(raw)]
        except (ValueError, UnicodeDecodeError):
            return False
        if any(not isinstance(value, dict) or value.get("_tli_enc") for value in values):
            return False
    return True


def _store_key(filename: str, *, create: bool = False) -> bytes:
    """Revalidate persisted keys instead of relying on a surviving RAM cache."""
    path = os.path.join(DATA_DIR, filename)
    try:
        try:
            return _dp.load_existing_key(path)
        except FileNotFoundError:
            if not create or not _may_create_store_key(filename):
                raise ValueError("Existing saved data has no usable persisted key")
            return _dp.get_or_create_key(path)
    except (OSError, ValueError) as exc:
        raise _saved_data_unavailable("Saved data", exc) from exc


def get_chat_key() -> bytes:
    """Return (and lazily initialise) the AES key for LAN chat message storage."""
    global _CHAT_KEY
    _CHAT_KEY = _store_key("chat_key.bin", create=True)
    return _CHAT_KEY


def encrypt_jsonl_line(obj: dict) -> str:
    """Encrypt a dict to a single encrypted JSONL line string (no trailing newline)."""
    key = get_chat_key()
    plaintext = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, plaintext, None)
    envelope = {"_tli_enc": 1, "data": base64.b64encode(nonce + ct).decode("ascii")}
    return json.dumps(envelope, ensure_ascii=False)


def decrypt_jsonl_line(line: str) -> Optional[dict]:
    """Decrypt an encrypted JSONL line.  Returns None on error.
    If the line is plaintext JSON (legacy), returns it as-is."""
    line = line.strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    if not obj.get("_tli_enc"):
        # Legacy plaintext line — return directly
        return obj
    try:
        blob = base64.b64decode(obj["data"])
        nonce, ct = blob[:12], blob[12:]
        plaintext = AESGCM(_store_key("chat_key.bin")).decrypt(nonce, ct, None)
        return json.loads(plaintext.decode("utf-8"))
    except Exception as exc:
        raise _saved_data_unavailable("LAN chat history", exc) from exc

def _get_conv_key() -> bytes:
    global _CONV_KEY
    _CONV_KEY = _store_key("conversations_key.bin", create=True)
    return _CONV_KEY


from functools import wraps as _wraps
from inspect import signature as _signature
from threading import RLock as _RLock

CONVERSATIONS_LOCK = _RLock()


def conversation_transaction(function):
    """Serialize short read/modify/write operations on the encrypted store."""
    @_wraps(function)
    def guarded(*args, **kwargs):
        with CONVERSATIONS_LOCK:
            return function(*args, **kwargs)
    guarded.__signature__ = _signature(function, eval_str=True)
    return guarded


def load_conversations(*, check=None) -> Dict[str, Any]:
    """Read existing history; optional authority stays bound through the read.

    Legacy internal callers retain their existing contract. Supplying a check
    does not initialize keys or grant authority to those no-check callers.
    """
    denied = None

    def authorize():
        nonlocal denied
        if denied is not None:
            raise denied
        if check is not None:
            try:
                check()
            except Exception as error:
                denied = error
                raise

    def read_existing():
        try:
            with open(CONVERSATIONS_FILE, "rb") as f:
                authorize()
                raw = f.read()
                authorize()

            data = json.loads(raw)
            authorize()
            if not isinstance(data, dict):
                raise ValueError("Conversation store must be an object")

            if data.get("_tli_enc"):
                blob = base64.b64decode(data["data"])
                nonce, ct = blob[:12], blob[12:]
                authorize()
                key = _store_key("conversations_key.bin")
                authorize()
                plaintext = AESGCM(key).decrypt(nonce, ct, None)
                authorize()
                data = json.loads(plaintext.decode("utf-8"))
                authorize()

            if not isinstance(data, dict) or any(not isinstance(value, dict) for value in data.values()):
                raise ValueError("Unsupported conversation structure")

            # Legacy plaintext remains unchanged until an explicit save.
            authorize()
            return data
        except FileNotFoundError:
            authorize()
            return {}
        except Exception as exc:
            authorize()
            raise _saved_data_unavailable("Conversation history", exc) from exc

    authorize()
    try:
        with CONVERSATIONS_LOCK:
            authorize()
            result = read_existing()
    except Exception:
        authorize()
        raise
    authorize()
    return result


@conversation_transaction
def save_conversations(conversations: Dict[str, Any], *, check=None) -> None:
    # Reject replacement of unreadable existing history even when a caller
    # supplies a fresh dictionary without first loading the current store.
    if check is not None:
        check()
    tmp_path = Path(CONVERSATIONS_FILE + ".tmp")
    staged = False
    try:
        previous = load_conversations()
        if check is not None:
            check()
        key = _get_conv_key()
        plaintext = json.dumps(conversations, ensure_ascii=False).encode("utf-8")
        nonce = os.urandom(12)
        ct = AESGCM(key).encrypt(nonce, plaintext, None)
        envelope = {
            "_tli_enc": 1,
            "data": base64.b64encode(nonce + ct).decode("ascii"),
        }
        if check is not None:
            check()
        with tmp_path.open("w", encoding="utf-8") as f:
            staged = True
            json.dump(envelope, f)
        if check is not None:
            check()
        tmp_path.replace(CONVERSATIONS_FILE)
    except Exception as exc:
        if check is not None:
            if staged:
                try:
                    tmp_path.unlink(missing_ok=True)
                except OSError:
                    pass
            # A slow or failed read/write must not reveal its result after
            # the operation's originally captured access has ended.
            check()
        if isinstance(exc, OSError):
            raise _saved_data_unavailable("Conversation history", exc) from exc
        raise
    if check is not None:
        check()
    from workspace_events import publish
    for ident in previous.keys() | conversations.keys():
        if previous.get(ident) != conversations.get(ident):
            item = conversations.get(ident) or previous.get(ident) or {}
            owner = item.get("user_id")
            publish("local" if owner == "bundled-ai" else owner, "conversation", ident)


# ============================================
#  Memory
# ============================================

# ── Memory encryption ─────────────────────────────────────────────
# Per-user AI memory (learned facts) is encrypted at rest using a
# machine-local AES key (DPAPI-protected on Windows).
# Existing plaintext memory files are migrated automatically on first save.

_MEM_KEY: Optional[bytes] = None

def _get_mem_key() -> bytes:
    global _MEM_KEY
    _MEM_KEY = _store_key("memory_key.bin", create=True)
    return _MEM_KEY


def memory_path_for_user(user_id: str) -> str:
    safe_id = "".join(c for c in user_id if c.isalnum() or c in "-_")
    return os.path.join(DATA_DIR, f"memory_{safe_id}.json")


def _normalize_memory_structure(raw: Dict[str, Any]) -> Dict[str, Any]:
    facts = raw.get("facts", [])
    normalized: List[Dict[str, Any]] = []
    if facts and isinstance(facts[0], str):
        for idx, s in enumerate(facts):
            normalized.append({
                "id": f"legacy-{idx}", "text": s, "category": "general",
                "device_id": None,
                "created_at": raw.get("last_updated"),
                "updated_at": raw.get("last_updated"),
                "deleted": False,
            })
    elif isinstance(facts, list):
        for f in facts:
            if isinstance(f, dict) and "text" in f:
                normalized.append({
                    **{k: f[k] for k in ("source", "report_id", "title", "chat_source", "note_links") if k in f},
                    "id": f.get("id") or f"f-{len(normalized)}",
                    "text": f.get("text", ""), "category": f.get("category") or "general",
                    "device_id": f.get("device_id"),
                    "created_at": f.get("created_at"),
                    "updated_at": f.get("updated_at"),
                    "deleted": bool(f.get("deleted", False)),
                })
    return {"facts": normalized, "last_updated": raw.get("last_updated")}


def load_memory(user_id: str, *, strict: bool = False) -> Dict[str, Any]:
    path = memory_path_for_user(user_id)
    try:
        with open(path, "rb") as f:
            raw = f.read()

        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("Memory must be an object")

        # Encrypted envelope: {"_tli_enc": 1, "data": "<base64>"}
        if data.get("_tli_enc"):
            blob = base64.b64decode(data["data"])
            nonce, ct = blob[:12], blob[12:]
            plaintext = AESGCM(_store_key("memory_key.bin")).decrypt(nonce, ct, None)
            data = json.loads(plaintext.decode("utf-8"))

        from memory_validation import validate_memory_structure
        validate_memory_structure(data)

        # Legacy plaintext — normalise and return; will be encrypted on next save
        return _normalize_memory_structure(data)
    except FileNotFoundError:
        return {"facts": [], "last_updated": None}
    except Exception as exc:
        raise _saved_data_unavailable("Notebook", exc) from exc


def save_memory(user_id: str, memory: Dict[str, Any]) -> None:
    path = memory_path_for_user(user_id)
    load_memory(user_id, strict=True)
    memory["last_updated"] = datetime.utcnow().isoformat()
    key = _get_mem_key()
    plaintext = json.dumps(memory, ensure_ascii=False).encode("utf-8")
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, plaintext, None)
    envelope = {
        "_tli_enc": 1,
        "data": base64.b64encode(nonce + ct).decode("ascii"),
    }
    tmp_path = Path(path + ".tmp")
    try:
        with tmp_path.open("w", encoding="utf-8") as f:
            json.dump(envelope, f)
        tmp_path.replace(Path(path))
    except OSError as exc:
        raise _saved_data_unavailable("Notebook", exc) from exc
    _discard_optional_session_state("intelligence.note_search", "invalidate", user_id)
    from workspace_events import publish
    publish(user_id, "notes")


def _auto_category_for_fact(text: str) -> str:
    lower = text.lower()
    if any(k in lower for k in ["favorite", "like", "love", "prefer"]):
        return "preference"
    if any(k in lower for k in ["birthday", "age", "name", "live in", "from "]):
        return "profile"
    if any(k in lower for k in ["work", "job", "career"]):
        return "work"
    if any(k in lower for k in ["music", "guitar", "song", "album", "studio"]):
        return "music"
    return "general"


def add_fact(user_id: str, text: str, category: Optional[str] = None,
             device_id: Optional[str] = None) -> Dict[str, Any]:
    memory = load_memory(user_id)
    facts = memory.get("facts", [])
    cat = (category or "").strip().lower() or _auto_category_for_fact(text)
    now = datetime.utcnow().isoformat()
    fact_id = f"f-{len(facts)}-{int(datetime.utcnow().timestamp())}"
    fact_obj = {
        "id": fact_id, "text": text, "category": cat, "device_id": device_id,
        "created_at": now, "updated_at": now, "deleted": False,
    }
    facts.append(fact_obj)
    memory["facts"] = facts
    save_memory(user_id, memory)
    return fact_obj


def select_relevant_facts(query: str, memory: Dict[str, Any],
                           device_id: Optional[str], limit: int = 8) -> List[Dict[str, Any]]:
    facts = memory.get("facts", [])
    if not facts:
        return []
    query_words = set(w for w in re.findall(r"\w+", query.lower()) if len(w) > 3)
    if not query_words:
        return [f for f in facts if not f.get("deleted")][-limit:]
    scored = []
    for fact in facts:
        if fact.get("deleted"):
            continue
        f_dev = fact.get("device_id")
        if device_id and f_dev not in (None, device_id):
            continue
        text = fact.get("text", "")
        f_words = set(w for w in re.findall(r"\w+", text.lower()) if len(w) > 3)
        score = len(query_words & f_words)
        if score == 0:
            continue
        if device_id and f_dev == device_id:
            score += 1
        scored.append((score, fact))
    if not scored:
        return [f for f in facts if not f.get("deleted") and not f.get("device_id")][:limit]
    scored.sort(key=lambda x: x[0], reverse=True)
    return [f for _, f in scored[:limit]]


# ============================================
#  File operation undo persistence
# ============================================

def save_last_file_operation(op: Dict[str, Any]) -> None:
    try:
        tmp = LAST_FILE_OP_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(op, indent=2), encoding="utf-8")
        tmp.replace(LAST_FILE_OP_PATH)
    except Exception:
        pass


def load_last_file_operation() -> Optional[Dict[str, Any]]:
    try:
        if not LAST_FILE_OP_PATH.exists():
            return None
        raw = LAST_FILE_OP_PATH.read_text(encoding="utf-8")
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


# ============================================
#  Model config
# ============================================

MODEL_CONFIG: Dict[str, Dict[str, str]] = {
    "deepseek": {"id": "deepseek-r1-distill-llama-8b", "label": "DeepSeek R1 Distill Llama 8B"},
}
DEFAULT_MODEL_KEY = "deepseek"


def load_model_config_from_disk() -> None:
    # Startup must fail clearly on damaged saved choices, rather than silently
    # using a different model. Missing files alone use immutable built-in defaults.
    read_model_settings()


def _publish_model_settings(document) -> None:
    import selection_settings as settings
    projected = settings.model_projection(document)
    globals().update(MODEL_CONFIG=projected["models"], DEFAULT_MODEL_KEY=projected["default_key"])


def read_model_settings(*, check=None):
    import selection_settings as settings
    with settings.LOCK:
        document = settings.read(MODEL_CONFIG_FILE, "models", check=check)
        settings._access(check)
        _publish_model_settings(document)
        result = settings.model_projection(document)
        settings._access(check)
        return result


def save_default_model(model_id, label=None, *, check=None):
    import selection_settings as settings
    document = settings.update(MODEL_CONFIG_FILE, "models",
        lambda value: settings.choose_model(value, model_id, label), check=check,
        on_commit=_publish_model_settings)
    projected = settings.model_projection(document)
    result = {"ok": True, "default_key": projected["default_key"],
              "model": projected["models"][projected["default_key"]]}
    settings._access(check)
    return result


def save_model_config_to_disk(*, check=None) -> None:
    """Compatibility writer for internal rehearsal callers; never delete presets."""
    from copy import deepcopy
    import selection_settings as settings
    with settings.LOCK:
        models, default = deepcopy(MODEL_CONFIG), DEFAULT_MODEL_KEY
        def merge(document):
            for key, row in models.items():
                document["models"].setdefault(key, {}).update(row)
            document["default_key"] = default
            if "default_model_key" in document:
                document["default_model_key"] = default
        settings.update(MODEL_CONFIG_FILE, "models", merge, check=check,
                        on_commit=_publish_model_settings)


# ============================================
#  System profile
# ============================================

SYSTEM_PROFILES = {
    "lite":     {"label": "Lite (low RAM/VRAM)",  "ui_defaults": {"temp": "0.7", "max_tokens": "512"}},
    "balanced": {"label": "Balanced (recommended)", "ui_defaults": {"temp": "0.7", "max_tokens": "768"}},
    "power":    {"label": "Power (big hardware)",   "ui_defaults": {"temp": "0.8", "max_tokens": "1200"}},
}

CURRENT_SYSTEM_PROFILE = "balanced"

SYSTEM_PROFILE_LIMITS = {
    "lite":     {"max_concurrent_jobs": 1, "heartbeat_interval_sec": 8,  "scan_interval_sec": 120},
    "balanced": {"max_concurrent_jobs": 2, "heartbeat_interval_sec": 5,  "scan_interval_sec": 60},
    "power":    {"max_concurrent_jobs": 4, "heartbeat_interval_sec": 3,  "scan_interval_sec": 30},
}


def get_active_system_limits() -> Dict[str, int]:
    return SYSTEM_PROFILE_LIMITS.get(CURRENT_SYSTEM_PROFILE, SYSTEM_PROFILE_LIMITS["balanced"])


def load_system_profile_from_disk() -> None:
    read_profile_settings()


def _publish_profile_settings(document) -> None:
    global CURRENT_SYSTEM_PROFILE
    CURRENT_SYSTEM_PROFILE = document["profile"].strip().lower()


def read_profile_settings(*, check=None):
    from copy import deepcopy
    import selection_settings as settings
    with settings.LOCK:
        document = settings.read(SYSTEM_PROFILE_FILE, "profile", check=check)
        settings._access(check)
        _publish_profile_settings(document)
        current = document["profile"].strip().lower()
        result = {"current": current, "profiles": deepcopy(SYSTEM_PROFILES),
                  "ui_defaults": deepcopy(SYSTEM_PROFILES[current]["ui_defaults"]),
                  "limits": dict(SYSTEM_PROFILE_LIMITS[current])}
        settings._access(check)
        return result


def save_profile(profile, *, check=None):
    import selection_settings as settings
    document = settings.update(SYSTEM_PROFILE_FILE, "profile",
        lambda value: settings.choose_profile(value, profile), check=check,
        on_commit=_publish_profile_settings)
    settings._access(check)
    return {"ok": True, "current": document["profile"]}


def save_system_profile_to_disk(*, check=None) -> None:
    import selection_settings as settings
    with settings.LOCK:
        save_profile(CURRENT_SYSTEM_PROFILE, check=check)


# ============================================
#  Protected‑path safety helpers
# ============================================

WINDOWS_PROTECTED_PREFIXES = [
    r"c:\windows", r"c:\program files", r"c:\program files (x86)",
    r"c:\programdata", r"c:\$recycle.bin", r"c:\system volume information",
]
WINDOWS_PROTECTED_FILES = [r"c:\hiberfil.sys", r"c:\pagefile.sys"]
DARWIN_PROTECTED_PREFIXES = ["/system", "/usr", "/bin", "/sbin", "/private", "/library", "/applications", "/volumes/recovery"]
POSIX_PROTECTED_PREFIXES = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64",
                            "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var", "/snap", "/opt"]


def is_protected_system_path(path: Path) -> bool:
    try:
        p = path.resolve()
    except Exception:
        p = path
    try:
        home = Path.home().resolve()
        if p == home or home in p.parents:
            return False
    except Exception:
        pass
    raw = str(p)
    lower = raw.replace("\\", "/").lower()
    if os.name == "nt":
        for f in WINDOWS_PROTECTED_FILES:
            if lower == f.replace("\\", "/").lower():
                return True
        for prefix in WINDOWS_PROTECTED_PREFIXES:
            lp = prefix.replace("\\", "/").lower()
            if lower == lp or lower.startswith(lp + "/"):
                return True
        return False
    if sys.platform == "darwin":
        for prefix in DARWIN_PROTECTED_PREFIXES:
            lp = prefix.lower()
            if lower == lp or lower.startswith(lp + "/"):
                return True
        return False
    for prefix in POSIX_PROTECTED_PREFIXES:
        lp = prefix.lower()
        if lower == lp or lower.startswith(lp + "/"):
            return True
    return False


# ============================================
#  Shelly registry
# ============================================

def load_shelly_registry() -> List[Dict[str, Any]]:
    from shelly_store import read
    return read(SHELLY_REGISTRY_PATH)


def save_shelly_registry(devices: List[Dict[str, Any]], *, check=None, **options) -> None:
    from shelly_store import write
    write(SHELLY_REGISTRY_PATH, devices, check=check, **options)


# ============================================
#  PIN lock config
# ============================================

_PIN_CONFIG_LOCK = threading.RLock()


def read_pin_config() -> Dict[str, Any]:
    """Absent new PINs and explicitly disabled PINs are the only open states."""
    try:
        data = _security.read_json(PIN_CONFIG_FILE, "PIN configuration", 65536, reject_duplicates=True)
    except FileNotFoundError:
        if _security.companion_dependencies(DATA_DIR):
            raise _security.SecurityStateUnavailable("PIN configuration")
        return {"enabled": False}
    if isinstance(data, dict):
        if "attempts" in data:
            _validate_pin_attempts(data["attempts"])
        if data.get("enabled") is False and "hash" not in data and "salt" not in data:
            return {"enabled": False}
        if all(isinstance(data.get(k), str) and re.fullmatch(r"[0-9a-f]{64}", data[k]) for k in ("hash", "salt")) and data.get("enabled", True) is True:
            result = {"enabled": True, "hash": data["hash"], "salt": data["salt"]}
            if "attempts" in data:
                result["attempts"] = dict(data["attempts"])
            return result
    raise _security.SecurityStateUnavailable("PIN configuration")


def load_pin_config() -> Dict[str, Any]:
    return read_pin_config()


def _validate_pin_attempts(value) -> None:
    import math
    if (not isinstance(value, dict) or set(value) != {"failures", "blocked_until"}
            or type(value["failures"]) is not int or not 0 <= value["failures"] <= 32
            or type(value["blocked_until"]) not in (int, float)
            or not 0 <= value["blocked_until"] <= 32503680000
            or not math.isfinite(value["blocked_until"])
            or value["failures"] < 5 and value["blocked_until"] != 0
            or value["failures"] >= 5 and value["blocked_until"] == 0):
        raise _security.SecurityStateUnavailable("PIN configuration")


def record_pin_attempts(failures: int, blocked_until: float) -> None:
    """Preserve credentials and compatible metadata while journaling attempts."""
    with _PIN_CONFIG_LOCK:
        cfg = read_pin_config()
        if not cfg["enabled"]:
            raise _security.SecurityStateUnavailable("PIN configuration")
        attempts = {"failures": failures, "blocked_until": blocked_until}
        _validate_pin_attempts(attempts)
        data = _security.read_json(PIN_CONFIG_FILE, "PIN configuration", 65536, reject_duplicates=True)
        data["attempts"] = attempts
        _security.write_json(PIN_CONFIG_FILE, data, "PIN configuration")


def save_pin_config(pin_hash: str, salt: str) -> None:
    with _PIN_CONFIG_LOCK:
        read_pin_config()
        if not all(isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) for v in (pin_hash, salt)):
            raise ValueError("Invalid PIN hash or salt")
        _security.write_json(PIN_CONFIG_FILE, {"hash": pin_hash, "salt": salt}, "PIN configuration", new=not PIN_CONFIG_FILE.exists())


def clear_pin_config(*, check=None) -> None:
    with _PIN_CONFIG_LOCK:
        read_pin_config()
        if check is not None:
            check()
        # An explicit marker distinguishes authorized removal from lost settings.
        _security.write_json(PIN_CONFIG_FILE, {"enabled": False}, "PIN configuration",
                             new=not PIN_CONFIG_FILE.exists(), before_commit=check)


# ============================================
#  License
# ============================================

def load_license() -> Dict[str, Any]:
    """Read preserved license metadata; only a fresh missing file is empty."""
    from license_store import read
    return read(LICENSE_FILE)


def save_license(data: Dict[str, Any], *, check=None, **options) -> None:
    from license_store import write
    write(LICENSE_FILE, data, check=check, **options)


# ============================================
#  Ambient alerts
# ============================================

ALERTS_FILE = Path(os.path.join(DATA_DIR, "tli_alerts.json"))


def load_alerts(*, check=None) -> List[Dict[str, Any]]:
    from alert_store import read
    return read(ALERTS_FILE, check=check)


def save_alerts(alerts: List[Dict[str, Any]], *, check=None) -> None:
    """Compatibility full replacement; producer edits use serialized helpers."""
    from alert_store import save
    save(ALERTS_FILE, alerts, check=check)


def add_alert(kind: str, message: str, detail: str = "", severity: str = "warn", *, check=None) -> Optional[Dict[str, Any]]:
    """Add alert unless one with the same kind is already active. Returns None if deduped."""
    from alert_store import add
    return add(ALERTS_FILE, kind, message, detail, severity, check=check)


def dismiss_alert(alert_id: str, *, check=None) -> bool:
    from alert_store import dismiss
    return dismiss(ALERTS_FILE, alert_id, check=check)


def resolve_alert(kind: str, *, check=None) -> None:
    """Auto-dismiss an active alert when its condition clears."""
    from alert_store import resolve
    resolve(ALERTS_FILE, kind, check=check)


def dismiss_all_alerts(*, check=None) -> int:
    """Dismiss the current active rows in one producer-safe transaction."""
    from alert_store import dismiss_all
    return dismiss_all(ALERTS_FILE, check=check)


# ============================================
#  Session store (in-memory; cleared on restart)
# ============================================

SESSION_TTL_SECONDS: int = 86_400  # 24 hours

# token → {"expiry": float, "user_id": str}
_active_sessions: Dict[str, Dict[str, Any]] = {}
_session_revocation_epoch = object()


def session_revocation_epoch() -> object:
    """Process-local invalidation marker, never an access credential.

    Long-lived local invitations also need revocation when no PIN cookie existed
    at issuance. Comparing only current PIN mode misses off/on/off transitions.
    """
    return _session_revocation_epoch


def create_session_token(user_id: str = "local") -> str:
    token = _secrets.token_hex(32)
    _active_sessions[token] = {"expiry": time.time() + SESSION_TTL_SECONDS, "user_id": user_id}
    return token


def validate_session_token(token: str) -> bool:
    entry = _active_sessions.get(token)
    if entry is None:
        return False
    if time.time() > entry["expiry"]:
        _active_sessions.pop(token, None)
        return False
    return True


def get_session_user_id(token: str) -> str:
    """Return the user_id stored with this session token, or 'local' as fallback."""
    entry = _active_sessions.get(token)
    if entry is None:
        return "local"
    return entry.get("user_id", "local")


def revoke_all_sessions() -> None:
    global _session_revocation_epoch
    _session_revocation_epoch = object()
    _active_sessions.clear()
    _discard_optional_session_state("intelligence.note_search", "clear_browser")
    _discard_optional_session_state("mcp_bridge", "revoke_all_grants")
    _discard_optional_session_state("home_assistant_bridge", "revoke_all_connections")
    _discard_optional_session_state("pihole_bridge", "revoke_all_connections")
    _discard_optional_session_state("pihole_self_service", "revoke_all_connections")
    _discard_optional_session_state("mcp_client", "revoke_all_connections")
    _discard_optional_session_state("storage_jobs", "revoke_all_sessions")
    _discard_optional_session_state("voice_service", "revoke_all_sessions")


def revoke_session_token(token: str) -> None:
    """Revoke one browser session without affecting other browsers or phones."""
    _active_sessions.pop(token, None)
    _discard_optional_session_state("intelligence.note_search", "clear_browser", token)
    _discard_optional_session_state("mcp_bridge", "revoke_browser_session", token)
    _discard_optional_session_state("home_assistant_bridge", "revoke_browser_session", token)
    _discard_optional_session_state("pihole_bridge", "revoke_browser_session", token)
    _discard_optional_session_state("mcp_client", "revoke_browser_session", token)
    _discard_optional_session_state("storage_jobs", "revoke_browser_session", token)
    _discard_optional_session_state("voice_service", "revoke_browser_session", token)


def _discard_optional_session_state(module_name: str, method: str, *args) -> None:
    """Clear already-loaded temporary state without importing optional services.

    Revoking a session or saving a note must succeed even if an optional service
    has failed. Those services also revalidate session and source identity before
    returning results; this hook eagerly releases their derived state.
    """
    import sys
    module = sys.modules.get(module_name)
    if module is not None:
        try:
            getattr(module, method)(*args)
        except Exception:
            pass
