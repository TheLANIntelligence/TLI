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


def _emit(stream: TextIO, event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), file=stream, flush=True)


def main(argv: Sequence[str] | None = None) -> int:
    """Fixed local commands; lifecycle actions require a fresh generation review."""
    protocol = sys.stdout
    reconfigure = getattr(protocol, "reconfigure", None)
    if reconfigure is not None:
        reconfigure(encoding="utf-8", errors="replace", newline="\n", line_buffering=True)

    arguments = list(sys.argv[1:] if argv is None else argv)
    action = 'launch'
    token = None
    if arguments == ['--status']:
        action = 'status'
    elif len(arguments) == 2 and arguments[0] in {'--stop', '--restart'} and L.H.HEX.fullmatch(arguments[1]):
        action, token = arguments[0][2:], arguments[1]
    elif arguments:
        _emit(protocol, "error", message="Choose a supported local TLI action with a current review. Installation overrides are not accepted.")
        return 1

    # Bind to this code installation even if the caller inherited TLI_ROOT.
    root = Path(__file__).resolve().parent.parent
    def emit_state():
        with redirect_stdout(sys.stderr):
            state = L.desktop_status(root)
        if state is not None:
            _emit(protocol, 'state', **state)
        return state

    try:
        # Keep incidental diagnostics out of the machine-readable protocol.
        with redirect_stdout(sys.stderr):
            if action == 'status':
                emit_state()
                return 0
            if action in {'stop', 'restart'}:
                result = L.desktop_action(root, action, token,
                    progress=lambda message: _emit(protocol, 'progress', message=message))
                emit_state()
                if action == 'stop':
                    return 0
            else:
                if not L.dependencies_ready(root):
                    state = emit_state()
                    if state and state['state'] != 'stopped':
                        _emit(protocol, 'error', message='TLI needs updated components. Stop TLI here first, then open it again to prepare them.')
                        return 1
                    _emit(protocol, "setup_required", message="TLI needs first-time setup before it can open.")
                    return 2
                result = L.launch(
                    root,
                    open_browser=False,
                    progress=lambda message: _emit(protocol, "progress", message=message),
                )
                emit_state()
        # The URL comes from the same settings snapshot that was verified by
        # launch(), not a second read that could race a settings change.
        if result.get("backend_state") != "running" or not result.get("url"):
            raise RuntimeError("TLI did not confirm an address that is ready to open.")
        if result.get("runtime_warning"):
            _emit(protocol, "warning", code="local_ai_unavailable", message=result["runtime_warning"])
        _emit(protocol, "ready", url=result["url"])
        return 0
    except Exception as error:
        emit_state()
        _emit(protocol, "error", message=str(getattr(error, "detail", error)))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
