"""Bounded, preservation-first JSON stores for the single HomePower runtime."""
from __future__ import annotations

import copy
import json
import math
import os
from pathlib import Path
import tempfile

from fastapi import HTTPException

MAX_BYTES = 1024 * 1024
MAX_ROWS = 1000


class HomePowerStateUnavailable(HTTPException):
    def __init__(self, area: str):
        super().__init__(503, f"Saved HomePower {area} is unavailable or a save could not be confirmed. "
                         "Existing files were not reset. Stop TLI, preserve the files and restore a matching backup "
                         "before restarting. Do not repeat an uncertain device action.")


def _object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate field")
        value[key] = item
    return value


def _finite(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Nonfinite number")
    return number


def _invalid_constant(value):
    raise ValueError("Nonfinite number")


class Store:
    """Caller holds the runtime RLock across each read/modify/write transaction.

    No migration or repair is implicit. Unknown fields are retained by callers.
    External edits and recovery require a stopped host; this is not a concurrent
    multi-process repository or a revision protocol for external editors.
    A previously observed file disappearing is not a fresh empty installation.
    """

    def __init__(self, path: Path, area: str, default, validate):
        self.path = path
        self.area = area
        self.default = default
        self.validate = validate
        self._seen = False

    def _bytes(self):
        try:
            with self.path.open("rb") as stream:
                raw = stream.read(MAX_BYTES + 1)
            self._seen = True
            if len(raw) > MAX_BYTES:
                raise ValueError("Oversized saved state")
            return raw
        except FileNotFoundError:
            if self._seen or self.path.is_symlink():
                raise HomePowerStateUnavailable(self.area)
            return None
        except (OSError, ValueError) as exc:
            raise HomePowerStateUnavailable(self.area) from exc

    def _decode(self, raw):
        try:
            value = copy.deepcopy(self.default) if raw is None else json.loads(
                raw.decode("utf-8"), object_pairs_hook=_object,
                parse_float=_finite, parse_constant=_invalid_constant,
            )
            self.validate(value)
            return value
        except (ValueError, TypeError, KeyError, OverflowError, RecursionError) as exc:
            raise HomePowerStateUnavailable(self.area) from exc

    def read(self):
        return self._decode(self._bytes())

    def write(self, value, *, check=None):
        def access():
            if check is not None:
                check()
        temporary = None
        try:
            access()
            original = self._bytes()
            self._decode(original)  # Refuse a write over damaged existing contents.
            access()
            self.validate(value)
            raw = json.dumps(value, indent=2, allow_nan=False).encode("utf-8")
            if len(raw) > MAX_BYTES:
                raise ValueError("Oversized saved state")
            access()
            self.path.parent.mkdir(parents=True, exist_ok=True)
            access()
            with tempfile.NamedTemporaryFile(mode="wb", dir=self.path.parent,
                                             prefix=".tli-homepower-", suffix=".tmp", delete=False) as stream:
                temporary = Path(stream.name)
                access()
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            # Detect changed or damaged files during preparation. This is not
            # an inter-process lock; one host process owns these stores.
            current = self._bytes()
            self._decode(current)
            if current != original:
                raise ValueError("Saved state changed during preparation")
            access()
            os.replace(temporary, self.path)
            temporary = None
            self._seen = True
            access()
        except HTTPException:
            access()
            raise
        except (OSError, ValueError, TypeError, KeyError, OverflowError, RecursionError) as exc:
            access()
            raise HomePowerStateUnavailable(self.area) from exc
        finally:
            if temporary is not None:
                try:
                    temporary.unlink()
                except OSError:
                    pass
