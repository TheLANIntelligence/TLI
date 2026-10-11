"""Launch options for background commands whose output belongs in TLI's UI."""
from __future__ import annotations

import subprocess
import sys


def hidden_process_kwargs() -> dict[str, int]:
    """Prevent a new Windows console, including under pythonw/frozen hosts.

    Capturing stdout/stderr alone does not suppress console creation. This flag
    leaves capture, timeouts and exit codes to each caller and is deliberately
    absent on other platforms. It does not hide an explicitly opened GUI app.
    """
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}
