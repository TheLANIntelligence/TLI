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
from contextlib import contextmanager
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
        "description": "Smallest bundled text model for quick tasks and simple questions.",
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
        "description": "Default bundled text model for general conversation and tasks.",
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
        "description": "Larger bundled text preset with higher memory needs. Review its recorded answer-quality findings.",
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

from .model_catalog import QWEN3_PRESETS
from .preset_launch import preset_runtime_args
MODEL_PRESETS.update(QWEN3_PRESETS)

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


def _windows_job_api():
    import ctypes
    from ctypes import wintypes as w
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    signatures = {
        "CreateJobObjectW": ([ctypes.c_void_p, w.LPCWSTR], w.HANDLE),
        "SetInformationJobObject": ([w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD], w.BOOL),
        "AssignProcessToJobObject": ([w.HANDLE, w.HANDLE], w.BOOL),
        "IsProcessInJob": ([w.HANDLE, w.HANDLE, ctypes.POINTER(w.BOOL)], w.BOOL),
        "TerminateJobObject": ([w.HANDLE, w.UINT], w.BOOL),
        "CloseHandle": ([w.HANDLE], w.BOOL),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(kernel, name)
        function.argtypes, function.restype = arguments, result
    return kernel


def _setup_win32_job() -> None:
    global _win32_job
    if os.name != 'nt' or _win32_job is not None:
        return
    try:
        import ctypes
        from ctypes import wintypes as w
        k32 = _windows_job_api()

        class Basic(ctypes.Structure):
            _fields_ = [("ProcessTime", ctypes.c_longlong), ("JobTime", ctypes.c_longlong), ("Flags", w.DWORD),
                        ("MinWorkingSet", ctypes.c_size_t), ("MaxWorkingSet", ctypes.c_size_t), ("ActiveProcesses", w.DWORD),
                        ("Affinity", ctypes.c_size_t), ("Priority", w.DWORD), ("Scheduling", w.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")]
        class Extended(ctypes.Structure):
            _fields_ = [("Basic", Basic), ("IO", IO), ("ProcessMemory", ctypes.c_size_t), ("JobMemory", ctypes.c_size_t),
                        ("PeakProcessMemory", ctypes.c_size_t), ("PeakJobMemory", ctypes.c_size_t)]

        job = k32.CreateJobObjectW(None, None)
        if not job:
            return
        info = Extended()
        info.Basic.Flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            k32.CloseHandle(job)
            LOGGER.warning("[AI] Runtime Job Object limits could not be established")
            return

        _win32_job = job
        LOGGER.info("[AI] Job Object ready — llama_server will exit with TLI automatically")
    except Exception as e:
        LOGGER.warning(f"[AI] Could not create Job Object: {e}")


def _assign_to_win32_job(process):
    """Bind tree cleanup to this Popen's retained handle, never reopen a PID."""
    if os.name != 'nt' or _win32_job is None:
        return
    try:
        handle = int(process._handle)
        if handle <= 0 or process.poll() is not None:
            return
        if not _windows_job_api().AssignProcessToJobObject(_win32_job, handle):
            LOGGER.warning("[AI] Runtime Job Object assignment could not be confirmed")
            return
        return process, _win32_job
    except Exception as e:
        LOGGER.warning(f"[AI] Could not assign llama_server to Job Object: {e}")


def _stop_windows_runtime(process, job_binding=None):
    """Stop only retained process/job handles; a recycled PID has no authority."""
    import ctypes
    from ctypes import wintypes as w
    handle = getattr(process, "_handle", None)
    if handle is None or int(handle) <= 0:
        raise RuntimeError("The owned AI process handle is unavailable; no process was stopped.")
    if job_binding and job_binding[0] is process and job_binding[1] == _win32_job:
        try:
            kernel = _windows_job_api()
            member = w.BOOL()
            if kernel.IsProcessInJob(int(handle), job_binding[1], ctypes.byref(member)) and member.value:
                if kernel.TerminateJobObject(job_binding[1], 1):
                    process.wait(timeout=5)
                    return
        except Exception as error:
            LOGGER.warning("[AI] Owned runtime tree cleanup could not be confirmed: %s", error)
    # Popen uses the original Windows process handle for terminate/wait. Even if
    # the child exits here, this cannot target another process reusing its PID.
    if process.poll() is None:
        process.terminate()
    process.wait(timeout=5)


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
            if pid == "custom" and data.get("filename"):
                return "custom"
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
        tmp = ACTIVE_MODEL_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(ACTIVE_MODEL_PATH)
    except Exception as e:
        LOGGER.error(f"[AI] Failed to save active model config: {e}")
        raise


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
        if p.exists() or ACTIVE_MODEL_PATH.exists():
            return p

    if active == "custom":
        try:
            from .model_library import contained_filename
            data = json.loads(ACTIVE_MODEL_PATH.read_text(encoding="utf-8"))
            return contained_filename(models_dir, data["filename"])
        except (ValueError, KeyError, OSError):
            pass

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
        self._proc_job_binding = None
        self._text_capacity_launch = None
        self._proc_lock = threading.Lock()
        self._stop = threading.Event()
        self._watchdog = None
        self.operation_lock = threading.RLock()
        self._generations = 0
        self._transition = False
        self._manual_failure = False
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

    def text_capacity(self):
        """Read owned launch configuration without probing or starting inference.

        A live process and matching launch identity bind the configuration to
        this runtime. They do not prove health or tokenizer/effective capacity.
        """
        unknown = {"status": "unknown", "context_tokens": None,
                   "source": "unavailable", "model": self._active_preset}
        with self._proc_lock:
            launch = self._text_capacity_launch
            if (not launch or self._transition or self._proc is not launch["process"] or
                    launch["model"] != self._active_preset or launch["model_path"] != str(self.cfg.model_path)):
                return unknown
            try:
                if self._proc.poll() is not None:
                    return unknown
            except Exception:
                return unknown
            return {"status": "configured", "context_tokens": launch["context_tokens"],
                    "source": "owned_runtime_launch", "model": launch["model"]}

    def _sig(self, *_):
        self.stop()

    def is_healthy(self):
        if not _is_port_open(self.cfg.host, self.cfg.port):
            return False
        return isinstance(_http_get_json(self.base_url + self.cfg.health_path, self.cfg.health_timeout_s), dict)

    def ensure_running(self):
        if self._transition or self._manual_failure:
            return False
        if self.is_healthy():
            self._start_watchdog()
            return True
        return self.start()

    @contextmanager
    def generation(self):
        from fastapi import HTTPException
        if not self.operation_lock.acquire(blocking=False):
            raise HTTPException(409, "Model operation in progress. Retry when it completes.")
        try:
            self._generations += 1
        finally:
            self.operation_lock.release()
        try:
            yield
        finally:
            with self.operation_lock:
                self._generations -= 1

    def start(self):
        if not self.operation_lock.acquire(blocking=False):
            return False
        try:
            return self._start_runtime()
        finally:
            self.operation_lock.release()

    def _start_runtime(self):
        with self._proc_lock:
            if self._proc and self._proc.poll() is None:
                return self.is_healthy()
            if not self.cfg.runtime_path.exists():
                LOGGER.error(f"[AI] Runtime binary missing: {self.cfg.runtime_path}")
                return False
            if not self.cfg.model_path.exists():
                LOGGER.error(f"[AI] Model file missing: {self.cfg.model_path}")
                return False

            # Read ctx_size from preset if available
            preset = self.preset(self._active_preset) if self._active_preset in MODEL_PRESETS or self._active_preset.startswith("custom:") else {}
            if preset.get("min_runtime_build"):
                from .runtime_support import support
                runtime = support(preset, self.cfg.runtime_path)
                if runtime["state"] != "supported":
                    LOGGER.error("Cannot start selected model: %s", runtime["reason"])
                    return False
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

            cmd += preset_runtime_args(preset)

            if gpu_layers > 0:
                cmd += ["--n-gpu-layers", str(gpu_layers)]
                LOGGER.info(f"[AI] Metal GPU enabled — offloading {gpu_layers} layers")

            # Vision models need the mmproj (multimodal projector) file
            if preset.get("mmproj_filename"):
                mmproj_path = get_models_dir() / preset["mmproj_filename"]
                if mmproj_path.exists():
                    cmd += ["--mmproj", str(mmproj_path)]
                else:
                    LOGGER.error(f"[AI] mmproj file missing for vision model: {mmproj_path}")
                    return False

            LOGGER.info(f"[AI] Starting llama server with {self.cfg.model_path.name}...")
            if _is_port_open(self.cfg.host, self.cfg.port):
                LOGGER.error("AI runtime port is occupied by an unowned process")
                return False
            self._proc = subprocess.Popen(
                cmd,
                cwd=str(self.cfg.runtime_path.parent),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            self._text_capacity_launch = {"process": self._proc, "context_tokens": ctx,
                                          "model": self._active_preset, "model_path": str(self.cfg.model_path)}
            self._proc_job_binding = _assign_to_win32_job(self._proc)

        deadline = time.time() + self.cfg.startup_timeout_s
        while time.time() < deadline:
            if self._proc is None or self._proc.poll() is not None:
                LOGGER.error("AI runtime exited before becoming ready")
                return False
            if self.is_healthy():
                LOGGER.info("[AI] Runtime healthy")
                if self._transition:
                    return True
                self._start_watchdog()
                try:
                    import event_bus as _eb
                    preset = MODEL_PRESETS.get(self._active_preset, {})
                    label = preset.get("label") or "Imported AI model"
                    _eb.emit_event("ai", "ok", f"{label} ready", "Local AI is running")
                except Exception:
                    pass
                return True
            time.sleep(0.4)

        LOGGER.error("[AI] Runtime failed to start")
        try:
            import event_bus as _eb
            _eb.emit_event("ai", "warn", "AI model startup timed out", "Local AI did not become ready.")
        except Exception:
            pass
        return False

    def stop(self):
        self._stop.set()
        with self._proc_lock:
            if self._proc:
                try:
                    if os.name == "nt":
                        _stop_windows_runtime(self._proc, self._proc_job_binding)
                    else:
                        self._proc.terminate()
                        try:
                            self._proc.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            self._proc.kill()
                except Exception as error:
                    if os.name == "nt":
                        self._text_capacity_launch = None
                        LOGGER.warning("[AI] Runtime stop was not confirmed; its owned process reference was retained: %s", error)
                        raise RuntimeError("The owned AI runtime did not confirm shutdown.") from error
                self._proc = None
                self._proc_job_binding = None
            self._text_capacity_launch = None

    def preset(self, preset_id):
        if preset_id in MODEL_PRESETS:
            return MODEL_PRESETS[preset_id]
        from .model_library import contained_filename
        if preset_id.startswith("custom:"):
            path = contained_filename(get_models_dir(), preset_id[7:])
            return {"id": preset_id, "name": path.name, "filename": path.name,
                    "ctx_size": self.cfg.ctx_size, "size_bytes": path.stat().st_size}
        raise ValueError("Unknown model preset")

    def compatibility(self, preset_id):
        from .model_library import assess
        return assess(self.preset(preset_id), get_models_dir(), self.cfg.runtime_path,
                      "Metal (shared memory)" if _gpu_layers_for_platform() else "CPU")

    def inference_check(self):
        import requests
        try:
            response = requests.post(self.base_url + "/v1/chat/completions",
                json={"model": "tli-bundled", "messages": [{"role": "user", "content": "Say OK."}],
                      "max_tokens": 4, "temperature": 0, "stream": False}, timeout=(3, 20))
            response.raise_for_status()
            return bool(response.json()["choices"][0]["message"]["content"].strip())
        except Exception:
            return False

    def switch_model(self, preset_id: str, check_unknown=False) -> Dict[str, Any]:
        if not self.operation_lock.acquire(blocking=False):
            return {"ok": False, "busy": True, "error": "Model operation in progress. Retry when it completes."}
        previous_path, previous_id = self.cfg.model_path, self._active_preset
        was_running = False
        touched = False
        try:
            if self._generations:
                return {"ok": False, "busy": True, "error": "Bundled generation is active. Retry after it finishes."}
            preset = self.preset(preset_id)
            compatibility = self.compatibility(preset_id)
            if preset.get("min_runtime_build") and compatibility["runtime"]["state"] != "supported":
                return {"ok": False, "error": compatibility["runtime"]["reason"], "compatibility": compatibility}
            if not compatibility["installation"]["complete"]:
                return {"ok": False, "error": "Required model files are missing or invalid.", "compatibility": compatibility}
            if compatibility["state"] in ("unsupported", "insufficient_resources") or (compatibility["state"] == "unknown" and not check_unknown):
                return {"ok": False, "error": " ".join(compatibility["reasons"]), "compatibility": compatibility}
            model_path = get_models_dir() / preset["filename"]
            if preset.get("sha256"):
                from .model_library import verify_checksum
                if not verify_checksum(model_path, preset["sha256"]):
                    return {"ok": False, "error": "Model checksum could not be verified against the publisher artifact. Current model was not stopped."}
            if self.cfg.model_path == model_path and self.is_healthy():
                return {"ok": True, "preset_id": preset_id, "model": preset["filename"], "healthy": True, "error": None}
            was_running = self.is_healthy()
            self._transition = True
            self._manual_failure = False
            touched = True
            from event_bus import emit_event
            emit_event("ai", "info", "AI model switch started", "Checking the candidate runtime before saving the selection.")
            self.stop()
            self.cfg.model_path, self._active_preset = model_path, preset_id
            self._stop.clear()
            if not self.start() or not self.inference_check():
                raise RuntimeError("Candidate model failed its startup or inference check.")
            _save_active_preset_id("custom" if preset_id.startswith("custom:") else preset_id, preset["filename"])
            self._transition = False
            try:
                self._start_watchdog()
            except Exception as watchdog_error:
                LOGGER.warning("Runtime ready, but watchdog could not start: %s", watchdog_error)
            emit_event("ai", "ok", "AI model switch completed", "The selected model passed startup and a short inference check. Local AI is running.")
            return {"ok": True, "preset_id": preset_id, "model": preset["filename"],
                    "healthy": True, "error": None, "compatibility": compatibility}
        except Exception as exc:
            recovered = False
            if touched:
                self.stop()
                self.cfg.model_path, self._active_preset = previous_path, previous_id
                if was_running:
                    try:
                        self._stop.clear()
                        recovered = bool(self.start() and self.inference_check())
                    except Exception:
                        recovered = False
                if not recovered:
                    self.stop()
                    self._manual_failure = True
                self._transition = False
                if recovered:
                    try:
                        self._start_watchdog()
                    except Exception as watchdog_error:
                        LOGGER.warning("Recovery ready, but watchdog could not start: %s", watchdog_error)
                from event_bus import emit_event
                emit_event("ai", "warn", "AI model switch failed", "The candidate was rejected. The previous selection was preserved.")
                if recovered:
                    emit_event("ai", "ok", "Previous AI model restored", "Recovery passed startup and a short inference check. Local AI is running again.")
                else:
                    emit_event("ai", "warn", "Local AI is unavailable", "Recovery failed." if was_running else "There was no previously running model to restore.")
            return {"ok": False, "preset_id": preset_id, "error": str(exc),
                    "healthy": recovered, "recovery": {"attempted": touched and was_running,
                    "restored": recovered, "previous_preset": previous_id}}
        finally:
            self._transition = False
            self.operation_lock.release()

    def status(self) -> Dict[str, Any]:
        """Full status report for the UI."""
        healthy = not self._transition and self.is_healthy()
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
            "active_model": preset.get("name", self.cfg.model_path.name),
            "active_filename": preset.get("filename", self.cfg.model_path.name),
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
            if not self._transition and not self._manual_failure and not self.is_healthy():
                LOGGER.warning("[AI] Restarting runtime...")
                self.start()
            time.sleep(2)
