"""Bounded Windows inference-runtime checks; never install or change software."""
from contextlib import contextmanager
from pathlib import Path
import os
import subprocess
import sys
import threading

from process_utils import hidden_process_kwargs


WINDOWS_RUNTIME_REPAIR = (
    "Windows may need the Microsoft Visual C++ v14 Redistributable (x64). "
    "This check does not establish which dependency is missing. Microsoft's official repair information:\n"
    "https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist/\n\n"
    "After repair, reopen TLI or retry model activation. If it still fails, extract the complete "
    "release into a new folder.\n\n"
    "Your TLI workspace can open while local AI is unavailable. This diagnostic check does not install software."
)


class RuntimeUnavailable(RuntimeError):
    """The optional, prepared inference binary failed its loader/version check."""


def _failure(evidence):
    return RuntimeUnavailable("The packaged local AI runtime could not start.\n\n" + evidence + "\n\n" + WINDOWS_RUNTIME_REPAIR)


_ERROR_MODE_LOCK = threading.RLock()


@contextmanager
def suppress_runtime_dialogs():
    """Suppress native loader/crash dialogs inherited by background AI children."""
    if os.name != "nt":
        yield
        return
    import ctypes
    with _ERROR_MODE_LOCK:
        previous = ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)
        try:
            yield
        finally:
            ctypes.windll.kernel32.SetErrorMode(previous)


def check_windows_runtime(path):
    """Probe only the supplied prepared binary, without loading model weights."""
    path = Path(path)
    if sys.platform != "win32" or not path.exists():
        return
    try:
        with suppress_runtime_dialogs():
            result = subprocess.run(
                [str(path), "--version"], cwd=str(path.parent), stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False,
                **hidden_process_kwargs(),
            )
        if result.returncode != 0:
            code = int(result.returncode)
            raise _failure(f"The runtime version check exited with code {code} (0x{code & 0xffffffff:08X}).")
    except subprocess.TimeoutExpired as error:
        raise _failure("The runtime version check did not finish within 5 seconds.") from error
    except OSError as error:
        detail = str(error).replace("\r", " ").replace("\n", " ").strip()[:320]
        raise _failure("Windows could not launch the runtime: " + (detail or "operating-system launch error") + ".") from error
