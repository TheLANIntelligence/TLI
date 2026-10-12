"""Fixed-installation worker for the native TLI desktop launcher.

Stdout is a UTF-8 JSON-lines protocol. The desktop UI owns browser opening and
failure presentation; backend ownership, startup and readiness remain in
``host_launcher``.
"""
from __future__ import annotations

from contextlib import redirect_stdout
import json
from pathlib import Path
import sys
from typing import Sequence, TextIO

import host_launcher as L


def _emit(stream: TextIO, event: str, **fields: str) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), file=stream, flush=True)


def main(argv: Sequence[str] | None = None) -> int:
    """Report progress without adding setup, shell or process-control authority."""
    protocol = sys.stdout
    reconfigure = getattr(protocol, "reconfigure", None)
    if reconfigure is not None:
        reconfigure(encoding="utf-8", errors="replace", newline="\n", line_buffering=True)

    if list(sys.argv[1:] if argv is None else argv):
        _emit(protocol, "error", message="The TLI desktop launcher does not accept command-line arguments.")
        return 1

    # Bind to this code installation even if the caller inherited TLI_ROOT.
    root = Path(__file__).resolve().parent.parent
    try:
        # Keep incidental diagnostics out of the machine-readable protocol.
        with redirect_stdout(sys.stderr):
            if not L.dependencies_ready(root):
                _emit(protocol, "setup_required", message="TLI needs first-time setup before it can open.")
                return 2
            result = L.launch(
                root,
                open_browser=False,
                progress=lambda message: _emit(protocol, "progress", message=message),
            )
        # The URL comes from the same settings snapshot that was verified by
        # launch(), not a second read that could race a settings change.
        if result.get("backend_state") != "running" or not result.get("url"):
            raise RuntimeError("TLI did not confirm an address that is ready to open.")
        if result.get("runtime_warning"):
            _emit(protocol, "warning", code="local_ai_unavailable", message=result["runtime_warning"])
        _emit(protocol, "ready", url=result["url"])
        return 0
    except Exception as error:
        _emit(protocol, "error", message=str(getattr(error, "detail", error)))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
