from __future__ import annotations

# backend/routers/hub_routes.py
# TLI Hub — community package registry browser and installer.
#
# Endpoints:
#   GET  /hub/status              — opt-in flag, hub URL, installed count
#   POST /hub/settings            — toggle opt-in, set hub URL
#   GET  /hub/registry            — fetch + cache registry from hub URL
#   GET  /hub/installed           — list installed packages
#   POST /hub/install             — download and install a package
#   DELETE /hub/packages/{pkg_id} — uninstall a package
#   GET  /hub/sample              — built-in sample registry (for local testing)

import hashlib
import json
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from routers.system_routes import require_session
from pydantic import BaseModel

import tli_state as S
from process_utils import hidden_process_kwargs

router = APIRouter(tags=["hub"])

# ── Paths ────────────────────────────────────────────────────────
def _settings_path() -> Path:
    return Path(S.DATA_DIR) / "hub_settings.json"

def _installed_path() -> Path:
    return Path(S.DATA_DIR) / "hub_installed.json"

def _pkg_dir() -> Path:
    p = Path(S.DATA_DIR) / "hub_packages"
    p.mkdir(parents=True, exist_ok=True)
    return p

def _local_registry_path() -> Path:
    return Path(S.DATA_DIR) / "hub_local_registry.json"

# ── Defaults ─────────────────────────────────────────────────────
_DEFAULT_HUB_URL = ""  # Hub not yet live — user must configure manually
_REGISTRY_CACHE: dict = {}
_CACHE_TS: float = 0
_CACHE_TTL = 300  # 5 minutes

# ── Helpers ──────────────────────────────────────────────────────
def _load_settings() -> dict:
    p = _settings_path()
    try:
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {"enabled": False, "hub_url": _DEFAULT_HUB_URL}


def _save_settings(s: dict) -> None:
    p = _settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, indent=2), encoding="utf-8")
    tmp.replace(p)


def _load_installed() -> list:
    p = _installed_path()
    try:
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8")) or []
    except Exception:
        pass
    return []


def _save_installed(lst: list) -> None:
    p = _installed_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(lst, indent=2), encoding="utf-8")
    tmp.replace(p)


def _fetch_registry(hub_url: str) -> dict:
    global _REGISTRY_CACHE, _CACHE_TS
    now = time.time()
    if _REGISTRY_CACHE and (now - _CACHE_TS) < _CACHE_TTL:
        return _REGISTRY_CACHE

    try:
        req = urllib.request.Request(
            hub_url,
            headers={"User-Agent": f"TLI/{S.TLI_VERSION if hasattr(S, 'TLI_VERSION') else '1.0.0'}"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        _REGISTRY_CACHE = data
        _CACHE_TS = now
        return data
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not reach TLI Hub: {e}")


# ── Sample registry (local demo, no internet needed) ─────────────
_SAMPLE_REGISTRY = {
    "version": "1",
    "hub": "TLI Hub",
    "updated": "2026-04-11",
    "packages": [
        {
            "id": "theme-void",
            "type": "theme",
            "name": "Void",
            "author": "TLI Official",
            "version": "1.0",
            "description": "Pure black background with high-contrast emerald accents. Maximum focus.",
            "tags": ["dark", "minimal", "official"],
            "downloads": 0,
            "rating": 5.0,
            "preview_css": ":root { --bg: #000000; --bg-panel: #0a0a0a; --bg-elevated: #111111; --accent: #38e8b2; }",
        },
        {
            "id": "theme-slate",
            "type": "theme",
            "name": "Slate",
            "author": "TLI Official",
            "version": "1.0",
            "description": "Deep blue-grey tones. Easy on the eyes for long sessions.",
            "tags": ["dark", "blue", "official"],
            "downloads": 0,
            "rating": 4.8,
            "preview_css": ":root { --bg: #0f172a; --bg-panel: #1e293b; --bg-elevated: #253347; --accent: #38bdf8; }",
        },
        {
            "id": "preset-home-guardian",
            "type": "ai_preset",
            "name": "Home Guardian",
            "author": "TLI Official",
            "version": "1.0",
            "description": "AI persona focused on home security, device monitoring, and anomaly alerts. Speaks in concise status reports.",
            "tags": ["security", "monitoring", "official"],
            "downloads": 0,
            "rating": 4.9,
            "system_prompt": "You are Home Guardian, a security-focused AI assistant running on a private home LAN. You monitor devices, flag anomalies, and speak in concise status reports. Prioritize brevity and precision. If you detect something unusual in device states or network activity, lead with it.",
        },
        {
            "id": "preset-code-review",
            "type": "ai_preset",
            "name": "Code Reviewer",
            "author": "TLI Official",
            "version": "1.0",
            "description": "Strict code review persona. Flags bugs, security issues, and style violations. No hand-holding.",
            "tags": ["coding", "review", "official"],
            "downloads": 0,
            "rating": 4.7,
            "system_prompt": "You are a senior software engineer performing code review. Be direct and critical. Flag bugs, security vulnerabilities, and poor patterns. Do not soften feedback. Format issues as a numbered list with severity (critical/major/minor). Only praise code that genuinely deserves it.",
        },
        {
            "id": "script-disk-cleanup",
            "type": "script",
            "name": "Disk Cleanup",
            "author": "TLI Official",
            "version": "1.0",
            "description": "PowerShell script that finds temp files, Windows Update cache, and log files over 100MB. Reports sizes before deleting.",
            "tags": ["maintenance", "powershell", "official"],
            "downloads": 0,
            "rating": 4.6,
            "shell": "powershell",
            "code": "# TLI Disk Cleanup — finds and reports large temp/cache files\n$targets = @($env:TEMP, 'C:\\Windows\\Temp', 'C:\\Windows\\SoftwareDistribution\\Download')\n$total = 0\nforeach ($dir in $targets) {\n  if (Test-Path $dir) {\n    $size = (Get-ChildItem $dir -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum\n    $mb = [math]::Round($size / 1MB, 1)\n    Write-Host \"$dir : $mb MB\"\n    $total += $size\n  }\n}\nWrite-Host \"\nTotal: $([math]::Round($total / 1MB, 1)) MB found\"\nWrite-Host \"Run with -Delete flag to remove.\"",
        },
        {
            "id": "automation-night-mode",
            "type": "automation",
            "name": "Night Mode",
            "author": "TLI Official",
            "version": "1.0",
            "description": "Turns off all registered Shelly devices at 11 PM every night. Safe default for home setups.",
            "tags": ["shelly", "schedule", "official"],
            "downloads": 0,
            "rating": 4.5,
            "trigger": {"type": "time", "time": "23:00", "days": ["mon","tue","wed","thu","fri","sat","sun"]},
            "actions": [{"type": "shelly_all_off"}],
        },
        {
            "id": "app-mesh-monitor",
            "type": "app",
            "name": "Mesh Monitor",
            "author": "TLI Official",
            "version": "1.0",
            "description": "Live view of all TLI nodes on your LAN. Shows device name, role, and IP address in a clean grid.",
            "tags": ["mesh", "monitor", "official"],
            "downloads": 0,
            "rating": 5.0,
            "icon": "🖧",
            "permissions": ["mesh.devices", "notifications"],
            "inline_html": """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Mesh Monitor</title>
  <script src="/tli-bridge.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg, #0b0f14);
      color: var(--text-main, #e8f0f0);
      font-family: system-ui, -apple-system, sans-serif;
      padding: 24px;
      min-height: 100vh;
    }
    h1 { font-size: 15px; font-weight: 600; color: var(--accent, #38e8b2); letter-spacing: .04em; }
    .sub { font-size: 11px; opacity: .5; margin-top: 2px; margin-bottom: 20px; }
    .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
    .refresh-btn {
      background: transparent;
      border: 1px solid rgba(56,232,178,.3);
      color: var(--accent, #38e8b2);
      padding: 5px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      transition: background .15s;
    }
    .refresh-btn:hover { background: rgba(56,232,178,.08); }
    .count { font-size: 11px; opacity: .45; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
      gap: 12px;
    }
    .card {
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(56,232,178,.1);
      border-radius: 10px;
      padding: 14px 16px;
      transition: border-color .2s;
    }
    .card:hover { border-color: rgba(56,232,178,.3); }
    .card-name {
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--accent, #38e8b2);
      flex-shrink: 0;
    }
    .card-role { font-size: 11px; opacity: .45; margin-top: 4px; padding-left: 15px; }
    .card-ip   { font-size: 11px; opacity: .55; margin-top: 2px; padding-left: 15px; font-family: monospace; }
    .empty { font-size: 13px; opacity: .4; padding: 30px 0; }
    .self-badge {
      font-size: 9px;
      background: rgba(56,232,178,.15);
      color: var(--accent, #38e8b2);
      border-radius: 3px;
      padding: 1px 5px;
      margin-left: 4px;
      vertical-align: middle;
    }
  </style>
</head>
<body>
  <h1>🖧 Mesh Monitor</h1>
  <div class="sub">Live view of TLI nodes on your LAN</div>
  <div class="toolbar">
    <button class="refresh-btn" id="refresh-btn">↺ Refresh</button>
    <span class="count" id="count"></span>
  </div>
  <div class="grid" id="grid"><div class="empty">Connecting to TLI…</div></div>

  <script>
    function render(devices) {
      const grid = document.getElementById("grid");
      const count = document.getElementById("count");
      if (!devices || !devices.length) {
        grid.innerHTML = '<div class="empty">No mesh peers found.<br>Make sure other TLI nodes are running on your LAN.</div>';
        count.textContent = "0 nodes";
        return;
      }
      count.textContent = devices.length + " node" + (devices.length === 1 ? "" : "s");
      grid.innerHTML = devices.map(function(d) {
        const name = d.node_name || d.name || "Unknown Node";
        const role = d.role || "peer";
        const ip   = d.ip   || d.address || "—";
        const isSelf = d.is_self || false;
        return [
          '<div class="card">',
            '<div class="card-name">',
              '<span class="dot"></span>',
              name,
              isSelf ? '<span class="self-badge">this</span>' : "",
            '</div>',
            '<div class="card-role">' + role + '</div>',
            '<div class="card-ip">' + ip + '</div>',
          '</div>',
        ].join("");
      }).join("");
    }

    TLIBridge.ready(function() {
      TLIBridge.getMeshDevices().then(function(devices) {
        render(devices);
        if (devices.length) {
          TLIBridge.notify("Mesh Monitor: " + devices.length + " node(s) online", "success");
        }
      }).catch(function() {
        document.getElementById("grid").innerHTML =
          '<div class="empty">Could not fetch mesh devices. Check that TLI mesh is active.</div>';
      });
    });

    document.getElementById("refresh-btn").addEventListener("click", function() {
      document.getElementById("grid").innerHTML = '<div class="empty">Refreshing…</div>';
      document.getElementById("count").textContent = "";
      TLIBridge.getMeshDevices().then(render).catch(function() {
        document.getElementById("grid").innerHTML = '<div class="empty">Refresh failed.</div>';
      });
    });
  </script>
</body>
</html>""",
        },
        # The former app-wol-pad sample required an unimplemented /mesh/wol API.
        # Retire the bundled offer; installed packages and user registries are untouched.
    ],
}


# ── Helpers ── local registry ──────────────────────────────────────
def _load_local_registry() -> dict:
    p = _local_registry_path()
    try:
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {"version": "1", "hub": "TLI Local Hub", "packages": []}


def _save_local_registry(reg: dict) -> None:
    p = _local_registry_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(reg, indent=2), encoding="utf-8")
    tmp.replace(p)


# ── Pydantic models ───────────────────────────────────────────────
class HubSettingsRequest(BaseModel):
    enabled: Optional[bool] = None
    hub_url: Optional[str] = None


class InstallRequest(BaseModel):
    package_id: str
    use_sample: bool = False   # install from sample registry instead of remote


class PublishRequest(BaseModel):
    id:          str
    name:        str
    type:        str                    # theme / ai_preset / script / automation / app
    description: str = ""
    author:      str = "Local"
    version:     str = "1.0"
    tags:        List[str] = []
    # type-specific payload fields
    preview_css:   Optional[str] = None
    system_prompt: Optional[str] = None
    shell:         Optional[str] = None
    code:          Optional[str] = None
    trigger:       Optional[Dict[str, Any]] = None
    actions:       Optional[List[Dict[str, Any]]] = None
    # app-specific fields
    inline_html:   Optional[str] = None   # single-file app HTML content
    permissions:   List[str] = []         # declared TLI Bridge permissions
    icon:          Optional[str] = None   # emoji or URL for nav icon


# ── Routes ────────────────────────────────────────────────────────

@router.get("/hub/status")
def hub_status():
    s = _load_settings()
    installed = _load_installed()
    return {
        "enabled": s.get("enabled", False),
        "hub_url": s.get("hub_url", _DEFAULT_HUB_URL),
        "installed_count": len(installed),
    }


@router.post("/hub/settings")
def hub_settings(req: HubSettingsRequest, _session: str = Depends(require_session)):
    s = _load_settings()
    if req.enabled is not None:
        s["enabled"] = req.enabled
    if req.hub_url is not None:
        s["hub_url"] = req.hub_url.strip().rstrip("/")
    _save_settings(s)
    S.log_debug("hub", "INFO", "Hub settings updated", enabled=s["enabled"], url=s["hub_url"])
    return {"ok": True, "settings": s}


@router.get("/hub/registry")
def hub_registry(sample: bool = False):
    if sample:
        installed = _load_installed()
        installed_ids = {i["id"] for i in installed}
        pkgs = [
            {**p, "installed": p["id"] in installed_ids}
            for p in _SAMPLE_REGISTRY["packages"]
        ]
        return {**_SAMPLE_REGISTRY, "packages": pkgs, "source": "sample"}

    s = _load_settings()
    if not s.get("enabled"):
        raise HTTPException(status_code=403, detail="TLI Hub is not enabled. Enable it in Hub settings.")

    data = _fetch_registry(s.get("hub_url", _DEFAULT_HUB_URL))
    installed = _load_installed()
    installed_ids = {i["id"] for i in installed}
    pkgs = [
        {**p, "installed": p["id"] in installed_ids}
        for p in data.get("packages", [])
    ]
    return {**data, "packages": pkgs, "source": "remote"}


@router.get("/hub/sample")
def hub_sample_registry():
    """Always returns the built-in sample registry regardless of opt-in status."""
    installed = _load_installed()
    installed_ids = {i["id"] for i in installed}
    pkgs = [
        {**p, "installed": p["id"] in installed_ids}
        for p in _SAMPLE_REGISTRY["packages"]
    ]
    return {**_SAMPLE_REGISTRY, "packages": pkgs, "source": "sample"}


@router.get("/hub/installed")
def hub_installed():
    return {"installed": _load_installed()}


@router.post("/hub/install")
def hub_install(req: InstallRequest, _session: str = Depends(require_session)):
    # Find the package — sample first, then remote if hub enabled
    pkg = None
    for p in _SAMPLE_REGISTRY["packages"]:
        if p["id"] == req.package_id:
            pkg = p
            break

    if not pkg and not req.use_sample:
        s = _load_settings()
        if s.get("enabled"):
            try:
                data = _fetch_registry(s.get("hub_url", _DEFAULT_HUB_URL))
                for p in data.get("packages", []):
                    if p["id"] == req.package_id:
                        pkg = p
                        break
            except Exception:
                pass

    if not pkg:
        raise HTTPException(status_code=404, detail=f"Package '{req.package_id}' not found.")

    installed = _load_installed()
    # Remove existing entry for this id (re-install / update)
    installed = [i for i in installed if i["id"] != req.package_id]

    pkg_type = pkg.get("type", "unknown")
    pkg_dir  = _pkg_dir()
    now      = datetime.utcnow().isoformat() + "Z"

    # ── Type-specific install ──────────────────────────────────────
    if pkg_type == "theme":
        css = pkg.get("preview_css", "")
        css_file = pkg_dir / f"theme_{pkg['id']}.css"
        css_file.write_text(css, encoding="utf-8")

    elif pkg_type == "ai_preset":
        preset_file = pkg_dir / f"preset_{pkg['id']}.json"
        preset_file.write_text(
            json.dumps({"id": pkg["id"], "name": pkg["name"],
                        "system_prompt": pkg.get("system_prompt", "")}, indent=2),
            encoding="utf-8",
        )

    elif pkg_type == "script":
        script_file = pkg_dir / f"script_{pkg['id']}.json"
        script_file.write_text(
            json.dumps({"id": pkg["id"], "name": pkg["name"],
                        "shell": pkg.get("shell", "powershell"),
                        "code": pkg.get("code", "")}, indent=2),
            encoding="utf-8",
        )

    elif pkg_type == "automation":
        auto_file = pkg_dir / f"automation_{pkg['id']}.json"
        auto_file.write_text(
            json.dumps({"id": pkg["id"], "name": pkg["name"],
                        "trigger": pkg.get("trigger", {}),
                        "actions": pkg.get("actions", [])}, indent=2),
            encoding="utf-8",
        )

    elif pkg_type == "app":
        app_dir = Path(S.DATA_DIR) / "apps" / pkg["id"]
        app_dir.mkdir(parents=True, exist_ok=True)
        # Write inline HTML entry point if provided
        inline = pkg.get("inline_html")
        if inline:
            (app_dir / "index.html").write_text(inline, encoding="utf-8")
        # Write manifest so the runtime knows permissions / icon / entry
        manifest = {
            "id":          pkg["id"],
            "name":        pkg["name"],
            "version":     pkg.get("version", "1.0"),
            "author":      pkg.get("author", "Unknown"),
            "permissions": pkg.get("permissions", []),
            "icon":        pkg.get("icon", "📦"),
            "entry":       "index.html",
        }
        (app_dir / "manifest.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8"
        )

    record = {
        "id":           pkg["id"],
        "type":         pkg_type,
        "name":         pkg["name"],
        "author":       pkg.get("author", "Unknown"),
        "version":      pkg.get("version", "1.0"),
        "installed_at": now,
    }
    installed.append(record)
    _save_installed(installed)

    S.log_debug("hub", "INFO", "Package installed", id=pkg["id"], type=pkg_type)
    return {"ok": True, "package": record}


@router.delete("/hub/packages/{pkg_id}")
def hub_uninstall(pkg_id: str, _session: str = Depends(require_session)):
    installed = _load_installed()
    before = len(installed)
    target = next((i for i in installed if i["id"] == pkg_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Package not installed.")

    # Remove file artifact
    pkg_dir = _pkg_dir()
    for f in pkg_dir.glob(f"*_{pkg_id}.*"):
        try:
            f.unlink()
        except Exception:
            pass

    # App packages: remove the whole app directory
    if target.get("type") == "app":
        app_dir = Path(S.DATA_DIR) / "apps" / pkg_id
        if app_dir.exists():
            try:
                shutil.rmtree(app_dir)
            except Exception:
                pass

    installed = [i for i in installed if i["id"] != pkg_id]
    _save_installed(installed)
    S.log_debug("hub", "INFO", "Package uninstalled", id=pkg_id)
    return {"ok": True, "removed": before - len(installed)}


@router.get("/hub/apps")
def hub_apps():
    """Return installed app packages with their manifests (for tli-apps.js runtime)."""
    installed   = _load_installed()
    apps_dir    = Path(S.DATA_DIR) / "apps"
    result      = []
    for record in installed:
        if record.get("type") != "app":
            continue
        app_dir       = apps_dir / record["id"]
        manifest_file = app_dir / "manifest.json"
        manifest      = {}
        if manifest_file.exists():
            try:
                manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            except Exception:
                pass
        result.append({
            **record,
            "permissions": manifest.get("permissions", []),
            "icon":        manifest.get("icon", "📦"),
            "entry":       manifest.get("entry", "index.html"),
        })
    return {"apps": result}


@router.get("/hub/themes")
def hub_themes():
    """Return CSS for all installed themes so frontend can apply them."""
    pkg_dir = _pkg_dir()
    themes = []
    for f in pkg_dir.glob("theme_*.css"):
        pkg_id = f.stem.replace("theme_", "", 1)
        themes.append({"id": pkg_id, "css": f.read_text(encoding="utf-8")})
    return {"themes": themes}


@router.get("/hub/presets")
def hub_presets():
    """Return all installed AI presets for the Brain selector."""
    pkg_dir = _pkg_dir()
    presets = []
    for f in pkg_dir.glob("preset_*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            presets.append(data)
        except Exception:
            pass
    return {"presets": presets}


@router.post("/hub/packages/{pkg_id}/run")
def hub_run_script(pkg_id: str):
    """
    Execute an installed script package.
    Returns stdout/stderr (truncated to 8 KB) and exit code.
    Only script-type packages can be run.
    """
    installed = _load_installed()
    record = next((i for i in installed if i["id"] == pkg_id), None)
    if not record:
        raise HTTPException(status_code=404, detail="Package not installed.")
    if record.get("type") != "script":
        raise HTTPException(status_code=400, detail="Only script packages can be run.")

    script_file = _pkg_dir() / f"script_{pkg_id}.json"
    if not script_file.exists():
        raise HTTPException(status_code=404, detail="Script file not found — try reinstalling the package.")

    script_data = json.loads(script_file.read_text(encoding="utf-8"))
    shell = script_data.get("shell", "powershell")
    code  = script_data.get("code", "")

    if not code.strip():
        raise HTTPException(status_code=400, detail="Script has no code.")

    try:
        if shell == "powershell":
            result = subprocess.run(
                ["powershell", "-NonInteractive", "-NoProfile", "-Command", code],
                capture_output=True, text=True, timeout=30, **hidden_process_kwargs(),
            )
        elif shell in ("bash", "sh"):
            result = subprocess.run(
                [shell, "-c", code],
                capture_output=True, text=True, timeout=30, **hidden_process_kwargs(),
            )
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported shell: {shell}")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="Script timed out after 30 seconds.")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail=f"Shell '{shell}' not found on this system.")

    MAX = 8192
    return {
        "ok":        result.returncode == 0,
        "exit_code": result.returncode,
        "stdout":    result.stdout[:MAX],
        "stderr":    result.stderr[:MAX],
        "shell":     shell,
    }


# ── Local registry (publish + serve) ─────────────────────────────

@router.get("/hub/local-registry")
def hub_local_registry():
    """
    Serve this node's published packages as a Hub-compatible registry.
    Mesh peers can point their Hub URL at:  http://<this-node-ip>:<port>/hub/local-registry
    """
    reg = _load_local_registry()
    installed = _load_installed()
    installed_ids = {i["id"] for i in installed}
    pkgs = [{**p, "installed": p["id"] in installed_ids} for p in reg.get("packages", [])]
    return {**reg, "packages": pkgs, "source": "local"}


@router.post("/hub/publish")
def hub_publish(req: PublishRequest):
    """
    Publish a package to this node's local registry.
    Existing entry with the same id is replaced (acts as update).
    """
    VALID_TYPES = {"theme", "ai_preset", "script", "automation", "app"}
    if req.type not in VALID_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {sorted(VALID_TYPES)}")

    reg = _load_local_registry()
    now = datetime.utcnow().isoformat() + "Z"

    pkg: Dict[str, Any] = {
        "id":          req.id,
        "type":        req.type,
        "name":        req.name,
        "description": req.description,
        "author":      req.author,
        "version":     req.version,
        "tags":        req.tags,
        "published_at": now,
        "downloads":   0,
        "rating":      0,
    }
    if req.type == "theme"      and req.preview_css:    pkg["preview_css"]   = req.preview_css
    if req.type == "ai_preset"  and req.system_prompt:  pkg["system_prompt"] = req.system_prompt
    if req.type == "script":
        if req.shell:  pkg["shell"] = req.shell
        if req.code:   pkg["code"]  = req.code
    if req.type == "automation":
        if req.trigger: pkg["trigger"] = req.trigger
        if req.actions: pkg["actions"] = req.actions
    if req.type == "app":
        if req.inline_html:  pkg["inline_html"]  = req.inline_html
        if req.permissions:  pkg["permissions"]   = req.permissions
        if req.icon:         pkg["icon"]          = req.icon

    packages = [p for p in reg.get("packages", []) if p["id"] != req.id]
    packages.append(pkg)
    reg["packages"] = packages
    reg["updated"] = now
    _save_local_registry(reg)

    S.log_debug("hub", "INFO", "Package published to local registry", id=req.id, type=req.type)
    return {"ok": True, "package": pkg}


@router.delete("/hub/local-registry/{pkg_id}")
def hub_unpublish(pkg_id: str):
    """Remove a package from this node's local registry."""
    reg = _load_local_registry()
    before = len(reg.get("packages", []))
    reg["packages"] = [p for p in reg.get("packages", []) if p["id"] != pkg_id]
    if len(reg["packages"]) == before:
        raise HTTPException(status_code=404, detail="Package not found in local registry.")
    _save_local_registry(reg)
    return {"ok": True}
