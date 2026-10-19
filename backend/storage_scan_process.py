"""Owned scan-process transport. Never launches the application or AI lifecycle."""
from __future__ import annotations
import ctypes
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import threading
import time

from storage_scan_worker import MAX_REQUEST, MAX_RESULT, MAX_MEMORY, MAX_INVENTORY_FRAME, canonical

MAX_INVENTORY_WIRE = 512 * 1024 * 1024


class WindowsJob:
    """A private parent-held Job Object, never the AI runtime's job."""
    def __init__(self):
        from ctypes import wintypes as w
        class Basic(ctypes.Structure):
            _fields_ = [("ProcessTime", ctypes.c_longlong), ("JobTime", ctypes.c_longlong), ("Flags", w.DWORD),
                        ("MinWorkingSet", ctypes.c_size_t), ("MaxWorkingSet", ctypes.c_size_t), ("ActiveProcesses", w.DWORD),
                        ("Affinity", ctypes.c_size_t), ("Priority", w.DWORD), ("Scheduling", w.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")]
        class Extended(ctypes.Structure):
            _fields_ = [("Basic", Basic), ("IO", IO), ("ProcessMemory", ctypes.c_size_t), ("JobMemory", ctypes.c_size_t),
                        ("PeakProcessMemory", ctypes.c_size_t), ("PeakJobMemory", ctypes.c_size_t)]
        class Completion(ctypes.Structure):
            _fields_ = [("Key", ctypes.c_void_p), ("Port", w.HANDLE)]
        class Accounting(ctypes.Structure):
            _fields_ = [(name, ctypes.c_longlong) for name in ("User", "Kernel", "PeriodUser", "PeriodKernel")] + [
                (name, w.DWORD) for name in ("PageFaults", "TotalProcesses", "ActiveProcesses", "TerminatedProcesses")]
        self.Accounting = Accounting
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]; self.kernel.CreateJobObjectW.restype = w.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]; self.kernel.SetInformationJobObject.restype = w.BOOL
        self.kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]; self.kernel.AssignProcessToJobObject.restype = w.BOOL
        self.kernel.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]; self.kernel.TerminateJobObject.restype = w.BOOL
        self.kernel.CloseHandle.argtypes = [w.HANDLE]; self.kernel.CloseHandle.restype = w.BOOL
        self.kernel.CreateIoCompletionPort.argtypes = [w.HANDLE, w.HANDLE, ctypes.c_size_t, w.DWORD]
        self.kernel.CreateIoCompletionPort.restype = w.HANDLE
        self.kernel.GetQueuedCompletionStatus.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD), ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_void_p), w.DWORD]
        self.kernel.GetQueuedCompletionStatus.restype = w.BOOL
        self.kernel.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD)]
        self.kernel.QueryInformationJobObject.restype = w.BOOL
        self.handle = self.kernel.CreateJobObjectW(None, None)
        self.port = self.kernel.CreateIoCompletionPort(w.HANDLE(-1), None, 0, 1)
        self.memory_limit_seen = False
        info = Extended()
        info.Basic.Flags = 0x2000 | 0x200 | 0x8  # kill on parent close, job memory, process-count bound
        # Both a Windows venv redirector and a frozen onefile bootloader create
        # their one interpreter child. All descendants stay in this same job.
        info.Basic.ActiveProcesses = 2
        info.JobMemory = MAX_MEMORY
        if not self.handle or not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            self.close()
            raise RuntimeError("Scan process limits could not be established")
        completion = Completion(1, self.port)
        if not self.port or not self.kernel.SetInformationJobObject(self.handle, 7, ctypes.byref(completion), ctypes.sizeof(completion)):
            self.close()
            raise RuntimeError("Scan resource notifications could not be established")

    def assign_and_resume(self, child):
        from ctypes import wintypes as w
        if not self.kernel.AssignProcessToJobObject(self.handle, w.HANDLE(int(child._handle))):
            raise RuntimeError("The scan worker could not be placed in its private job")
        # Start suspended so a frozen bootloader cannot spawn an unowned child
        # before assignment. Resume only this Popen's already-held process handle.
        resume = ctypes.WinDLL("ntdll").NtResumeProcess
        resume.argtypes = [w.HANDLE]; resume.restype = ctypes.c_long
        if resume(w.HANDLE(int(child._handle))) != 0:
            raise RuntimeError("The isolated scan worker could not be resumed")

    def kill(self):
        if self.handle:
            self.kernel.TerminateJobObject(self.handle, 1)

    def resource_limited(self):
        # Documented Job Object notifications distinguish a memory limit from an
        # ordinary worker crash. Absence is not evidence of an empty scan.
        from ctypes import wintypes as w
        message, key, detail = w.DWORD(), ctypes.c_size_t(), ctypes.c_void_p()
        for _ in range(32):
            if not self.kernel.GetQueuedCompletionStatus(self.port, ctypes.byref(message), ctypes.byref(key), ctypes.byref(detail), 0):
                break
            if message.value in {9, 10}: self.memory_limit_seen = True
        return self.memory_limit_seen

    def active_count(self):
        info = self.Accounting()
        if not self.kernel.QueryInformationJobObject(self.handle, 1, ctypes.byref(info), ctypes.sizeof(info), None):
            raise RuntimeError("The private scan job's exit could not be confirmed")
        return info.ActiveProcesses

    def confirm_exit(self):
        # A redirector/bootloader exit alone does not prove its interpreter child
        # exited. Zero active processes in this private job is the admission gate.
        deadline = time.monotonic() + 2
        if self.active_count(): self.kill()
        while self.active_count():
            if time.monotonic() >= deadline:
                raise RuntimeError("The private scan job is still stopping")
            time.sleep(.01)

    def close(self):
        if getattr(self, "handle", None):
            self.kernel.CloseHandle(self.handle)
            self.handle = None
        if getattr(self, "port", None):
            self.kernel.CloseHandle(self.port)
            self.port = None


class PosixGroup:
    """Only the new session/process group created for this Popen is owned."""
    def __init__(self):
        self.pgid = None

    def assign_and_resume(self, child):
        # start_new_session=True establishes pgid==pid before executing the child.
        # It also contains a frozen onefile interpreter after its bootloader exits.
        self.pgid = child.pid

    def kill(self):
        if self.pgid is not None:
            try: os.killpg(self.pgid, getattr(signal, "SIGKILL", 9))
            except ProcessLookupError: pass

    def active_count(self):
        if self.pgid is None: return 0
        try:
            os.killpg(self.pgid, 0)
            return 1  # Presence only; never infer a process count from this probe.
        except ProcessLookupError:
            return 0

    def confirm_exit(self):
        deadline = time.monotonic() + 2
        if self.active_count(): self.kill()
        while self.active_count():
            if time.monotonic() >= deadline:
                raise RuntimeError("The owned scan process group is still stopping")
            time.sleep(.01)

    def resource_limited(self):
        return False

    def close(self):
        pass


def command():
    if getattr(sys, "frozen", False):
        return [sys.executable, "--tli-storage-worker"]
    return [sys.executable, "-I", "-B", str(Path(__file__).with_name("storage_scan_bootstrap.py"))]


def environment():
    allowed = {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
               "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA"}
    result = {k: v for k, v in os.environ.items() if k.upper() in allowed}
    if getattr(sys, "frozen", False):
        result["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    return result


class LaunchStopped(RuntimeError):
    """Launch failed with no surviving owned child."""


def launch():
    job = None
    child = None
    try:
        job = WindowsJob() if os.name == "nt" else PosixGroup()
        child = subprocess.Popen(command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 env=environment(), close_fds=True,
                                 **({"creationflags": subprocess.CREATE_NO_WINDOW | 0x4} if os.name == "nt" else {"start_new_session": True}))
        if job:
            job.assign_and_resume(child)
        return child, job
    except BaseException as error:
        try:
            if child is not None:
                if job: job.kill()
                child.kill()
                child.wait()
                if job: job.confirm_exit()
        finally:
            if job: job.close()
        if not isinstance(error, Exception): raise
        raise LaunchStopped("The isolated reader could not start") from error


def run(request, cancel, progress, authorized, *, grace=2.0, inventory=None):
    """Return only after this owned child exits. An unconfirmed stop keeps admission held."""
    payload = canonical(request) + b"\n"
    if len(payload) > MAX_REQUEST:
        raise ValueError("Scan request exceeds its byte limit")
    try:
        child, job = launch()
    except LaunchStopped:
        return {"type": "error", "error": {"code": "worker_start_failed", "status_code": 503,
                "message": "The isolated reader could not start. No files were changed."}, "worker_stopped": True}
    received = {"frame": None, "error": None, "bytes": 0, "inventory_bytes": 0, "inventory_rows": 0, "inventory_started": False}
    lock = threading.Lock()
    reader_done = threading.Event()
    started = time.monotonic()
    stopping_at = None
    stop_reason = None
    killed = False

    def read():
        try:
            while True:
                line = child.stdout.readline(MAX_RESULT + 2)
                if not line:
                    break
                if len(line) > MAX_RESULT + 1 or not line.endswith(b"\n"):
                    raise ValueError("Worker output exceeded a framing or byte limit")
                frame = json.loads(line)
                if not isinstance(frame, dict) or frame.get("type") not in {"progress", "result", "error", "cancelled", "inventory_start", "inventory_rows"}:
                    raise ValueError("Unsupported worker frame")
                with lock:
                    if received["frame"] is not None:
                        raise ValueError("Worker emitted data after its final frame")
                if frame["type"].startswith("inventory_"):
                    received["inventory_bytes"] += len(line)
                    if request.get("inventory_version") != 1 or len(line) > MAX_INVENTORY_FRAME or received["inventory_bytes"] > MAX_INVENTORY_WIRE:
                        raise ValueError("Inventory output exceeds its protocol limits")
                    if not authorized() or cancel.is_set():
                        raise ValueError("Inventory session ended")
                    if frame["type"] == "inventory_start":
                        root = frame.get("root")
                        if received["inventory_started"] or not isinstance(root, str) or not 0 < len(root) <= 4096 or "\x00" in root:
                            raise ValueError("Invalid inventory start")
                        received["inventory_started"] = True
                    else:
                        rows = frame.get("rows")
                        if not received["inventory_started"] or not isinstance(rows, list) or not 1 <= len(rows) <= 128 or any(not isinstance(row, dict) for row in rows):
                            raise ValueError("Invalid inventory batch")
                        received["inventory_rows"] += len(rows)
                        if received["inventory_rows"] > request["limits"]["max_entries"] + 1:
                            raise ValueError("Inventory row count exceeds acquisition limits")
                    # Backpressure bounds memory: one batch is indexed before
                    # reading the next. The child still has no write access.
                    if inventory is not None:
                        inventory(frame)
                    continue
                received["bytes"] += len(line)
                if received["bytes"] > MAX_RESULT + 2 * 1024 * 1024:
                    raise ValueError("Worker result exceeded its byte limit")
                if frame["type"] == "progress":
                    if len(line) > 4096 or not isinstance(frame.get("progress"), dict):
                        raise ValueError("Invalid progress frame")
                    clean = {k: v for k, v in frame["progress"].items() if k in {"phase", "entries_seen", "files", "found", "files_hashed", "records_examined", "records_total", "bytes_read"}}
                    if any(not (isinstance(v, str) and k == "phase" and len(v) <= 40 or type(v) is int and 0 <= v <= (2**63 - 1 if k in {"bytes_read", "records_examined", "records_total"} else 500_000)) for k, v in clean.items()):
                        raise ValueError("Invalid progress values")
                    progress(clean)
                else:
                    with lock:
                        received["frame"] = frame
        except BaseException as error:
            with lock:
                received["error"] = str(error)[:200]
        finally:
            reader_done.set()

    def write():
        try:
            child.stdin.write(payload); child.stdin.flush()
        except Exception:
            with lock:
                received["error"] = "Worker request pipe failed"

    reader = threading.Thread(target=read, name="storage-result-reader", daemon=True)
    writer = threading.Thread(target=write, name="storage-request-writer", daemon=True)
    try:
        reader.start(); writer.start()
        while child.poll() is None:
            now = time.monotonic()
            try:
                valid = authorized()
            except Exception:
                valid = False
            with lock:
                error = received["error"]
            reason = "revoked" if not valid else "resource_limit" if job and job.resource_limited() else "cancelled" if cancel.is_set() else "transport_error" if error else "deadline" if now - started > request["limits"]["max_seconds"] + 5 else None
            if reason and stopping_at is None:
                stopping_at, stop_reason = now, reason
                progress({"phase": "stopping"})
                # A short control write is off the supervisor thread too: a stuck
                # child must not block cancellation on a full stdin pipe.
                def send_cancel():
                    try: child.stdin.write(b"cancel\n"); child.stdin.flush()
                    except Exception: pass
                threading.Thread(target=send_cancel, name="storage-cancel-writer", daemon=True).start()
            if stopping_at is not None and now - stopping_at >= grace and not killed:
                if job: job.kill()
                else: child.kill()
                killed = True
            time.sleep(.05)
        child.wait()
        # The final batch may still be in the parent's bounded index writer
        # after the child has exited. Keep admission/ownership until that
        # callback has finished; closing pipes or aborting its database beneath
        # it would race publication. Index callbacks check cancellation during
        # SQLite work. A blocked host disk remains visibly stopping, never a
        # falsely completed reader that admits another intensive scan.
        while not reader_done.wait(.05):
            try:
                valid = authorized()
            except Exception:
                valid = False
            reason = "revoked" if not valid else "cancelled" if cancel.is_set() else "deadline" if time.monotonic() - started > request["limits"]["max_seconds"] + 5 else None
            if reason:
                if stop_reason is None:
                    stop_reason = reason
                    progress({"phase": "stopping"})
                cancel.set()
        reader.join()
        with lock:
            frame, error = received["frame"], received["error"]
        if not reader_done.is_set():
            error = "Worker output did not close after exit"
        if job and job.resource_limited() and stop_reason != "revoked":
            stop_reason = "resource_limit"
        try:
            valid = authorized()
        except Exception:
            valid = False
        if not valid:
            stop_reason = "revoked"
        if stop_reason == "cancelled" and not killed and not error and not child.returncode and frame and frame.get("type") == "result" and isinstance(frame.get("result"), dict):
            frame["result"].setdefault("meta", {}).update(partial=True, cancelled=True)
            return {**frame, "worker_stopped": True}
        if stop_reason:
            return {"type": "cancelled" if stop_reason in {"cancelled", "revoked"} else "error",
                    "error": {"code": stop_reason, "status_code": 422, "message": "The isolated scan stopped. No files were changed."},
                    "worker_stopped": True}
        if error or child.returncode or frame is None:
            resource = (child.returncode or 0) & 0xffffffff in {0xc0000017, 0xc0000044, 0xc000009a, 0xc000012d}
            return {"type": "error", "error": {"code": "resource_limit" if resource else "worker_failed", "status_code": 422,
                    "message": "The isolated reader exceeded a memory or resource limit. No files were changed." if resource else "The isolated scan did not return a complete supported result. No files were changed."}, "worker_stopped": True}
        return {**frame, "worker_stopped": True}
    except Exception:
        if child.poll() is None:
            if job: job.kill()
            else: child.kill()
        child.wait()
        return {"type": "error", "error": {"code": "worker_transport_failed", "status_code": 503,
                "message": "The isolated reader stopped after a transport failure. No files were changed."}, "worker_stopped": True}
    finally:
        # Even caller interruption cannot release ownership while the child runs.
        try:
            if child.poll() is None:
                if job: job.kill()
                else: child.kill()
                child.wait()
            if job: job.confirm_exit()
        finally:
            if job: job.close()
            for stream in (child.stdin, child.stdout):
                try: stream.close()
                except Exception: pass
