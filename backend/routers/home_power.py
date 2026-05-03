# backend/routers/home_power.py
"""
TLI Uplift 4 — Smart Home Power (LAN-only, deterministic)

Design goals:
- Offline-first (LAN-only). No cloud dependencies.
- AI may propose rules, but execution is deterministic and only runs approved automations.
- Receipts for everything: what ran, why, what succeeded/failed.

This router is Shelly-first (Gen2 RPC via existing ShellyDriver), but scenes/automations are capability-based
so future LAN drivers can be added without rewriting saved scenes.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional, Literal
from pathlib import Path
from datetime import datetime, timezone
import json
import threading
import time

from routers.system_routes import require_session
from license_gate import gate as _gate

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

def _read_json(path: Path, default: Any) -> Any:
    try:
        if not path.exists():
            return default
        raw = path.read_text(encoding="utf-8")
        return json.loads(raw) if raw else default
    except Exception:
        return default

def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)

def _append_jsonl(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload) + "\n")

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

class HomePowerDevice(BaseModel):
    device_id: str = Field(min_length=1, max_length=64)
    name: str = Field(default="")
    vendor: str = "shelly"
    ip: str = Field(min_length=3, max_length=128)
    relay: int = Field(default=0, ge=0, le=8)
    extra: Dict[str, Any] = Field(default_factory=dict)
    capabilities: List[Capability] = Field(default_factory=lambda: ["switch.on","switch.off","switch.toggle"])
    room: Optional[str] = None
    tags: List[str] = Field(default_factory=list)

class SceneAction(BaseModel):
    device_id: str
    capability: Capability

class Scene(BaseModel):
    scene_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=64)
    description: str = ""
    actions: List[SceneAction] = Field(default_factory=list)
    enabled: bool = True

TriggerType = Literal["time_daily", "game_started"]

class Automation(BaseModel):
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

        # runtime state (persisted best-effort)
        self._last_game_present: bool = False
        self._last_time_daily_fired: Dict[str, str] = {}  # automation_id -> YYYY-MM-DD
        self._last_run_ts: Dict[str, float] = {}          # automation_id -> unix seconds

        self._load_state()

    # ---- persistence ----
    def _load_state(self) -> None:
        st = _read_json(self._state_path, {})
        try:
            self._last_game_present = bool(st.get("last_game_present", False))
            self._last_time_daily_fired = dict(st.get("last_time_daily_fired", {}) or {})
            self._last_run_ts = {k: float(v) for k, v in (st.get("last_run_ts", {}) or {}).items()}
        except Exception:
            pass

    def _save_state(self) -> None:
        try:
            payload = {
                "last_game_present": self._last_game_present,
                "last_time_daily_fired": self._last_time_daily_fired,
                "last_run_ts": self._last_run_ts,
                "ts": _utc_now_iso(),
            }
            _write_json(self._state_path, payload)
        except Exception:
            pass

    # ---- loading config ----
    def load_devices(self) -> List[Dict[str, Any]]:
        return _read_json(self._devices_path, {"devices": []}).get("devices", [])

    def save_devices(self, devices: List[Dict[str, Any]]) -> None:
        _write_json(self._devices_path, {"devices": devices, "updated_at": _utc_now_iso()})

    def load_scenes(self) -> List[Dict[str, Any]]:
        return _read_json(self._scenes_path, {"scenes": []}).get("scenes", [])

    def save_scenes(self, scenes: List[Dict[str, Any]]) -> None:
        _write_json(self._scenes_path, {"scenes": scenes, "updated_at": _utc_now_iso()})

    def load_automations(self) -> List[Dict[str, Any]]:
        return _read_json(self._autos_path, {"automations": []}).get("automations", [])

    def save_automations(self, autos: List[Dict[str, Any]]) -> None:
        _write_json(self._autos_path, {"automations": autos, "updated_at": _utc_now_iso()})

    # ---- receipts ----
    def receipt(self, kind: str, title: str, **extra: Any) -> Dict[str, Any]:
        r = {"ts": _utc_now_iso(), "kind": kind, "title": title, "extra": extra}
        _append_jsonl(self._receipts_path, r)
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
    def run_scene(self, scene_id: str, dry_run: bool = False, reason: str = "manual") -> Dict[str, Any]:
        scene = self._find_scene(scene_id)
        if not scene:
            raise HTTPException(status_code=404, detail="Scene not found")

        actions = scene.get("actions") or []
        results: List[Dict[str, Any]] = []

        for a in actions:
            try:
                device_id = str(a.get("device_id") or "")
                cap = str(a.get("capability") or "")
                d = self._find_device(device_id)
                if not d:
                    results.append({"device_id": device_id, "capability": cap, "ok": False, "error": "device_not_found"})
                    continue

                if dry_run:
                    results.append({"device_id": device_id, "capability": cap, "ok": True, "dry_run": True})
                    continue

                vendor = str(d.get("vendor") or "shelly").lower()

                # Route through driver registry (supports all vendors)
                driver = self._driver_registry.get(vendor)
                if driver is not None:
                    out = driver.execute(d, cap)
                elif vendor == "shelly":
                    # Legacy fallback for shelly_driver from older init
                    ip = str(d.get("ip") or "")
                    relay = int(d.get("relay") or 0)
                    if cap == "switch.on":
                        out = self.shelly_driver.turn_on(ip=ip, relay=relay)
                    elif cap == "switch.off":
                        out = self.shelly_driver.turn_off(ip=ip, relay=relay)
                    elif cap == "switch.toggle":
                        out = self.shelly_driver.toggle(ip=ip, relay=relay)
                    else:
                        results.append({"device_id": device_id, "capability": cap, "ok": False, "error": "unsupported_capability"})
                        continue
                else:
                    results.append({"device_id": device_id, "capability": cap, "ok": False, "error": f"unsupported_vendor:{vendor}"})
                    continue

                results.append({"device_id": device_id, "capability": cap, "ok": bool(out.get("ok")), "summary": out.get("summary")})
            except Exception as e:
                results.append({"device_id": a.get("device_id"), "capability": a.get("capability"), "ok": False, "error": str(e)})

        ok = all(r.get("ok") for r in results) if results else True
        receipt = self.receipt(
            kind="scene_run" if not dry_run else "scene_preview",
            title=f'{scene.get("name")}',
            scene_id=scene_id,
            dry_run=dry_run,
            reason=reason,
            ok=ok,
            results=results,
        )
        return {"ok": ok, "scene": scene, "results": results, "receipt": receipt}

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
        self._save_state()

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
            time.sleep(1.5)
        self.debug_log("home_power", "INFO", "Home Power loop stopped")

    def _tick(self) -> None:
        autos = self.load_automations()
        if not autos:
            return

        # game presence
        game_present = False
        game_name = None
        if games_detect_best:
            try:
                det = games_detect_best()  # type: ignore
                game = det.get("game") if isinstance(det, dict) else None
                if isinstance(game, dict):
                    game_name = game.get("name") or game.get("exe_name")
                    game_present = True
            except Exception:
                game_present = False

        # local time
        now_local = datetime.now()
        today = now_local.date().isoformat()
        hhmm = now_local.strftime("%H:%M")

        for raw in autos:
            try:
                a = Automation(**raw)
            except Exception:
                continue

            if not a.enabled:
                continue

            # cooldown
            if not self._cooldown_ok(a.automation_id, a.cooldown_s):
                continue

            # after_hhmm gate
            if a.after_hhmm:
                try:
                    if hhmm < a.after_hhmm:
                        continue
                except Exception:
                    pass

            if a.trigger == "time_daily":
                if not a.time_hhmm:
                    continue
                if hhmm != a.time_hhmm:
                    continue
                # once per day
                if self._last_time_daily_fired.get(a.automation_id) == today:
                    continue
                self._last_time_daily_fired[a.automation_id] = today
                self._mark_ran(a.automation_id)
                self.run_scene(a.run_scene_id, dry_run=False, reason=f"automation:{a.automation_id}:time_daily")
                self.receipt("automation_run", a.name, automation_id=a.automation_id, trigger="time_daily", at=hhmm, date=today)
                continue

            if a.trigger == "game_started":
                # only fire on rising edge
                if game_present and not self._last_game_present:
                    # optional filter
                    if a.game_name_contains and game_name:
                        if a.game_name_contains.lower() not in str(game_name).lower():
                            # update edge state anyway
                            pass
                        else:
                            self._mark_ran(a.automation_id)
                            self.run_scene(a.run_scene_id, dry_run=False, reason=f"automation:{a.automation_id}:game_started")
                            self.receipt("automation_run", a.name, automation_id=a.automation_id, trigger="game_started", game=game_name)
                    else:
                        self._mark_ran(a.automation_id)
                        self.run_scene(a.run_scene_id, dry_run=False, reason=f"automation:{a.automation_id}:game_started")
                        self.receipt("automation_run", a.name, automation_id=a.automation_id, trigger="game_started", game=game_name)
                # update at end
                continue

        self._last_game_present = game_present
        self._save_state()


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
def status():
    rt = get_runtime()
    return {
        "ok": True,
        "devices": len(rt.load_devices()),
        "scenes": len(rt.load_scenes()),
        "automations": len(rt.load_automations()),
        "ts": _utc_now_iso(),
    }

@home_power_router.get("/devices")
def get_devices():
    rt = get_runtime()
    return {"devices": rt.load_devices()}

@home_power_router.post("/devices/save")
def save_device(payload: SaveDeviceRequest, _s=Depends(require_session), _l=Depends(_gate("home_automation"))):
    rt = get_runtime()
    d = payload.device.dict()
    with rt._lock:
        devices = rt.load_devices()
        # upsert by device_id
        out = []
        found = False
        for it in devices:
            if str(it.get("device_id")) == d["device_id"]:
                out.append(d); found = True
            else:
                out.append(it)
        if not found:
            out.append(d)
        rt.save_devices(out)
    rt.receipt("device_saved", d.get("name") or d["device_id"], device_id=d["device_id"])
    return {"ok": True}

@home_power_router.delete("/devices/{device_id}")
def delete_device(device_id: str, _s=Depends(require_session), _l=Depends(_gate("home_automation"))):
    rt = get_runtime()
    with rt._lock:
        devices = rt.load_devices()
        new = [d for d in devices if str(d.get("device_id")) != device_id]
        rt.save_devices(new)
    rt.receipt("device_deleted", device_id, device_id=device_id)
    return {"ok": True}

@home_power_router.get("/scenes")
def get_scenes():
    rt = get_runtime()
    return {"scenes": rt.load_scenes()}

@home_power_router.post("/scenes/save")
def save_scene(payload: SaveSceneRequest, _s=Depends(require_session), _l=Depends(_gate("home_automation"))):
    rt = get_runtime()
    s = payload.scene.dict()
    with rt._lock:
        scenes = rt.load_scenes()
        out=[]
        found=False
        for it in scenes:
            if str(it.get("scene_id")) == s["scene_id"]:
                out.append(s); found=True
            else:
                out.append(it)
        if not found:
            out.append(s)
        rt.save_scenes(out)
    rt.receipt("scene_saved", s.get("name") or s["scene_id"], scene_id=s["scene_id"])
    return {"ok": True}

@home_power_router.post("/scenes/bootstrap")
def bootstrap_scenes(_s=Depends(require_session), _l=Depends(_gate("home_automation"))):
    rt = get_runtime()
    defaults = [
        {"scene_id":"movie","name":"Movie","description":"Dim/disable distractions (customize me).","enabled":True,"actions":[]},
        {"scene_id":"night","name":"Night","description":"Lights out / bedtime routine (customize me).","enabled":True,"actions":[]},
        {"scene_id":"work","name":"Work","description":"Focus mode devices (customize me).","enabled":True,"actions":[]},
        {"scene_id":"away","name":"Away","description":"All off / security baseline (customize me).","enabled":True,"actions":[]},
    ]
    with rt._lock:
        scenes = rt.load_scenes()
        existing = {str(s.get("scene_id")) for s in scenes}
        for d in defaults:
            if d["scene_id"] not in existing:
                scenes.append(d)
        rt.save_scenes(scenes)
    rt.receipt("scene_bootstrap", "Default scenes created/ensured")
    return {"ok": True, "count": len(rt.load_scenes())}

@home_power_router.post("/scenes/run")
def run_scene(req: RunSceneRequest, _s=Depends(require_session), _l=Depends(_gate("home_automation"))):
    rt = get_runtime()
    return rt.run_scene(req.scene_id, dry_run=req.dry_run, reason="manual")

@home_power_router.get("/automations")
def get_automations():
    rt = get_runtime()
    return {"automations": rt.load_automations()}

@home_power_router.post("/automations/save")
def save_automation(payload: SaveAutomationRequest, _s=Depends(require_session), _l=Depends(_gate("home_automation"))):
    rt = get_runtime()
    a = payload.automation.dict()
    with rt._lock:
        autos = rt.load_automations()
        out=[]
        found=False
        for it in autos:
            if str(it.get("automation_id")) == a["automation_id"]:
                out.append(a); found=True
            else:
                out.append(it)
        if not found:
            out.append(a)
        rt.save_automations(out)
    rt.receipt("automation_saved", a.get("name") or a["automation_id"], automation_id=a["automation_id"])
    return {"ok": True}

@home_power_router.post("/automations/bootstrap")
def bootstrap_automations(_s=Depends(require_session), _l=Depends(_gate("home_automation"))):
    rt = get_runtime()
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
        autos = rt.load_automations()
        existing = {str(a.get("automation_id")) for a in autos}
        for d in defaults:
            if d["automation_id"] not in existing:
                autos.append(d)
        rt.save_automations(autos)
    rt.receipt("automation_bootstrap", "Default automations created/ensured")
    return {"ok": True, "count": len(rt.load_automations())}

@home_power_router.post("/automations/enabled")
def set_automation_enabled(payload: SetAutomationEnabledRequest, _s=Depends(require_session), _l=Depends(_gate("home_automation"))):
    rt = get_runtime()
    with rt._lock:
        autos = rt.load_automations()
        changed=False
        for a in autos:
            if str(a.get("automation_id")) == payload.automation_id:
                a["enabled"] = bool(payload.enabled)
                changed=True
        rt.save_automations(autos)
    rt.receipt("automation_enabled", payload.automation_id, automation_id=payload.automation_id, enabled=payload.enabled)
    return {"ok": True, "changed": changed}

class ExecuteDeviceRequest(BaseModel):
    capability: str


@home_power_router.post("/devices/{device_id}/execute")
def execute_device(device_id: str, req: ExecuteDeviceRequest, _s=Depends(require_session)):
    rt = get_runtime()
    d = rt._find_device(device_id)
    if not d:
        raise HTTPException(status_code=404, detail="Device not found")
    vendor = str(d.get("vendor") or "shelly").lower()
    driver = rt._driver_registry.get(vendor)
    if driver is not None:
        try:
            return driver.execute(d, req.capability)
        except Exception as e:
            return {"ok": False, "summary": str(e)}
    if vendor == "shelly":
        try:
            ip = str(d.get("ip") or "")
            relay = int(d.get("relay") or 0)
            if req.capability == "switch.on":
                return rt.shelly_driver.turn_on(ip=ip, relay=relay)
            elif req.capability == "switch.off":
                return rt.shelly_driver.turn_off(ip=ip, relay=relay)
            elif req.capability == "switch.toggle":
                return rt.shelly_driver.toggle(ip=ip, relay=relay)
            return {"ok": False, "summary": "Unsupported capability for shelly"}
        except Exception as e:
            return {"ok": False, "summary": str(e)}
    return {"ok": False, "summary": f"No driver for vendor: {vendor}"}


@home_power_router.get("/devices/{device_id}/status")
def get_device_status(device_id: str):
    rt = get_runtime()
    d = rt._find_device(device_id)
    if not d:
        raise HTTPException(status_code=404, detail="Device not found")
    vendor = str(d.get("vendor") or "shelly").lower()
    driver = rt._driver_registry.get(vendor)
    if driver is not None:
        try:
            return driver.get_status(d)
        except Exception as e:
            return {"ok": False, "summary": str(e)}
    if vendor == "shelly":
        # Legacy Shelly path
        try:
            ip = str(d.get("ip") or "")
            relay = int(d.get("relay") or 0)
            return rt.shelly_driver.get_status(ip=ip, relay=relay)
        except Exception as e:
            return {"ok": False, "summary": str(e)}
    return {"ok": False, "summary": f"No driver for vendor: {vendor}"}


@home_power_router.get("/receipts")
def get_receipts(limit: int = 50):
    rt = get_runtime()
    return {"receipts": rt.read_receipts(limit=limit)}
