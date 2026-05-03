"""
TLI Bundled AI — ai_routes.py (rebuilt from scratch)

SSE protocol (matches app.js tliBundledChatStream):
  data: {"type":"meta","session_id":"conv-xxx"}\n\n
  data: {"type":"delta","text":"Hello"}\n\n
  data: {"type":"delta","text":" world"}\n\n
  data: {"type":"done"}\n\n

Non-streaming fallback:
  POST /api/ai/chat → {"session_id":"...", "reply":"...", "model":"...", "elapsed_ms":N}

Conversation history saved to conversations.json via tli_state.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from fastapi import APIRouter, HTTPException, UploadFile, File, Request, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .ai_manager import BundledAIManager, MODEL_PRESETS, DEFAULT_PRESET, _save_active_preset_id, get_models_dir, set_models_dir, _ai_base_dir
from .intent_engine import detect_intent, execute_action, IntentResult, ActionResult
from .diagnostics import run_full_diagnostic, run_startup_check

try:
    import tli_state as S
    _HAS_STATE = True
except ImportError:
    _HAS_STATE = False

router = APIRouter(prefix="/api/ai", tags=["BundledAI"])

MAX_HISTORY_TURNS = 16

# ==================================================================
#  Mesh AI peer discovery + transparent routing
# ==================================================================

_MESH_CACHE: dict = {"peers": [], "ts": 0.0}
_MESH_CACHE_TTL = 30          # seconds between full subnet pings
_MESH_TIER_RANK = {"power": 4, "standard": 3, "lite": 2, "vision": 1}


def _find_mesh_ai_peer() -> dict | None:
    """
    Return the best mesh peer that currently has a healthy AI running.
    Results are cached for _MESH_CACHE_TTL seconds to avoid hammering the LAN.
    Peers are ranked by model tier (power > standard > lite > vision).
    """
    now = time.time()
    if now - _MESH_CACHE["ts"] < _MESH_CACHE_TTL and _MESH_CACHE["peers"]:
        return _MESH_CACHE["peers"][0]

    candidates: list[dict] = []
    try:
        if _HAS_STATE:
            directory = S.load_mesh_directory()
            for peer_id, peer in directory.items():
                ip = peer.get("ip", "")
                port = int(peer.get("tli_port", 8000))
                if not ip:
                    continue
                try:
                    r = requests.get(f"http://{ip}:{port}/agent/ping", timeout=1.5)
                    if not r.ok:
                        continue
                    data = r.json()
                    if data.get("ai_healthy"):
                        preset = data.get("active_preset") or "lite"
                        candidates.append({
                            "ip": ip,
                            "port": port,
                            "node_id": peer_id,
                            "node_name": data.get("node_name") or data.get("hostname") or ip,
                            "preset": preset,
                            "rank": _MESH_TIER_RANK.get(preset, 0),
                        })
                except Exception:
                    continue
    except Exception:
        pass

    candidates.sort(key=lambda x: x["rank"], reverse=True)
    _MESH_CACHE["peers"] = candidates
    _MESH_CACHE["ts"] = now
    return candidates[0] if candidates else None


def _invalidate_mesh_cache() -> None:
    _MESH_CACHE["ts"] = 0.0


def _should_prefer_mesh() -> bool:
    """
    Return True if this node should try a mesh AI peer BEFORE running local inference.
    Triggers when:
      - prefer_mesh_ai is explicitly set on this node, OR
      - current CPU usage exceeds the configured threshold (default 80%), OR
      - available RAM is critically low (>90% used)
    """
    try:
        cfg = S.load_node_config()
        if cfg.prefer_mesh_ai:
            return True
        import psutil
        threshold = cfg.mesh_ai_cpu_threshold or 80
        cpu = psutil.cpu_percent(interval=0.2)
        if cpu >= threshold:
            _log("chat", "INFO", "CPU overload — preferring mesh AI",
                 cpu_pct=cpu, threshold=threshold)
            return True
        ram = psutil.virtual_memory()
        if ram.percent >= 90:
            _log("chat", "INFO", "RAM pressure — preferring mesh AI",
                 ram_pct=ram.percent, available_mb=round(ram.available / 1024 / 1024))
            return True
    except Exception:
        pass
    return False


def _stream_via_mesh_peer(peer: dict, user_text: str, conv_id: str,
                           max_tokens: int, temperature: float,
                           device_id: str | None = None):
    """
    Proxy a streaming AI request to a mesh peer, re-emitting our SSE protocol.
    Skips the peer's meta event and injects our own with mesh_node details.
    """
    node_name = peer.get("node_name", peer.get("ip", "Mesh node"))
    peer_url = f"http://{peer['ip']}:{peer['port']}/api/ai/chat/stream"

    yield f"data: {json.dumps({'type': 'meta', 'session_id': conv_id, 'handled_by': 'mesh', 'mesh_node': {'name': node_name, 'ip': peer['ip'], 'preset': peer.get('preset', '')}})}\n\n"

    payload = {
        "message": user_text,
        "conversation_id": conv_id,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "device_id": device_id,
    }

    try:
        with requests.post(peer_url, json=payload, stream=True, timeout=(3, 90)) as resp:
            if not resp.ok:
                yield f"data: {json.dumps({'type': 'error', 'detail': f'Mesh peer {node_name} returned HTTP {resp.status_code}'})}\n\n"
                return
            for raw in resp.iter_lines():
                if not raw:
                    continue
                line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
                if not line.startswith("data: "):
                    continue
                try:
                    obj = json.loads(line[6:])
                    if obj.get("type") == "meta":
                        continue  # we already sent our own meta
                    yield f"data: {json.dumps(obj)}\n\n"
                    if obj.get("type") == "done":
                        break
                except Exception:
                    continue
    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'detail': f'Mesh connection to {node_name} lost: {str(e)}'})}\n\n"


# ==================================================================
#  Startup self-check (background, 3s delay)
# ==================================================================

def _launch_startup_self_check():
    """Run a lightweight AI + model file check 3 seconds after module load."""
    def _run():
        import time as _time
        _time.sleep(3)
        try:
            mgr = BundledAIManager.get()
            model_path = None
            try:
                active = mgr.active_preset_id
                if active and active in MODEL_PRESETS:
                    model_path = get_models_dir() / MODEL_PRESETS[active]["filename"]
            except Exception:
                pass
            report = run_startup_check(mgr.base_url, model_path=model_path)
            status = "OK" if report["healthy"] else "DEGRADED"
            summary = [f"{c['name']}: {'OK' if c['ok'] else 'FAIL'} ({c['detail']})"
                       for c in report["checks"]]
            _log("ai", "INFO", f"Startup self-check: {status}", checks=summary)
        except Exception as e:
            _log("ai", "WARN", f"Startup self-check failed: {e}")

    t = threading.Thread(target=_run, daemon=True, name="tli-startup-check")
    t.start()


_launch_startup_self_check()

AI_DIR = _ai_base_dir()
DEVICES_DIR = AI_DIR / "memory" / "devices"
DEVICES_DIR.mkdir(parents=True, exist_ok=True)


# ==================================================================
#  Helpers: logging, time, conversation persistence
# ==================================================================

def _now():
    return S.now_iso() if _HAS_STATE else __import__("datetime").datetime.utcnow().isoformat() + "Z"

def _log(sub, lvl, msg, **kw):
    if _HAS_STATE:
        S.log_debug(sub, lvl, msg, **kw)

def _get_or_create_conv(conv_id, device_id=None, mesh_source_ip=None):
    if not _HAS_STATE:
        return conv_id or str(uuid.uuid4())
    conversations = S.load_conversations()
    if conv_id and conv_id in conversations:
        return conv_id
    new_id = conv_id or f"conv-{uuid.uuid4().hex[:12]}"
    now = _now()
    conv = {
        "id": new_id, "title": "", "user_id": "bundled-ai",
        "device_id": device_id, "created_at": now, "last_updated": now,
        "messages": [], "provider": "bundled",
    }
    if mesh_source_ip:
        conv["mesh_source_ip"] = mesh_source_ip  # marks this as a peer-originated conversation
    conversations[new_id] = conv
    S.save_conversations(conversations)
    return new_id

def _auto_title(text, max_len=60):
    clean = re.sub(r"[#*_`~\[\]()]", "", text).strip()
    clean = re.sub(r"\s+", " ", clean)
    if len(clean) <= max_len:
        return clean
    return clean[:max_len].rsplit(" ", 1)[0] + "..."

def _save_turn(conv_id, role, content, **extra):
    if not _HAS_STATE or not conv_id:
        return
    conversations = S.load_conversations()
    conv = conversations.get(conv_id)
    if not conv:
        return
    msg = {"role": role, "content": content, "ts": _now()}
    msg.update(extra)
    conv.setdefault("messages", []).append(msg)
    conv["last_updated"] = _now()
    if not conv.get("title") and role == "user":
        conv["title"] = _auto_title(content)
    S.save_conversations(conversations)

def _load_history(conv_id):
    if not _HAS_STATE or not conv_id:
        return []
    conversations = S.load_conversations()
    conv = conversations.get(conv_id)
    if not conv:
        return []
    turns = []
    for m in (conv.get("messages") or []):
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content"):
            turns.append({"role": m["role"], "content": m["content"]})
    return turns[-MAX_HISTORY_TURNS:] if len(turns) > MAX_HISTORY_TURNS else turns


# ==================================================================
#  Device memory (personal facts per-device)
# ==================================================================

def _dev_mem_path(device_id):
    safe = "".join(c for c in (device_id or "default") if c.isalnum() or c in "-_")
    return DEVICES_DIR / f"{safe}_memory.json"

def _load_dev_mem(device_id):
    if not device_id:
        return []
    p = _dev_mem_path(device_id)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return [str(m) for m in data if m] if isinstance(data, list) else []
    except Exception:
        return []

def _save_dev_mem(device_id, memories):
    if not device_id:
        return
    p = _dev_mem_path(device_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    capped = memories[-100:]
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(capped, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)

def _append_dev_mem(device_id, fact):
    if not device_id or not fact or not fact.strip():
        return
    mems = _load_dev_mem(device_id)
    cleaned = fact.strip()
    if cleaned not in mems:
        mems.append(cleaned)
        _save_dev_mem(device_id, mems)


# ==================================================================
#  System prompt builder
# ==================================================================

def _get_tli_context():
    try:
        import importlib, sys, os
        from datetime import datetime as _dt
        backend_dir = AI_DIR.parent
        data_dir = backend_dir / "data"
        shelly_path = data_dir / "shelly_registry.json"
        if str(backend_dir) not in sys.path:
            sys.path.insert(0, str(backend_dir))
        mod = importlib.import_module("system_summary")
        ctx = mod.get_tli_context(data_dir=str(data_dir), shelly_registry_path=str(shelly_path))
        lines = ["\n\nCurrent TLI environment:"]
        lines.append(f"  - Current date/time: {_dt.now().strftime('%A, %B %d, %Y %H:%M')} (local)")
        try:
            _nc = S.load_node_config()
            if _nc.node_name:
                lines.append(f"  - Node name: {_nc.node_name} (role: {_nc.role or 'standalone'})")
        except Exception:
            pass
        if not ctx:
            return "\n".join(lines)
        for d in (ctx.get("shelly_devices") or []):
            name = d.get("name") or d.get("ip") or "?"
            lines.append(f"  - Device: {name}")
        for n in (ctx.get("mesh_nodes") or []):
            lines.append(f"  - Node: {n.get('name','?')} ({n.get('role','member')})")
        st = ctx.get("storage_hint") or {}
        if st.get("percent_used") is not None:
            lines.append(f"  - Storage: {st['percent_used']:.0f}% used, {st.get('free_human','?')} free")
        return "\n".join(lines)
    except Exception:
        return ""

_PANEL_LABELS = {
    "panel-dashboard":    "Dashboard",
    "panel-devices":      "Devices",
    "panel-visualizer":   "Visualizer",
    "panel-fileorg":      "File Organizer",
    "panel-printshop":    "Print & Scan Studio",
    "panel-vault":        "Vault",
    "panel-homeauto":     "Home Automation",
    "panel-lan":          "LAN Scanner",
    "panel-usb":          "USB Devices",
    "panel-mesh":         "Mesh",
    "panel-chat":         "Chat",
}

def _build_system_prompt(device_id=None, active_panel=None):
    prompt_path = AI_DIR / "prompts" / "system_default.txt"
    try:
        base = prompt_path.read_text(encoding="utf-8").strip()
    except Exception:
        base = ""
    if not base:
        base = (
            "You are TLI, a local AI assistant running on the user's own hardware.\n"
            "Be concise. Match your response length to the question -- short questions get short answers.\n"
            "Use markdown for structure when helpful (headers, bold, lists, code blocks).\n"
            "Never invent facts. You have no internet access.\n"
            "Be friendly and direct. Skip filler phrases like 'Certainly!' or 'Great question!'.\n"
            "CRITICAL: Never simulate or roleplay running tools or commands. "
            "Do not pretend to call functions like disk_usage_analysis() or produce fake output. "
            "If you do not have real data, say so clearly and direct the user to the relevant TLI panel."
        )
    ctx = _get_tli_context()
    panel_block = ""
    if active_panel:
        label = _PANEL_LABELS.get(active_panel, active_panel.replace("panel-", "").replace("-", " ").title())
        panel_block = f"\n\nActive panel: The user is currently viewing the **{label}** panel."
    mem_block = ""
    if device_id:
        mems = _load_dev_mem(device_id)
        if mems:
            mem_block = "\n\nKnown facts about this user:\n" + "\n".join(f"- {m}" for m in mems[-8:])
    return base + ctx + panel_block + mem_block


# ==================================================================
#  Fast-path tool answers (no model call)
# ==================================================================

def _tool_answer(request, text):
    """
    Fast-path: answer common TLI questions by calling backend endpoints directly.
    Returns real data, not generic advice. Returns None if no match.
    Any crash falls through to the LLM gracefully.
    """
    try:
        return _tool_answer_inner(request, text)
    except Exception as e:
        _log("chat", "WARN", f"Tool fast-path crashed, falling through to LLM: {e}")
        return None


def _kw_match(kws: List[str], query: str) -> bool:
    """
    True if a keyword matches AND it appears as a primary topic of the query.
    Conservative guard: long sentences where the keyword is buried are skipped,
    letting the LLM handle casual mentions naturally.

    Examples:
      "what's my printer"           → True   (short, direct)
      "I was printing something"    → False  (keyword buried past char 40 in longer context)
    """
    if not any(kw in query for kw in kws):
        return False
    # Short queries are almost always direct requests
    if len(query) <= 60:
        return True
    # Long queries: keyword must appear in the first 40 chars to be the primary topic
    prefix = query[:40]
    return any(kw in prefix for kw in kws)


def _tool_answer_inner(request, text):
    q = (text or "").strip().lower()
    base = str(request.base_url).rstrip("/") + "/"
    _log("chat", "DEBUG", f"Tool fast-path checking: '{q[:80]}'")

    def _get(path, timeout=3):
        try:
            r = requests.get(base + path, timeout=timeout)
            return r.json() if r.ok else None
        except Exception:
            return None

    # ---- Date / Time (authoritative — never let LLM guess this) ----
    if _kw_match(["what's today", "what day is", "what date", "today's date",
                  "current date", "what time", "current time", "what year"], q):
        from datetime import datetime as _dt
        now = _dt.now()
        return (f"Today is **{now.strftime('%A, %B %d, %Y')}**. "
                f"The local time is **{now.strftime('%I:%M %p')}**.")

    # ---- Printers ----
    if _kw_match(["printer", "printing", "print queue"], q):
        _log("chat", "DEBUG", "Tool match: printer")
        data = _get("printers")
        _log("chat", "DEBUG", f"Printer data: {str(data)[:200] if data else 'None'}")
        if data:
            # Handle both formats: list of printers OR dict with "printers" key
            printers = data if isinstance(data, list) else (data.get("printers") or [])
            dp = data.get("default_printer") if isinstance(data, dict) else None
            # Find default from list if not explicit
            if not dp:
                for p in printers:
                    if isinstance(p, dict) and p.get("is_default"):
                        dp = p.get("name") or p.get("system_name") or "unknown"
                        break
            names = [p.get("name") or p.get("system_name") or "?" for p in printers if isinstance(p, dict)]
            if dp:
                if len(names) > 1:
                    return f"Your default printer is **{dp}**. All printers: {', '.join(names)}."
                return f"Your default printer is **{dp}**."
            if names:
                return f"Found {len(names)} printer(s): {', '.join(names)}. No default is set."
        return "I checked TLI's printer endpoint but no printers were detected."

    # ---- Smart home / Shelly ----
    if _kw_match(["shelly", "smart plug", "smart home", "plug", "power usage", "energy", "watt"], q):
        data = _get("homeauto/devices")
        if data:
            devices = data.get("devices") or []
            if not devices:
                return "No Shelly smart home devices are registered in TLI. Add them in the Home Automation panel."
            lines = []
            for d in devices:
                name = d.get("name") or d.get("ip") or "unknown"
                ip = d.get("ip", "")
                # Try to get live status
                status = _get(f"shelly/status?ip={ip}&relay=0", timeout=4) if ip else None
                if status and status.get("ok"):
                    s = status.get("summary") or {}
                    state = "ON" if s.get("is_on") else "OFF" if s.get("is_on") is False else "unknown"
                    power = s.get("power_w")
                    pw = f", {power:.1f}W" if power is not None else ""
                    lines.append(f"- **{name}** ({ip}): {state}{pw}")
                else:
                    lines.append(f"- **{name}** ({ip}): status unavailable")
            return "Smart home devices:\n" + "\n".join(lines)

    # ---- USB devices ----
    if _kw_match(["usb", "usb device", "plugged in", "connected device"], q):
        data = _get("devices/usb", timeout=5)
        if data:
            devices = data.get("devices") or []
            if not devices:
                return "No USB devices detected."
            names = [d.get("name","USB Device") for d in devices[:10] if isinstance(d, dict)]
            return f"Found {len(devices)} USB device(s):\n" + "\n".join(f"- {n}" for n in names)
        return "USB scan didn't return results. Check the Devices panel."

    # ---- System info / disk ----
    if _kw_match(["system info", "system status", "my computer", "my pc", "my machine",
                  "cpu", "ram", "memory usage", "disk space", "storage",
                  "drive", "disk", "full", "running out", "space left", "free space",
                  "how much space", "disk usage", "what's taking", "why is my"], q):
        parts = []
        disk_parts = []
        # Fetch real disk data first
        try:
            r = requests.post(base + "tools/run", json={"tool_id": "disk_overview"}, timeout=5)
            if r.ok:
                out = r.json().get("output")
                if out:
                    snap = json.loads(out) if isinstance(out, str) else out
                    for d in (snap.get("disks") or [])[:5]:
                        pct = d.get("percent_used", 0)
                        flag = " ⚠️ CRITICALLY FULL" if pct >= 95 else (" ⚠️ getting full" if pct >= 85 else "")
                        disk_parts.append(
                            f"- {d.get('mountpoint','?')}: "
                            f"{d.get('free_gb','?')} GB free of {d.get('total_gb','?')} GB "
                            f"({pct:.0f}% used){flag}"
                        )
        except Exception:
            pass
        # Fallback: sys_snapshot also has disks + RAM
        if not disk_parts:
            try:
                r = requests.post(base + "tools/run", json={"tool_id": "sys_snapshot"}, timeout=5)
                if r.ok:
                    out = r.json().get("output")
                    if out:
                        snap = json.loads(out) if isinstance(out, str) else out
                        mem = snap.get("memory") or {}
                        if mem:
                            parts.append(f"RAM: {mem.get('used_gb','?')} / {mem.get('total_gb','?')} GB ({mem.get('percent_used','?')}% used)")
                        for d in (snap.get("disks") or [])[:5]:
                            pct = d.get("percent_used", 0)
                            flag = " ⚠️ CRITICALLY FULL" if pct >= 95 else (" ⚠️ getting full" if pct >= 85 else "")
                            disk_parts.append(
                                f"- {d.get('mountpoint','?')}: "
                                f"{d.get('free_gb','?')} GB free of {d.get('total_gb','?')} GB "
                                f"({pct:.0f}% used){flag}"
                            )
            except Exception:
                pass
        result_lines = []
        if disk_parts:
            result_lines.append("**Storage (real-time data):**")
            result_lines.extend(disk_parts)
        if parts:
            result_lines.extend(parts)
        if result_lines:
            result_lines.append("\nOpen the Visualizer panel to drill into large folders.")
            return "\n".join(result_lines)
        return "Couldn't retrieve disk data right now. Check the Visualizer panel for live storage details."

    # ---- Network / LAN ----
    if _kw_match(["network", "lan scan", "lan device", "arp", "who is on my network",
                  "devices on my network", "ip address", "connected to my network"], q):
        data = _get("devices/scan", timeout=6)
        if data:
            arp = data.get("arp_table") or []
            if arp:
                lines = [f"Found {len(arp)} device(s) on your network:"]
                for entry in arp[:12]:
                    ip = entry.get("ip","?")
                    mac = entry.get("mac","?")
                    vendor = entry.get("vendor","")
                    mesh = entry.get("mesh_device")
                    label = f" ({mesh.get('display_name','')})" if mesh else (f" ({vendor})" if vendor else "")
                    lines.append(f"- {ip} · {mac}{label}")
                if len(arp) > 12:
                    lines.append(f"  ...and {len(arp)-12} more")
                return "\n".join(lines)
        return "LAN scan didn't find any devices. Check your network connection."

    # ---- Vault ----
    if _kw_match(["vault", "password", "secret", "encrypted"], q):
        data = _get("vault/status")
        if data:
            init = data.get("initialized", False)
            unlocked = data.get("unlocked", False)
            if not init:
                return "Your vault isn't set up yet. Go to the Vault panel to create a master password."
            if unlocked:
                return "Your vault is **unlocked**. You can store and retrieve secrets from the Vault panel."
            return "Your vault is **locked**. Unlock it from the Vault panel to access your secrets."
        return "Couldn't check vault status."

    # ---- Mesh ----
    if _kw_match(["mesh", "other computer", "other pc", "other machine", "lan node", "joined"], q):
        data = _get("mesh/directory")
        if data:
            devices = data if isinstance(data, dict) else {}
            if not devices:
                return "No mesh nodes found. This machine is running standalone. Other PCs can join via the Mesh panel."
            lines = []
            for dev_id, info in devices.items():
                if not isinstance(info, dict):
                    continue
                name = info.get("display_name") or info.get("hostname") or dev_id
                status = info.get("status", "unknown")
                role = "host" if info.get("is_host") else "member"
                lines.append(f"- **{name}**: {status} ({role})")
            return f"Mesh network ({len(lines)} node(s)):\n" + "\n".join(lines) if lines else "No mesh nodes found."

    # ---- Model / AI info ----
    if _kw_match(["what model", "which model", "what ai", "which ai", "about yourself"], q):
        data = _get("api/ai/bundled/status")
        if data and data.get("healthy"):
            model = data.get("active_model") or "local model"
            return f"I'm TLI's built-in AI, currently running **{model}** on your hardware. Fully offline, no cloud."
        return "I'm TLI's built-in AI assistant. I run locally on your hardware via llama.cpp."

    return None


# ==================================================================
#  Action intent execution (AI function-calling)
# ==================================================================

def _route_action_intent(request: Request, user_text: str) -> Optional[str]:
    """
    Route through the intent engine. Returns a response string if the intent engine
    handled the request (LLM LOCKED OUT), or None if no intent matched (safe to fall through).

    3-state routing:
      no_match → return None (fall through to tools/LLM)
      failed   → return error string (LLM locked out — device not found)
      matched  → execute action, return result (LLM locked out)
    On any exception → return error string (NOT None — don't fall through to LLM)
    """
    try:
        shelly_registry = []
        if _HAS_STATE:
            try:
                shelly_registry = S.load_shelly_registry()
            except Exception:
                pass

        result = detect_intent(user_text, shelly_registry)

        if result.status == "no_match":
            return None

        if result.status == "failed":
            _log("chat", "INFO", f"Intent failed (device not found): {(result.error or '')[:80]}")
            return result.error

        # status == "matched"
        intent = result.intent
        _log("chat", "INFO", f"Intent matched: {intent.get('type')} → {intent.get('action', intent.get('tool_id', '?'))}")
        base_url = str(request.base_url).rstrip("/")
        action_result = execute_action(base_url, intent)
        _log("chat", "INFO", f"Action result: success={action_result.success} elapsed_ms={action_result.elapsed_ms}")
        return action_result.message

    except Exception as e:
        _log("chat", "WARN", f"Intent engine exception (blocking LLM): {e}")
        return f"Action system error: {e}"


# ==================================================================
#  LLM communication
# ==================================================================

def _llama_post(base_url, payload, timeout_s=60):
    """Non-streaming POST to llama.cpp."""
    import urllib.request, urllib.error
    url = base_url + "/v1/chat/completions"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise HTTPException(status_code=502, detail=f"AI HTTPError {e.code}: {body}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI request failed: {e}")


def _llama_stream_raw(url, payload):
    """
    Generator: yields raw SSE data strings from llama.cpp streaming endpoint.
    Each yielded value is the content of a "data:" line (without the prefix).
    """
    try:
        with requests.post(url, json=payload, stream=True, timeout=(5, 120)) as r:
            if not r.ok:
                yield json.dumps({"type": "error", "detail": f"HTTP {r.status_code}"})
                return
            r.encoding = "utf-8"  # force UTF-8; llama.cpp may omit charset in Content-Type
            for raw_line in r.iter_lines(decode_unicode=True):
                if not raw_line:
                    continue
                line = raw_line.strip()
                if not line.startswith("data:"):
                    continue
                data_str = line[5:].strip()
                if data_str == "[DONE]":
                    return
                yield data_str
    except Exception as e:
        yield json.dumps({"type": "error", "detail": str(e)[:500]})


# ==================================================================
#  Pydantic models
# ==================================================================

class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    raw_input: Optional[str] = None
    session_id: Optional[str] = None
    conversation_id: Optional[str] = None
    device_id: Optional[str] = None
    active_panel: Optional[str] = None  # e.g. "panel-visualizer", "panel-printshop"
    max_tokens: int = 300
    temperature: float = 0.2
    image_b64: Optional[str] = None   # base64-encoded image for vision models
    image_mime: Optional[str] = None  # e.g. "image/jpeg", "image/png"
    _mesh_source_ip: Optional[str] = None  # set server-side when request comes from a mesh peer

class ChatResponse(BaseModel):
    session_id: str
    conversation_id: Optional[str] = None
    reply: str
    model: Optional[str] = None
    elapsed_ms: int
    provider: Optional[str] = None
    handled_by: Optional[str] = None

def _user_message(text: str, image_b64: Optional[str] = None, image_mime: Optional[str] = None) -> dict:
    """Build a user message dict. Includes image content when provided (vision models)."""
    if not image_b64:
        return {"role": "user", "content": text}
    return {
        "role": "user",
        "content": [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {
                "url": f"data:{image_mime or 'image/jpeg'};base64,{image_b64}"
            }},
        ],
    }


class ClearSessionRequest(BaseModel):
    session_id: str

class ClearDeviceMemoryRequest(BaseModel):
    device_id: str

class MemoryAddRequest(BaseModel):
    device_id: str
    fact: str


# ==================================================================
#  GET /api/ai/diagnostics
# ==================================================================

@router.get("/diagnostics")
def ai_diagnostics(request: Request):
    """Full system health report — AI runtime, model file, Shelly devices, tools, conversations."""
    mgr = BundledAIManager.get()
    base_url = str(request.base_url).rstrip("/")

    shelly_registry = []
    if _HAS_STATE:
        try:
            shelly_registry = S.load_shelly_registry()
        except Exception:
            pass

    # Resolve active model path
    model_path = None
    try:
        active = mgr.active_preset_id
        if active and active in MODEL_PRESETS:
            model_path = get_models_dir() / MODEL_PRESETS[active]["filename"]
    except Exception:
        pass

    conversations_path = None
    if _HAS_STATE:
        try:
            from pathlib import Path as _Path
            conversations_path = _Path(S.CONVERSATIONS_FILE)
        except Exception:
            pass

    report = run_full_diagnostic(
        base_url=base_url,
        shelly_registry=shelly_registry,
        model_path=model_path,
        conversations_path=conversations_path,
    )
    return report


# ==================================================================
#  GET /api/ai/status
# ==================================================================

@router.get("/mesh/status")
def mesh_ai_status():
    """
    Returns the best available AI source: local first, then mesh peers.
    Used by the frontend AI pill to show 'Mesh AI · NodeName' when local AI is off.
    """
    mgr = BundledAIManager.get()
    st = mgr.status()
    if st.get("healthy"):
        return {"available": True, "source": "local", "peer": None}

    peer = _find_mesh_ai_peer()
    if peer:
        return {
            "available": True,
            "source": "mesh",
            "peer": {
                "name": peer["node_name"],
                "ip": peer["ip"],
                "preset": peer.get("preset", ""),
            },
        }
    return {"available": False, "source": "none", "peer": None}


@router.get("/mesh/preference")
def get_mesh_preference():
    """Return this node's mesh AI preference settings."""
    try:
        cfg = S.load_node_config()
        return {
            "prefer_mesh_ai": cfg.prefer_mesh_ai,
            "mesh_ai_cpu_threshold": cfg.mesh_ai_cpu_threshold,
        }
    except Exception:
        return {"prefer_mesh_ai": False, "mesh_ai_cpu_threshold": 80}


@router.post("/mesh/preference")
def set_mesh_preference(payload: Dict[str, Any]):
    """
    Update mesh AI preference settings.
    Body: { prefer_mesh_ai: bool, mesh_ai_cpu_threshold: int (40-100) }
    """
    try:
        cfg = S.load_node_config()
        if "prefer_mesh_ai" in payload:
            cfg.prefer_mesh_ai = bool(payload["prefer_mesh_ai"])
        if "mesh_ai_cpu_threshold" in payload:
            val = int(payload["mesh_ai_cpu_threshold"])
            cfg.mesh_ai_cpu_threshold = max(40, min(100, val))
        import tli_state as _S
        cfg.updated_at = _S.now_iso()
        S.save_node_config(cfg)
        _invalidate_mesh_cache()
        return {"ok": True, "prefer_mesh_ai": cfg.prefer_mesh_ai,
                "mesh_ai_cpu_threshold": cfg.mesh_ai_cpu_threshold}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/status")
def ai_status():
    mgr = BundledAIManager.get()
    st = mgr.status()
    if not st.get("model_exists"):
        return {
            "ok": False,
            "healthy": False,
            "reason": "model_missing",
            "active_preset": st.get("active_preset"),
            "base_url": mgr.base_url,
            "presets": list(MODEL_PRESETS.keys()),
        }
    return {
        "ok": True,
        "healthy": st.get("healthy", False),
        "base_url": mgr.base_url,
        "active_preset": st.get("active_preset"),
        "active_model": st.get("active_model"),
        "active_filename": st.get("active_filename"),
    }


# ==================================================================
#  Model management (download, upload, status)
# ==================================================================

# ==================================================================
#  Model presets + download system
# ==================================================================

_DL = {"in_progress": False, "bytes_done": 0, "bytes_total": 0,
       "status": "idle", "error": "", "started_at": None, "finished_at": None,
       "url": "", "preset_id": "", "filename": ""}
_DL_LOCK = threading.Lock()
_DL_CANCEL = threading.Event()

def _set_dl(**kw):
    with _DL_LOCK: _DL.update(kw)

def _get_dl():
    with _DL_LOCK: return dict(_DL)


@router.get("/models/presets")
def list_model_presets():
    """Return all available model tiers with download status."""
    mgr = BundledAIManager.get()
    models_dir = get_models_dir()
    presets = []
    for pid, p in MODEL_PRESETS.items():
        fpath = models_dir / p["filename"]
        file_exists = fpath.exists()
        presets.append({
            **p,
            "downloaded": file_exists,
            "size_on_disk": fpath.stat().st_size if file_exists else 0,
            "is_active": pid == mgr.active_preset_id and file_exists,
            "is_selected": pid == mgr.active_preset_id,  # config says this, even if missing
        })
    return {"presets": presets, "active": mgr.active_preset_id}


@router.post("/models/select")
def select_model_preset(payload: Dict[str, Any]):
    """Switch to a different model tier. Model must be downloaded first."""
    preset_id = (payload or {}).get("preset_id", "").strip()
    if not preset_id:
        raise HTTPException(status_code=400, detail="preset_id is required")
    if preset_id not in MODEL_PRESETS:
        raise HTTPException(status_code=400, detail=f"Unknown preset: {preset_id}")
    mgr = BundledAIManager.get()
    result = mgr.switch_model(preset_id)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "Switch failed"))
    return result


@router.get("/model/info")
def model_info():
    mgr = BundledAIManager.get()
    st = mgr.status()
    preset = MODEL_PRESETS.get(mgr.active_preset_id, {})
    return {
        "expected_name": preset.get("filename", ""),
        "expected_path": str(mgr.cfg.model_path),
        "exists": mgr.cfg.model_path.exists(),
        "size_bytes": mgr.cfg.model_path.stat().st_size if mgr.cfg.model_path.exists() else 0,
        "active_preset": mgr.active_preset_id,
        "preset": preset,
        "default_download_url": preset.get("url", ""),
        "recommended_url": preset.get("url", ""),  # alias used by model manager UI
    }


@router.post("/model/upload")
async def model_upload(file: UploadFile = File(...)):
    """Upload a custom .gguf file. Saves to models/ and activates it."""
    mgr = BundledAIManager.get()
    fname = (file.filename or "").strip()
    if not fname.lower().endswith(".gguf"):
        raise HTTPException(status_code=400, detail="Please upload a .gguf file")
    _md = get_models_dir()
    _md.mkdir(parents=True, exist_ok=True)
    target = _md / fname
    tmp = target.with_suffix(target.suffix + ".uploading")
    with open(tmp, "wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk: break
            f.write(chunk)
    if target.exists():
        try: target.unlink()
        except: pass
    tmp.replace(target)
    # Save as active (custom model)
    _save_active_preset_id("custom", filename=fname)
    mgr.cfg.model_path = target
    mgr.stop()
    mgr.ensure_running()
    return {"ok": True, "saved_as": fname, "path": str(target), "healthy": mgr.is_healthy()}


def _download_worker(preset_id, url, target_path):
    """Background download worker for model files."""
    _DL_CANCEL.clear()
    try:
        _set_dl(in_progress=True, bytes_done=0, bytes_total=0, status="downloading",
                error="", started_at=time.time(), finished_at=None, url=url,
                preset_id=preset_id, filename=Path(target_path).name)
        path = Path(target_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".downloading")
        with requests.get(url, stream=True, timeout=(15, 300)) as r:
            r.raise_for_status()
            total = int(r.headers.get("content-length") or 0)
            _set_dl(bytes_total=total)
            done = 0
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(chunk_size=1024 * 1024):
                    if _DL_CANCEL.is_set():
                        raise RuntimeError("Download cancelled")
                    if chunk:
                        f.write(chunk)
                        done += len(chunk)
                        _set_dl(bytes_done=done)
        if path.exists():
            try: path.unlink()
            except: pass
        tmp.replace(path)
        _set_dl(in_progress=False, status="done", finished_at=time.time())
        # Auto-activate the downloaded model
        _save_active_preset_id(preset_id)
        _log("ai", "INFO", f"Model downloaded and activated: {preset_id}")
    except Exception as e:
        _set_dl(in_progress=False, status="error", error=str(e), finished_at=time.time())
        # Clean up partial file
        try:
            tmp_path = Path(target_path).with_suffix(Path(target_path).suffix + ".downloading")
            if tmp_path.exists(): tmp_path.unlink()
        except: pass


@router.post("/model/download")
def model_download(payload: Dict[str, Any]):
    """Download a model. Accepts preset_id (recommended) or raw url."""
    preset_id = (payload or {}).get("preset_id", "").strip()
    url = (payload or {}).get("url", "").strip()

    if _get_dl().get("in_progress"):
        return {"ok": True, "status": "already_downloading", "progress": _get_dl()}

    _models_dir = get_models_dir()
    # If preset_id given, use its URL
    if preset_id and preset_id in MODEL_PRESETS:
        preset = MODEL_PRESETS[preset_id]
        url = url or preset["url"]
        target = str(_models_dir / preset["filename"])
    elif url:
        # Custom URL: extract filename from URL
        fname = url.rsplit("/", 1)[-1] if "/" in url else "custom_model.gguf"
        target = str(_models_dir / fname)
        preset_id = preset_id or "custom"
    else:
        # Default to standard
        preset = MODEL_PRESETS[DEFAULT_PRESET]
        preset_id = DEFAULT_PRESET
        url = preset["url"]
        target = str(_models_dir / preset["filename"])

    if not url:
        raise HTTPException(status_code=400, detail="No URL to download from")

    _set_dl(status="starting", url=url, preset_id=preset_id)

    # For vision presets, also queue the mmproj download after the main model
    mmproj_url = (MODEL_PRESETS.get(preset_id) or {}).get("mmproj_url")
    mmproj_target = None
    if mmproj_url:
        mmproj_fname = (MODEL_PRESETS.get(preset_id) or {}).get("mmproj_filename")
        if mmproj_fname:
            mmproj_target = str(_models_dir / mmproj_fname)

    def _download_chain():
        _download_worker(preset_id, url, target)
        if mmproj_url and mmproj_target and _get_dl().get("status") == "done":
            _set_dl(status="downloading_mmproj", in_progress=True, bytes_done=0)
            _download_worker(preset_id + "_mmproj", mmproj_url, mmproj_target)

    threading.Thread(target=_download_chain, daemon=True).start()
    return {"ok": True, "status": "started", "preset_id": preset_id, "url": url,
            "mmproj": bool(mmproj_url)}


@router.post("/model/download/cancel")
def model_download_cancel():
    """Cancel an in-progress download."""
    _DL_CANCEL.set()
    with _DL_LOCK:
        _DL.update({"status": "cancelled", "in_progress": False, "finished_at": time.time()})
    return {"ok": True, "status": "cancelled"}


@router.get("/model/download/status")
def model_download_status():
    return _get_dl()


@router.delete("/model/{preset_id}")
def delete_model(preset_id: str):
    """Delete a downloaded model file. If it's active, stops the server first."""
    if preset_id not in MODEL_PRESETS:
        raise HTTPException(status_code=404, detail=f"Unknown preset: {preset_id}")
    mgr = BundledAIManager.get()
    # If deleting the active model, stop the server
    if mgr.active_preset_id == preset_id:
        mgr.stop()
        _log("ai", "INFO", f"Stopped AI server — active model being deleted: {preset_id}")
    fpath = get_models_dir() / MODEL_PRESETS[preset_id]["filename"]
    if fpath.exists():
        fpath.unlink()
        return {"ok": True, "deleted": True, "was_active": mgr.active_preset_id == preset_id}
    return {"ok": True, "deleted": False, "note": "File was not present"}


def _extract_user_text(raw_input: Optional[str], wrapped_message: str) -> str:
    """
    Extract the user's actual message using 4-priority fallback chain.
    Priority 1: raw_input field (clean text, no parsing needed)
    Priority 2: Parse last "User:" line from SYSTEM:/CONVERSATION: wrapped format
    Priority 3: Strip SYSTEM:/CONVERSATION: blocks, use remainder
    Priority 4: Use full message as-is
    """
    # Priority 1
    if raw_input and raw_input.strip():
        return raw_input.strip()

    raw = wrapped_message or ""

    # Priority 2
    if "User:" in raw:
        lines = raw.split("\n")
        user_lines = [ln for ln in lines if ln.strip().startswith("User:")]
        if user_lines:
            clean = user_lines[-1].split("User:", 1)[-1].strip()
            if clean.endswith("Assistant:"):
                clean = clean[: -len("Assistant:")].strip()
            if clean:
                return clean

    # Priority 3
    stripped = re.sub(r"SYSTEM:.*?(?=CONVERSATION:|User:|$)", "", raw, flags=re.DOTALL).strip()
    stripped = re.sub(r"CONVERSATION:.*?(?=User:|$)", "", stripped, flags=re.DOTALL).strip()
    if stripped:
        return stripped

    # Priority 4
    return raw.strip()


# ==================================================================
#  Request trace
# ==================================================================

class RequestTrace:
    def __init__(self, user_text: str):
        self.user_text = user_text
        self.started = time.time()
        self.layers: List[Dict] = []

    def record(self, layer: str, result: str, elapsed_ms: int) -> None:
        self.layers.append({"layer": layer, "result": result, "elapsed_ms": elapsed_ms})

    def summary(self) -> Dict:
        return {
            "user_text": self.user_text[:100],
            "total_ms": int((time.time() - self.started) * 1000),
            "layers": self.layers,
        }


# ==================================================================
#  POST /api/ai/chat (non-streaming fallback)
# ==================================================================

def _proxy_chat_to_mesh_peer(peer: dict, req) -> "ChatResponse | None":
    """Proxy a non-streaming chat request to a mesh peer. Returns ChatResponse or None on failure."""
    try:
        r = requests.post(
            f"http://{peer['ip']}:{peer['port']}/api/ai/chat",
            json={"message": req.message, "max_tokens": req.max_tokens,
                  "temperature": req.temperature, "device_id": req.device_id},
            timeout=90,
        )
        if r.ok:
            d = r.json()
            return ChatResponse(
                session_id=d.get("session_id", "mesh"),
                conversation_id=d.get("conversation_id", "mesh"),
                reply=d.get("reply", ""),
                provider="mesh",
                elapsed_ms=d.get("elapsed_ms", 0),
                handled_by="mesh",
            )
    except Exception as e:
        _log("chat", "WARN", "Mesh peer non-stream failed", peer=peer.get("ip"), error=str(e))
    return None


@router.post("/chat", response_model=ChatResponse)
def ai_chat(request: Request, req: ChatRequest):
    mgr = BundledAIManager.get()

    # Prefer mesh peer AI if explicitly configured or CPU is overloaded
    if mgr.ensure_running() and _should_prefer_mesh():
        peer = _find_mesh_ai_peer()
        if peer:
            _log("chat", "INFO", "Non-stream prefer-mesh: routing to mesh AI peer",
                 peer_name=peer["node_name"], peer_ip=peer["ip"])
            result = _proxy_chat_to_mesh_peer(peer, req)
            if result:
                return result
            # Fall through to local AI if mesh failed

    if not mgr.ensure_running():
        peer = _find_mesh_ai_peer()
        if peer:
            _log("chat", "INFO", "Non-stream: routing to mesh AI peer",
                 peer_name=peer["node_name"], peer_ip=peer["ip"])
            result = _proxy_chat_to_mesh_peer(peer, req)
            if result:
                return result
            raise HTTPException(status_code=503, detail="Mesh AI peer unreachable.")
        raise HTTPException(status_code=503, detail="No AI available — no local model and no mesh peers with AI found.")

    conv_id = _get_or_create_conv(req.conversation_id or req.session_id, device_id=req.device_id)
    user_text = _extract_user_text(req.raw_input, req.message.strip())
    trace = RequestTrace(user_text)

    # Layer 1: Action intent (Shelly control, tool runs — LLM lockout on match or fail)
    t1 = time.time()
    action_result = _route_action_intent(request, user_text)
    if action_result is not None:
        trace.record("intent_engine", action_result[:60], int((time.time() - t1) * 1000))
        _log("chat", "DEBUG", "request_trace", **trace.summary())
        _save_turn(conv_id, "user", user_text)
        _save_turn(conv_id, "assistant", action_result, provider="tli-action")
        return ChatResponse(session_id=conv_id, conversation_id=conv_id,
                            reply=action_result, provider="tli-action", elapsed_ms=0,
                            handled_by="intent_engine")

    trace.record("intent_engine", "no_match", int((time.time() - t1) * 1000))

    # Layer 2: Read-only fast-path (printers, vault status, etc.)
    t2 = time.time()
    tool_ans = _tool_answer(request, user_text)
    if tool_ans:
        trace.record("tool_fastpath", tool_ans[:60], int((time.time() - t2) * 1000))
        _log("chat", "DEBUG", "request_trace", **trace.summary())
        _save_turn(conv_id, "user", user_text)
        _save_turn(conv_id, "assistant", tool_ans, provider="tli-tools")
        return ChatResponse(session_id=conv_id, conversation_id=conv_id,
                            reply=tool_ans, provider="tli-tools", elapsed_ms=0,
                            handled_by="tool_fastpath")

    trace.record("tool_fastpath", "no_match", int((time.time() - t2) * 1000))

    # Vision gate — text models cannot process images
    if req.image_b64:
        from ai.ai_manager import MODEL_PRESETS
        _active_preset = MODEL_PRESETS.get(mgr.active_preset_id, {})
        if not _active_preset.get("is_vision"):
            _vision_msg = (
                "Image analysis requires the **Vision model** (Qwen2.5-VL). "
                "Your current model is text-only and cannot see images.\n\n"
                "Go to **Settings → AI Model** and download the **Vision** preset to enable image analysis."
            )
            _save_turn(conv_id, "user", user_text)
            _save_turn(conv_id, "assistant", _vision_msg, provider="tli-system")
            return ChatResponse(session_id=conv_id, conversation_id=conv_id,
                                reply=_vision_msg, provider="tli-system", elapsed_ms=0,
                                handled_by="tli-system")

    # Layer 3: LLM
    system_prompt = _build_system_prompt(device_id=req.device_id, active_panel=req.active_panel)
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(_load_history(conv_id))
    messages.append(_user_message(user_text, req.image_b64, req.image_mime))

    _save_turn(conv_id, "user", user_text)

    payload = {"model": "tli-bundled", "messages": messages,
               "max_tokens": int(req.max_tokens), "temperature": float(req.temperature), "stream": False}

    t3 = time.time()
    result = _llama_post(mgr.base_url, payload, timeout_s=60)
    elapsed = int((time.time() - t3) * 1000)

    reply = ""
    try: reply = result["choices"][0]["message"]["content"]
    except: pass
    reply = (reply or "").strip()
    if not reply:
        raise HTTPException(status_code=502, detail="AI returned empty response.")

    trace.record("llm", reply[:60], elapsed)
    _log("chat", "DEBUG", "request_trace", **trace.summary())
    _save_turn(conv_id, "assistant", reply, provider="bundled")

    return ChatResponse(session_id=conv_id, conversation_id=conv_id,
                        reply=reply, model=result.get("model"), elapsed_ms=elapsed,
                        provider="bundled", handled_by="llm")


# ==================================================================
#  POST /api/ai/chat/stream (SSE — matches app.js protocol)
#  GET  /api/ai/chat/stream (EventSource fallback)
# ==================================================================

def _stream_response(request: Request, message: str, conv_id: str, device_id: Optional[str],
                     max_tokens: int, temperature: float, raw_input: Optional[str] = None,
                     image_b64: Optional[str] = None, image_mime: Optional[str] = None,
                     active_panel: Optional[str] = None):
    """Core streaming generator — used by both POST and GET handlers."""
    mgr = BundledAIManager.get()
    user_text = _extract_user_text(raw_input, (message or "").strip())
    trace = RequestTrace(user_text)

    if not user_text:
        yield f"data: {json.dumps({'type': 'error', 'detail': 'Empty message'})}\n\n"
        return

    # Prefer mesh peer AI if explicitly configured or CPU is overloaded
    if mgr.ensure_running() and _should_prefer_mesh():
        peer = _find_mesh_ai_peer()
        if peer:
            _log("chat", "INFO", "Prefer-mesh: routing to mesh AI peer before local",
                 peer_name=peer["node_name"], peer_ip=peer["ip"], preset=peer.get("preset"))
            try:
                import event_bus as _eb
                import psutil as _pu
                _ram = _pu.virtual_memory().percent
                _cpu = _pu.cpu_percent(interval=None)
                _reason = f"RAM {_ram:.0f}%" if _ram >= 90 else f"CPU {_cpu:.0f}%"
                _eb.emit_event("ai", "info",
                    f"AI → {peer['node_name']} (mesh)",
                    f"{_reason} on this node — routed to {peer['node_name']} · {peer.get('preset','').title()} model")
            except Exception:
                pass
            yield from _stream_via_mesh_peer(peer, user_text, conv_id, max_tokens, temperature, device_id)
            return
        # No mesh peer found — fall through to local AI

    if not mgr.ensure_running():
        peer = _find_mesh_ai_peer()
        if peer:
            _log("chat", "INFO", "Routing to mesh AI peer",
                 peer_name=peer["node_name"], peer_ip=peer["ip"], preset=peer.get("preset"))
            try:
                import event_bus as _eb
                _eb.emit_event("ai", "info",
                    f"AI → {peer['node_name']} (mesh)",
                    f"Local model unavailable — routed to {peer['node_name']} · {peer.get('preset','').title()} model")
            except Exception:
                pass
            yield from _stream_via_mesh_peer(peer, user_text, conv_id, max_tokens, temperature, device_id)
            return
        yield f"data: {json.dumps({'type': 'error', 'detail': 'No AI available — no local model and no mesh peers with AI found.'})}\n\n"
        return

    # Layer 1: Action intent (Shelly control, tool runs — LLM lockout on match or fail)
    t1 = time.time()
    action_result = _route_action_intent(request, user_text)
    if action_result is not None:
        trace.record("intent_engine", action_result[:60], int((time.time() - t1) * 1000))
        _log("chat", "DEBUG", "request_trace", **trace.summary())
        _save_turn(conv_id, "user", user_text)
        _save_turn(conv_id, "assistant", action_result, provider="tli-action")
        yield f"data: {json.dumps({'type': 'meta', 'session_id': conv_id, 'handled_by': 'intent_engine'})}\n\n"
        yield f"data: {json.dumps({'type': 'delta', 'text': action_result})}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"
        return

    trace.record("intent_engine", "no_match", int((time.time() - t1) * 1000))

    # Layer 2: Read-only fast-path (printers, vault status, etc.)
    t2 = time.time()
    tool_ans = _tool_answer(request, user_text)
    if tool_ans:
        trace.record("tool_fastpath", tool_ans[:60], int((time.time() - t2) * 1000))
        _log("chat", "DEBUG", "request_trace", **trace.summary())
        _save_turn(conv_id, "user", user_text)
        _save_turn(conv_id, "assistant", tool_ans, provider="tli-tools")
        yield f"data: {json.dumps({'type': 'meta', 'session_id': conv_id, 'handled_by': 'tool_fastpath'})}\n\n"
        yield f"data: {json.dumps({'type': 'delta', 'text': tool_ans})}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"
        return

    trace.record("tool_fastpath", "no_match", int((time.time() - t2) * 1000))

    # Vision gate — text models cannot process images
    if image_b64:
        from ai.ai_manager import MODEL_PRESETS
        _active_preset = MODEL_PRESETS.get(mgr.active_preset_id, {})
        if not _active_preset.get("is_vision"):
            _vision_msg = (
                "Image analysis requires the **Vision model** (Qwen2.5-VL). "
                "Your current model is text-only and cannot see images.\n\n"
                "Go to **Settings → AI Model** and download the **Vision** preset to enable image analysis."
            )
            _save_turn(conv_id, "user", user_text)
            _save_turn(conv_id, "assistant", _vision_msg, provider="tli-system")
            yield f"data: {json.dumps({'type': 'meta', 'session_id': conv_id, 'handled_by': 'tli-system'})}\n\n"
            yield f"data: {json.dumps({'type': 'delta', 'text': _vision_msg})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            return

    # Layer 3: LLM
    system_prompt = _build_system_prompt(device_id=device_id, active_panel=active_panel)
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(_load_history(conv_id))
    messages.append(_user_message(user_text, image_b64, image_mime))

    _save_turn(conv_id, "user", user_text)

    payload = {"model": "tli-bundled", "messages": messages,
               "temperature": float(temperature), "max_tokens": int(max_tokens), "stream": True}

    upstream_url = mgr.base_url + "/v1/chat/completions"

    # Send meta event with session_id and handled_by
    yield f"data: {json.dumps({'type': 'meta', 'session_id': conv_id, 'handled_by': 'llm'})}\n\n"

    # Stream tokens
    t3 = time.time()
    collected = []
    for data_str in _llama_stream_raw(upstream_url, payload):
        try:
            obj = json.loads(data_str)
        except Exception:
            continue

        if obj.get("type") == "error":
            yield f"data: {json.dumps(obj)}\n\n"
            return

        delta = ""
        try:
            choice = (obj.get("choices") or [None])[0] or {}
            delta = ((choice.get("delta") or {}).get("content")) or ""
        except Exception:
            pass

        if delta:
            collected.append(delta)
            yield f"data: {json.dumps({'type': 'delta', 'text': delta})}\n\n"

    yield f"data: {json.dumps({'type': 'done'})}\n\n"

    # Persist full reply + log trace
    final = "".join(collected).strip()
    if final:
        trace.record("llm", final[:60], int((time.time() - t3) * 1000))
        _log("chat", "DEBUG", "request_trace", **trace.summary())
        _save_turn(conv_id, "assistant", final, provider="bundled")
        _log("chat", "INFO", "Stream complete", conversation_id=conv_id, reply_length=len(final))


@router.post("/chat/stream")
def ai_chat_stream_post(request: Request, req: ChatRequest):
    # Detect mesh-originated requests: any client IP that isn't localhost is a LAN peer
    client_ip = None
    try:
        client_host = request.client.host if request.client else None
        if client_host and client_host not in ("127.0.0.1", "::1", "localhost"):
            client_ip = client_host
    except Exception:
        pass
    conv_id = _get_or_create_conv(req.conversation_id or req.session_id,
                                   device_id=req.device_id, mesh_source_ip=client_ip)
    return StreamingResponse(
        _stream_response(request, req.message, conv_id, req.device_id, req.max_tokens, req.temperature,
                         raw_input=req.raw_input, image_b64=req.image_b64, image_mime=req.image_mime,
                         active_panel=req.active_panel),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/chat/stream")
def ai_chat_stream_get(request: Request,
                        message: str = Query(""),
                        session_id: Optional[str] = Query(None),
                        max_tokens: int = Query(300),
                        temperature: float = Query(0.2)):
    """EventSource GET fallback (used when POST fails due to CORS/preflight)."""
    conv_id = _get_or_create_conv(session_id)
    return StreamingResponse(
        _stream_response(request, message, conv_id, None, max_tokens, temperature),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ==================================================================
#  Memory endpoints
# ==================================================================

@router.post("/memory/add")
def memory_add(req: MemoryAddRequest):
    _append_dev_mem(req.device_id, req.fact)
    return {"ok": True, "device_id": req.device_id, "total_memories": len(_load_dev_mem(req.device_id))}

@router.get("/memory/{device_id}")
def memory_get(device_id: str):
    mems = _load_dev_mem(device_id)
    return {"device_id": device_id, "memories": mems, "count": len(mems)}

@router.delete("/memory/{device_id}")
def memory_clear(device_id: str):
    p = _dev_mem_path(device_id)
    if p.exists(): p.unlink()
    return {"ok": True, "device_id": device_id}


# ==================================================================
#  Conversation history
# ==================================================================

@router.get("/conversations")
def list_conversations():
    """Return recent bundled-AI conversations for the Recent Chats panel.
    Excludes conversations that were initiated by mesh peers — those originated
    on another node and were processed here as a service; they should only appear
    in the Recent Chats of the node that sent the request."""
    if not _HAS_STATE:
        return {"conversations": []}
    convs = S.load_conversations()
    items = []
    for c in convs.values():
        if not isinstance(c, dict):
            continue
        # Skip conversations that were routed to us from a mesh peer
        if c.get("mesh_source_ip"):
            continue
        msgs = c.get("messages") or []
        title = c.get("title") or ""
        if not title:
            for m in msgs:
                if m.get("role") == "user" and m.get("content"):
                    title = m["content"][:80]
                    break
        if not title:
            continue
        items.append({
            "id": c.get("id"),
            "title": title,
            "last_updated": c.get("last_updated", ""),
            "message_count": len(msgs),
        })
    items.sort(key=lambda x: x.get("last_updated", ""), reverse=True)
    return {"conversations": items[:20]}


@router.delete("/conversations")
def clear_all_conversations():
    """Delete all bundled-AI conversations."""
    if not _HAS_STATE:
        return {"ok": True, "deleted": 0}
    convs = S.load_conversations()
    count = len(convs)
    S.save_conversations({})
    return {"ok": True, "deleted": count}


@router.get("/conversations/{conv_id}")
def get_conversation(conv_id: str):
    """Return full message list for a conversation (for resuming in chat)."""
    if not _HAS_STATE:
        raise HTTPException(status_code=404, detail="State not available")
    convs = S.load_conversations()
    conv = convs.get(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Not found")
    return {
        "id": conv_id,
        "title": conv.get("title", ""),
        "messages": [
            {"role": m["role"], "content": m["content"]}
            for m in (conv.get("messages") or [])
            if m.get("role") in ("user", "assistant") and m.get("content")
        ],
    }


# ==================================================================
#  Session management
# ==================================================================

@router.post("/clear-session")
def clear_session(req: ClearSessionRequest):
    if _HAS_STATE:
        convs = S.load_conversations()
        existed = req.session_id in convs
        if existed:
            del convs[req.session_id]
            S.save_conversations(convs)
        return {"ok": True, "session_id": req.session_id, "deleted": existed}
    return {"ok": True, "session_id": req.session_id}

@router.post("/clear-device-memory")
def clear_device_memory(req: ClearDeviceMemoryRequest):
    deleted = 0
    for f in DEVICES_DIR.glob(f"{req.device_id}*"):
        try: f.unlink(); deleted += 1
        except: pass
    return {"ok": True, "device_id": req.device_id, "deleted_files": deleted}


# ==================================================================
#  Endpoints previously in ai_model_routes.py (consolidated here)
# ==================================================================

# ==================================================================
#  Storage location management
# ==================================================================

@router.get("/storage/drives")
def storage_drives():
    """List available drives with free space. Used by the frontend storage picker."""
    try:
        import psutil
        drives = []
        for part in psutil.disk_partitions(all=False):
            try:
                usage = psutil.disk_usage(part.mountpoint)
                drives.append({
                    "mountpoint": part.mountpoint,
                    "device": part.device,
                    "fstype": part.fstype,
                    "total_gb": round(usage.total / (1024 ** 3), 1),
                    "free_gb": round(usage.free / (1024 ** 3), 1),
                    "percent_used": usage.percent,
                })
            except Exception:
                continue
        return {"ok": True, "drives": drives}
    except ImportError:
        return {"ok": False, "error": "psutil not installed", "drives": []}


@router.get("/storage/location")
def storage_location():
    """Return the current model storage directory and free space."""
    models_dir = get_models_dir()
    try:
        import psutil
        usage = psutil.disk_usage(str(models_dir.parent if not models_dir.exists() else models_dir))
        free_gb = round(usage.free / (1024 ** 3), 1)
        total_gb = round(usage.total / (1024 ** 3), 1)
    except Exception:
        free_gb = None
        total_gb = None
    return {
        "ok": True,
        "path": str(models_dir),
        "exists": models_dir.exists(),
        "free_gb": free_gb,
        "total_gb": total_gb,
    }


@router.post("/storage/location")
def set_storage_location(payload: Dict[str, Any]):
    """Set a new model storage directory. Creates it if needed."""
    path = (payload or {}).get("path", "").strip()
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    try:
        p = Path(path)
        p.mkdir(parents=True, exist_ok=True)
        set_models_dir(str(p))
        return {"ok": True, "path": str(p)}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not set storage location: {exc}")


@router.post("/model/reveal")
async def model_reveal():
    """Open the models folder in the OS file manager."""
    import subprocess as _sp
    path = str(get_models_dir())
    try:
        if os.name == "nt":
            _sp.Popen(["explorer", path])
        elif sys.platform == "darwin":
            _sp.Popen(["open", path])
        else:
            _sp.Popen(["xdg-open", path])
        return {"ok": True, "path": path}
    except Exception as exc:
        return {"ok": False, "path": path, "error": str(exc)}


@router.get("/bundled/status")
def bundled_status():
    """Health check for bundled AI — used by UI badge."""
    mgr = BundledAIManager.get()
    st = mgr.status()
    return {
        "ok": st.get("healthy", False),
        "healthy": st.get("healthy", False),
        "model_exists": st.get("model_exists", False),
        "active_preset": st.get("active_preset"),
        "active_model": st.get("active_model"),
        "note": "Model present" if st.get("model_exists") else "Model missing",
    }


@router.get("/model/progress")
def model_progress():
    """Download progress — polled by frontend during model download."""
    dl = _get_dl()
    if dl.get("in_progress") or dl.get("status") in ("downloading", "done", "error", "cancelled"):
        return {
            "ok": True,
            "status": dl.get("status", "idle"),
            "bytes_done": int(dl.get("bytes_done") or 0),
            "bytes_total": int(dl.get("bytes_total") or 0),
            "preset_id": dl.get("preset_id", ""),
            "filename": dl.get("filename", ""),
            "error": dl.get("error", ""),
        }
    # Fallback: check active model file on disk
    mgr = BundledAIManager.get()
    p = mgr.cfg.model_path
    exists = p.exists()
    return {
        "ok": True,
        "status": "complete" if exists else "idle",
        "bytes_done": p.stat().st_size if exists else 0,
        "bytes_total": 0,
    }
