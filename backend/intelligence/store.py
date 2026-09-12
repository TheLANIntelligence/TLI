"""Small encrypted sidecar stores; existing TLI data formats stay in place."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import tli_state as S

LOCK = threading.RLock()


def root() -> Path:
    path = Path(S.DATA_DIR) / "intelligence"
    path.mkdir(parents=True, exist_ok=True)
    return path


def private_path(user: str, name: str, *, create: bool = True) -> Path:
    directory = root() if create else Path(S.DATA_DIR) / "intelligence"
    return directory / f"{name}-{hashlib.sha256(user.encode()).hexdigest()}.json"


def read_private(user: str, name: str, default):
    path = private_path(user, name, create=False)
    try:
        envelope = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except Exception as exc:
        raise S._saved_data_unavailable("Saved reports and images", exc) from exc
    try:
        if not isinstance(envelope, dict) or envelope.get("_tli_enc") != 1:
            raise ValueError("Unsupported encrypted store")
        blob = base64.b64decode(envelope["data"])
        raw = AESGCM(S._store_key("memory_key.bin")).decrypt(blob[:12], blob[12:], f"{name}:{user}".encode())
        result = json.loads(raw)
        if not isinstance(result, dict if default is None else type(default)):
            raise ValueError("Unsupported saved data structure")
        return result
    except Exception as exc:
        raise S._saved_data_unavailable("Saved reports and images", exc) from exc


def write_private(user: str, name: str, value) -> None:
    with LOCK:
        read_private(user, name, [] if isinstance(value, list) else {})
        nonce = os.urandom(12)
        encrypted = AESGCM(S._get_mem_key()).encrypt(nonce, json.dumps(value, ensure_ascii=False).encode(), f"{name}:{user}".encode())
        path = private_path(user, name)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            S.save_json_file(path, {"_tli_enc": 1, "data": base64.b64encode(nonce + encrypted).decode()})
        except OSError as exc:
            raise S._saved_data_unavailable("Saved reports and images", exc) from exc
