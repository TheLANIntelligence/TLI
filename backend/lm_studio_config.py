"""Bounded, preserved LM Studio endpoint settings; no discovery or network calls."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import stat
import tempfile
import threading
from urllib.parse import urlsplit

DEFAULTS = {"chat_url": "http://localhost:1234/v1/chat/completions",
            "models_url": "http://localhost:1234/v1/models"}
MAX_BYTES = 16 * 1024
LOCK = threading.RLock()


class InvalidEndpoint(ValueError):
    pass


class ConfigurationUnavailable(RuntimeError):
    pass


def _access(check):
    if check is not None:
        try:
            check()
        except Exception as error:
            # Keep the original authority failure across broad storage-error
            # handlers without importing the host's HTTP stack into this module.
            error.lm_studio_authority_failure = True
            raise


def _endpoint(value):
    try:
        if (not isinstance(value, str) or not value or len(value) > 4096
                or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value) or "\\" in value):
            raise ValueError()
        if len(value.encode("utf-8")) > 4096:
            raise ValueError()
        parsed = urlsplit(value)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment or "?" in value or "#" in value
                or parsed.port is not None and not 1 <= parsed.port <= 65535):
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        raise InvalidEndpoint("Use an HTTP or HTTPS LM Studio address without credentials, query parameters or fragments.") from None
    return value


def validate(value):
    if not isinstance(value, dict) or not all(key in value for key in DEFAULTS):
        raise InvalidEndpoint("LM Studio settings must include both chat_url and models_url.")
    return {key: _endpoint(value[key]) for key in DEFAULTS}


def from_url(value):
    """Accept a server/base address, /v1, or an explicit chat endpoint."""
    if not isinstance(value, str):
        raise InvalidEndpoint("Use an HTTP or HTTPS LM Studio address.")
    value = _endpoint(value.strip().rstrip("/"))
    if value.endswith("/chat/completions"):
        chat = value
    elif value.endswith("/v1"):
        chat = value + "/chat/completions"
    elif "/v1/" not in urlsplit(value).path:
        chat = value + "/v1/chat/completions"
    else:
        raise InvalidEndpoint("Use the server address, its /v1 base, or its /chat/completions endpoint.")
    return validate({"chat_url": chat, "models_url": chat[:-len("/chat/completions")] + "/models"})


def config_path(data_dir):
    return Path(data_dir) / "lm_studio_config.json"


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate configuration field")
        value[key] = item
    return value


def _finite_float(value):
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("Invalid number")
    return parsed


def _read_snapshot(data_dir, *, check=None):
    _access(check)
    try:
        path = config_path(data_dir)
        try:
            info = path.lstat()
        except FileNotFoundError:
            _access(check)
            return dict(DEFAULTS), None
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("A regular settings file is required")
        _access(check)
        with path.open("rb") as stream:
            _access(check)
            raw = stream.read(MAX_BYTES + 1)
        _access(check)
        if len(raw) > MAX_BYTES:
            raise ValueError("Oversized configuration")
        value = json.loads(raw, object_pairs_hook=_unique, parse_float=_finite_float,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid number")))
        validate(value)
        _access(check)
        return value, raw
    except Exception as error:
        if getattr(error, "lm_studio_authority_failure", False):
            raise
        _access(check)
        raise ConfigurationUnavailable(
            "Saved LM Studio settings could not be read. The existing file was preserved; "
            "no default endpoint was substituted. Restore or correct lm_studio_config.json before continuing."
        ) from error


def read(data_dir, *, check=None):
    _access(check)
    with LOCK:
        _access(check)
        try:
            result = validate(_read_snapshot(data_dir, check=check)[0])
        except Exception:
            _access(check)
            raise
        _access(check)
        return result


def write(data_dir, value, *, check=None, on_commit=None):
    """Validate old bytes first, then flush and atomically replace the file."""
    _access(check)
    try:
        value = validate(value)
    except Exception:
        _access(check)
        raise
    _access(check)
    path = config_path(data_dir)
    temporary = None
    with LOCK:
        _access(check)
        document, original = _read_snapshot(data_dir, check=check)
        document.update(value)  # Preserve compatible metadata from older settings.
        try:
            raw = json.dumps(document, indent=2, allow_nan=False)
            if len(raw.encode("utf-8")) > MAX_BYTES:
                raise ValueError("Oversized configuration")
            _access(check)
            path.parent.mkdir(parents=True, exist_ok=True)
            _access(check)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                             prefix=".lm-studio-", suffix=".tmp", delete=False) as stream:
                temporary = Path(stream.name)
                _access(check)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            _access(check)
            # The lock serializes this process; preserve external edits or
            # damage observed while preparing the replacement as well.
            _, current = _read_snapshot(data_dir, check=check)
            if current != original:
                raise ConfigurationUnavailable("Saved LM Studio settings changed during this request.")
            _access(check)
            os.replace(temporary, path)
            temporary = None
            # Confirmed disk state must match provider/global state even if the
            # requesting browser lost authority during replacement.
            if on_commit is not None:
                on_commit()
            _access(check)
        except Exception as error:
            if getattr(error, "lm_studio_authority_failure", False):
                raise
            _access(check)
            raise ConfigurationUnavailable(
                "The LM Studio settings save was not confirmed. No default endpoint was substituted. "
                "Check the saved configuration before retrying."
            ) from error
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
    return value
