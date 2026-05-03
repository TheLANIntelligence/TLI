# backend/ai/ai_manager.py
# Bundled AI runtime manager — supports dynamic model switching.
#
# Changes from original:
# - Model path is resolved dynamically from active_model.json (not hardcoded)
# - Supports stop → switch model → restart cycle
# - MODEL_PRESETS define the tiered system (Lite / Standard / Power)
# - get() reads active preset on first call; switch_model() swaps live

from __future__ import annotations

import os
import sys
import json
import time
import atexit
import signal
import socket
import logging
import threading
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Dict, Any
from urllib.request import Request, urlopen

LOGGER = logging.getLogger("tli.ai")
if not LOGGER.handlers:
    LOGGER.setLevel(logging.INFO)
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s"))
    LOGGER.addHandler(_h)


# ==================================================================
#  Model presets — the three tiers users can choose from
# ==================================================================

MODEL_PRESETS: Dict[str, Dict[str, Any]] = {
    "lite": {
        "id": "lite",
        "name": "Qwen2.5 1.5B (Lite)",
        "description": "Fast on any PC. Good for quick tasks and simple questions.",
        "filename": "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
        "size_bytes": 1_050_000_000,   # ~1 GB
        "size_human": "~1 GB",
        "min_ram_gb": 8,
        "url": "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
        "license": "Apache 2.0",
        "ctx_size": 4096,
        "tier": "lite",
    },
    "standard": {
        "id": "standard",
        "name": "Qwen2.5 3B (Standard)",
        "description": "Recommended. Smart and fast — best balance for most users.",
        "filename": "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
        "size_bytes": 2_050_000_000,   # ~2 GB
        "size_human": "~2 GB",
        "min_ram_gb": 12,
        "url": "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf",
        "license": "Apache 2.0",
        "ctx_size": 4096,
        "tier": "standard",
    },
    "power": {
        "id": "power",
        "name": "Qwen2.5 7B (Power)",
        "description": "Best quality. Complex tasks, code generation, deep reasoning. Needs 16 GB+ RAM.",
        "filename": "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        "size_bytes": 4_700_000_000,   # ~4.5 GB
        "size_human": "~4.5 GB",
        "min_ram_gb": 16,
        "url": "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        "license": "Apache 2.0",
        "ctx_size": 4096,
        "tier": "power",
    },
    "vision": {
        "id": "vision",
        "name": "Qwen2.5-VL 3B (Vision)",
        "description": "Analyze images, diagrams, and photos alongside text. Requires two files (~2.5 GB total).",
        "filename": "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
        "mmproj_filename": "mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf",
        "size_bytes": 2_200_000_000,
        "size_human": "~2.2 GB",
        "mmproj_size_bytes": 390_000_000,
        "mmproj_size_human": "~390 MB",
        "min_ram_gb": 8,
        "url": "https://huggingface.co/bartowski/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
        "mmproj_url": "https://huggingface.co/bartowski/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf",
        "license": "Apache 2.0",
        "ctx_size": 4096,
        "tier": "vision",
        "is_vision": True,
    },
}

DEFAULT_PRESET = "standard"

# Legacy filename → still works if users have it from before
LEGACY_MODEL_NAMES = {"phi-3.5-mini-instruct.Q4_K_M.gguf"}


# ==================================================================
#  Config persistence (which model is active)
# ==================================================================

def _ai_base_dir() -> Path:
    """
    When running as a frozen onefile EXE, __file__ resolves to the temp
    extraction dir (_MEIPASS). Use the EXE's own directory instead so that
    ai/runtime/ and ai/models/ are found next to tli_backend.exe.
    Falls back to the source tree location when running from source.
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "ai"
    return Path(__file__).resolve().parent

AI_DIR = _ai_base_dir()


# ==================================================================
#  Windows Job Object — ensures llama_server dies with this process
# ==================================================================
#
# When tli_backend.exe exits for ANY reason (normal, exception, window
# closed, Task Manager kill), the OS closes all open handles held by
# that process.  Because we hold the only reference to this Job Object,
# it closes too — and Windows immediately kills every process inside it.
#
# This works even if atexit / signal handlers never run.

_win32_job = None   # keep reference alive; GC would close the handle early


def _setup_win32_job() -> None:
    global _win32_job
    if os.name != 'nt' or _win32_job is not None:
        return
    try:
        import ctypes
        k32 = ctypes.windll.kernel32

        job = k32.CreateJobObjectW(None, None)
        if not job:
            return

        # JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes on 64-bit Windows).
        # LimitFlags sits at offset 16 (after two LARGE_INTEGER = 16 bytes).
        # Flag 0x2000 = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        buf = (ctypes.c_uint8 * 144)()
        ctypes.c_uint32.from_buffer(buf, 16).value = 0x2000
        k32.SetInformationJobObject(job, 9, buf, ctypes.sizeof(buf))  # 9 = JobObjectExtendedLimitInformation

        _win32_job = job
        LOGGER.info("[AI] Job Object ready — llama_server will exit with TLI automatically")
    except Exception as e:
        LOGGER.warning(f"[AI] Could not create Job Object: {e}")


def _assign_to_win32_job(pid: int) -> None:
    if os.name != 'nt' or _win32_job is None:
        return
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(0x1F0FFF, False, pid)  # PROCESS_ALL_ACCESS
        if handle:
            k32.AssignProcessToJobObject(_win32_job, handle)
            k32.CloseHandle(handle)
    except Exception as e:
        LOGGER.warning(f"[AI] Could not assign llama_server to Job Object: {e}")


_setup_win32_job()
ACTIVE_MODEL_PATH = AI_DIR / "active_model.json"
_STORAGE_CONFIG_PATH = AI_DIR / "model_storage.json"


def get_models_dir() -> Path:
    """Return the current model storage directory (user-configurable)."""
    try:
        if _STORAGE_CONFIG_PATH.exists():
            data = json.loads(_STORAGE_CONFIG_PATH.read_text(encoding="utf-8"))
            p = data.get("models_dir", "")
            if p:
                return Path(p)
    except Exception:
        pass
    return AI_DIR / "models"


def set_models_dir(path: str) -> None:
    """Persist a new model storage directory."""
    data = {"models_dir": str(path)}
    _STORAGE_CONFIG_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _load_active_preset_id() -> str:
    """Read which preset is currently active. Falls back to DEFAULT_PRESET."""
    try:
        if ACTIVE_MODEL_PATH.exists():
            data = json.loads(ACTIVE_MODEL_PATH.read_text(encoding="utf-8"))
            pid = data.get("preset_id", "").strip()
            if pid in MODEL_PRESETS:
                return pid
            # Check if there's a custom filename that matches a preset
            fname = data.get("filename", "")
            for k, v in MODEL_PRESETS.items():
                if v["filename"] == fname:
                    return k
    except Exception:
        pass
    return DEFAULT_PRESET


def _save_active_preset_id(preset_id: str, filename: Optional[str] = None) -> None:
    """Persist the active model choice."""
    try:
        data = {"preset_id": preset_id, "filename": filename or MODEL_PRESETS.get(preset_id, {}).get("filename", "")}
        ACTIVE_MODEL_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as e:
        LOGGER.error(f"[AI] Failed to save active model config: {e}")


def _resolve_model_path(preset_id: Optional[str] = None) -> Path:
    """
    Resolve the model file path. Priority:
    1. If preset_id given → use that preset's filename
    2. Read active_model.json → use stored preset
    3. Scan models/ dir for any .gguf file
    4. Fall back to standard preset filename (even if not downloaded yet)
    """
    models_dir = get_models_dir()
    models_dir.mkdir(parents=True, exist_ok=True)

    # 1. Explicit preset
    if preset_id and preset_id in MODEL_PRESETS:
        p = models_dir / MODEL_PRESETS[preset_id]["filename"]
        if p.exists():
            return p

    # 2. Active config
    active = _load_active_preset_id()
    if active in MODEL_PRESETS:
        p = models_dir / MODEL_PRESETS[active]["filename"]
        if p.exists():
            return p

    # 3. Scan for ANY .gguf file (handles legacy phi-3.5 or user-uploaded models)
    try:
        for f in sorted(models_dir.iterdir()):
            if f.suffix == ".gguf" and f.stat().st_size > 100_000_000:  # >100MB = real model
                return f
    except Exception:
        pass

    # 4. Fall back to expected path (may not exist yet)
    return models_dir / MODEL_PRESETS.get(active, MODEL_PRESETS[DEFAULT_PRESET])["filename"]


# ==================================================================
#  Runtime config
# ==================================================================

@dataclass
class BundledAIConfig:
    ai_dir: Path
    runtime_path: Path
    model_path: Path

    host: str = "127.0.0.1"
    port: int = 8089

    ctx_size: int = 4096
    temp: float = 0.2
    top_p: float = 0.9
    repeat_penalty: float = 1.15

    startup_timeout_s: int = 120
    health_timeout_s: int = 5
    restart_backoff_s: int = 2

    health_path: str = "/v1/models"
    threads: Optional[int] = None  # resolved at startup — see _optimal_threads()


def _optimal_threads() -> int:
    """
    Pick a thread count that leaves headroom for the OS and other processes.
    All cores = often slower due to memory bandwidth contention.
    """
    n = os.cpu_count() or 4
    if n <= 4:
        return n          # small machines: use everything
    if n <= 8:
        return n - 1      # mid-range: leave 1 core free
    return n - 2          # high-core: leave 2 cores free


def _gpu_layers_for_platform() -> int:
    """
    Returns the number of GPU layers to offload to the GPU.
    - Apple Silicon (arm64 Mac): use Metal — offload all layers (99)
    - Intel Mac / Windows / Linux without CUDA: 0 (CPU only)
    """
    if sys.platform != "darwin":
        return 0
    try:
        import subprocess as _sp
        result = _sp.run(["uname", "-m"], capture_output=True, text=True, timeout=2)
        if result.stdout.strip() == "arm64":
            return 99  # Metal GPU — offload all layers
    except Exception:
        pass
    return 0  # Intel Mac — CPU only


def _is_port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def _http_get_json(url: str, timeout_s: int):
    try:
        req = Request(url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=timeout_s) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


# ==================================================================
#  Manager
# ==================================================================

class BundledAIManager:
    _instance = None
    _lock = threading.Lock()

    def __init__(self, cfg: BundledAIConfig):
        self.cfg = cfg
        self._proc = None
        self._proc_lock = threading.Lock()
        self._stop = threading.Event()
        self._watchdog = None
        self._active_preset = _load_active_preset_id()
        atexit.register(self.stop)
        try:
            signal.signal(signal.SIGINT, self._sig)
            signal.signal(signal.SIGTERM, self._sig)
        except Exception:
            pass

    @classmethod
    def get(cls) -> "BundledAIManager":
        with cls._lock:
            if cls._instance:
                return cls._instance
            ai_dir = _ai_base_dir()
            runtime = ai_dir / "runtime" / ("llama_server.exe" if os.name == "nt" else "llama-server")
            model = _resolve_model_path()
            cfg = BundledAIConfig(ai_dir, runtime, model)
            cls._instance = cls(cfg)
            return cls._instance

    @property
    def base_url(self):
        return f"http://{self.cfg.host}:{self.cfg.port}"

    @property
    def active_preset_id(self) -> str:
        return self._active_preset

    def _sig(self, *_):
        self.stop()

    def is_healthy(self):
        if not _is_port_open(self.cfg.host, self.cfg.port):
            return False
        return isinstance(_http_get_json(self.base_url + self.cfg.health_path, self.cfg.health_timeout_s), dict)

    def ensure_running(self):
        if self.is_healthy():
            self._start_watchdog()
            return True
        return self.start()

    def start(self):
        with self._proc_lock:
            if self._proc and self._proc.poll() is None:
                return True
            if not self.cfg.runtime_path.exists():
                LOGGER.error(f"[AI] Runtime binary missing: {self.cfg.runtime_path}")
                return False
            if not self.cfg.model_path.exists():
                LOGGER.error(f"[AI] Model file missing: {self.cfg.model_path}")
                return False

            # Read ctx_size from preset if available
            preset = MODEL_PRESETS.get(self._active_preset, {})
            ctx = preset.get("ctx_size", self.cfg.ctx_size)

            threads = self.cfg.threads or _optimal_threads()
            gpu_layers = _gpu_layers_for_platform()

            cmd = [
                str(self.cfg.runtime_path),
                "--model", str(self.cfg.model_path),
                "--host", self.cfg.host,
                "--port", str(self.cfg.port),
                "--ctx-size", str(ctx),
                "--temp", str(self.cfg.temp),
                "--top-p", str(self.cfg.top_p),
                "--repeat-penalty", str(self.cfg.repeat_penalty),
                "--threads", str(threads),
            ]

            if gpu_layers > 0:
                cmd += ["--n-gpu-layers", str(gpu_layers)]
                LOGGER.info(f"[AI] Metal GPU enabled — offloading {gpu_layers} layers")

            # Vision models need the mmproj (multimodal projector) file
            if preset.get("mmproj_filename"):
                mmproj_path = get_models_dir() / preset["mmproj_filename"]
                if mmproj_path.exists():
                    cmd += ["--mmproj", str(mmproj_path)]
                else:
                    LOGGER.warning(f"[AI] mmproj file missing for vision model: {mmproj_path}")

            LOGGER.info(f"[AI] Starting llama server with {self.cfg.model_path.name}...")
            self._proc = subprocess.Popen(
                cmd,
                cwd=str(self.cfg.runtime_path.parent),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            _assign_to_win32_job(self._proc.pid)

        deadline = time.time() + self.cfg.startup_timeout_s
        while time.time() < deadline:
            if self.is_healthy():
                LOGGER.info("[AI] Runtime healthy")
                self._start_watchdog()
                try:
                    import event_bus as _eb
                    preset = MODEL_PRESETS.get(self._active_preset, {})
                    label = preset.get("label") or self._active_preset or "AI model"
                    _eb.emit_event("ai", "ok", f"{label} ready", "Local AI is running")
                except Exception:
                    pass
                return True
            time.sleep(0.4)

        LOGGER.error("[AI] Runtime failed to start")
        try:
            import event_bus as _eb
            _eb.emit_event("ai", "warn", "AI model startup timed out", "Check system resources — will retry automatically")
        except Exception:
            pass
        return False

    def stop(self):
        self._stop.set()
        with self._proc_lock:
            if self._proc:
                pid = self._proc.pid
                try:
                    if os.name == "nt":
                        # taskkill /T kills the process tree (llama_server + any children)
                        subprocess.run(
                            ["taskkill", "/F", "/T", "/PID", str(pid)],
                            capture_output=True, timeout=5,
                        )
                    else:
                        self._proc.terminate()
                        try:
                            self._proc.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            self._proc.kill()
                except Exception:
                    pass
                self._proc = None

    def switch_model(self, preset_id: str) -> Dict[str, Any]:
        """
        Switch to a different model preset.
        Stops current server, updates config, restarts with new model.
        Returns status dict.
        """
        if preset_id not in MODEL_PRESETS:
            return {"ok": False, "error": f"Unknown preset: {preset_id}"}

        preset = MODEL_PRESETS[preset_id]
        model_path = get_models_dir() / preset["filename"]

        if not model_path.exists():
            return {"ok": False, "error": f"Model file not found: {preset['filename']}. Download it first."}

        if not self.cfg.runtime_path.exists():
            return {"ok": False, "error": "Bundled AI runtime not installed on this machine. Use LM Studio (Advanced) to run a local AI model."}

        LOGGER.info(f"[AI] Switching model to {preset_id} ({preset['filename']})...")

        # Stop current
        self._stop.set()
        self.stop()
        time.sleep(0.5)

        # Update config
        self.cfg.model_path = model_path
        self._active_preset = preset_id
        _save_active_preset_id(preset_id)
        self._stop.clear()

        # Restart
        ok = self.start()

        return {
            "ok": ok,
            "preset_id": preset_id,
            "model": preset["filename"],
            "healthy": self.is_healthy(),
            "error": None if ok else "AI runtime started but did not become healthy in time. Check system resources.",
        }

    def status(self) -> Dict[str, Any]:
        """Full status report for the UI."""
        healthy = self.is_healthy()
        preset = MODEL_PRESETS.get(self._active_preset, {})
        model_exists = self.cfg.model_path.exists()

        # Check which presets have models downloaded
        available = {}
        models_dir = get_models_dir()
        for pid, p in MODEL_PRESETS.items():
            fpath = models_dir / p["filename"]
            available[pid] = {
                "downloaded": fpath.exists(),
                "size_on_disk": fpath.stat().st_size if fpath.exists() else 0,
            }

        return {
            "healthy": healthy,
            "model_exists": model_exists,
            "active_preset": self._active_preset,
            "active_model": preset.get("name", "Unknown"),
            "active_filename": preset.get("filename", ""),
            "model_path": str(self.cfg.model_path),
            "base_url": self.base_url,
            "presets_available": available,
        }

    def _start_watchdog(self):
        if self._watchdog and self._watchdog.is_alive():
            return
        self._stop.clear()
        self._watchdog = threading.Thread(target=self._watchdog_loop, daemon=True)
        self._watchdog.start()

    def _watchdog_loop(self):
        while not self._stop.is_set():
            if not self.is_healthy():
                LOGGER.warning("[AI] Restarting runtime...")
                self.start()
            time.sleep(2)
