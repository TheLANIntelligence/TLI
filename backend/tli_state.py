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

TLI_VERSION = "1.3.5-beta"

# ============================================
#  LM Studio / HTTP config
# ============================================

LM_STUDIO_URL        = "http://localhost:1234/v1/chat/completions"
LM_STUDIO_MODELS_URL = "http://localhost:1234/v1/models"

def load_lm_studio_config_from_disk() -> None:
    """Override LM_STUDIO_URL/MODELS_URL if a saved config exists (written by onboarding or settings)."""
    global LM_STUDIO_URL, LM_STUDIO_MODELS_URL
    cfg_path = Path(DATA_DIR) / "lm_studio_config.json"
    if not cfg_path.exists():
        return
    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
        if data.get("chat_url"):
            LM_STUDIO_URL = data["chat_url"]
        if data.get("models_url"):
            LM_STUDIO_MODELS_URL = data["models_url"]
    except Exception:
        pass

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


def save_node_config(cfg: NodeConfig) -> None:
    _ensure_mesh_data_dir()
    tmp_path = NODE_CONFIG_PATH.with_suffix(".tmp")
    try:
        with tmp_path.open("w", encoding="utf-8") as f:
            json.dump(cfg.dict(), f, indent=2)
        tmp_path.replace(NODE_CONFIG_PATH)
    except Exception as e:
        log_debug("mesh", "ERROR", "Failed to save node_config.json", error=str(e))


def load_node_config() -> NodeConfig:
    _ensure_mesh_data_dir()
    if NODE_CONFIG_PATH.exists():
        try:
            with NODE_CONFIG_PATH.open("r", encoding="utf-8") as f:
                data = json.load(f)
            return NodeConfig(**data)
        except Exception as e:
            log_debug("mesh", "ERROR", "Failed to load node_config.json; regenerating", error=str(e))

    now = datetime.utcnow().isoformat() + "Z"
    cfg = NodeConfig(
        node_id=str(uuid.uuid4()),
        node_name=platform.node() or "TLI Node",
        role="standalone",
        mesh_status="unpaired",
        created_at=now,
        updated_at=now,
    )
    save_node_config(cfg)
    return cfg


# ============================================
#  Mesh directory / agent state persistence
# ============================================

def load_mesh_directory() -> Dict[str, Any]:
    if not MESH_DIRECTORY_PATH.exists():
        return {}
    try:
        with MESH_DIRECTORY_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_mesh_directory(devices: Dict[str, Any]) -> None:
    tmp_path = Path(str(MESH_DIRECTORY_PATH) + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(devices, f, indent=2)
    tmp_path.replace(MESH_DIRECTORY_PATH)


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

def get_chat_key() -> bytes:
    """Return (and lazily initialise) the AES key for LAN chat message storage."""
    global _CHAT_KEY
    if _CHAT_KEY is None:
        _CHAT_KEY = _dp.get_or_create_key(
            os.path.join(DATA_DIR, "chat_key.bin")
        )
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
        plaintext = AESGCM(get_chat_key()).decrypt(nonce, ct, None)
        return json.loads(plaintext.decode("utf-8"))
    except Exception:
        return None

def _get_conv_key() -> bytes:
    global _CONV_KEY
    if _CONV_KEY is None:
        _CONV_KEY = _dp.get_or_create_key(
            os.path.join(DATA_DIR, "conversations_key.bin")
        )
    return _CONV_KEY


def load_conversations() -> Dict[str, Any]:
    if not os.path.exists(CONVERSATIONS_FILE):
        return {}
    try:
        with open(CONVERSATIONS_FILE, "rb") as f:
            raw = f.read()

        # Try JSON parse first
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

        if not isinstance(data, dict):
            return {}

        # Encrypted envelope: {"_tli_enc": 1, "data": "<base64>"}
        if data.get("_tli_enc"):
            blob = base64.b64decode(data["data"])
            nonce, ct = blob[:12], blob[12:]
            plaintext = AESGCM(_get_conv_key()).decrypt(nonce, ct, None)
            decrypted = json.loads(plaintext.decode("utf-8"))
            return decrypted if isinstance(decrypted, dict) else {}

        # Legacy plaintext — return as-is; will be encrypted on next save
        return data
    except Exception:
        return {}


def save_conversations(conversations: Dict[str, Any]) -> None:
    key = _get_conv_key()
    plaintext = json.dumps(conversations, ensure_ascii=False).encode("utf-8")
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, plaintext, None)
    envelope = {
        "_tli_enc": 1,
        "data": base64.b64encode(nonce + ct).decode("ascii"),
    }
    tmp_path = Path(CONVERSATIONS_FILE + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(envelope, f)
    tmp_path.replace(CONVERSATIONS_FILE)


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
    if _MEM_KEY is None:
        _MEM_KEY = _dp.get_or_create_key(
            os.path.join(DATA_DIR, "memory_key.bin")
        )
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
                "created_at": raw.get("last_updated") or datetime.utcnow().isoformat(),
                "updated_at": raw.get("last_updated") or datetime.utcnow().isoformat(),
                "deleted": False,
            })
    elif isinstance(facts, list):
        for f in facts:
            if isinstance(f, dict) and "text" in f:
                normalized.append({
                    "id": f.get("id") or f"f-{len(normalized)}",
                    "text": f.get("text", ""), "category": f.get("category") or "general",
                    "device_id": f.get("device_id"),
                    "created_at": f.get("created_at") or datetime.utcnow().isoformat(),
                    "updated_at": f.get("updated_at") or datetime.utcnow().isoformat(),
                    "deleted": bool(f.get("deleted", False)),
                })
    return {"facts": normalized, "last_updated": raw.get("last_updated")}


def load_memory(user_id: str) -> Dict[str, Any]:
    path = memory_path_for_user(user_id)
    if not os.path.exists(path):
        return {"facts": [], "last_updated": None}
    try:
        with open(path, "rb") as f:
            raw = f.read()

        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {"facts": [], "last_updated": None}

        if not isinstance(data, dict):
            return {"facts": [], "last_updated": None}

        # Encrypted envelope: {"_tli_enc": 1, "data": "<base64>"}
        if data.get("_tli_enc"):
            blob = base64.b64decode(data["data"])
            nonce, ct = blob[:12], blob[12:]
            plaintext = AESGCM(_get_mem_key()).decrypt(nonce, ct, None)
            decrypted = json.loads(plaintext.decode("utf-8"))
            return _normalize_memory_structure(decrypted if isinstance(decrypted, dict) else {})

        # Legacy plaintext — normalise and return; will be encrypted on next save
        return _normalize_memory_structure(data)
    except Exception:
        return {"facts": [], "last_updated": None}


def save_memory(user_id: str, memory: Dict[str, Any]) -> None:
    path = memory_path_for_user(user_id)
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
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(envelope, f)
    tmp_path.replace(Path(path))


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
    global MODEL_CONFIG, DEFAULT_MODEL_KEY
    if not MODEL_CONFIG_FILE.exists():
        return
    try:
        raw = MODEL_CONFIG_FILE.read_text(encoding="utf-8")
        data = json.loads(raw)
        models = data.get("models")
        default_key = data.get("default_key") or data.get("default_model_key")
        if isinstance(models, dict) and models:
            new_config: Dict[str, Dict[str, str]] = {}
            for key, val in models.items():
                if not isinstance(val, dict):
                    continue
                model_id = val.get("id")
                if not model_id:
                    continue
                new_config[key] = {"id": model_id, "label": val.get("label") or key}
            if new_config:
                MODEL_CONFIG = new_config
        if isinstance(default_key, str) and default_key in MODEL_CONFIG:
            DEFAULT_MODEL_KEY = default_key
        log_debug("models", "INFO", "Loaded model config from disk",
                  default_key=DEFAULT_MODEL_KEY, keys=list(MODEL_CONFIG.keys()))
    except Exception as e:
        log_debug("models", "ERROR", "Failed to load model config from disk", error=str(e))


def save_model_config_to_disk() -> None:
    try:
        payload = {"models": MODEL_CONFIG, "default_key": DEFAULT_MODEL_KEY}
        MODEL_CONFIG_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        log_debug("models", "INFO", "Saved model config to disk",
                  default_key=DEFAULT_MODEL_KEY, keys=list(MODEL_CONFIG.keys()))
    except Exception as e:
        log_debug("models", "ERROR", "Failed to save model config to disk", error=str(e))


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
    global CURRENT_SYSTEM_PROFILE
    try:
        if not SYSTEM_PROFILE_FILE.exists():
            return
        raw = SYSTEM_PROFILE_FILE.read_text(encoding="utf-8")
        data = json.loads(raw) if raw else {}
        prof = (data.get("profile") or "").strip().lower()
        if prof in SYSTEM_PROFILES:
            CURRENT_SYSTEM_PROFILE = prof
            log_debug("system", "INFO", "Loaded system profile", profile=prof)
    except Exception as e:
        log_debug("system", "ERROR", "Failed to load system profile", error=str(e))


def save_system_profile_to_disk() -> None:
    try:
        payload = {"profile": CURRENT_SYSTEM_PROFILE}
        SYSTEM_PROFILE_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        log_debug("system", "INFO", "Saved system profile", profile=CURRENT_SYSTEM_PROFILE)
    except Exception as e:
        log_debug("system", "ERROR", "Failed to save system profile", error=str(e))


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
    if SHELLY_REGISTRY_PATH.exists():
        try:
            with SHELLY_REGISTRY_PATH.open("r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data
        except Exception:
            pass
    return []


def save_shelly_registry(devices: List[Dict[str, Any]]) -> None:
    try:
        SHELLY_REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
        with SHELLY_REGISTRY_PATH.open("w", encoding="utf-8") as f:
            json.dump(devices, f, indent=2)
    except Exception:
        pass


# ============================================
#  PIN lock config
# ============================================

def load_pin_config() -> Dict[str, Any]:
    """Return {enabled, hash, salt} or {enabled: False}."""
    if not PIN_CONFIG_FILE.exists():
        return {"enabled": False}
    try:
        data = json.loads(PIN_CONFIG_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("hash") and data.get("salt"):
            return {"enabled": True, "hash": data["hash"], "salt": data["salt"]}
    except Exception:
        pass
    return {"enabled": False}


def save_pin_config(pin_hash: str, salt: str) -> None:
    tmp = PIN_CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"hash": pin_hash, "salt": salt}, indent=2), encoding="utf-8")
    tmp.replace(PIN_CONFIG_FILE)


def clear_pin_config() -> None:
    try:
        if PIN_CONFIG_FILE.exists():
            PIN_CONFIG_FILE.unlink()
    except Exception:
        pass


# ============================================
#  License
# ============================================

def load_license() -> Dict[str, Any]:
    """Return stored license dict, e.g. {"key": "TLI1-..."}. Empty dict if none."""
    if not LICENSE_FILE.exists():
        return {}
    try:
        data = json.loads(LICENSE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_license(data: Dict[str, Any]) -> None:
    tmp = LICENSE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(LICENSE_FILE)


# ============================================
#  Ambient alerts
# ============================================

ALERTS_FILE = Path(os.path.join(DATA_DIR, "tli_alerts.json"))


def load_alerts() -> List[Dict[str, Any]]:
    return load_json_file(ALERTS_FILE, default=[])


def save_alerts(alerts: List[Dict[str, Any]]) -> None:
    save_json_file(ALERTS_FILE, alerts)


def add_alert(kind: str, message: str, detail: str = "", severity: str = "warn") -> Optional[Dict[str, Any]]:
    """Add alert unless one with the same kind is already active. Returns None if deduped."""
    alerts = load_alerts()
    for a in alerts:
        if a.get("kind") == kind and not a.get("dismissed"):
            return None  # already active, don't double-up
    alert: Dict[str, Any] = {
        "id": f"alert-{uuid.uuid4().hex[:10]}",
        "kind": kind,
        "message": message,
        "detail": detail,
        "severity": severity,
        "created_at": now_iso(),
        "dismissed": False,
    }
    alerts.append(alert)
    save_alerts(alerts)
    return alert


def dismiss_alert(alert_id: str) -> bool:
    alerts = load_alerts()
    for a in alerts:
        if a.get("id") == alert_id:
            a["dismissed"] = True
            save_alerts(alerts)
            return True
    return False


def resolve_alert(kind: str) -> None:
    """Auto-dismiss an active alert when its condition clears."""
    alerts = load_alerts()
    changed = False
    for a in alerts:
        if a.get("kind") == kind and not a.get("dismissed"):
            a["dismissed"] = True
            changed = True
    if changed:
        save_alerts(alerts)


# ============================================
#  Session store (in-memory; cleared on restart)
# ============================================

SESSION_TTL_SECONDS: int = 86_400  # 24 hours

# token → {"expiry": float, "user_id": str}
_active_sessions: Dict[str, Dict[str, Any]] = {}


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
    _active_sessions.clear()
