"""Frozen historical Actions JSON/JSONL reader for compatibility tests only.

Source: backend/routers/actions_engine.py
Commit: a5f2104f134a0d0fe482e4b65acadd515699d2fb
Git blob: eb4e9c87a5fd908158499b52162d7ea74976025f
Source SHA-256: 2149d12d45cfc609940ed81706150a44f5d0b1c06ca5282cef62a0a57a6e4983

The context initializer and read-only dependency closure below are copied
verbatim from that source; only route decorators and unrelated code are omitted.
This preserves the old file contract without importing routers, starting services
or conferring authority on current HTTP endpoints. Do not update this fixture to
match current application code.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

_CTX: Dict[str, Any] = {
    "data_dir": None,
    "shelly_registry_path": None,
    "log_debug": None,
    "shelly_driver": None,
    "games_detect_best": None,
    "home_power_runtime": None,
}

def init_actions_engine(*, data_dir: Path, shelly_registry_path: Path, shelly_driver, log_debug, games_detect_best=None, home_power_runtime=None):
    _CTX["data_dir"] = Path(data_dir)
    _CTX["shelly_registry_path"] = Path(shelly_registry_path)
    _CTX["shelly_driver"] = shelly_driver
    _CTX["log_debug"] = log_debug
    _CTX["games_detect_best"] = games_detect_best
    _CTX["home_power_runtime"] = home_power_runtime

def _paths():
    d = _CTX.get("data_dir")
    if not d:
        raise RuntimeError("Actions engine not initialized (data_dir missing).")
    actions_path = Path(d) / "actions.json"
    receipts_path = Path(d) / "actions_receipts.jsonl"
    return actions_path, receipts_path

def _is_initialized() -> bool:
    return bool(_CTX.get("data_dir"))

def _load_json(path: Path, default):
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8") or "null") or default
    except Exception:
        return default
    return default

def actions_list():
    if not _is_initialized():
        return {"actions": [], "triggers": []}
    actions_path, _ = _paths()
    data = _load_json(actions_path, default={"actions": [], "triggers": []})
    return data

def actions_receipts(limit: int = 50):
    if not _is_initialized():
        return {"items": []}
    _, receipts_path = _paths()
    if not receipts_path.exists():
        return {"items": []}
    items = []
    try:
        with receipts_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    items.append(json.loads(line))
                except Exception:
                    continue
        items = items[-max(1, min(200, int(limit))):]
    except Exception:
        items = []
    return {"items": items}
