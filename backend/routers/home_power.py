# backend/routers/home_power.py
"""
Smart Home Power — deterministic controls for registered local devices.

Design goals:
- Local LAN drivers and explicit Bluetooth profile adapters; no cloud dependency.
- AI may propose rules, but execution is deterministic and only runs approved automations.
- Receipts for everything: what ran, why, what succeeded/failed.

Scenes use capabilities across registered drivers. Bluetooth adapters require
captured authority through each operation and do not run in unattended scenes.
Profile enrollment is explicit; discovery hints never grant control permission.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ConfigDict, field_validator
from typing import Any, Dict, List, Optional, Literal
from pathlib import Path
from datetime import date, datetime, timezone
import json
import math
import threading
import time

from routers.system_routes import require_session
from license_gate import gate as _gate
from device_commands import run as run_command, target_key
from action_results import driver_succeeded
from browser_authority import browser_control_access
from home_power_store import Store, HomePowerStateUnavailable, MAX_ROWS
import bluetooth_profiles

# Optional dependency: used for "game_started" trigger
try:
    from routers.games import games_detect_best  # type: ignore
except Exception:
    games_detect_best = None  # type: ignore


home_power_router = APIRouter(prefix="/homepower", tags=["home_power"])


# -----------------------------
# Storage helpers (atomic)
# -----------------------------

def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

def _access(check):
    if check is not None:
        check()


class _CapturedAccess:
    """An observed authority failure cannot recover midway through a command."""
    def __init__(self, check):
        self.check = check
        self.failure = None
        self.lock = threading.RLock()

    def __call__(self):
        with self.lock:
            if self.failure is not None:
                raise self.failure
            try:
                self.check()
            except Exception as error:
                self.failure = error if isinstance(error, HTTPException) else HTTPException(
                    503, "Device access is unavailable.", headers={"Cache-Control": "no-store"})
                raise self.failure from error


def _capture(check):
    return _CapturedAccess(check) if check is not None and not isinstance(check, _CapturedAccess) else check


def _driver_execute(driver, device, capability, check):
    _access(check)
    profile = _bluetooth_profile(device)
    if profile is not None:
        _require_bluetooth_driver(driver)
        if capability not in profile["capabilities"]:
            raise HTTPException(422, "This capability is not supported by the saved Bluetooth profile.")
    checked = getattr(driver, "execute_checked", None)
    if callable(checked):
        if check is None:
            raise HTTPException(403, "Bluetooth control requires an explicit authorized request.")
        return checked(device, capability, check=check)
    return driver.execute(device, capability)


def _bluetooth_profile(device):
    if not bluetooth_profiles.is_bluetooth_record(device):
        return None
    profile = bluetooth_profiles.record_profile(device)
    if profile is None:
        raise HTTPException(422, "The saved Bluetooth binding is unavailable. Review the registered device before continuing.")
    return profile


def _require_bluetooth_driver(driver):
    if driver is None or any(not callable(getattr(driver, method, None)) for method in (
            "probe_checked", "execute_checked", "get_status_checked")):
        raise HTTPException(503, "This Bluetooth profile has no checked control adapter available.")


def _checked(check, operation):
    """Keep the initiating authority across reads, failures and disclosure."""
    _access(check)
    try:
        result = operation()
    except Exception:
        _access(check)
        raise
    _access(check)
    return result


def _append_jsonl(path: Path, payload: Dict[str, Any], *, check=None) -> None:
    _access(check)
    path.parent.mkdir(parents=True, exist_ok=True)
    _access(check)
    with path.open("a", encoding="utf-8") as f:
        line = json.dumps(payload) + "\n"
        _access(check)
        f.write(line)

def _safe_bool(x: Any) -> Optional[bool]:
    if isinstance(x, bool): return x
    return None

# -----------------------------
# Data model
# -----------------------------

Capability = Literal[
    "switch.on",
    "switch.off",
    "switch.toggle",
    "light.brightness",
    "light.color",
]

class HomePowerRecord(BaseModel):
    # Retain compatible fields that older/newer clients do not understand.
    model_config = ConfigDict(extra="allow")


class HomePowerDevice(HomePowerRecord):
    device_id: str = Field(min_length=1, max_length=64)
    name: str = Field(default="")
    vendor: str = "shelly"
    ip: str = Field(min_length=3, max_length=128)
    relay: int = Field(default=0, ge=0, le=8)
    extra: Dict[str, Any] = Field(default_factory=dict)
    capabilities: List[Capability] = Field(default_factory=lambda: ["switch.on","switch.off","switch.toggle"])
    room: Optional[str] = None
    tags: List[str] = Field(default_factory=list)

class SceneAction(HomePowerRecord):
    device_id: str = Field(min_length=1, max_length=64)
    capability: Capability

class Scene(HomePowerRecord):
    scene_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=64)
    description: str = ""
    actions: List[SceneAction] = Field(default_factory=list, max_length=MAX_ROWS)
    enabled: bool = True

TriggerType = Literal["time_daily", "game_started"]

class Automation(HomePowerRecord):
    automation_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=64)
    enabled: bool = False
    trigger: TriggerType
    # time_daily: "HH:MM" local time
    time_hhmm: Optional[str] = None
    # game_started: optional allowlist of game names (substring match)
    game_name_contains: Optional[str] = None
    # action: run scene
    run_scene_id: str = Field(min_length=1, max_length=64)
    cooldown_s: int = Field(default=600, ge=0, le=86400)
    # optional: only run after this HH:MM (local)
    after_hhmm: Optional[str] = None

    @field_validator("time_hhmm", "after_hhmm")
    @classmethod
    def valid_time(cls, value):
        if value not in (None, ""):
            if (len(value) != 5 or value[2] != ":" or not value[:2].isdigit()
                    or not value[3:].isdigit() or not 0 <= int(value[:2]) <= 23
                    or not 0 <= int(value[3:]) <= 59):
                raise ValueError("Time must be HH:MM")
        return value


def _collection_validator(key, model, identifier):
    def validate(value):
        if not isinstance(value, dict) or not isinstance(value.get(key), list) or len(value[key]) > MAX_ROWS:
            raise ValueError("Invalid saved collection")
        seen = set()
        for row in value[key]:
            model.model_validate(row, strict=True)
            ident = row[identifier]
            if not ident.strip() or ident in seen:
                raise ValueError("Invalid or duplicate identity")
            seen.add(ident)
    return validate


def _validate_runtime_state(value):
    if (not isinstance(value, dict) or type(value.get("last_game_present")) is not bool
            or not isinstance(value.get("last_time_daily_fired"), dict)
            or not isinstance(value.get("last_run_ts"), dict)):
        raise ValueError("Invalid automation state")
    for field in ("last_time_daily_fired", "last_run_ts"):
        if len(value[field]) > MAX_ROWS:
            raise ValueError("Oversized automation state")
        for key, item in value[field].items():
            if not isinstance(key, str) or not key.strip() or len(key) > 64:
                raise ValueError("Invalid automation identity")
            if field == "last_time_daily_fired":
                if not isinstance(item, str) or date.fromisoformat(item).isoformat() != item:
                    raise ValueError("Invalid daily reservation")
            elif type(item) not in (int, float) or not 0 <= item <= 32503680000 or not math.isfinite(item):
                raise ValueError("Invalid cooldown reservation")

class RunSceneRequest(BaseModel):
    scene_id: str
    dry_run: bool = False

class SaveDeviceRequest(BaseModel):
    device: HomePowerDevice

class SaveSceneRequest(BaseModel):
    scene: Scene

class SaveAutomationRequest(BaseModel):
    automation: Automation

class SetAutomationEnabledRequest(BaseModel):
    automation_id: str
    enabled: bool

# -----------------------------
# Runtime (automations loop)
# -----------------------------

class SceneAccessStopped(HTTPException):
    """Internal evidence of an interrupted scene; never an HTTP response body."""

    def __init__(self, error: HTTPException, scene_result: Dict[str, Any]):
        super().__init__(status_code=error.status_code, detail=error.detail, headers=error.headers)
        self.scene_result = scene_result


class HomePowerRuntime:
    def __init__(self, data_dir: Path, shelly_driver: Any, debug_log: Any, driver_registry: Any = None):
        self.data_dir = data_dir
        self.shelly_driver = shelly_driver
        self.debug_log = debug_log
        # Prefer the full driver registry; fall back to shelly_driver-only for backwards compat
        self._driver_registry = driver_registry or {}

        self._devices_path = self.data_dir / "home_power" / "devices.json"
        self._scenes_path = self.data_dir / "home_power" / "scenes.json"
        self._autos_path = self.data_dir / "home_power" / "automations.json"
        self._receipts_path = self.data_dir / "home_power" / "receipts.jsonl"
        self._state_path = self.data_dir / "home_power" / "runtime_state.json"

        self._lock = threading.RLock()
        self._stop_evt = threading.Event()
        self._thread: Optional[threading.Thread] = None

        self._stores = {
            "devices": Store(self._devices_path, "devices", {"devices": []},
                             _collection_validator("devices", HomePowerDevice, "device_id")),
            "scenes": Store(self._scenes_path, "scenes", {"scenes": []},
                            _collection_validator("scenes", Scene, "scene_id")),
            "automations": Store(self._autos_path, "automations", {"automations": []},
                                 _collection_validator("automations", Automation, "automation_id")),
        }
        self._state_store = Store(self._state_path, "automation runtime state", {
            "last_game_present": False, "last_time_daily_fired": {}, "last_run_ts": {},
        }, _validate_runtime_state)
        self._automation_error: Optional[str] = None

        # Durable reservations precede automated dispatch. They are not receipts.
        self._last_game_present: bool = False
        self._last_time_daily_fired: Dict[str, str] = {}  # automation_id -> YYYY-MM-DD
        self._last_run_ts: Dict[str, float] = {}          # automation_id -> unix seconds

        self._load_state()

    # ---- persistence ----
    def _load_state(self, *, strict: bool = False, check=None) -> None:
        with self._lock:
            _access(check)
            try:
                self._check_automation_ready()
                st = _checked(check, self._state_store.read)
                if not self._state_store._seen and any(a.get("enabled", False) for a in self.load_automations(check=check)):
                    # A lost reservation file cannot safely become an empty
                    # history for already-enabled automations after restart.
                    raise HomePowerStateUnavailable("automation runtime state")
                self._last_game_present = st["last_game_present"]
                self._last_time_daily_fired = dict(st["last_time_daily_fired"])
                self._last_run_ts = dict(st["last_run_ts"])
            except HomePowerStateUnavailable as error:
                self._automation_error = error.detail
                if strict:
                    raise

    def _check_automation_ready(self) -> None:
        if self._automation_error is not None:
            raise HomePowerStateUnavailable("automation runtime state")

    def automation_status(self, *, check=None) -> Dict[str, Any]:
        self._load_state(check=check)
        return {"automation_ready": self._automation_error is None,
                "error": self._automation_error}

    def _save_state(self, *, check=None) -> None:
        with self._lock:
            _access(check)
            try:
                self._check_automation_ready()
                payload = {**_checked(check, self._state_store.read),
                    "last_game_present": self._last_game_present,
                    "last_time_daily_fired": self._last_time_daily_fired,
                    "last_run_ts": self._last_run_ts,
                    "ts": _utc_now_iso(),
                }
                self._state_store.write(payload, check=check)
            except HomePowerStateUnavailable as error:
                self._automation_error = error.detail
                raise

    def _load_collection(self, key, check=None):
        with self._lock:
            return _checked(check, self._stores[key].read)[key]

    def _save_collection(self, key, rows, check=None):
        with self._lock:
            store = self._stores[key]
            previous = _checked(check, store.read)
            store.write({**previous, key: rows, "updated_at": _utc_now_iso()}, check=check)

    # ---- loading config ----
    def load_devices(self, *, check=None) -> List[Dict[str, Any]]:
        return self._load_collection("devices", check)

    def save_devices(self, devices: List[Dict[str, Any]], *, check=None) -> None:
        self._save_collection("devices", devices, check)

    def load_scenes(self, *, check=None) -> List[Dict[str, Any]]:
        return self._load_collection("scenes", check)

    def save_scenes(self, scenes: List[Dict[str, Any]], *, check=None) -> None:
        self._save_collection("scenes", scenes, check)

    def load_automations(self, *, check=None) -> List[Dict[str, Any]]:
        return self._load_collection("automations", check)

    def save_automations(self, autos: List[Dict[str, Any]], *, check=None) -> None:
        with self._lock:
            previous = _checked(check, self._stores["automations"].read)
            try:
                self._stores["automations"].validate({**previous, "automations": autos})
            except (ValueError, TypeError, KeyError, OverflowError, RecursionError) as error:
                _access(check)
                raise HomePowerStateUnavailable("automations") from error
            if any(a.get("enabled", False) for a in autos):
                self._load_state(strict=True, check=check)
                if not self._state_store._seen:
                    self._save_state(check=check)  # Establish history before enabling.
            self._save_collection("automations", autos, check)

    # ---- receipts ----
    def receipt(self, kind: str, title: str, *, check=None, **extra: Any) -> Dict[str, Any]:
        r = {"ts": _utc_now_iso(), "kind": kind, "title": title, "extra": extra}
        _checked(check, lambda: _append_jsonl(self._receipts_path, r, check=check))
        return r

    def read_receipts(self, limit: int = 50) -> List[Dict[str, Any]]:
        if limit < 1: limit = 1
        if limit > 200: limit = 200
        p = self._receipts_path
        if not p.exists():
            return []
        # Read last N lines efficiently
        try:
            with p.open("rb") as f:
                f.seek(0, 2)
                size = f.tell()
                block = 4096
                data = b""
                pos = size
                while pos > 0 and data.count(b"\n") <= limit + 2:
                    read = min(block, pos)
                    pos -= read
                    f.seek(pos)
                    data = f.read(read) + data
            lines = [ln for ln in data.decode("utf-8", errors="ignore").splitlines() if ln.strip()]
            tail = lines[-limit:]
            out: List[Dict[str, Any]] = []
            for ln in tail:
                try:
                    out.append(json.loads(ln))
                except Exception:
                    pass
            return out[::-1]  # newest first
        except Exception:
            return []

    # ---- helpers ----
    def _find_device(self, device_id: str) -> Optional[Dict[str, Any]]:
        for d in self.load_devices():
            if str(d.get("device_id")) == device_id:
                return d
        return None

    def _find_scene(self, scene_id: str) -> Optional[Dict[str, Any]]:
        for s in self.load_scenes():
            if str(s.get("scene_id")) == scene_id:
                return s
        return None

    def _cooldown_ok(self, automation_id: str, cooldown_s: int) -> bool:
        if cooldown_s <= 0:
            return True
        last = float(self._last_run_ts.get(automation_id, 0.0) or 0.0)
        return (time.time() - last) >= cooldown_s

    def _mark_ran(self, automation_id: str) -> None:
        self._last_run_ts[automation_id] = time.time()

    # ---- execution ----
    def run_scene(self, scene_id: str, dry_run: bool = False, reason: str = "manual", *, check=None) -> Dict[str, Any]:
        # Scheduled/internal callers keep their existing authority. A browser
        # action supplies its original access check, never a replacement token.
        check = _capture(check)
        results: List[Dict[str, Any]] = []
        dispatched = 0

        def check_access(completed=None):
            if check is None:
                return
            try:
                check()
            except HTTPException as error:
                if not dispatched:
                    raise
                # An already submitted command cannot be undone. Keep what is
                # known internally, stop later steps, and withhold HTTP results.
                outcome = {**completed, "access_stopped": True, "dispatched": dispatched,
                           "execution_completed": True} if completed is not None else {
                               "ok": False, "scene": scene, "results": results,
                               "access_stopped": True, "dispatched": dispatched,
                               "execution_completed": False}
                if completed is None:
                    try:
                        outcome["receipt"] = self.receipt(
                            kind="scene_run", title=str(scene.get("name") or scene_id),
                            scene_id=scene_id, dry_run=False, reason=reason, ok=False,
                            results=results, access_stopped=True, dispatched=dispatched,
                        )
                    except Exception:
                        # Persistence failure must not replace the access denial
                        # or prevent the dashboard from retaining an audit record.
                        outcome["receipt_unavailable"] = True
                raise SceneAccessStopped(error, outcome) from error

        check_access()
        try:
            scene = self._find_scene(scene_id)
        except Exception:
            check_access()
            raise
        check_access()
        if not scene:
            raise HTTPException(status_code=404, detail="Scene not found")

        actions = scene.get("actions") or []

        for a in actions:
            check_access()
            device_id = str(a.get("device_id") or "")
            cap = str(a.get("capability") or "")
            try:
                d = self._find_device(device_id)
            except HomePowerStateUnavailable as error:
                self._automation_error = error.detail
                check_access()
                if dispatched:
                    try:
                        self.receipt("scene_run", str(scene.get("name") or scene_id),
                                     scene_id=scene_id, dry_run=False, reason=reason, ok=False,
                                     results=results, state_unavailable=True, dispatched=dispatched)
                    except Exception:
                        pass
                raise
            except Exception as error:
                check_access()
                results.append({"device_id": device_id, "capability": cap, "ok": False, "error": str(error)})
                continue
            check_access()
            if not d:
                results.append({"device_id": device_id, "capability": cap, "ok": False, "error": "device_not_found"})
                continue

            bluetooth = bluetooth_profiles.is_bluetooth_record(d)
            try:
                profile = _bluetooth_profile(d)
                if profile is not None and cap not in profile["capabilities"]:
                    raise HTTPException(422, "This capability is not supported by the saved Bluetooth profile.")
            except HTTPException as error:
                check_access()
                results.append({"device_id": device_id, "capability": cap, "ok": False,
                                "outcome": "not_sent", "dispatched": False, "summary": error.detail})
                continue

            if dry_run:
                results.append({"device_id": device_id, "capability": cap, "ok": True, "dry_run": True})
                continue

            try:
                vendor = str(d.get("vendor") or "shelly").lower()

                # Route through driver registry (supports all vendors)
                driver = self._driver_registry.get(vendor)
                if bluetooth:
                    _require_bluetooth_driver(driver)
                if driver is not None:
                    if callable(getattr(driver, "execute_checked", None)) and check is None:
                        results.append({"device_id": device_id, "capability": cap, "ok": False,
                                        "outcome": "not_sent", "dispatched": False,
                                        "summary": "Bluetooth control requires an explicit authorized request."})
                        continue
                    execute = lambda: _driver_execute(driver, d, cap, check)
                elif vendor == "shelly":
                    # Legacy fallback for shelly_driver from older init
                    ip = str(d.get("ip") or "")
                    relay = int(d.get("relay") or 0)
                    if cap == "switch.on":
                        execute = lambda: self.shelly_driver.turn_on(ip=ip, relay=relay)
                    elif cap == "switch.off":
                        execute = lambda: self.shelly_driver.turn_off(ip=ip, relay=relay)
                    elif cap == "switch.toggle":
                        execute = lambda: self.shelly_driver.toggle(ip=ip, relay=relay)
                    else:
                        results.append({"device_id": device_id, "capability": cap, "ok": False, "error": "unsupported_capability"})
                        continue
                else:
                    results.append({"device_id": device_id, "capability": cap, "ok": False, "error": f"unsupported_vendor:{vendor}"})
                    continue
            except Exception as error:
                check_access()
                results.append({"device_id": device_id, "capability": cap, "ok": False, "error": str(error)})
                continue

            # Keep authorization exceptions outside the driver error handler;
            # treating revocation as a failed step would run the next device.
            check_access()
            dispatched += 1
            try:
                out = execute()
                if bluetooth and out.get("outcome") == "not_sent":
                    dispatched -= 1
                results.append({"device_id": device_id, "capability": cap, "ok": driver_succeeded(out),
                                **{key: out[key] for key in ("summary", "outcome", "acknowledged", "verified") if key in out}})
            except Exception as e:
                known = getattr(e, "device_result", None)
                if bluetooth and (not isinstance(known, dict) or known.get("outcome") == "not_sent"):
                    dispatched -= 1
                if isinstance(known, dict):
                    results.append({"device_id": device_id, "capability": cap, "ok": driver_succeeded(known),
                                    **{key: known[key] for key in ("summary", "outcome", "acknowledged", "verified") if key in known}})
                else:
                    results.append({"device_id": a.get("device_id"), "capability": a.get("capability"), "ok": False, "error": str(e)})
            check_access()

        check_access()
        ok = all(r.get("ok") for r in results) if results else True
        result = {"ok": ok, "scene": scene, "results": results}
        try:
            result["receipt"] = self.receipt(
                kind="scene_run" if not dry_run else "scene_preview",
                title=f'{scene.get("name")}',
                scene_id=scene_id,
                dry_run=dry_run,
                reason=reason,
                ok=ok,
                results=results,
                check=check if dry_run else None,
            )
        except Exception:
            # All steps have finished. An uncertain append must not rewrite
            # their outcome or attempt another receipt after authority is lost.
            check_access({**result, "receipt_unavailable": True})
            raise
        check_access(result)
        return result

    # ---- loop ----
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_evt.clear()
        self._thread = threading.Thread(target=self._loop, name="tli_home_power_loop", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_evt.set()
        try:
            if self._thread:
                self._thread.join(timeout=1.5)
        except Exception:
            pass
        # Every automation reservation is already durable before dispatch.
        # Shutdown must not overwrite a damaged or externally restored store.

    def _loop(self) -> None:
        self.debug_log("home_power", "INFO", "Home Power loop started")
        while not self._stop_evt.is_set():
            try:
                self._tick()
            except Exception as e:
                try:
                    self.debug_log("home_power", "ERROR", "Home Power tick failed", error=str(e))
                except Exception:
                    pass
                if isinstance(e, HomePowerStateUnavailable):
                    break  # Remain paused until repaired and restarted.
            self._stop_evt.wait(1.5)
        self.debug_log("home_power", "INFO", "Home Power loop stopped")

    def _tick(self) -> None:
        with self._lock:
            try:
                self._load_state(strict=True)
                autos = self.load_automations()
                # Validate the full configuration before scheduling any effect.
                self.load_devices()
                self.load_scenes()
                if not autos:
                    return

                game_present = False
                game_name = None
                game_known = False
                if games_detect_best:
                    try:
                        det = games_detect_best()
                        game_known = (isinstance(det, dict) and "game" in det
                                      and det.get("ok", True) is not False and not det.get("error"))
                        game = det.get("game") if game_known else None
                        if game is not None and not isinstance(game, dict):
                            game_known = False
                        if game_known and game is None and isinstance(det.get("filter"), dict):
                            game_known = det["filter"].get("reason") == "no_store_games_running"
                        if isinstance(game, dict):
                            game_name = game.get("name") or game.get("exe_name")
                            game_present = True
                    except Exception:
                        pass  # An unavailable probe must not reset a rising edge.

                now_local = datetime.now()
                today = now_local.date().isoformat()
                hhmm = now_local.strftime("%H:%M")
                pending = []
                for raw in autos:
                    a = Automation.model_validate(raw, strict=True)
                    if not a.enabled or not self._cooldown_ok(a.automation_id, a.cooldown_s):
                        continue
                    if a.after_hhmm and hhmm < a.after_hhmm:
                        continue
                    if a.trigger == "time_daily":
                        if hhmm != a.time_hhmm or self._last_time_daily_fired.get(a.automation_id) == today:
                            continue
                        self._last_time_daily_fired[a.automation_id] = today
                        context = {"at": hhmm, "date": today}
                    else:
                        if not game_known or not game_present or self._last_game_present:
                            continue
                        if a.game_name_contains and (not game_name or a.game_name_contains.lower() not in str(game_name).lower()):
                            continue
                        context = {"game": game_name}
                    self._mark_ran(a.automation_id)
                    pending.append((a, context))

                edge_changed = game_known and self._last_game_present != game_present
                if game_known:
                    self._last_game_present = game_present
                if pending or edge_changed:
                    self._save_state()
                # A crash after reservation may skip a scheduled occurrence;
                # it must not silently repeat an uncertain physical action.
                for a, context in pending:
                    if self._stop_evt.is_set():
                        break
                    self.run_scene(a.run_scene_id, dry_run=False, reason=f"automation:{a.automation_id}:{a.trigger}")
                    self.receipt("automation_run", a.name, automation_id=a.automation_id, trigger=a.trigger, **context)
            except HomePowerStateUnavailable as error:
                self._automation_error = error.detail
                raise


_RUNTIME: Optional[HomePowerRuntime] = None

def init_home_power_runtime(data_dir: Path, shelly_driver: Any, debug_log: Any, driver_registry: Any = None) -> HomePowerRuntime:
    global _RUNTIME
    if _RUNTIME is None:
        _RUNTIME = HomePowerRuntime(
            data_dir=data_dir,
            shelly_driver=shelly_driver,
            debug_log=debug_log,
            driver_registry=driver_registry,
        )
    return _RUNTIME

def get_runtime() -> HomePowerRuntime:
    if _RUNTIME is None:
        raise RuntimeError("HomePower runtime not initialized")
    return _RUNTIME

# -----------------------------
# API endpoints
# -----------------------------

@home_power_router.get("/status")
def status(check=Depends(browser_control_access)):
    rt = _checked(check, get_runtime)
    readiness = _checked(check, lambda: rt.automation_status(check=check))
    result = {
        "ok": readiness["automation_ready"],
        **readiness,
        "devices": len(_checked(check, rt.load_devices)),
        "scenes": len(_checked(check, rt.load_scenes)),
        "automations": len(_checked(check, rt.load_automations)),
        "ts": _utc_now_iso(),
    }
    check()
    return result

@home_power_router.get("/devices")
def get_devices(check=Depends(browser_control_access)):
    rt = _checked(check, get_runtime)
    check()
    return {"devices": _checked(check, rt.load_devices)}

@home_power_router.post("/devices/save")
def save_device(payload: SaveDeviceRequest, check=Depends(browser_control_access), _l=Depends(_gate("home_automation"))):
    rt = _checked(check, get_runtime)
    d = payload.device.model_dump()
    with rt._lock:
        check()
        devices = _checked(check, rt.load_devices)
        from routers.bluetooth_routes import validate_generic_save
        _checked(check, lambda: validate_generic_save(d, devices, payload.device.model_dump(exclude_unset=True)))
        # upsert by device_id
        out = []
        found = False
        for it in devices:
            if str(it.get("device_id")) == d["device_id"]:
                changes = payload.device.model_dump(exclude_unset=True)
                if "extra" in changes:
                    changes["extra"] = {**it.get("extra", {}), **changes["extra"]}
                out.append({**it, **changes}); found = True
            else:
                out.append(it)
        if not found:
            out.append(d)
        rt.save_devices(out, check=check)
    rt.receipt("device_saved", d.get("name") or d["device_id"], device_id=d["device_id"], check=check)
    check()
    return {"ok": True}

@home_power_router.delete("/devices/{device_id}")
def delete_device(device_id: str, check=Depends(browser_control_access), _l=Depends(_gate("home_automation"))):
    rt = _checked(check, get_runtime)
    with rt._lock:
        check()
        devices = _checked(check, rt.load_devices)
        new = [d for d in devices if str(d.get("device_id")) != device_id]
        rt.save_devices(new, check=check)
    rt.receipt("device_deleted", device_id, device_id=device_id, check=check)
    check()
    return {"ok": True}

@home_power_router.get("/scenes")
def get_scenes(check=Depends(browser_control_access)):
    rt = _checked(check, get_runtime)
    check()
    return {"scenes": _checked(check, rt.load_scenes)}

@home_power_router.post("/scenes/save")
def save_scene(payload: SaveSceneRequest, check=Depends(browser_control_access), _l=Depends(_gate("home_automation"))):
    rt = _checked(check, get_runtime)
    s = payload.scene.model_dump()
    with rt._lock:
        check()
        scenes = _checked(check, rt.load_scenes)
        out=[]
        found=False
        for it in scenes:
            if str(it.get("scene_id")) == s["scene_id"]:
                merged = {**it, **payload.scene.model_dump(exclude_unset=True)}
                if "actions" in payload.scene.model_fields_set:
                    # Match repeated identical actions by occurrence; keep
                    # compatible per-action metadata when editing the scene.
                    prior = {}
                    for action in it.get("actions", []):
                        prior.setdefault((action["device_id"], action["capability"]), []).append(action)
                    actions = []
                    for action in merged["actions"]:
                        candidates = prior.get((action["device_id"], action["capability"]), [])
                        actions.append({**(candidates.pop(0) if candidates else {}), **action})
                    merged["actions"] = actions
                out.append(merged); found=True
            else:
                out.append(it)
        if not found:
            out.append(s)
        rt.save_scenes(out, check=check)
    rt.receipt("scene_saved", s.get("name") or s["scene_id"], scene_id=s["scene_id"], check=check)
    check()
    return {"ok": True}

@home_power_router.post("/scenes/bootstrap")
def bootstrap_scenes(check=Depends(browser_control_access), _l=Depends(_gate("home_automation"))):
    rt = _checked(check, get_runtime)
    defaults = [
        {"scene_id":"movie","name":"Movie","description":"Dim/disable distractions (customize me).","enabled":True,"actions":[]},
        {"scene_id":"night","name":"Night","description":"Lights out / bedtime routine (customize me).","enabled":True,"actions":[]},
        {"scene_id":"work","name":"Work","description":"Focus mode devices (customize me).","enabled":True,"actions":[]},
        {"scene_id":"away","name":"Away","description":"All off / security baseline (customize me).","enabled":True,"actions":[]},
    ]
    with rt._lock:
        check()
        scenes = _checked(check, rt.load_scenes)
        existing = {str(s.get("scene_id")) for s in scenes}
        for d in defaults:
            if d["scene_id"] not in existing:
                scenes.append(d)
        rt.save_scenes(scenes, check=check)
    rt.receipt("scene_bootstrap", "Default scenes created/ensured", check=check)
    check()
    return {"ok": True, "count": len(_checked(check, rt.load_scenes))}

@home_power_router.post("/scenes/run")
def run_scene(req: RunSceneRequest, check=Depends(browser_control_access), _l=Depends(_gate("home_automation"))):
    rt = _checked(check, get_runtime)
    check()
    return _checked(check, lambda: rt.run_scene(req.scene_id, dry_run=req.dry_run, reason="manual", check=check))

@home_power_router.get("/automations")
def get_automations(check=Depends(browser_control_access)):
    rt = _checked(check, get_runtime)
    check()
    return {"automations": _checked(check, rt.load_automations)}

@home_power_router.post("/automations/save")
def save_automation(payload: SaveAutomationRequest, check=Depends(browser_control_access), _l=Depends(_gate("home_automation"))):
    rt = _checked(check, get_runtime)
    a = payload.automation.model_dump()
    with rt._lock:
        check()
        autos = _checked(check, rt.load_automations)
        out=[]
        found=False
        for it in autos:
            if str(it.get("automation_id")) == a["automation_id"]:
                out.append({**it, **payload.automation.model_dump(exclude_unset=True)}); found=True
            else:
                out.append(it)
        if not found:
            out.append(a)
        rt.save_automations(out, check=check)
    rt.receipt("automation_saved", a.get("name") or a["automation_id"], automation_id=a["automation_id"], check=check)
    check()
    return {"ok": True}

@home_power_router.post("/automations/bootstrap")
def bootstrap_automations(check=Depends(browser_control_access), _l=Depends(_gate("home_automation"))):
    rt = _checked(check, get_runtime)
    defaults = [
        {
            "automation_id":"game_to_movie",
            "name":"When a game starts → Movie scene",
            "enabled": False,
            "trigger":"game_started",
            "game_name_contains": None,
            "run_scene_id":"movie",
            "cooldown_s": 600,
            "after_hhmm":"20:00",
            "time_hhmm": None,
        }
    ]
    with rt._lock:
        check()
        autos = _checked(check, rt.load_automations)
        existing = {str(a.get("automation_id")) for a in autos}
        for d in defaults:
            if d["automation_id"] not in existing:
                autos.append(d)
        rt.save_automations(autos, check=check)
    rt.receipt("automation_bootstrap", "Default automations created/ensured", check=check)
    check()
    return {"ok": True, "count": len(_checked(check, rt.load_automations))}

@home_power_router.post("/automations/enabled")
def set_automation_enabled(payload: SetAutomationEnabledRequest, check=Depends(browser_control_access), _l=Depends(_gate("home_automation"))):
    rt = _checked(check, get_runtime)
    with rt._lock:
        check()
        autos = _checked(check, rt.load_automations)
        changed=False
        for a in autos:
            if str(a.get("automation_id")) == payload.automation_id:
                a["enabled"] = bool(payload.enabled)
                changed=True
        rt.save_automations(autos, check=check)
    rt.receipt("automation_enabled", payload.automation_id, automation_id=payload.automation_id, enabled=payload.enabled, check=check)
    check()
    return {"ok": True, "changed": changed}


class ExecuteDeviceRequest(BaseModel):
    capability: str = Field(min_length=1, max_length=128)
    request_id: Optional[str] = Field(default=None, pattern=r"^[a-f0-9-]{32,36}$")


@home_power_router.post("/devices/{device_id}/execute")
def execute_device_http(device_id: str, req: ExecuteDeviceRequest,
                        check=Depends(browser_control_access), user=Depends(require_session)):
    return _checked(check, lambda: execute_device(device_id, req, _s=user, check=check))


def execute_device(device_id: str, req: ExecuteDeviceRequest, _s=None, *, check=None):
    """In-process service; HTTP callers must enter execute_device_http."""
    check = _capture(check)
    rt = _checked(check, get_runtime)
    d = _checked(check, lambda: rt._find_device(device_id))
    if not d:
        raise HTTPException(status_code=404, detail="Device not found")
    vendor = str(d.get("vendor") or "shelly").lower()
    profile = _checked(check, lambda: _bluetooth_profile(d))
    if profile is not None and check is None:
        raise HTTPException(403, "Bluetooth control requires an explicit authorized request.")
    if profile is not None:
        _checked(check, lambda: _require_bluetooth_driver(rt._driver_registry.get(profile["vendor"])))
        if req.capability not in profile["capabilities"]:
            raise HTTPException(422, "This capability is not supported by the saved Bluetooth profile.")
    target = ("shelly", *target_key(d.get("ip"), d.get("relay") or 0)) if vendor == "shelly" else (vendor, device_id)
    if profile is not None:
        target = ("bluetooth", d["extra"]["address"])
    action = req.capability.removeprefix("switch.") if vendor == "shelly" else req.capability
    denial = None
    def execute():
        nonlocal denial
        try:
            _access(check)
        except HTTPException as error:
            denial = error
            raise
        # Let the shared command cache retain the actual adapter outcome before
        # disclosure is checked. Never retry a command after access changes.
        try:
            return _execute_direct_device(rt, d, req.capability, check=check)
        except Exception as error:
            if check is not None and check.failure is not None:
                denial = error
            raise
    try:
        result = run_command(_s, target, action, req.request_id, execute)
    except Exception:
        _access(check)
        raise
    if denial is not None:
        raise denial
    _access(check)
    return result


def _execute_direct_device(rt, d, capability, *, check=None):
    vendor = str(d.get("vendor") or "shelly").lower()
    driver = rt._driver_registry.get(vendor)
    if _bluetooth_profile(d) is not None:
        _require_bluetooth_driver(driver)
    if driver is not None:
        _access(check)
        return _driver_execute(driver, d, capability, check)
    if vendor == "shelly":
        ip = str(d.get("ip") or "")
        relay = int(d.get("relay") or 0)
        _access(check)
        if capability == "switch.on":
            return rt.shelly_driver.turn_on(ip=ip, relay=relay)
        elif capability == "switch.off":
            return rt.shelly_driver.turn_off(ip=ip, relay=relay)
        elif capability == "switch.toggle":
            return rt.shelly_driver.toggle(ip=ip, relay=relay)
        return {"ok": False, "summary": "Unsupported capability for shelly"}
    return {"ok": False, "summary": f"No driver for vendor: {vendor}"}


@home_power_router.get("/devices/{device_id}/status")
def get_device_status_http(device_id: str, check=Depends(browser_control_access)):
    return _checked(check, lambda: get_device_status(device_id, check=check))


def get_device_status(device_id: str, _s=None, *, check=None):
    """In-process service; HTTP callers must enter get_device_status_http."""
    check = _capture(check)
    rt = _checked(check, get_runtime)
    d = _checked(check, lambda: rt._find_device(device_id))
    if not d:
        raise HTTPException(status_code=404, detail="Device not found")
    vendor = str(d.get("vendor") or "shelly").lower()
    profile = _checked(check, lambda: _bluetooth_profile(d))
    driver = rt._driver_registry.get(vendor)
    if profile is not None:
        _checked(check, lambda: _require_bluetooth_driver(driver))
    if driver is not None:
        try:
            checked = getattr(driver, "get_status_checked", None)
            if callable(checked) and check is None:
                raise HTTPException(403, "Bluetooth status requires an explicit authorized request.")
            out = _checked(check, lambda: checked(d, check=check) if callable(checked) else driver.get_status(d))
            if not isinstance(out, dict):
                return {"ok": False, "on": None, "summary": "Device status is unavailable."}
            valid = driver_succeeded(out)
            if profile is not None:
                valid = valid and out.get("verified") is True and type(out.get("on")) is bool
                if not valid:
                    out = {**out, "verified": False, "summary": "Bluetooth state has not been verified."}
            return {**out, "ok": valid, "on": out.get("on") if valid and isinstance(out.get("on"), bool) else None,
                    "checked_at": time.time()}
        except HTTPException:
            raise
        except Exception as e:
            _access(check)
            return {"ok": False, "summary": str(e)}
    if vendor == "shelly":
        # Legacy Shelly path
        try:
            ip = str(d.get("ip") or "")
            relay = int(d.get("relay") or 0)
            out = _checked(check, lambda: rt.shelly_driver.get_status(ip=ip, relay=relay))
            raw = out.get("raw") if isinstance(out, dict) else None
            switch = raw.get(f"switch:{relay}") if isinstance(raw, dict) else None
            valid = driver_succeeded(out) and isinstance(switch, dict) and isinstance(switch.get("output"), bool)
            return {**out, "ok": valid, "on": switch["output"] if valid else None,
                    "relay": relay, "checked_at": time.time(),
                    "summary": out.get("summary", "") if valid else "The requested relay state is unavailable."}
        except HTTPException:
            raise
        except Exception as e:
            _access(check)
            return {"ok": False, "summary": str(e)}
    return {"ok": False, "summary": f"No driver for vendor: {vendor}"}


@home_power_router.get("/receipts")
def get_receipts(limit: int = 50, check=Depends(browser_control_access)):
    check()
    try:
        rt = get_runtime()
        check()
        receipts = rt.read_receipts(limit=limit)
    except Exception:
        check()
        raise
    check()
    return {"receipts": receipts}


from routers.bluetooth_routes import bluetooth_router
home_power_router.include_router(bluetooth_router)
