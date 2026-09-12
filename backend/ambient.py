# backend/ambient.py
# Ambient awareness — background health checks + home snapshot for AI context.
#
# run_ambient_loop()   → start from main.py on_startup as an asyncio task
# get_home_snapshot()  → sync helper called by chat_routes to inject home state
from __future__ import annotations

import asyncio
import shutil
import platform
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

try:
    import psutil as _psutil
except ImportError:
    _psutil = None  # type: ignore

import tli_state as S

_DISK_WARN_PCT  = 85
_DISK_CRIT_PCT  = 95
_OFFLINE_MINS   = 30   # minutes without heartbeat → offline alert


# ── helpers ──────────────────────────────────────────────────────────────────

def _minutes_since(iso_ts: str) -> float:
    try:
        ts = iso_ts.rstrip("Z")
        dt = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds() / 60
    except Exception:
        return float("inf")


# ── individual checks ─────────────────────────────────────────────────────────

def _safe_kind(mountpoint: str) -> str:
    """Turn a mount point into a safe alert kind suffix."""
    safe = mountpoint.replace("\\", "_").replace("/", "_").replace(":", "").strip("_")
    return safe or "root"


def _check_disk() -> None:
    """
    Check every mounted filesystem for fullness.
    Each drive/partition gets its own alert keyed by mount point,
    so multi-drive setups report correctly on all platforms.
    """
    checked: set = set()

    def _check_mount(mountpoint: str) -> None:
        if mountpoint in checked:
            return
        checked.add(mountpoint)
        try:
            usage = shutil.disk_usage(mountpoint)
            if usage.total == 0:
                return
            pct = int(usage.used / usage.total * 100)
            free_gb = round(usage.free / 1e9, 1)
            sfx = _safe_kind(mountpoint)
            kind_crit = f"disk_critical_{sfx}"
            kind_warn  = f"disk_warn_{sfx}"
            label = mountpoint if mountpoint != str(Path.home()) else f"{mountpoint} (home)"
            if pct >= _DISK_CRIT_PCT:
                new_alert = S.add_alert(kind_crit,
                            f"Disk critically full: {pct}% used ({free_gb} GB free) — {label}",
                            detail=mountpoint, severity="critical")
                if new_alert:
                    try:
                        import event_bus as _eb
                        _eb.emit_event("system", "alert",
                                       f"Disk critically full: {pct}% used ({free_gb} GB free) — {label}",
                                       f"{label} is almost full. Open Free Space to review this drive; no files have been changed.")
                    except Exception:
                        pass
                S.resolve_alert(kind_warn)
            elif pct >= _DISK_WARN_PCT:
                new_alert = S.add_alert(kind_warn,
                            f"Disk filling up: {pct}% used ({free_gb} GB free) — {label}",
                            detail=mountpoint, severity="warn")
                if new_alert:
                    try:
                        import event_bus as _eb
                        _eb.emit_event("system", "warn",
                                       f"Disk filling up: {pct}% used ({free_gb} GB free) — {label}",
                                       f"Consider reviewing free space on {label} soon.")
                    except Exception:
                        pass
                S.resolve_alert(kind_crit)
            else:
                S.resolve_alert(kind_warn)
                S.resolve_alert(kind_crit)
        except (PermissionError, OSError):
            pass

    # Dismiss legacy single-key alerts from old schema
    S.resolve_alert("disk_critical")
    S.resolve_alert("disk_warn")

    try:
        if _psutil:
            for part in _psutil.disk_partitions(all=False):
                mp = part.mountpoint
                # Skip pseudo / special filesystems on Linux/macOS
                if platform.system() != "Windows" and part.fstype in (
                    "tmpfs", "devtmpfs", "sysfs", "proc", "cgroup",
                    "cgroup2", "securityfs", "pstore", "efivarfs",
                    "bpf", "debugfs", "tracefs", "hugetlbfs", "mqueue",
                    "fusectl", "squashfs",
                ):
                    continue
                _check_mount(mp)
        else:
            # psutil not available — fall back to home directory drive
            _check_mount(str(Path.home()))
    except Exception as e:
        S.log_debug("ambient", "WARN", "Disk check failed", error=str(e))


def _probe_shelly(ip: str, timeout: float = 2.0) -> bool:
    """Quick reachability probe — True if device responds."""
    import requests as _req
    try:
        r = _req.get(f"http://{ip}/rpc/Shelly.GetDeviceInfo", timeout=timeout)
        return r.status_code == 200
    except Exception:
        return False


def _check_shelly_devices() -> None:
    """Alert for Shelly devices that don't respond to a quick probe."""
    try:
        devices = S.load_shelly_registry()
        for dev in devices:
            ip   = (dev.get("ip") or dev.get("address") or "").strip()
            name = dev.get("name") or ip or "unknown"
            if not ip:
                continue
            kind = f"shelly_offline_{ip}"
            if _probe_shelly(ip):
                S.resolve_alert(kind)
            else:
                new_alert = S.add_alert(kind,
                            f"Smart device unreachable: {name}",
                            detail=f"No response from http://{ip}",
                            severity="warn")
                if new_alert:
                    try:
                        import event_bus as _eb
                        _eb.emit_event("device", "warn", f"Smart device unreachable: {name}",
                                       f"No response from http://{ip}")
                    except Exception:
                        pass
    except Exception as e:
        S.log_debug("ambient", "WARN", "Shelly check failed", error=str(e))


def _check_mesh_nodes() -> None:
    try:
        directory = S.load_mesh_directory()
        node_cfg  = S.load_node_config()
        # Dedup by IP + name so one physical machine with multiple node_ids
        # only generates one alert regardless of how many directory entries it has.
        seen_ips:   set = set()
        seen_names: set = set()
        for node_id, node in directory.items():
            if node_id == node_cfg.node_id:
                continue
            ip   = node.get("ip", "")
            name = (node.get("display_name") or node_id).strip().lower()
            if ip and ip in seen_ips:
                continue
            if name and name in seen_names:
                continue
            if ip:
                seen_ips.add(ip)
            if name:
                seen_names.add(name)
            ts   = node.get("last_seen") or ""
            if not ts:
                continue
            # Use a stable kind keyed on display name so both entries share one alert slot
            kind = f"mesh_offline_{name}"
            mins = _minutes_since(ts)
            if mins > _OFFLINE_MINS:
                new_alert = S.add_alert(kind,
                            f"Mesh node offline: {node.get('display_name') or node_id}",
                            detail=f"Last seen {int(mins)} min ago",
                            severity="warn")
                if new_alert:
                    try:
                        import event_bus as _eb
                        _eb.emit_event("mesh", "warn",
                                       f"Mesh node offline: {node.get('display_name') or node_id}",
                                       f"Last seen {int(mins)} min ago")
                    except Exception:
                        pass
            else:
                S.resolve_alert(kind)
    except Exception as e:
        S.log_debug("ambient", "WARN", "Mesh node check failed", error=str(e))


def run_all_checks() -> None:
    _check_disk()
    _check_shelly_devices()
    _check_mesh_nodes()


# ── background loop ───────────────────────────────────────────────────────────

async def run_ambient_loop() -> None:
    """Long-running asyncio task started in main.py on_startup."""
    await asyncio.sleep(30)   # let startup finish first
    while True:
        try:
            run_all_checks()
        except Exception as e:
            S.log_debug("ambient", "ERROR", "Ambient loop error", error=str(e))
        limits   = S.get_active_system_limits()
        interval = max(60, limits.get("scan_interval_sec", 120))
        await asyncio.sleep(interval)


# ── home snapshot for chat context ────────────────────────────────────────────

def get_home_snapshot() -> Dict[str, Any]:
    """
    Return a lightweight dict describing current home state.
    Called by chat_routes to inject live context into the AI system prompt.
    """
    snap: Dict[str, Any] = {}

    try:
        # Report the fullest drive for chat context
        worst_pct, worst_free = 0, 0.0
        if _psutil:
            for part in _psutil.disk_partitions(all=False):
                try:
                    u = _psutil.disk_usage(part.mountpoint)
                    if u.total > 0 and u.percent > worst_pct:
                        worst_pct = int(u.percent)
                        worst_free = round(u.free / 1e9, 1)
                except (PermissionError, OSError):
                    continue
        if worst_pct == 0:
            usage = shutil.disk_usage(Path.home())
            worst_pct = int(usage.used / usage.total * 100)
            worst_free = round(usage.free / 1e9, 1)
        snap["disk_used_pct"] = worst_pct
        snap["disk_free_gb"]  = worst_free
    except Exception:
        pass

    try:
        devices = S.load_shelly_registry()
        snap["shelly_count"]   = len(devices)
        snap["shelly_devices"] = [d.get("name") or d.get("ip", "?") for d in devices[:6]]
    except Exception:
        pass

    try:
        directory = S.load_mesh_directory()
        node_cfg  = S.load_node_config()
        snap["mesh_role"]  = node_cfg.role
        snap["mesh_peers"] = len(directory)
        snap["mesh_online"] = [
            n.get("display_name", nid)
            for nid, n in directory.items()
            if n.get("status") == "allowed"
        ]
    except Exception:
        pass

    try:
        alerts = S.load_alerts()
        active = [a for a in alerts if not a.get("dismissed")]
        snap["alert_count"]   = len(active)
        snap["alert_messages"] = [a["message"] for a in active[:4]]
    except Exception:
        pass

    return snap
