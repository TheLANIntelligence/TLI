"""Host-wide Narrator preferences; reading never creates or repairs a file."""
import json
import os
from pathlib import Path
import threading
import uuid

from fastapi import HTTPException
import tli_state as S

LOCK = threading.RLock()
MODES = {"quiet", "balanced", "detailed"}


def _path():
    return Path(S.DATA_DIR) / "narrator-settings.json"


def read():
    with LOCK:
        try:
            with _path().open("rb") as handle:
                raw = handle.read(4097)
        except FileNotFoundError:
            return {"mode": "balanced"}
        except OSError as exc:
            raise HTTPException(503, "Narrator preferences could not be read. Existing settings were preserved.") from exc
        try:
            data = json.loads(raw) if len(raw) <= 4096 else None
            if not isinstance(data, dict) or data.get("version") != 1 or data.get("mode") not in MODES:
                raise ValueError("Invalid preferences")
        except (ValueError, TypeError) as exc:
            raise HTTPException(503, "Saved Narrator preferences are unavailable. Preserve the existing file and use Data & Recovery guidance.") from exc
        return {"mode": data["mode"]}


def save(mode):
    with LOCK:
        read()  # Never replace malformed/unreadable existing configuration.
        if mode not in MODES:
            raise HTTPException(422, "Choose Quiet, Balanced or Detailed.")
        path = _path()
        temp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with temp.open("x", encoding="utf-8") as handle:
                json.dump({"version": 1, "mode": mode}, handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, path)
        except OSError as exc:
            raise HTTPException(503, "Narrator preferences were not saved. The previous mode remains active.") from exc
        finally:
            try:
                temp.unlink(missing_ok=True)
            except OSError:
                pass
        return {"mode": mode}
