"""Saved startup choices, readable by launchers before importing the application."""
from __future__ import annotations

import ipaddress
import json
import os
import sys
import tempfile
import threading
from pathlib import Path

DEFAULTS = {"host": "127.0.0.1", "port": 8000, "https": False}
SAVED_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}
LOCK = threading.RLock()


class StartupConfigurationError(ValueError):
    pass


def installation_root() -> Path:
    override = os.environ.get("TLI_ROOT")
    if override and Path(override).is_dir():
        return Path(override).resolve()
    return Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent.parent


def config_path(root=None) -> Path:
    return Path(root or installation_root()) / "data" / "startup.json"


def local_only(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def validate(value, *, saved=False):
    if not isinstance(value, dict) or set(value) != set(DEFAULTS):
        raise StartupConfigurationError("Startup settings must include host, port and HTTPS mode.")
    host, port, https = value["host"], value["port"], value["https"]
    if not isinstance(host, str) or not host or (saved and host not in SAVED_HOSTS):
        raise StartupConfigurationError("Choose this computer only or secure LAN access.")
    try:
        if host != "localhost":
            ipaddress.ip_address(host)
    except ValueError as error:
        raise StartupConfigurationError("TLI_HOST must be localhost or an IP address.") from error
    if type(port) is not int or not 1 <= port <= 65535 or type(https) is not bool:
        raise StartupConfigurationError("Use a port from 1 to 65535 and an explicit HTTPS setting.")
    if saved and not local_only(host) and not https:
        raise StartupConfigurationError("Saved LAN access requires HTTPS. Choose secure LAN access or this computer only.")
    return dict(value)


def read(root=None):
    """Return defaults only when no settings file exists; never repair a file."""
    try:
        with config_path(root).open("rb") as stream:
            raw = stream.read(16385)
        if len(raw) > 16384:
            raise ValueError("Oversized configuration")
        envelope = json.loads(raw)
        if not isinstance(envelope, dict) or envelope.get("version") != 1 or set(envelope) != {"version", *DEFAULTS}:
            raise ValueError("Invalid configuration")
        return validate({key: envelope[key] for key in DEFAULTS}, saved=True), True
    except FileNotFoundError:
        return dict(DEFAULTS), False
    except Exception as error:
        raise StartupConfigurationError(
            "Saved startup settings could not be read. The original file was preserved. "
            "Restore its matching backup before restarting; default settings were not substituted."
        ) from error


def resolve(root=None, environ=None, *, candidate=None):
    saved, configured = read(root)
    if candidate is not None:
        saved, configured = validate(candidate, saved=True), True
    env = os.environ if environ is None else environ
    effective, overrides = dict(saved), []
    if "TLI_LAN_MODE" in env:
        if env["TLI_LAN_MODE"] not in {"0", "1"}:
            raise StartupConfigurationError("TLI_LAN_MODE must be 0 or 1.")
        effective["host"] = "0.0.0.0" if env["TLI_LAN_MODE"] == "1" else "127.0.0.1"
        overrides.append("TLI_LAN_MODE")
    if "TLI_HOST" in env:
        effective["host"] = env["TLI_HOST"]
        overrides.append("TLI_HOST")
    if "TLI_PORT" in env:
        try:
            effective["port"] = int(env["TLI_PORT"])
        except (TypeError, ValueError) as error:
            raise StartupConfigurationError("TLI_PORT must be an integer from 1 to 65535.") from error
        overrides.append("TLI_PORT")
    if "TLI_ENABLE_TLS" in env:
        flag = env["TLI_ENABLE_TLS"].strip().lower()
        if flag not in {"0", "1", "false", "true", "no", "yes", ""}:
            raise StartupConfigurationError("TLI_ENABLE_TLS must be 0/1, false/true or no/yes.")
        effective["https"] = flag in {"1", "true", "yes"}
        overrides.append("TLI_ENABLE_TLS")
    validate(effective)
    if configured and not local_only(effective["host"]) and not effective["https"]:
        raise StartupConfigurationError("Environment overrides would start saved LAN access without HTTPS. Correct the overrides before restarting; HTTP was not started.")
    return {"saved": saved, "configured": configured, "effective_next": effective, "environment_overrides": overrides}


def write(value, root=None):
    value = validate(value, saved=True)
    path = config_path(root)
    with LOCK:
        read(root)  # an explicit save does not authorize replacing unreadable state
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".startup-", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump({"version": 1, **value}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def create_if_absent(value, root=None):
    """Publish a first-launch choice without replacing concurrent saved settings.

    A failed write retains its file for review; a later read must not substitute
    defaults for partially written settings. No existing file is removed.
    """
    value = validate(value, saved=True)
    path = config_path(root)
    with LOCK:
        if read(root)[1]:
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            stream = path.open("x", encoding="utf-8")
        except FileExistsError:
            return False
        with stream:
            json.dump({"version": 1, **value}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        return True


def browser_url(settings):
    host = settings["host"]
    host = "localhost" if host in {"0.0.0.0", "::"} else host
    if ":" in host:
        host = f"[{host}]"
    return f"{'https' if settings['https'] else 'http'}://{host}:{settings['port']}"
