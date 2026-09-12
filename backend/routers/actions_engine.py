from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Body, Request
from pydantic import BaseModel, Field
from pathlib import Path
from typing import Any, Dict, List, Optional
from datetime import datetime
import json
import uuid
import re
import copy
import hashlib
import threading
import os

from routers.system_routes import require_session
from device_resolution import resolve
from action_results import driver_succeeded, execution_summary

router = APIRouter()
_STORE_LOCK = threading.RLock()
_INFLIGHT = set()

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
        with path.open("rb") as handle:
            raw = handle.read(1024 * 1024 + 1)
    except FileNotFoundError:
        return copy.deepcopy(default)
    except OSError as exc:
        raise HTTPException(503, "Saved actions or their device registry are unavailable. Existing files were retained.") from exc
    try:
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError("Duplicate field")
                result[key] = value
            return result
        if len(raw) > 1024 * 1024:
            raise ValueError("Oversized action data")
        value = json.loads(raw, object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid number")))
        if not isinstance(value, type(default)):
            raise ValueError("Invalid store structure")
        if isinstance(value, dict) and "actions" in default:
            if (not isinstance(value.get("actions"), list) or not isinstance(value.get("triggers"), list) or
                    len(value["actions"]) > 1000 or len(value["triggers"]) > 1000 or
                    any(not isinstance(row, dict) for row in [*value["actions"], *value["triggers"]])):
                raise ValueError("Invalid saved action lists")
        return value
    except (ValueError, TypeError, RecursionError) as exc:
        raise HTTPException(503, "Saved actions or their device registry could not be read. Existing files were retained.") from exc

def _save_json(path: Path, obj):
    with _STORE_LOCK:
        _load_json(path, {"actions": [], "triggers": []} if isinstance(obj, dict) and "actions" in obj else type(obj)())
        raw = json.dumps(obj, indent=2, allow_nan=False)
        if len(raw.encode("utf-8")) > 1024 * 1024:
            raise HTTPException(413, "Saved actions exceed the 1 MiB limit. Existing files were retained.")
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        try:
            tmp.write_text(raw, encoding="utf-8")
            tmp.replace(path)
        except OSError as exc:
            raise HTTPException(503, "Action save was not confirmed. The previous file was retained.") from exc

def _append_receipt(receipt: Dict[str, Any]):
    _, receipts_path = _paths()
    receipts_path.parent.mkdir(parents=True, exist_ok=True)
    with _STORE_LOCK, receipts_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(receipt, allow_nan=False) + "\n")
        f.flush()
        os.fsync(f.fileno())

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

def _resolve_device(query: str) -> Dict[str, Any]:
    from intelligence.devices import with_context
    result = resolve(query, with_context(_read_shelly_registry()))
    if result.device is None:
        raise HTTPException(status_code=409 if result.status == "ambiguous" else 404,
                            detail=result.message(query))
    return result.device

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
    name: str = Field(min_length=1, max_length=120)
    steps: List[ActionStep] = Field(default_factory=list, max_length=20)
    # optional trigger support (keep simple now; we can expand later)
    trigger: Optional[Dict[str, Any]] = None
    request_id: Optional[str] = Field(default=None, min_length=1, max_length=128)


class RunRequest(BaseModel):
    request_id: Optional[str] = Field(default=None, min_length=1, max_length=128)
    expected_revision: Optional[str] = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    expected_targets: Optional[str] = Field(default=None, pattern=r"^[a-f0-9]{64}$")


def _fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def _action(action_id):
    store = _load_json(_paths()[0], {"actions": [], "triggers": []})
    matches = [row for row in store["actions"] if row.get("id") == action_id]
    if not matches:
        raise HTTPException(404, "Action not found.")
    if len(matches) != 1:
        raise HTTPException(409, "More than one saved action has this identifier. No action ran.")
    action = matches[0]
    if not isinstance(action.get("steps"), list) or len(action["steps"]) > 20 or any(not isinstance(row, dict) for row in action["steps"]):
        raise HTTPException(503, "Saved action steps could not be read. Existing data was retained.")
    return action

# ---------------- routes ----------------
@router.get("/actions/list")
def actions_list(_session: str = Depends(require_session)):
    _ensure_initialized()
    actions_path, _ = _paths()
    data = _load_json(actions_path, default={"actions": [], "triggers": []})
    return data

@router.get("/actions/receipts")
def actions_receipts(limit: int = 50, _session: str = Depends(require_session)):
    _ensure_initialized()
    _, receipts_path = _paths()
    if not receipts_path.exists():
        return {"items": []}
    from collections import deque
    items = deque(maxlen=max(1, min(200, int(limit))))
    try:
        if receipts_path.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("Receipt history exceeds the read limit")
        with receipts_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError("Invalid receipt")
                items.append(row)
    except Exception as exc:
        raise HTTPException(503, "Action receipts could not be read. Existing receipts were retained.") from exc
    return {"items": list(items)}

@router.post("/actions/approve")
def actions_approve(req: ApproveRequest, _session: str = Depends(require_session)):
    _ensure_initialized()
    with _STORE_LOCK:
        return _approve(req, _session)


def _approve(req, owner):
    actions_path, _ = _paths()
    store = _load_json(actions_path, default={"actions": [], "triggers": []})
    request_key = _fingerprint([owner, req.request_id]) if req.request_id else None
    content = _fingerprint(req.model_dump(exclude={"request_id"}))
    if not req.name.strip():
        raise HTTPException(422, "Give this action a name.")
    if request_key:
        for existing in store["actions"]:
            if existing.get("_save_request") == request_key:
                if existing.get("_save_fingerprint") != content:
                    raise HTTPException(409, "That save identifier belongs to a different draft. No action was replaced.")
                return {"ok": True, "action": existing, "duplicate": True,
                        "trigger_active": False, "summary": "Action already saved. Saved trigger definitions are not executed by this engine."}
    if len(store["actions"]) >= 1000 or req.trigger and len(store["triggers"]) >= 1000:
        raise HTTPException(413, "The saved action limit was reached. Existing actions were retained.")

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
    if request_key:
        action.update({"_save_request": request_key, "_save_fingerprint": content})
    store.setdefault("actions", []).append(action)

    # Optional trigger saved but NOT required for your UI to work today
    if req.trigger and isinstance(req.trigger, dict):
        trg = dict(req.trigger)
        trg["action_id"] = action_id
        trg.setdefault("enabled", True)
        trg.setdefault("cooldown_sec", 30)
        store.setdefault("triggers", []).append(trg)

    _save_json(actions_path, store)

    receipt_saved = True
    try:
        _append_receipt({
        "ts": now,
        "kind": "action_saved",
        "action_id": action_id,
        "summary": f"Saved action: {action['name']}",
        })
    except OSError:
        receipt_saved = False

    return {"ok": True, "action": action, "receipt_saved": receipt_saved, "trigger_active": False,
            "summary": "Action saved. Saved trigger definitions are not executed by this engine."}

def _prepare_steps(steps):
    shelly = _CTX.get("shelly_driver")
    hp_runtime = _CTX.get("home_power_runtime")
    prepared = []
    errors = {}
    # Resolve every target before any side effect, including explicit-ID steps.
    for index, step in enumerate(steps):
        try:
            kind = step.get("type")
            if kind == "shelly.switch":
                device = _resolve_device(step.get("device") or "")
                if not shelly:
                    raise ValueError("Shelly driver not available")
                if str(step.get("value") or "").strip().lower() not in ("on", "off"):
                    raise ValueError("value must be 'on' or 'off'")
                if not (device.get("ip") or device.get("host")):
                    raise ValueError("Device has no address")
                int(device.get("relay") or 0)
            elif kind == "homepower.execute":
                if not hp_runtime:
                    raise ValueError("Home power runtime not available")
                device = hp_runtime._find_device(step.get("device_id") or "")
                if not device:
                    raise ValueError(f"Device not found: {step.get('device_id')}")
                if not step.get("capability"):
                    raise ValueError("capability required")
            else:
                raise ValueError(f"Unsupported step type: {kind}")
            prepared.append(device)
        except Exception as exc:
            errors[index] = exc.detail if isinstance(exc, HTTPException) else str(exc)
            prepared.append(None)
    return prepared, errors


def _target_review(steps, prepared):
    rows = []
    for index, (step, device) in enumerate(zip(steps, prepared)):
        rows.append({"index": index, "step_type": step.get("type"),
                     "effect": step.get("capability") or step.get("value"),
                     "target": {"id": device.get("device_id") or device.get("id"), "name": device.get("name") or device.get("label"),
                                "address": device.get("ip") or device.get("host"), "relay": device.get("relay", 0),
                                "vendor": device.get("vendor", "shelly")} if device else None})
    return rows


@router.get("/actions/{action_id}/review")
def review_action(action_id: str, _session: str = Depends(require_session)):
    _ensure_initialized()
    with _STORE_LOCK:
        action = _action(action_id)
        prepared, errors = _prepare_steps(action["steps"])
        targets = _target_review(action["steps"], prepared)
        return {"ok": True, "protocol": "tli-action-review-v1", "actions_performed": False, "checked_at": _nowz(),
                "action_id": action_id, "name": action.get("name"), "revision": _fingerprint(action),
                "target_revision": _fingerprint(targets), "steps": targets, "errors": errors,
                "available": bool(targets) and not errors and action.get("enabled") is not False,
                "scope": "Manual action on the registered targets shown. Review every relay and effect. No step ran during this review.",
                "trigger_active": False}


@router.post("/actions/preview")
def preview_action(req: ApproveRequest, _session: str = Depends(require_session)):
    _ensure_initialized()
    steps = [step.model_dump() for step in req.steps]
    prepared, errors = _prepare_steps(steps)
    targets = _target_review(steps, prepared)
    return {"ok": True, "protocol": "tli-action-review-v1", "actions_performed": False, "checked_at": _nowz(),
            "name": req.name, "draft_revision": _fingerprint(req.model_dump(exclude={"request_id"})),
            "target_revision": _fingerprint(targets), "steps": targets, "errors": errors,
            "available": bool(targets) and not errors, "trigger_active": False,
            "scope": "Unsaved manual routine. Review the exact device, address, relay and effect for every step. Previewing or saving does not run it."}


@router.post("/actions/run/{action_id}")
def actions_run(action_id: str, request: Request, req: Optional[RunRequest] = Body(default=None), _session: str = Depends(require_session)):
    _ensure_initialized()
    _action(action_id)  # preserve corrupt-store and missing-action failures
    req = req or RunRequest()
    if any((req.request_id, req.expected_revision, req.expected_targets)) and not all((req.request_id, req.expected_revision, req.expected_targets)):
        raise HTTPException(422, "Reviewed actions need a request identifier, saved revision and exact target review.")
    if not all((req.request_id, req.expected_revision, req.expected_targets)):
        return {"ok": False, "review_required": True, "actions_performed": False, "results": [],
                "summary": "Review the saved routine and its exact targets before running it. No step ran.",
                "review_url": f"/actions/{action_id}/review"}
    from companion_auth import operation_access
    access_check = operation_access(request, _session)
    key = (str(_CTX["data_dir"]), action_id)
    with _STORE_LOCK:
        if key in _INFLIGHT:
            raise HTTPException(409, "This saved action is already running. No second execution started.")
        _INFLIGHT.add(key)
    try:
        return _run_action(action_id, req, _session, access_check=access_check)
    finally:
        with _STORE_LOCK:
            _INFLIGHT.discard(key)


def _run_action(action_id, req, owner, *, access_check):
    access_check()
    action = _action(action_id)
    if action.get("enabled") is False:
        raise HTTPException(409, "This action is disabled. No step ran.")
    if req.expected_revision and _fingerprint(action) != req.expected_revision:
        raise HTTPException(409, "The saved action changed. Review it again; no step ran.")
    steps = action["steps"]
    prepared, errors = _prepare_steps(steps)
    targets = _target_review(steps, prepared)
    if req.expected_targets and (errors or _fingerprint(targets) != req.expected_targets):
        raise HTTPException(409, "A target or step changed. Review it again; no step ran.")
    request_key = _fingerprint([owner, action_id, req.request_id]) if req.request_id else None
    signature = _fingerprint([req.expected_revision, req.expected_targets])
    if request_key:
        # Durable start receipts block uncertain replay after a host interruption.
        # A completed duplicate returns the recorded result, never new I/O.
        all_receipts = _read_request_receipts()
        matching = [r for r in all_receipts if r.get("_request_key") == request_key]
        if matching:
            if any(r.get("_request_signature") != signature for r in matching):
                raise HTTPException(409, "That execution identifier belongs to a different review.")
            completed = next((r for r in reversed(matching) if r.get("kind") == "action_run"), None)
            if completed:
                return {"ok": completed["ok"], "results": completed["results"], "summary": completed["summary"], "duplicate": True, "receipt_saved": True}
            raise HTTPException(409, "This action was already started but its final result is unavailable. Inspect the devices before deliberately preparing another run.")
        _append_receipt({"ts": _nowz(), "kind": "action_started", "action_id": action_id, "_request_key": request_key,
                         "_request_signature": signature, "summary": "Reviewed action started; final result is not yet recorded."})

    shelly = _CTX.get("shelly_driver")
    hp_runtime = _CTX.get("home_power_runtime")

    results = []
    if errors:
        results = [{"ok": False, "step": step, "skipped": True,
                    "error": errors.get(i, "Not executed: another target or step could not be validated.")}
                   for i, step in enumerate(steps)]
    else:
        stopped = None
        for step, device in zip(steps, prepared):
            try:
                if stopped:
                    results.append({"ok": False, "step": step, "skipped": True, "error": stopped})
                    continue
                try:
                    access_check()
                    current_action = _action(action_id)
                    current_prepared, current_errors = _prepare_steps(current_action["steps"])
                    if (current_errors or _fingerprint(current_action) != req.expected_revision or
                            _fingerprint(_target_review(current_action["steps"], current_prepared)) != req.expected_targets):
                        raise HTTPException(409, "The routine or its targets changed. Remaining steps were not run; review again.")
                    access_check()
                except HTTPException as error:
                    stopped = str(error.detail)
                    results.append({"ok": False, "step": step, "skipped": True, "error": stopped})
                    continue
                if step["type"] == "shelly.switch":
                    ip = device.get("ip") or device.get("host")
                    relay = int(device.get("relay") or 0)
                    # Support older injected drivers as well as the bundled driver.
                    value = str(step["value"]).strip().lower()
                    if hasattr(shelly, "set_relay"):
                        out = shelly.set_relay(ip=ip, relay=relay, on=value == "on")
                    else:
                        out = (shelly.turn_on if value == "on" else shelly.turn_off)(ip=ip, relay=relay)
                    ok = driver_succeeded(out)
                    results.append({"ok": ok, "device": device.get("name") or ip, "ip": ip,
                                    "relay": relay, "value": value, "driver_ok": ok,
                                    **({"error": "Device did not report success"} if not ok else {})})
                else:
                    vendor = str(device.get("vendor") or "shelly").lower()
                    cap = step["capability"]
                    driver = hp_runtime._driver_registry.get(vendor)
                    if driver is not None:
                        out = driver.execute(device, cap)
                    elif vendor == "shelly" and cap in ("switch.on", "switch.off", "switch.toggle"):
                        method = {"switch.on": "turn_on", "switch.off": "turn_off", "switch.toggle": "toggle"}[cap]
                        out = getattr(hp_runtime.shelly_driver, method)(ip=device["ip"], relay=int(device.get("relay") or 0))
                    else:
                        raise ValueError(f"Unsupported vendor/capability: {vendor}/{cap}")
                    ok = driver_succeeded(out)
                    results.append({"ok": ok, "device_id": step["device_id"], "capability": cap,
                                    "summary": out.get("summary") if isinstance(out, dict) else None,
                                    **({"error": "Device did not report success"} if not ok else {})})
            except Exception as exc:
                results.append({"ok": False, "step": step, "error": str(exc)})

    ok, summary = execution_summary(results, action.get("name") or "action")
    receipt_saved = True
    try:
        _append_receipt({"ts": _nowz(), "kind": "action_run", "action_id": action_id,
                         "ok": ok, "summary": summary, "results": results,
                         **({"_request_key": request_key, "_request_signature": signature} if request_key else {})})
    except OSError:
        receipt_saved = False
    return {"ok": ok, "results": results, "summary": summary, "receipt_saved": receipt_saved}


def _read_request_receipts():
    path = _paths()[1]
    try:
        with path.open("rb") as handle:
            raw = handle.read(16 * 1024 * 1024 + 1)
    except FileNotFoundError:
        return []
    except OSError as exc:
        raise HTTPException(503, "Execution receipts are unavailable. No action started.") from exc
    try:
        if len(raw) > 16 * 1024 * 1024:
            raise ValueError("Receipt limit")
        rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
        if any(not isinstance(row, dict) for row in rows):
            raise ValueError("Malformed receipt")
        return rows
    except (ValueError, TypeError, RecursionError) as exc:
        raise HTTPException(503, "Execution receipts could not be read. No action started.") from exc


@router.get("/actions/capabilities")
def actions_capabilities(_session: str = Depends(require_session)):
    # Shelly legacy devices
    reg = _read_shelly_registry()
    shelly_devices = [{"name": d.get("name") or d.get("label") or d.get("ip"), "ip": d.get("ip") or d.get("host"),
                       "relay": d.get("relay", 0), "id": d.get("device_id") or d.get("id"),
                       "source_id": d.get("device_id") or d.get("id")} for d in reg]

    # Multi-vendor homepower devices
    hp_runtime = _CTX.get("home_power_runtime")
    hp_devices = hp_runtime.load_devices() if hp_runtime else []

    return {
        "drivers": ["shelly", "homepower"],
        "step_types": ["shelly.switch", "homepower.execute"],
        "devices": shelly_devices,
        "hp_devices": hp_devices,
        "notes": "Registered drivers and devices on this host. Availability and function require an explicit check.",
        "review_protocol": "tli-action-review-v1",
        "trigger_engine": {"available": False, "reason": "This saved-action engine stores trigger definitions but does not execute them. Use explicit manual review and Run; existing Home Power scenes use their separate controller."}
    }



