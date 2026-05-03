from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from pathlib import Path
from typing import Any, Dict, List, Optional
from datetime import datetime
import json
import uuid
import re

router = APIRouter()

# -------- runtime context (injected by main.py) --------
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

def _nowz() -> str:
    return datetime.utcnow().isoformat() + "Z"

def _log(level: str, msg: str, **extra):
    fn = _CTX.get("log_debug")
    try:
        if callable(fn):
            fn("actions", level, msg, **extra)
    except Exception:
        pass

def _paths():
    d = _CTX.get("data_dir")
    if not d:
        raise RuntimeError("Actions engine not initialized (data_dir missing).")
    actions_path = Path(d) / "actions.json"
    receipts_path = Path(d) / "actions_receipts.jsonl"
    return actions_path, receipts_path

def _is_initialized() -> bool:
    return bool(_CTX.get("data_dir"))

def _ensure_initialized():
    if not _is_initialized():
        # Use 503 so UI can show "backend not ready" rather than 500.
        raise HTTPException(status_code=503, detail="Actions engine not initialized yet. Restart backend or check init_actions_engine in main.py.")

def _load_json(path: Path, default):
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8") or "null") or default
    except Exception:
        return default
    return default

def _save_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    tmp.replace(path)

def _append_receipt(receipt: Dict[str, Any]):
    _, receipts_path = _paths()
    receipts_path.parent.mkdir(parents=True, exist_ok=True)
    with receipts_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(receipt) + "\n")

def _norm(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"[^\w\s\-]", "", s)  # strips emojis/punct for matching
    return s

def _read_shelly_registry() -> List[Dict[str, Any]]:
    p: Path = _CTX.get("shelly_registry_path")
    if not p:
        return []
    data = _load_json(p, default=[])
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    return []

def _build_device_index():
    """
    We do NOT change your registry format.
    We only build a tolerant index so any user naming still works.
    """
    reg = _read_shelly_registry()
    by_key = []
    for d in reg:
        name = str(d.get("name") or d.get("label") or "").strip()
        ip = str(d.get("ip") or d.get("host") or "").strip()
        relay = int(d.get("relay") or 0)
        if not ip:
            continue
        display = name or ip
        candidates = set()
        candidates.add(_norm(display))
        candidates.add(_norm(ip))
        # also add "name without spaces" variant
        candidates.add(_norm(display).replace(" ", ""))
        by_key.append((candidates, d, display, ip, relay))
    return by_key

def _resolve_device(query: str) -> Dict[str, Any]:
    """
    Query can be a name OR an IP OR messy text.
    Returns the registry dict.
    """
    q = _norm(query)
    if not q:
        raise HTTPException(status_code=400, detail="Device query was empty.")
    idx = _build_device_index()

    # exact-ish
    for keys, d, display, ip, relay in idx:
        if q in keys:
            return d

    # contains
    for keys, d, display, ip, relay in idx:
        for k in keys:
            if k and (q in k or k in q):
                return d

    raise HTTPException(status_code=404, detail=f"No Shelly device matched '{query}'.")

# ---------------- models ----------------
class ActionStep(BaseModel):
    type: str = Field(..., description="Step type: 'shelly.switch' or 'homepower.execute'")
    device: Optional[str] = Field(None, description="Device name or IP (shelly.switch only)")
    value: Optional[str] = Field(None, description="'on' or 'off' for shelly.switch")
    device_id: Optional[str] = Field(None, description="homepower device_id (homepower.execute only)")
    capability: Optional[str] = Field(None, description="capability string (homepower.execute only)")

class ActionModel(BaseModel):
    id: str
    name: str
    steps: List[ActionStep] = []
    enabled: bool = True
    created_at: str
    updated_at: str

class ApproveRequest(BaseModel):
    name: str
    steps: List[ActionStep] = []
    # optional trigger support (keep simple now; we can expand later)
    trigger: Optional[Dict[str, Any]] = None

# ---------------- routes ----------------
@router.get("/actions/list")
def actions_list():
    if not _is_initialized():
        return {"actions": [], "triggers": []}
    actions_path, _ = _paths()
    data = _load_json(actions_path, default={"actions": [], "triggers": []})
    return data

@router.get("/actions/receipts")
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

@router.post("/actions/approve")
def actions_approve(req: ApproveRequest):
    _ensure_initialized()
    actions_path, _ = _paths()
    store = _load_json(actions_path, default={"actions": [], "triggers": []})
    if not isinstance(store, dict):
        store = {"actions": [], "triggers": []}

    action_id = "act_" + uuid.uuid4().hex[:10]
    now = _nowz()
    action = {
        "id": action_id,
        "name": (req.name or "New Action").strip(),
        "steps": [s.model_dump() for s in (req.steps or [])],
        "enabled": True,
        "created_at": now,
        "updated_at": now,
    }
    store.setdefault("actions", []).append(action)

    # Optional trigger saved but NOT required for your UI to work today
    if req.trigger and isinstance(req.trigger, dict):
        trg = dict(req.trigger)
        trg["action_id"] = action_id
        trg.setdefault("enabled", True)
        trg.setdefault("cooldown_sec", 30)
        store.setdefault("triggers", []).append(trg)

    _save_json(actions_path, store)

    _append_receipt({
        "ts": now,
        "kind": "action_saved",
        "action_id": action_id,
        "summary": f"Saved action: {action['name']}",
    })

    return {"ok": True, "action": action}

@router.post("/actions/run/{action_id}")
def actions_run(action_id: str):
    _ensure_initialized()
    actions_path, _ = _paths()
    store = _load_json(actions_path, default={"actions": [], "triggers": []})
    actions = store.get("actions") if isinstance(store, dict) else []
    action = None
    for a in actions or []:
        if isinstance(a, dict) and a.get("id") == action_id:
            action = a
            break
    if not action:
        raise HTTPException(status_code=404, detail="Action not found.")

    results = []
    shelly = _CTX.get("shelly_driver")
    hp_runtime = _CTX.get("home_power_runtime")

    for step in action.get("steps", []):
        stype = (step.get("type") or "").strip()

        if stype == "homepower.execute":
            # Route through home_power driver registry
            if not hp_runtime:
                results.append({"ok": False, "step": step, "error": "home_power_runtime not available"})
                continue
            dev_id = step.get("device_id") or ""
            cap = step.get("capability") or ""
            if not dev_id or not cap:
                results.append({"ok": False, "step": step, "error": "device_id and capability required"})
                continue
            try:
                d = hp_runtime._find_device(dev_id)
                if not d:
                    results.append({"ok": False, "step": step, "error": f"device_not_found: {dev_id}"})
                    continue
                vendor = str(d.get("vendor") or "shelly").lower()
                driver = hp_runtime._driver_registry.get(vendor)
                if driver is not None:
                    out = driver.execute(d, cap)
                elif vendor == "shelly":
                    ip = str(d.get("ip") or "")
                    relay = int(d.get("relay") or 0)
                    if cap == "switch.on":
                        out = hp_runtime.shelly_driver.turn_on(ip=ip, relay=relay)
                    elif cap == "switch.off":
                        out = hp_runtime.shelly_driver.turn_off(ip=ip, relay=relay)
                    elif cap == "switch.toggle":
                        out = hp_runtime.shelly_driver.toggle(ip=ip, relay=relay)
                    else:
                        results.append({"ok": False, "step": step, "error": "unsupported_capability"})
                        continue
                else:
                    results.append({"ok": False, "step": step, "error": f"unsupported_vendor:{vendor}"})
                    continue
                results.append({"ok": bool(out.get("ok")), "device_id": dev_id, "capability": cap, "summary": out.get("summary")})
            except Exception as e:
                results.append({"ok": False, "step": step, "error": str(e)})
            continue

        if stype == "shelly.switch":
            if not shelly:
                results.append({"ok": False, "step": step, "error": "Shelly driver not available"})
                continue
            dev_query = step.get("device") or ""
            val = (step.get("value") or "").strip().lower()
            if val not in ("on", "off"):
                results.append({"ok": False, "step": step, "error": "value must be 'on' or 'off'"})
                continue
            try:
                d = _resolve_device(dev_query)
                ip = d.get("ip")
                relay = int(d.get("relay") or 0)
                ok = shelly.set_relay(ip=ip, relay=relay, on=(val == "on"))
                results.append({"ok": True, "device": d.get("name") or ip, "ip": ip, "relay": relay, "value": val, "driver_ok": bool(ok)})
            except HTTPException as he:
                results.append({"ok": False, "step": step, "error": he.detail})
            except Exception as e:
                results.append({"ok": False, "step": step, "error": str(e)})
            continue

        results.append({"ok": False, "step": step, "error": f"Unsupported step type: {stype}"})

    _append_receipt({
        "ts": _nowz(),
        "kind": "action_run",
        "action_id": action_id,
        "summary": f"Ran action: {action.get('name','(unnamed)')}",
        "results": results,
    })

    return {"ok": True, "results": results}


@router.get("/actions/capabilities")
def actions_capabilities():
    # Shelly legacy devices
    reg = _read_shelly_registry()
    shelly_devices = [{"name": d.get("name") or d.get("label") or d.get("ip"), "ip": d.get("ip"), "relay": d.get("relay", 0)} for d in reg]

    # Multi-vendor homepower devices
    hp_runtime = _CTX.get("home_power_runtime")
    hp_devices = hp_runtime.load_devices() if hp_runtime else []

    return {
        "drivers": ["shelly", "homepower"],
        "step_types": ["shelly.switch", "homepower.execute"],
        "devices": shelly_devices,
        "hp_devices": hp_devices,
        "notes": "Capabilities reflect what this node can do right now (LAN-only)."
    }



