# system_summary.py
# TLI Environment Context — injected into AI system prompt
# so the AI knows your live system state.
#
# This is what makes TLI different from a generic local AI.
# The AI doesn't just know about the world — it knows about YOUR setup.

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional


# ----------------------------
# Shelly devices
# ----------------------------
def _get_shelly_summary(shelly_registry_path: str) -> List[Dict[str, Any]]:
    """
    Read the Shelly device registry and return a lightweight summary list.
    Does NOT make live network calls — reads registry only.
    For live power readings, those come from the home_power router separately.
    """
    try:
        p = Path(shelly_registry_path)
        if not p.exists():
            return []
        raw = json.loads(p.read_text(encoding="utf-8") or "[]")
        if not isinstance(raw, list):
            return []

        devices = []
        for d in raw:
            if not isinstance(d, dict):
                continue
            ip = str(d.get("ip") or d.get("host") or "").strip()
            if not ip:
                continue
            devices.append({
                "name": str(d.get("name") or d.get("label") or "").strip() or ip,
                "ip": ip,
                "relay": int(d.get("relay") or 0),
                "vendor": "shelly",
            })
        return devices
    except Exception:
        return []


# ----------------------------
# Mesh nodes
# ----------------------------
def _get_mesh_summary(data_dir: str) -> List[Dict[str, Any]]:
    """
    Read mesh node state from the agent_state.json file.
    Returns a list of known nodes with their last-seen status.
    """
    try:
        agent_state_path = Path(data_dir) / "mesh" / "agent_state.json"
        if not agent_state_path.exists():
            # Try mesh_directory as fallback
            mesh_dir_path = Path(data_dir) / "mesh" / "mesh_directory.json"
            if not mesh_dir_path.exists():
                return []
            raw = json.loads(mesh_dir_path.read_text(encoding="utf-8") or "{}")
        else:
            raw = json.loads(agent_state_path.read_text(encoding="utf-8") or "{}")

        if not isinstance(raw, dict):
            return []

        nodes = []
        # agent_state is usually {device_id: {name, role, last_seen, ...}}
        for device_id, info in raw.items():
            if not isinstance(info, dict):
                continue
            nodes.append({
                "device_id": device_id,
                "name": str(info.get("node_name") or info.get("name") or device_id),
                "role": str(info.get("role") or "member"),
                "last_seen": str(info.get("last_seen") or info.get("updated_at") or "unknown"),
                "host_address": info.get("host_address"),
            })
        return nodes
    except Exception:
        return []


# ----------------------------
# Recent events from debug log
# ----------------------------
def _get_recent_events(data_dir: str, limit: int = 10) -> List[Dict[str, Any]]:
    """
    Read the last N entries from debug_log.jsonl.
    Returns a list of structured event dicts.
    Only includes WARN and ERROR level events — INFO is too noisy for AI context.
    """
    try:
        log_path = Path(data_dir) / "debug_log.jsonl"
        if not log_path.exists():
            return []

        lines = []
        with log_path.open("r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line:
                    lines.append(line)

        # Take last N*3 lines so we have enough to filter
        recent_lines = lines[-(limit * 3):]

        events = []
        for line in recent_lines:
            try:
                obj = json.loads(line)
                if not isinstance(obj, dict):
                    continue
                # Only surface WARN/ERROR to AI — INFO is too spammy
                level = str(obj.get("level") or "").upper()
                if level in ("WARN", "ERROR", "WARNING"):
                    events.append({
                        "ts": obj.get("ts", ""),
                        "level": level,
                        "subsystem": obj.get("subsystem", ""),
                        "message": obj.get("message", ""),
                    })
            except Exception:
                continue

        # Return most recent `limit` filtered events
        return events[-limit:]
    except Exception:
        return []


# ----------------------------
# Storage hint
# ----------------------------
def _get_storage_hint() -> Dict[str, Any]:
    """
    Return a quick storage snapshot using psutil.
    Shows the primary disk usage so the AI can answer storage questions.
    Falls back to empty dict if psutil not available.
    """
    try:
        import psutil  # type: ignore

        # Get all partitions, find the primary one (C:\ on Windows, / on Unix)
        partitions = psutil.disk_partitions(all=False)
        if not partitions:
            return {}

        # Pick the best primary partition
        primary = None
        for p in partitions:
            mp = p.mountpoint
            if mp in ("/", "C:\\", "C:/"):
                primary = p
                break
        if not primary:
            primary = partitions[0]

        try:
            usage = psutil.disk_usage(primary.mountpoint)
        except Exception:
            return {}

        def _human(n: int) -> str:
            units = ["B", "KB", "MB", "GB", "TB"]
            v = float(n)
            for u in units[:-1]:
                if v < 1024:
                    return f"{v:.1f} {u}"
                v /= 1024
            return f"{v:.1f} TB"

        return {
            "mountpoint": primary.mountpoint,
            "total_human": _human(usage.total),
            "used_human": _human(usage.used),
            "free_human": _human(usage.free),
            "percent_used": round(usage.percent, 1),
        }
    except Exception:
        return {}


# ----------------------------
# Main context function
# Called by ai_routes.py
# ----------------------------
def get_tli_context(data_dir: str, shelly_registry_path: str) -> Dict[str, Any]:
    """
    Gathers a real-time snapshot of the TLI environment.
    Injected into the AI system prompt so the AI knows your setup.

    Called once per chat request — kept fast and safe.
    Any individual section failing will not crash the whole context.
    """
    ctx: Dict[str, Any] = {}

    try:
        ctx["shelly_devices"] = _get_shelly_summary(shelly_registry_path)
    except Exception:
        ctx["shelly_devices"] = []

    try:
        ctx["mesh_nodes"] = _get_mesh_summary(data_dir)
    except Exception:
        ctx["mesh_nodes"] = []

    try:
        ctx["recent_events"] = _get_recent_events(data_dir)
    except Exception:
        ctx["recent_events"] = []

    try:
        ctx["storage_hint"] = _get_storage_hint()
    except Exception:
        ctx["storage_hint"] = {}

    return ctx
