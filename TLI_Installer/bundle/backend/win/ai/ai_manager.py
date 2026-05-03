"""
TLI Bundled AI - ai_manager.py

Purpose:
- Start and supervise the bundled llama.cpp server (llama_server.exe / llama-server)
- Provide health checks and auto-restart
- Provide a safe, single-instance manager used by FastAPI routes

Design goals:
- Stable, offline, low-friction
- No hard dependency on external Python packages
"""

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
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Dict, Any
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

# ----------------------------
# Logging
# ----------------------------
LOGGER = logging.getLogger("tli.ai")
if not LOGGER.handlers:
    LOGGER.setLevel(logging.INFO)
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s"))
    LOGGER.addHandler(_h)


# ----------------------------
# Config
# ----------------------------
@dataclass
class BundledAIConfig:
    # Base directory: .../backend/ai
    ai_dir: Path

    # Runtime binary
    runtime_path: Path

    # Model file
    model_path: Path

    # Server host/port
    host: str = "127.0.0.1"
    port: int = 8089

    # llama.cpp server args (safe defaults)
    ctx_size: int = 4096
    temp: float = 0.2
    top_p: float = 0.9
    repeat_penalty: float = 1.15

    # Process management
    startup_timeout_s: int = 120
    health_timeout_s: int = 5
    restart_backoff_s: int = 2

    # If your llama server supports OpenAI-compatible endpoints, keep these.
    # Many builds expose /v1/models
    health_path: str = "/v1/models"

    # Threads: "auto" is safest; we pass numeric threads only if desired later
    # Leave None to let llama decide.
    threads: Optional[int] = None


def _is_port_open(host: str, port: int) -> bool:
    """Quick TCP connect test."""
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def _http_get_json(url: str, timeout_s: int) -> Optional[Dict[str, Any]]:
    """GET JSON from a local endpoint. Returns dict or None."""
    try:
        req = Request(url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=timeout_s) as resp:
            data = resp.read().decode("utf-8", errors="replace")
            return json.loads(data)
    except (URLError, HTTPError, ValueError, TimeoutError):
        return None



# ----------------------------
# PID file helpers (prevents duplicate spawns; supports --reload)
# ----------------------------
def _pidfile_path(ai_dir: Path) -> Path:
    return ai_dir / "runtime" / "llama_server.pid"


def _write_pid(pidfile: Path, pid: int) -> None:
    try:
        pidfile.write_text(str(int(pid)), encoding="utf-8")
    except Exception:
        pass


def _read_pid(pidfile: Path) -> Optional[int]:
    try:
        return int(pidfile.read_text(encoding="utf-8").strip())
    except Exception:
        return None


def _pid_is_running(pid: int) -> bool:
    # Cross-platform best-effort check without extra deps.
    try:
        if pid <= 0:
            return False
    except Exception:
        return False

    if os.name == "nt":
        try:
            import ctypes  # stdlib
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, int(pid))
            if handle:
                ctypes.windll.kernel32.CloseHandle(handle)
                return True
        except Exception:
            return False
        return False

    # POSIX: signal 0
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False

class BundledAIManager:
    """
    Singleton-like manager to control llama-server lifecycle.

    Usage:
        mgr = BundledAIManager.get()
        mgr.ensure_running()
        base_url = mgr.base_url
    """

    _instance: Optional["BundledAIManager"] = None
    _instance_lock = threading.Lock()

    def __init__(self, cfg: BundledAIConfig):
        self.cfg = cfg
        self._proc: Optional[subprocess.Popen] = None
        self._proc_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._watchdog_thread: Optional[threading.Thread] = None

        # Register shutdown cleanup once
        atexit.register(self.stop)

        # Best-effort signal handling (mainly for dev runs)
        try:
            signal.signal(signal.SIGINT, self._handle_signal)
            signal.signal(signal.SIGTERM, self._handle_signal)
        except Exception:
            pass

    @classmethod
    def get(cls) -> "BundledAIManager":
        """
        Create or return the singleton manager.
        Assumes this file is located at .../backend/ai/ai_manager.py
        """
        with cls._instance_lock:
            if cls._instance is not None:
                return cls._instance

            ai_dir = Path(__file__).resolve().parent  # .../backend/ai
            runtime_path = ai_dir / "runtime" / ("llama_server.exe" if os.name == "nt" else "llama-server")
            model_path = ai_dir / "models" / "phi-3.5-mini-instruct.Q4_K_M.gguf"

            cfg = BundledAIConfig(
                ai_dir=ai_dir,
                runtime_path=runtime_path,
                model_path=model_path,
            )

            cls._instance = cls(cfg)
            return cls._instance

    @property
    def base_url(self) -> str:
        return f"http://{self.cfg.host}:{self.cfg.port}"

    def _handle_signal(self, signum, frame):
        LOGGER.info(f"[AI] Received signal {signum}, stopping AI runtime...")
        self.stop()

    # ----------------------------
    # Public lifecycle API
    # ----------------------------
    def ensure_running(self) -> bool:
        """
        Ensure llama-server is running and healthy.
        Returns True if healthy, False otherwise.
        """
        if self._stop_event.is_set():
            LOGGER.warning("[AI] ensure_running called after stop event set.")
            return False

        # If already healthy, done
        if self.is_healthy():
            self._start_watchdog_if_needed()
            return True

        # Start or restart
        started = self.start()
        if started:
            self._start_watchdog_if_needed()
        return started

    def is_healthy(self) -> bool:
        """
        Health check:
        1) Port open
        2) /v1/models returns JSON
        """
        if not _is_port_open(self.cfg.host, self.cfg.port):
            return False

        url = self.base_url + self.cfg.health_path
        j = _http_get_json(url, timeout_s=self.cfg.health_timeout_s)
        return isinstance(j, dict)

    def start(self) -> bool:
        """
        Start llama-server if not running; restart if needed.
        """
        with self._proc_lock:
            # If another backend process already started the runtime (e.g., uvicorn --reload), reuse it.
            pidfile = _pidfile_path(self.cfg.ai_dir)
            existing_pid = _read_pid(pidfile)
            if existing_pid and _pid_is_running(existing_pid) and self.is_healthy():
                return True
            # If process exists but dead, clear it
            if self._proc is not None and self._proc.poll() is not None:
                self._proc = None

            # Already running?
            if self._proc is not None and self._proc.poll() is None:
                # Still verify health
                if self.is_healthy():
                    return True
                # unhealthy -> restart
                LOGGER.warning("[AI] Runtime process exists but is unhealthy. Restarting...")
                self._terminate_locked()

            # Validate files exist
            if not self.cfg.runtime_path.exists():
                LOGGER.error(f"[AI] Missing runtime binary: {self.cfg.runtime_path}")
                return False
            if not self.cfg.model_path.exists():
                LOGGER.error(f"[AI] Missing model file: {self.cfg.model_path}")
                return False

            # Build command
            cmd = [str(self.cfg.runtime_path)]
            # Common llama.cpp server flags (works on many builds)
            cmd += ["--model", str(self.cfg.model_path)]
            cmd += ["--host", self.cfg.host]
            cmd += ["--port", str(self.cfg.port)]
            cmd += ["--ctx-size", str(self.cfg.ctx_size)]
            cmd += ["--temp", str(self.cfg.temp)]
            cmd += ["--top-p", str(self.cfg.top_p)]
            cmd += ["--repeat-penalty", str(self.cfg.repeat_penalty)]

            if self.cfg.threads is not None:
                cmd += ["--threads", str(self.cfg.threads)]

            # Working dir: runtime folder (often needed for DLLs)
            cwd = str(self.cfg.runtime_path.parent)

            # On Windows, hide console window
            creationflags = 0
            startupinfo = None
            if os.name == "nt":
                creationflags = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]

            LOGGER.info(f"[AI] Starting runtime: {' '.join(cmd)}")
            try:
                self._proc = subprocess.Popen(
                    cmd,
                    cwd=cwd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    creationflags=creationflags,
                    startupinfo=startupinfo,
                )
                _write_pid(_pidfile_path(self.cfg.ai_dir), self._proc.pid)
            except Exception as e:
                LOGGER.exception(f"[AI] Failed to start runtime: {e}")
                self._proc = None
                return False

        # Wait for health
        deadline = time.time() + self.cfg.startup_timeout_s
        while time.time() < deadline:
            if self._stop_event.is_set():
                return False

            # If process died early, read output (best effort)
            with self._proc_lock:
                proc = self._proc
            if proc is None:
                return False
            if proc.poll() is not None:
                LOGGER.error("[AI] Runtime exited during startup.")
                self._log_process_output(proc, max_lines=60)
                return False

            if self.is_healthy():
                LOGGER.info("[AI] Runtime is healthy ✅")
                return True

            time.sleep(0.5)

        LOGGER.error("[AI] Runtime did not become healthy before timeout.")
        return False

    def stop(self):
        """
        Stop the runtime and watchdog.
        Safe to call multiple times.
        """
        self._stop_event.set()

        # Stop watchdog
        if self._watchdog_thread and self._watchdog_thread.is_alive():
            # It will exit on stop_event
            self._watchdog_thread.join(timeout=2)

        with self._proc_lock:
            self._terminate_locked()

        # Clear PID file
        try:
            p = _pidfile_path(self.cfg.ai_dir)
            if p.exists():
                p.unlink()
        except Exception:
            pass

    # ----------------------------
    # Internal helpers
    # ----------------------------
    def _terminate_locked(self):
        """Terminate process (expects _proc_lock held)."""
        proc = self._proc
        self._proc = None
        if proc is None:
            return

        try:
            if proc.poll() is None:
                LOGGER.info("[AI] Terminating runtime...")
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    LOGGER.warning("[AI] Runtime did not terminate; killing...")
                    proc.kill()
                # Last resort on Windows: ensure process tree is gone
                try:
                    if os.name == "nt" and getattr(proc, "pid", None):
                        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
                except Exception:
                    pass
        except Exception:
            pass

    def _start_watchdog_if_needed(self):
        if self._watchdog_thread and self._watchdog_thread.is_alive():
            return

        self._watchdog_thread = threading.Thread(
            target=self._watchdog_loop,
            name="tli-ai-watchdog",
            daemon=True,
        )
        self._watchdog_thread.start()

    def _watchdog_loop(self):
        """
        Background thread:
        - If runtime becomes unhealthy, attempt restart.
        """
        LOGGER.info("[AI] Watchdog started.")
        while not self._stop_event.is_set():
            try:
                if not self.is_healthy():
                    LOGGER.warning("[AI] Health check failed. Attempting restart...")
                    self.start()
                    time.sleep(self.cfg.restart_backoff_s)
                else:
                    time.sleep(2)
            except Exception:
                # Never crash watchdog
                time.sleep(2)

        LOGGER.info("[AI] Watchdog stopped.")

    def _log_process_output(self, proc: subprocess.Popen, max_lines: int = 80):
        """
        Best-effort: dump last few lines from stdout for debugging.
        """
        try:
            if proc.stdout is None:
                return
            lines = []
            # Read any available lines without blocking too long
            start = time.time()
            while time.time() - start < 1.0:
                line = proc.stdout.readline()
                if not line:
                    break
                lines.append(line.rstrip("\n"))
                if len(lines) >= max_lines:
                    break
            if lines:
                LOGGER.error("[AI] Runtime output (last lines):")
                for ln in lines[-max_lines:]:
                    LOGGER.error("  " + ln)
        except Exception:
            pass
