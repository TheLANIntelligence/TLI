# TheLANIntelligence/backend/routers/games.py
"""
Games Router (TLI HomeOS) — Store-filtered detection (robust).

Endpoints:
- GET /games/detect_best
    Best-effort: foreground -> process scan fallback.
    Process scan uses multiple signals (exe path, cmdline) and more robust Steam path discovery.

- GET /games/detect_filtered
    Foreground-only (kept for compatibility).

Supported stores (inclusive):
- Steam, GOG, Epic, XboxGames, Battle.net

Why you were seeing "no_store_games_running":
- psutil may not be able to read some processes' exe paths (AccessDenied),
  or Steam install/library roots were not discovered (Steam installed in non-default location).
This version:
- reads Steam install path from registry (HKCU/HKLM) when available
- parses libraryfolders.vdf from that Steam path (and default paths)
- falls back to matching cmdline strings even when exe path is unavailable
"""

from __future__ import annotations

import json as _json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from typing import Any, Dict, List, Optional, Tuple
import os
import platform
import re
import time
import subprocess
from pathlib import Path
from datetime import datetime, timezone

try:
    import psutil  # type: ignore
except Exception:  # pragma: no cover
    psutil = None  # type: ignore

games_router = APIRouter(tags=["games"])

# Track last detected game to emit only on change (not every poll)
_last_game_name: Optional[str] = None

# --- Live metrics (best-effort) -------------------------------------------
# CPU/RAM is per-process via psutil.
# GPU/VRAM is best-effort via nvidia-smi (overall GPU util + memory, and per-PID VRAM when exposed).
# If nvidia-smi is missing or blocked, GPU fields will be None.

_NVIDIA_CACHE: Dict[str, Any] = {"ts": 0.0, "overall": None, "per_pid": {}}

def _nvidia_query_cached() -> Tuple[Optional[Dict[str, Any]], Dict[int, int]]:
    now = time.time()
    if (now - float(_NVIDIA_CACHE.get("ts", 0.0))) < 1.0:
        overall = _NVIDIA_CACHE.get("overall")
        per_pid = _NVIDIA_CACHE.get("per_pid") or {}
        return overall, per_pid

    overall: Optional[Dict[str, Any]] = None
    per_pid: Dict[int, int] = {}

    try:
        # Overall GPU util + used memory (MB)
        cmd = ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"]
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, universal_newlines=True, timeout=1.5).strip()
        # If multiple GPUs, take the first line for now.
        line = out.splitlines()[0].strip()
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2:
            overall = {
                "gpu_util_percent": int(float(parts[0])),
                "gpu_mem_used_mb": int(float(parts[1])),
            }
    except Exception:
        overall = None

    try:
        # Per-PID used memory (MB). Not always available (depends on driver/permissions).
        cmd = ["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, universal_newlines=True, timeout=1.5).strip()
        for row in out.splitlines():
            row = row.strip()
            if not row:
                continue
            cols = [c.strip() for c in row.split(",")]
            if len(cols) >= 2:
                try:
                    pid = int(cols[0])
                    mem = int(float(cols[1]))
                    per_pid[pid] = mem
                except Exception:
                    pass
    except Exception:
        per_pid = {}

    _NVIDIA_CACHE["ts"] = now
    _NVIDIA_CACHE["overall"] = overall
    _NVIDIA_CACHE["per_pid"] = per_pid
    return overall, per_pid


def _proc_metrics(pid: Optional[int]) -> Optional[Dict[str, Any]]:
    if not pid or not psutil:
        return None
    try:
        proc = psutil.Process(int(pid))

        # cpu_percent needs a small interval to be meaningful
        cpu = proc.cpu_percent(interval=0.05)
        rss = proc.memory_info().rss if proc.memory_info() else 0
        ram_mb = int(rss / (1024 * 1024))

        overall, per_pid = _nvidia_query_cached()
        metrics: Dict[str, Any] = {
            "cpu_percent": float(cpu),
            "ram_mb": ram_mb,
            "gpu_util_percent": (overall.get("gpu_util_percent") if overall else None),
            "gpu_mem_used_mb": (overall.get("gpu_mem_used_mb") if overall else None),
            "gpu_mem_used_mb_pid": (per_pid.get(int(pid)) if per_pid else None),
        }
        return metrics
    except Exception:
        return None
# -------------------------------------------------------------------------



def _win_foreground_process() -> Dict[str, Any]:
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return {"pid": None, "title": None}

        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))

        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(int(length) + 1)
        user32.GetWindowTextW(hwnd, buf, int(length) + 1)

        return {"pid": int(pid.value) if pid.value else None, "title": (buf.value or None)}
    except Exception:
        return {"pid": None, "title": None}


def _mac_foreground_process() -> Dict[str, Any]:
    """Get frontmost application on macOS via osascript."""
    try:
        r = subprocess.run(
            ["osascript", "-e",
             'tell application "System Events" to get name of first process whose frontmost is true'],
            capture_output=True, text=True, timeout=3,
        )
        app_name = r.stdout.strip()
        if app_name and psutil:
            for proc in psutil.process_iter(attrs=["pid", "name"]):
                try:
                    if (proc.info.get("name") or "").lower() == app_name.lower():
                        return {"pid": proc.info["pid"], "title": app_name}
                except Exception:
                    continue
        return {"pid": None, "title": app_name or None}
    except Exception:
        return {"pid": None, "title": None}


def _parse_allow_param(allow: Optional[str]) -> List[str]:
    if not allow:
        return []
    parts = [p.strip() for p in allow.split("|")]
    out: List[str] = []
    for p in parts:
        if not p or len(p) > 80:
            continue
        out.append(p.lower())
    return out[:50]


def _uniq_paths(paths: List[Path]) -> List[Path]:
    seen = set()
    out: List[Path] = []
    for p in paths:
        key = str(p).lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def _read_steam_path_from_registry() -> Optional[Path]:
    if platform.system() != "Windows":
        return None
    try:
        import winreg  # type: ignore
    except Exception:
        return None

    keys = [
        (winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\Valve\Steam"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\WOW6432Node\Valve\Steam"),
    ]
    for hive, sub in keys:
        try:
            with winreg.OpenKey(hive, sub) as k:
                val, _ = winreg.QueryValueEx(k, "SteamPath")
                if val:
                    p = Path(str(val))
                    if p.exists():
                        return p
        except Exception:
            continue
    return None


def _steam_candidate_bases() -> List[Path]:
    bases: List[Path] = []
    sys = platform.system()

    # Registry-discovered Steam install (Windows only)
    reg = _read_steam_path_from_registry()
    if reg:
        bases.append(reg)

    if sys == "Windows":
        bases.extend([
            Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Steam",
            Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Steam",
        ])
    elif sys == "Darwin":  # macOS
        home = Path.home()
        bases.extend([
            home / "Library" / "Application Support" / "Steam",
            Path("/Applications/Steam.app/Contents/MacOS"),
        ])
    else:  # Linux
        home = Path.home()
        bases.extend([
            home / ".local" / "share" / "Steam",
            home / ".steam" / "steam",
            home / ".steam" / "Steam",
            Path("/usr/share/Steam"),
            Path("/usr/local/share/Steam"),
        ])

    # Environment override (works on all platforms)
    env = os.environ.get("TLI_STEAM_PATH")
    if env:
        bases.append(Path(env))

    return _uniq_paths([b for b in bases if b])


def _parse_libraryfolders_vdf(vdf_text: str) -> List[str]:
    # Works for both older and newer VDF; we just extract "path" values.
    paths: List[str] = []
    for m in re.finditer(r'"path"\s*"([^"]+)"', vdf_text):
        p = m.group(1).replace("\\\\", "\\")
        paths.append(p)
    return paths


def _steam_library_roots() -> List[Path]:
    roots: List[Path] = []
    for base in _steam_candidate_bases():
        common = base / "steamapps" / "common"
        if common.exists():
            roots.append(common)

        vdf = base / "steamapps" / "libraryfolders.vdf"
        if vdf.exists():
            try:
                txt = vdf.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                txt = ""
            for p in _parse_libraryfolders_vdf(txt):
                lib = Path(p) / "steamapps" / "common"
                if lib.exists():
                    roots.append(lib)

    return _uniq_paths(roots)


def _gog_common_roots() -> List[Path]:
    if platform.system() == "Darwin":
        home = Path.home()
        roots = [
            home / "Library" / "Application Support" / "GOG.com" / "Games",
            Path("/Applications/GOG Galaxy.app"),
        ]
    elif platform.system() == "Linux":
        home = Path.home()
        roots = [home / "GOG Games", home / ".local" / "share" / "GOG.com" / "Games"]
    else:
        pf86 = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
        pf = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        roots = [
            pf86 / "GOG Galaxy" / "Games",
            pf / "GOG Galaxy" / "Games",
            Path(r"C:\GOG Games"),
        ]
    return _uniq_paths([r for r in roots if r.exists()])


def _epic_common_roots() -> List[Path]:
    if platform.system() == "Darwin":
        home = Path.home()
        roots = [
            home / "Library" / "Application Support" / "Epic" / "EpicGamesLauncher",
            Path("/Applications/Epic Games Launcher.app"),
        ]
    else:
        pf = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        roots = [pf / "Epic Games"]
    return _uniq_paths([r for r in roots if r.exists()])


def _xbox_common_roots() -> List[Path]:
    if platform.system() != "Windows":
        return []
    roots: List[Path] = []
    for drive in ["C:", "D:", "E:", "F:", "G:"]:
        p = Path(drive + r"\XboxGames")
        if p.exists():
            roots.append(p)
    return _uniq_paths(roots)


def _bnet_common_roots() -> List[Path]:
    if platform.system() == "Darwin":
        roots = [
            Path("/Applications/Battle.net.app"),
            Path("/Applications/Blizzard Entertainment"),
        ]
    else:
        pf86 = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
        pf = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        roots = [
            pf86 / "Battle.net",
            pf / "Battle.net",
            pf86 / "Blizzard Entertainment",
            pf / "Blizzard Entertainment",
        ]
    return _uniq_paths([r for r in roots if r.exists()])


def _path_is_under(path: str, roots: List[Path]) -> bool:
    if not path:
        return False
    try:
        p = Path(path)
    except Exception:
        return False

    try:
        p_res = p.resolve()
    except Exception:
        p_res = p

    p_low = str(p_res).lower()
    for root in roots:
        try:
            r_res = root.resolve()
        except Exception:
            r_res = root
        r_low = str(r_res).lower().rstrip("\\/")
        if p_low.startswith(r_low + "\\") or p_low.startswith(r_low + "/") or p_low == r_low:
            return True
    return False


def _is_launcher_exe(exe_name: str) -> bool:
    n = (exe_name or "").lower()
    return n in {
        "steam.exe",
        "goggalaxy.exe",
        "galaxyclient.exe",
        "epicgameslauncher.exe",
        "battle.net.exe",
        "battlenet.exe",
        "blizzardbrowser.exe",
    }


def _cmdline_blob(cmdline: Optional[List[str]]) -> str:
    if not cmdline:
        return ""
    # join safely; cmdline can contain null/odd values
    parts = []
    for x in cmdline:
        try:
            parts.append(str(x))
        except Exception:
            continue
    return " ".join(parts)


def _match_store_by_string(s: str) -> Optional[str]:
    low = (s or "").lower()
    # Windows paths (backslash)
    if "\\steamapps\\common\\" in low:
        return "steam_heuristic"
    if "\\gog galaxy\\games\\" in low or "\\gog games\\" in low:
        return "gog_heuristic"
    if "\\epic games\\" in low:
        return "epic_heuristic"
    if "\\xboxgames\\" in low:
        return "xbox_heuristic"
    if "\\blizzard entertainment\\" in low:
        return "bnet_heuristic"
    # macOS / Linux paths (forward slash)
    if "/steamapps/common/" in low:
        return "steam_heuristic"
    if "/gog.com/games" in low or "/gog galaxy/games" in low or "/gog games/" in low:
        return "gog_heuristic"
    if "/epic games/" in low or "epicgameslauncher" in low:
        return "epic_heuristic"
    if "/blizzard entertainment/" in low or "battle.net" in low:
        return "bnet_heuristic"
    return None


def _filter_game(exe_path: Optional[str], exe_name: Optional[str], cmdline: Optional[List[str]], allow: List[str]) -> Tuple[bool, str]:
    name = (exe_name or (Path(exe_path).name if exe_path else "")).lower()
    if name and _is_launcher_exe(name):
        return False, "launcher"

    exe_low = (exe_path or "").lower()
    cmd_blob = _cmdline_blob(cmdline).lower()

    if allow and any(tok in name or tok in exe_low or tok in cmd_blob for tok in allow):
        return True, "allowlist"

    steam_roots = _steam_library_roots()
    gog_roots = _gog_common_roots()
    epic_roots = _epic_common_roots()
    xbox_roots = _xbox_common_roots()
    bnet_roots = _bnet_common_roots()

    if exe_path:
        if _path_is_under(exe_path, steam_roots):
            return True, "steam"
        if _path_is_under(exe_path, gog_roots):
            return True, "gog"
        if _path_is_under(exe_path, epic_roots):
            return True, "epic"
        if _path_is_under(exe_path, xbox_roots):
            return True, "xbox"
        if _path_is_under(exe_path, bnet_roots):
            return True, "bnet"

    # Fallback to string heuristics (cmdline catches AccessDenied exe paths)
    h = _match_store_by_string(exe_low) or _match_store_by_string(cmd_blob)
    if h:
        return True, h

    return False, "not_in_known_game_roots"


def _proc_info(proc: "psutil.Process") -> Tuple[Optional[str], Optional[str], Optional[List[str]]]:
    exe: Optional[str]
    name: Optional[str]
    cmd: Optional[List[str]]
    try:
        exe = proc.exe()
    except Exception:
        exe = None
    try:
        name = proc.name()
    except Exception:
        name = None
    try:
        cmd = proc.cmdline()
    except Exception:
        cmd = None
    return exe, name, cmd


def _cpu_activity_score(proc: "psutil.Process", sleep_s: float = 0.12) -> float:
    try:
        t1 = proc.cpu_times()
        time.sleep(sleep_s)
        t2 = proc.cpu_times()
        return max(0.0, (t2.user + t2.system) - (t1.user + t1.system))
    except Exception:
        return 0.0


def _scan_running_games(allow_list: List[str], limit: int = 40) -> Tuple[Optional[Dict[str, Any]], str]:
    if not psutil:
        return None, "psutil_missing"

    candidates: List[Tuple[float, Dict[str, Any]]] = []
    seen = 0

    for proc in psutil.process_iter(attrs=["pid"]):
        if seen >= 8000:
            break
        seen += 1

        try:
            pid = int(proc.info["pid"])
        except Exception:
            continue

        exe, name, cmd = _proc_info(proc)
        ok, reason = _filter_game(exe, name, cmd, allow_list)
        if not ok:
            continue

        # Prefer exe_path when known, else try to extract a path-like token from cmdline blob.
        exe_path = exe
        if not exe_path and cmd:
            blob = _cmdline_blob(cmd)
            # crude: pick the first token that looks like C:\...\something.exe
            m = re.search(r'([A-Za-z]:\\[^"\s]+?\.exe)', blob)
            if m:
                exe_path = m.group(1)

        # score: short CPU activity delta (cheap)
        score = _cpu_activity_score(proc)
        if score <= 0.0:
            score = 0.001

        title = name or (Path(exe_path).name if exe_path else "Unknown")
        candidates.append((score, {"pid": pid, "name": title, "exe_path": exe_path, "reason": reason}))
        if len(candidates) >= limit:
            break

    if not candidates:
        return None, "no_store_games_running"

    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0][1], "process_scan"


@games_router.get("/games/detect_filtered")
def games_detect_filtered(allow: Optional[str] = None) -> Any:
    sys_name = platform.system()
    if sys_name == "Windows":
        fg = _win_foreground_process()
    elif sys_name == "Darwin":
        fg = _mac_foreground_process()
    else:
        fg = {"pid": None, "title": None}

    pid = fg.get("pid")
    title = fg.get("title")
    allow_list = _parse_allow_param(allow)

    confidence = 0
    reason = "no_process"
    game: Optional[Dict[str, Any]] = None

    if psutil and pid:
        try:
            proc = psutil.Process(int(pid))
            exe, name, cmd = _proc_info(proc)
            ok, reason = _filter_game(exe, name, cmd, allow_list)
            if ok:
                game = {"pid": pid, "name": (title or name), "exe_path": exe}
                confidence = 90
        except Exception:
            reason = "psutil_error_or_access_denied"

    metrics = _proc_metrics(int(pid)) if pid else None

    return {
        "foreground": fg,
        "game": game,
        "metrics": metrics if game else None,
        "confidence": confidence if game else 0,
        "candidates": [],
        "filter": {
            "mode": "store_roots_only_foreground",
            "allow": allow_list,
            "reason": reason,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    }


@games_router.get("/games/detect_best")
def games_detect_best(allow: Optional[str] = None) -> Any:
    """
    Best-effort:
    - If foreground is a store-root game, return it.
    - Else scan running processes and return best candidate.
    """
    allow_list = _parse_allow_param(allow)
    sys_name = platform.system()
    if sys_name == "Windows":
        fg = _win_foreground_process()
    elif sys_name == "Darwin":
        fg = _mac_foreground_process()
    else:
        fg = {"pid": None, "title": None}

    fg_res = games_detect_filtered(allow=allow)
    if fg_res.get("game"):
        fg_res["mode"] = "foreground"
        # ensure live metrics
        try:
            gpid = fg_res.get("game", {}).get("pid")
            fg_res["metrics"] = _proc_metrics(int(gpid)) if gpid else None
        except Exception:
            fg_res["metrics"] = None
        _emit_game_event(fg_res.get("game", {}))
        return fg_res

    best, scan_reason = _scan_running_games(allow_list)
    result = {
        "foreground": fg,
        "game": best,
        "metrics": _proc_metrics(int(best.get("pid"))) if best and best.get("pid") else None,
        "confidence": 70 if best else 0,
        "mode": "process_scan" if best else "none",
        "filter": {
            "mode": "store_roots_best",
            "allow": allow_list,
            "reason": scan_reason,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    }
    if best:
        _emit_game_event(best)
    else:
        _emit_game_cleared()
    return result


def _emit_game_event(game: Dict) -> None:
    """Emit a game-detected event only when the game changes."""
    global _last_game_name
    try:
        name = game.get("name") or game.get("title") or ""
        if not name or name == _last_game_name:
            return
        _last_game_name = name
        store = (game.get("store") or "").replace("_heuristic", "").replace("_", " ").title()
        body = f"Detected via {store}" if store else "Game detected"
        import event_bus as _eb
        _eb.emit_event("game", "ok", f"{name} detected", body)
    except Exception:
        pass


def _emit_game_cleared() -> None:
    """Emit a game-closed event when the previously active game is gone."""
    global _last_game_name
    try:
        if not _last_game_name:
            return
        prev = _last_game_name
        _last_game_name = None
        import event_bus as _eb
        _eb.emit_event("game", "info", f"{prev} closed", "No game running")
    except Exception:
        pass


# ============================================================
#  /games/recommend  — AI-generated, hardware-aware recommendations
# ============================================================

_PRESET_DESCRIPTIONS = {
    "stable_60": (
        "Stable 60 FPS",
        "The user wants a locked, smooth 60 FPS with minimal stutter. "
        "Prioritise frame-time consistency and low 1% lows over raw average FPS. "
        "Frame-rate cap at 60, prefer lower render scales over unstable higher ones."
    ),
    "high_fps": (
        "High FPS / Competitive",
        "The user wants maximum frame rate for competitive advantage. "
        "Reduce latency and input lag above all else. Low visual settings are acceptable. "
        "Disable VSync, use frame-rate caps only if needed to prevent thermal throttle."
    ),
    "max_visual": (
        "Max Visuals (Safe)",
        "The user wants the best-looking image quality without risking crashes or instability. "
        "Push texture quality, shadows, and AA as high as the hardware can sustain. "
        "Avoid overclocking, unstable RT settings, or settings known to cause driver crashes."
    ),
}


@games_router.post("/games/recommend")
def games_recommend(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    AI-generated game optimisation recommendations.
    Uses the hardware snapshot and optionally the detected game to produce
    targeted, specific advice for the selected preset goal.
    """
    preset    = (payload.get("preset") or "stable_60").lower().replace(" ", "_")
    detected  = payload.get("detected") or {}
    system    = payload.get("system") or {}

    preset_label, preset_goal = _PRESET_DESCRIPTIONS.get(
        preset, _PRESET_DESCRIPTIONS["stable_60"]
    )

    # Build hardware context string
    cpu  = system.get("cpu") or {}
    gpu  = system.get("gpu") or {}
    mem  = system.get("memory") or {}
    disp = system.get("display") or {}

    hw_lines = []
    if cpu.get("model") or cpu.get("name"):
        hw_lines.append(f"CPU: {cpu.get('model') or cpu.get('name')}"
                        + (f" ({cpu['cores']}C/{cpu.get('threads','?')}T)" if cpu.get("cores") else ""))
    if gpu.get("model") or gpu.get("name"):
        hw_lines.append(f"GPU: {gpu.get('model') or gpu.get('name')}"
                        + (f" ({gpu['vram_gb']} GB VRAM)" if gpu.get("vram_gb") else ""))
    if mem.get("total_gb"):
        hw_lines.append(f"RAM: {mem['total_gb']} GB")
    if disp.get("width") and disp.get("height"):
        hw_lines.append(f"Display: {disp['width']}×{disp['height']}"
                        + (f" @ {disp['hz']} Hz" if disp.get("hz") else ""))

    hw_block = "\n".join(hw_lines) if hw_lines else "Hardware info unavailable."

    # Build game context string
    game = detected.get("game") or {}
    game_name  = game.get("name") or game.get("exe_name") or "Unknown game"
    store      = (detected.get("store") or game.get("reason") or "unknown").upper()
    metrics    = detected.get("metrics") or {}

    if game_name != "Unknown game":
        game_lines = [f"Game: {game_name} (Store: {store})"]
        if metrics.get("cpu_percent") is not None:
            game_lines.append(f"Live CPU usage: {round(metrics['cpu_percent'])}%")
        if metrics.get("ram_mb") is not None:
            game_lines.append(f"Live RAM usage: {round(metrics['ram_mb'])} MB")
        if metrics.get("gpu_util_percent") is not None:
            game_lines.append(f"Live GPU util: {round(metrics['gpu_util_percent'])}%")
        game_block = "\n".join(game_lines)
    else:
        game_block = "No specific game detected — give general guidance for any modern PC game."

    prompt = (
        f"You are a PC gaming performance expert inside TheLANIntelligence (TLI), a local home OS.\n\n"
        f"Goal: {preset_label}\n"
        f"{preset_goal}\n\n"
        f"Hardware:\n{hw_block}\n\n"
        f"{game_block}\n\n"
        f"Provide 5-8 specific, actionable recommendations tailored exactly to this hardware and goal. "
        f"Format as a numbered list. Be concise (1-2 lines per item). "
        f"Reference the actual GPU model, CPU, and resolution in your advice. "
        f"Do not add disclaimers or preamble — go straight to the recommendations."
    )

    # Use bundled AI (llama.cpp on 127.0.0.1:8089)
    try:
        from ai.ai_manager import BundledAIManager
        mgr = BundledAIManager.get()
        if not mgr.is_healthy():
            raise RuntimeError("Bundled AI not running")
        import urllib.request as _ur
        import json as _json
        payload = {
            "model": "local",
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.4,
            "max_tokens": 600,
            "stream": False,
        }
        data = _json.dumps(payload).encode()
        req = _ur.Request(
            mgr.base_url + "/v1/chat/completions",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with _ur.urlopen(req, timeout=60) as resp:
            body = _json.loads(resp.read().decode())
        text = (body.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
        if text:
            return {"text": text, "preset": preset, "source": "bundled_ai"}
    except Exception as _ai_err:
        import tli_state as _S
        _S.log_debug("games", "WARN", f"Bundled AI recommend failed: {_ai_err}")

    # Fallback: static hardware-aware text
    fallback = _static_fallback(preset, hw_block, game_name)
    return {"text": fallback, "preset": preset, "source": "static"}


def _build_hw_block(system: dict) -> str:
    cpu  = system.get("cpu") or {}
    gpu  = system.get("gpu") or {}
    mem  = system.get("memory") or {}
    disp = system.get("display") or {}
    lines = []
    if cpu.get("model") or cpu.get("name"):
        lines.append(f"CPU: {cpu.get('model') or cpu.get('name')}"
                     + (f" ({cpu['cores']}C/{cpu.get('threads','?')}T)" if cpu.get("cores") else ""))
    if gpu.get("model") or gpu.get("name"):
        lines.append(f"GPU: {gpu.get('model') or gpu.get('name')}"
                     + (f" ({gpu['vram_gb']} GB VRAM)" if gpu.get("vram_gb") else ""))
    if mem.get("total_gb"):
        lines.append(f"RAM: {mem['total_gb']} GB")
    if disp.get("width") and disp.get("height"):
        lines.append(f"Display: {disp['width']}×{disp['height']}"
                     + (f" @ {disp['hz']} Hz" if disp.get("hz") else ""))
    return "\n".join(lines) if lines else "Hardware info unavailable."


def _static_fallback(preset: str, hw_block: str, game_name: str) -> str:
    """Return a reasonable static recommendation when AI is unavailable."""
    lines = [
        f"[AI offline — static recommendations for {preset.replace('_', ' ').title()}]",
        "",
        f"Hardware detected:\n{hw_block}",
        "",
    ]
    if preset == "high_fps":
        lines += [
            "1. Disable VSync and set in-game frame-rate cap to your monitor's refresh rate.",
            "2. Set texture quality to Medium — GPU memory freed = more headroom for FPS.",
            "3. Disable ray tracing and ambient occlusion entirely.",
            "4. Enable NVIDIA Reflex (or AMD Anti-Lag) if available in-game.",
            "5. Lower shadow distance and shadow quality first — big FPS gain, small visual loss.",
            "6. Ensure XMP/EXPO is enabled in BIOS for full RAM speed.",
            "7. Set Windows power plan to High Performance or Ultimate Performance.",
        ]
    elif preset == "max_visual":
        lines += [
            "1. Set resolution to your native display resolution — no upscaling needed.",
            "2. Enable DLSS Quality or FSR Quality if available for free AA.",
            "3. Max out texture quality and anisotropic filtering (16x) — low VRAM cost.",
            "4. Enable ray-traced shadows or ambient occlusion if GPU can sustain 60+ FPS.",
            "5. Use TAA or DLAA for anti-aliasing over MSAA (better quality, lower cost).",
            "6. Set shadow quality to High, not Ultra — diminishing returns beyond High.",
            "7. Keep frame-rate uncapped; monitor refresh rate governs smoothness.",
        ]
    else:
        lines += [
            "1. Cap frame rate to 60 FPS using RTSS or in-game limiter.",
            "2. Enable VSync only as a secondary cap — prefer frame-rate limiter.",
            "3. Set preset to Medium-High; fine-tune shadows and ambient occlusion down.",
            "4. Disable motion blur and depth of field — reduces GPU variance.",
            "5. Enable DLSS Balanced or FSR Balanced to reduce GPU load.",
            "6. Ensure no background apps (streaming, recording) are running.",
            "7. Monitor 1% lows with MSI Afterburner to identify stutter sources.",
        ]
    return "\n".join(lines)


# ============================================================
#  /games/config_read  — read + normalize game config files
# ============================================================

@games_router.post("/games/config_read")
def games_config_read(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Try to read graphics settings from the game's config file.
    Accepts: { game_name: str }
    Returns: { supported, config_path, settings: [...], error, game_name }
    """
    game_name = (payload.get("game_name") or "").strip()
    if not game_name:
        return {"supported": False, "config_path": None, "settings": [],
                "error": "game_name is required.", "game_name": ""}

    try:
        from game_configs.registry import read_game_config
        result = read_game_config(game_name)
    except Exception as exc:
        return {"supported": False, "config_path": None, "settings": [],
                "error": str(exc), "game_name": game_name}

    return {
        "supported":    result.supported,
        "config_path":  result.config_path,
        "settings":     [
            {"key": s.key, "label": s.label, "value": s.value,
             "category": s.category, "note": s.note}
            for s in result.settings
        ],
        "error":        result.error,
        "game_name":    result.game_name,
    }


@games_router.get("/games/supported")
def games_supported() -> Dict[str, Any]:
    """Return the list of games that have a config adapter."""
    try:
        from game_configs.registry import list_supported_games
        return {"games": list_supported_games()}
    except Exception:
        return {"games": []}


# ============================================================
#  /games/ask  — streaming AI advisor (SSE via fetch)
# ============================================================

@games_router.post("/games/ask")
def games_ask(payload: Dict[str, Any]):
    """
    Stream AI gaming advice as server-sent events.
    Accepts: { game_name, question, preset, system, current_settings? }
    Emits:   data: {"t": "<token>"}\n\n  ...  data: [DONE]\n\n
    """
    game_name        = (payload.get("game_name") or "an unspecified game").strip() or "an unspecified game"
    question         = (payload.get("question") or "").strip()
    preset           = (payload.get("preset") or "stable_60").strip()
    system           = payload.get("system") or {}
    current_settings = payload.get("current_settings") or []   # list of {key, label, value, category}

    hw_block = _build_hw_block(system)

    # Build current settings block when provided
    settings_block = ""
    if current_settings:
        lines = [f"  {s.get('label', s.get('key', '?'))}: {s.get('value', '?')}"
                 for s in current_settings if isinstance(s, dict)]
        if lines:
            settings_block = "Current game settings:\n" + "\n".join(lines) + "\n\n"

    if question:
        prompt = (
            f"You are a PC gaming performance expert embedded in TLI (TheLANIntelligence).\n\n"
            f"Game: {game_name}\n"
            f"Hardware:\n{hw_block}\n\n"
            f"{settings_block}"
            f"User question: {question}\n\n"
            f"Answer specifically for this hardware and game. Be concise and directly actionable. "
            f"Reference the actual hardware in your answer. "
            + (f"Where relevant, reference the current settings listed above and explain what to change and why. " if settings_block else "")
            + "No disclaimers or preamble."
        )
    else:
        preset_label, preset_goal = _PRESET_DESCRIPTIONS.get(preset, _PRESET_DESCRIPTIONS["stable_60"])
        prompt = (
            f"You are a PC gaming performance expert embedded in TLI (TheLANIntelligence).\n\n"
            f"Game: {game_name}\n"
            f"Optimization goal: {preset_label}\n"
            f"{preset_goal}\n\n"
            f"Hardware:\n{hw_block}\n\n"
            f"{settings_block}"
            f"Provide 5-8 specific, actionable recommendations tailored to this exact hardware and game. "
            f"Format as a numbered list. 1-2 lines per item. "
            + (f"For each recommendation, reference the current setting value shown above and what to change it to. " if settings_block else "")
            + "Reference the actual GPU, CPU, and resolution in your advice. "
            "No preamble — go straight to the recommendations."
        )

    def _generate():
        try:
            from ai.ai_manager import BundledAIManager
            import urllib.request as _ur

            mgr = BundledAIManager.get()
            if not mgr.is_healthy():
                raise RuntimeError("Bundled AI not running")

            req_body = _json.dumps({
                "model": "local",
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.45,
                "max_tokens": 700,
                "stream": True,
            }).encode()

            req = _ur.Request(
                mgr.base_url + "/v1/chat/completions",
                req_body,
                {"Content-Type": "application/json"},
                method="POST",
            )

            with _ur.urlopen(req, timeout=90) as resp:
                for raw_line in resp:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data: "):
                        continue
                    chunk = line[6:]
                    if chunk == "[DONE]":
                        break
                    try:
                        data = _json.loads(chunk)
                        token = data["choices"][0]["delta"].get("content", "")
                        if token:
                            yield f"data: {_json.dumps({'t': token})}\n\n"
                    except Exception:
                        continue

        except Exception as _err:
            import tli_state as _S
            _S.log_debug("games", "WARN", f"games/ask stream failed: {_err}")
            fallback = _static_fallback(preset, hw_block, game_name)
            for line in fallback.split("\n"):
                yield f"data: {_json.dumps({'t': line + chr(10)})}\n\n"

        yield "data: [DONE]\n\n"

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
