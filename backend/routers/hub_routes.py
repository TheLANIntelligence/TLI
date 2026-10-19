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

import copy
import json
import time
import urllib.request
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import tli_state as S
import hub_store as store
from browser_authority import browser_control_access
from script_sources import list_hub_metadata, read_hub_source

router = APIRouter(tags=["hub"])

# ── Paths ────────────────────────────────────────────────────────
def _settings_path() -> Path:
    return Path(S.DATA_DIR) / "hub_settings.json"

def _installed_path() -> Path:
    return Path(S.DATA_DIR) / "hub_installed.json"

def _pkg_dir() -> Path:
    return store.path("hub_packages")

def _local_registry_path() -> Path:
    return Path(S.DATA_DIR) / "hub_local_registry.json"

# ── Defaults ─────────────────────────────────────────────────────
_DEFAULT_HUB_URL = ""  # Hub not yet live — user must configure manually
_REGISTRY_CACHE: dict = {}
_CACHE_TS: float = 0
_CACHE_TTL = 300  # 5 minutes

# ── Helpers ──────────────────────────────────────────────────────
def _load_settings(check=store.noop) -> dict:
    return store.load("settings", check)


def _save_settings(s: dict, check=store.noop) -> None:
    store.update("settings", lambda _: s, check)


def _load_installed(check=store.noop) -> list:
    return store.load("installed", check)


def _save_installed(lst: list, check=store.noop) -> None:
    store.update("installed", lambda _: lst, check)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _fetch_registry(hub_url: str, check=store.noop) -> dict:
    global _REGISTRY_CACHE, _CACHE_TS
    store.hub_url(hub_url)
    if not hub_url:
        raise store.error(400, "Configure an HTTP or HTTPS Hub registry address first.")
    check()
    now = time.time()
    with store.LOCK:
        cached = _REGISTRY_CACHE.get(hub_url)
        if cached and now - cached[0] < _CACHE_TTL:
            check()
            return copy.deepcopy(cached[1])

    try:
        req = urllib.request.Request(
            hub_url,
            headers={"User-Agent": f"TLI/{S.TLI_VERSION if hasattr(S, 'TLI_VERSION') else '1.0.0'}"},
        )
        opener = urllib.request.build_opener(_NoRedirect())
        with opener.open(req, timeout=8) as resp:
            check()
            raw = resp.read(store.REGISTRY_LIMIT + 1)
            check()
        if len(raw) > store.REGISTRY_LIMIT:
            raise store.error(502, "The Hub registry exceeds its supported size.")
        data = store.validate_registry(store.decode_json(raw, status=502), status=502)
        check()
        with store.LOCK:
            check()
            # Keep bounded cache space, keyed by the exact configured URL.
            _REGISTRY_CACHE = {hub_url: (now, copy.deepcopy(data))}
            _CACHE_TS = now
        return data
    except HTTPException:
        check()
        raise
    except Exception:
        check()
        raise store.error(502, "The configured Hub registry could not be read. No redirect or replacement registry was used.") from None


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
def _load_local_registry(check=store.noop) -> dict:
    return store.load("registry", check)


def _save_local_registry(reg: dict, check=store.noop) -> None:
    store.update("registry", lambda _: reg, check)


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
def hub_status(check: Callable[[], None] = Depends(browser_control_access)):
    s = _load_settings(check)
    installed = _load_installed(check)
    check()
    return {
        "enabled": s.get("enabled", False),
        "hub_url": s.get("hub_url", _DEFAULT_HUB_URL),
        "installed_count": len(installed),
    }


@router.post("/hub/settings")
def hub_settings(req: HubSettingsRequest, check: Callable[[], None] = Depends(browser_control_access)):
    global _REGISTRY_CACHE
    def change(s):
        if req.enabled is not None:
            s["enabled"] = req.enabled
        if req.hub_url is not None:
            s["hub_url"] = store.hub_url(req.hub_url.strip())
        return s
    s = store.update("settings", change, check)
    with store.LOCK:
        _REGISTRY_CACHE = {}
    S.log_debug("hub", "INFO", "Hub settings updated", enabled=s["enabled"], url=s["hub_url"])
    check()
    return {"ok": True, "settings": s}


@router.get("/hub/registry")
def hub_registry(sample: bool = False, check: Callable[[], None] = Depends(browser_control_access)):
    installed = _load_installed(check)
    if sample:
        installed_ids = {i["id"] for i in installed}
        pkgs = [
            {**p, "installed": p["id"] in installed_ids}
            for p in _SAMPLE_REGISTRY["packages"]
        ]
        check()
        return {**_SAMPLE_REGISTRY, "packages": pkgs, "source": "sample"}

    s = _load_settings(check)
    if not s.get("enabled"):
        check()
        raise store.error(403, "TLI Hub is not enabled. Enable it in Hub settings.")

    check()
    data = _fetch_registry(s.get("hub_url", _DEFAULT_HUB_URL), check)
    check()
    installed = _load_installed(check)
    installed_ids = {i["id"] for i in installed}
    pkgs = [
        {**p, "installed": p["id"] in installed_ids}
        for p in data.get("packages", [])
    ]
    check()
    return {**data, "packages": pkgs, "source": "remote"}


@router.get("/hub/sample")
def hub_sample_registry(check: Callable[[], None] = Depends(browser_control_access)):
    """Always returns the built-in sample registry regardless of opt-in status."""
    installed = _load_installed(check)
    installed_ids = {i["id"] for i in installed}
    pkgs = [
        {**p, "installed": p["id"] in installed_ids}
        for p in _SAMPLE_REGISTRY["packages"]
    ]
    check()
    return {**_SAMPLE_REGISTRY, "packages": pkgs, "source": "sample"}


@router.get("/hub/installed")
def hub_installed(check: Callable[[], None] = Depends(browser_control_access)):
    check()
    installed = store.load("installed", check)
    check()
    return {"installed": installed}


@router.post("/hub/install")
def hub_install(req: InstallRequest, check: Callable[[], None] = Depends(browser_control_access)):
    store.safe_id(req.package_id)
    # Validate saved state before a remote wait or any package write.
    _load_installed(check)
    pkg = next((p for p in _SAMPLE_REGISTRY["packages"] if p["id"] == req.package_id), None)
    if pkg is None and not req.use_sample:
        settings = _load_settings(check)
        if settings["enabled"]:
            data = _fetch_registry(settings["hub_url"], check)
            check()
            pkg = next((p for p in data["packages"] if p["id"] == req.package_id), None)
    check()
    if pkg is None:
        raise store.error(404, "Package not found in the selected registry.")
    record = store.change_package(pkg, req.package_id, check, installed_at=datetime.utcnow().isoformat() + "Z")
    S.log_debug("hub", "INFO", "Package installed", id=record["id"], type=record["type"])
    check()
    return {"ok": True, "package": record}


@router.delete("/hub/packages/{pkg_id}")
def hub_uninstall(pkg_id: str, check: Callable[[], None] = Depends(browser_control_access)):
    store.change_package(None, pkg_id, check, remove=True)
    S.log_debug("hub", "INFO", "Package uninstalled", id=pkg_id)
    check()
    return {"ok": True, "removed": 1}


@router.get("/hub/apps")
def hub_apps(check: Callable[[], None] = Depends(browser_control_access)):
    """Return complete registered manifests; declared permissions grant nothing."""
    with store.LOCK:
        installed = _load_installed(check)
        result = []
        for record in installed:
            if record["type"] != "app":
                continue
            row, manifest, _html = store.app_snapshot(record["id"], check)
            result.append({**row, "permissions": manifest.get("permissions", []),
                           "icon": manifest.get("icon", "📦"), "entry": "index.html"})
        store.assert_ready(check)
        check()
        return {"apps": result}


@router.get("/hub/themes")
def hub_themes(check: Callable[[], None] = Depends(browser_control_access)):
    """Read exact registered theme files without globbing or creating directories."""
    with store.LOCK:
        themes = []
        for record in _load_installed(check):
            if record["type"] == "theme":
                target = store.artifact_paths(record["id"], "theme")[0]
                snapshot = store.read_artifact(target, check, store.SOURCE_LIMIT)
                try:
                    css = snapshot.raw.decode("utf-8")
                except UnicodeError:
                    check()
                    raise store.error() from None
                themes.append({"id": record["id"], "css": css})
        store.assert_ready(check)
        check()
        return {"themes": themes}


@router.get("/hub/presets")
def hub_presets(check: Callable[[], None] = Depends(browser_control_access)):
    """Read exact registered presets; damaged files are preserved and surfaced."""
    with store.LOCK:
        presets = []
        for record in _load_installed(check):
            if record["type"] == "ai_preset":
                target = store.artifact_paths(record["id"], "ai_preset")[0]
                snapshot = store.read_artifact(target, check, store.INDEX_LIMIT)
                try:
                    data = store.decode_json(snapshot.raw)
                    if not isinstance(data, dict) or data.get("id") != record["id"] or not isinstance(data.get("system_prompt"), str):
                        raise store.error()
                except Exception:
                    check()
                    raise
                presets.append(data)
        store.assert_ready(check)
        check()
        return {"presets": presets}


@router.post("/hub/packages/{pkg_id}/run")
def hub_run_script(pkg_id: str, check: Callable[[], None] = Depends(browser_control_access)):
    """Retire arbitrary host execution without reading or changing saved packages."""
    check()
    raise HTTPException(410, "Hub host-script execution is unavailable. Installed source and package records were preserved. View or export the saved source instead.", headers={"Cache-Control": "no-store"})


@router.get("/hub/packages/{pkg_id}/source")
def hub_script_source(pkg_id: str, check: Callable[[], None] = Depends(browser_control_access)):
    return read_hub_source(pkg_id, check)


# ── Local registry (publish + serve) ─────────────────────────────

@router.get("/hub/local-registry")
def hub_local_registry():
    """
    Serve this node's published packages as a Hub-compatible registry.
    Intentionally public: only explicitly published package contents are shared.
    Mesh peers can point their Hub URL at:  http://<this-node-ip>:<port>/hub/local-registry
    """
    reg = _load_local_registry()
    return {**reg, "source": "local"}


@router.post("/hub/publish")
def hub_publish(req: PublishRequest, check: Callable[[], None] = Depends(browser_control_access)):
    """
    Publish a package to this node's local registry.
    Existing entry with the same id is replaced (acts as update).
    """
    store.safe_id(req.id)
    now = datetime.utcnow().isoformat() + "Z"
    result = {}
    def change(reg):
        previous = next((p for p in reg["packages"] if p["id"] == req.id), {})
        if any(p["id"].casefold() == req.id.casefold() and p["id"] != req.id for p in reg["packages"]):
            raise store.error(409, "A published package already uses this identifier with different letter case.")
        # Keep compatible unknown fields when updating an existing publication.
        package = {**previous, **req.model_dump(exclude_none=True), "published_at": now,
                   "downloads": previous.get("downloads", 0), "rating": previous.get("rating", 0)}
        store.validate_package(package)
        reg["packages"] = [p for p in reg["packages"] if p["id"] != req.id] + [package]
        reg["updated"] = now
        result.update(package)
        return reg
    store.update("registry", change, check)
    S.log_debug("hub", "INFO", "Package published to local registry", id=req.id, type=req.type)
    check()
    return {"ok": True, "package": result}


@router.delete("/hub/local-registry/{pkg_id}")
def hub_unpublish(pkg_id: str, check: Callable[[], None] = Depends(browser_control_access)):
    """Remove a package from this node's local registry."""
    store.safe_id(pkg_id)
    def change(reg):
        packages = [p for p in reg["packages"] if p["id"] != pkg_id]
        if len(packages) == len(reg["packages"]):
            raise store.error(404, "Package not found in local registry.")
        reg["packages"] = packages
        return reg
    store.update("registry", change, check)
    check()
    return {"ok": True}
