"""Prepare verified desktop updates without replacing running application code.

The package's local updater installs after TLI is closed. Current version always
describes this process, never a staged download.
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid

import certifi

import tli_state as S
from process_utils import hidden_process_kwargs

DEFAULT_UPDATE_URL = "https://thelanintelligence.com/downloads.json"
MANUAL_URL = "https://github.com/TheLANIntelligence/TLI/releases"
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
AUTO_CHECK_INTERVAL = 6 * 60 * 60
AUTO_START_DELAY = 5
_SETTINGS_FILE = Path(S.DATA_DIR) / "update_settings.json"


class UpdateState(str, Enum):
    IDLE = "idle"
    CHECKING = "checking"
    AVAILABLE = "available"
    DOWNLOADING = "downloading"
    VERIFYING = "verifying"
    PREPARING = "preparing"
    READY = "ready"
    UP_TO_DATE = "up_to_date"
    ERROR = "error"


_BUSY = {UpdateState.CHECKING, UpdateState.DOWNLOADING, UpdateState.VERIFYING, UpdateState.PREPARING}
_lock = threading.RLock()
_state = UpdateState.IDLE
_info: dict = {}
_error = ""
_progress = 0
_checked_at = None
_ready_path = ""
_checking = False
_last_attempt = None
_last_check_error = ""
_settings_revision = 0
_auto_thread = None
_auto_stop = threading.Event()
_auto_wake = threading.Event()


def _platform_name():
    return {"win32": "windows", "darwin": "macos"}.get(sys.platform, "linux")


def _https_url(value):
    if not isinstance(value, str) or len(value) > 4096 or any(ord(c) < 33 for c in value):
        raise ValueError("Use a valid HTTPS release URL.")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("Update sources and downloads must use HTTPS without credentials or fragments.")
    return value


def _load_settings():
    defaults = {"update_url": DEFAULT_UPDATE_URL, "auto_check": True}
    try:
        saved = json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
        if isinstance(saved, dict):
            if isinstance(saved.get("update_url"), str):
                defaults["update_url"] = saved["update_url"]
            if type(saved.get("auto_check")) is bool:
                defaults["auto_check"] = saved["auto_check"]
    except (OSError, ValueError):
        pass
    if defaults["update_url"].rstrip("/") == "https://thelanintelligence.com/latest.json":
        defaults["update_url"] = DEFAULT_UPDATE_URL
    return defaults


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def save_settings(update_url: str, auto_check: bool = True):
    global _settings_revision, _last_attempt
    if update_url:
        _https_url(update_url)
    with _lock:
        previous = _load_settings()
        _write_json(_SETTINGS_FILE, {"update_url": update_url, "auto_check": auto_check})
        if previous != _load_settings():
            _settings_revision += 1
            _last_attempt = None
            _auto_wake.set()


def _parse_ver(value):
    match = re.fullmatch(r"v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?", str(value))
    if not match:
        raise ValueError("The release source has an invalid version.")
    major, minor, patch, prerelease = match.groups()
    parts = re.findall(r"\d+|[A-Za-z-]+", prerelease) if prerelease else []
    suffix = tuple((0, int(p)) if p.isdigit() else (1, p.lower()) for p in parts) if parts else ((2, ""),)
    return int(major), int(minor), int(patch or 0), suffix


def _is_newer(remote, local):
    return _parse_ver(remote) > _parse_ver(local)


def _updates_dir():
    root = Path(S.BASE_DIR).resolve()
    updates = Path(S.DATA_DIR).absolute() / "updates"
    if not updates.is_relative_to(root):
        raise ValueError("The update staging folder must be inside this TLI installation.")
    for path in (updates, *updates.parents):
        if path == root:
            break
        if path.exists() and (path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)):
            raise ValueError("The update staging folder cannot use linked directories.")
    return updates


def _restore_prepared():
    global _state, _info, _ready_path
    if _state != UpdateState.IDLE:
        return
    try:
        updates = _updates_dir()
        receipt_path = updates / "prepared.json"
        if receipt_path.stat().st_size > 256 * 1024:
            return
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if not _is_newer(receipt["version"], S.TLI_VERSION):
            return
        folder = receipt["folder"]
        if not re.fullmatch(r"job-[a-f0-9]{32}", folder):
            return
        package = updates / folder / "package"
        if package.resolve() != package or not (package / "TLI_RELEASE.json").is_file():
            return
        _info = {"version": receipt["version"], "notes": receipt.get("notes", ""), "can_prepare": True}
        _ready_path = str(package)
        _state = UpdateState.READY
    except (OSError, ValueError, KeyError, TypeError):
        pass


def get_status():
    global _state, _error, _ready_path
    with _lock:
        _restore_prepared()
        if _state == UpdateState.READY:
            try:
                package = Path(_ready_path)
                valid = (package.resolve() == package and package.parent.parent == _updates_dir()
                         and (package / "TLI_RELEASE.json").is_file())
            except (OSError, ValueError):
                valid = False
            if not valid:
                _state, _ready_path = UpdateState.ERROR, ""
                _error = "The prepared update folder is no longer available. Check for updates to download it again."
        message = _info.get("message", "")
        if _state == UpdateState.READY:
            launcher = "TLI_Update.bat" if _platform_name() == "windows" else "TLI_Update.command" if _platform_name() == "macos" else "TLI_Update.sh"
            message = f"Download verified. Open the update folder, quit TLI, then run {launcher}. Review your existing TLI folder and confirm installation. Open TLI normally afterward."
        return {
            "state": _state.value, "current_version": S.TLI_VERSION,
            "latest_version": _info.get("version"), "notes": _info.get("notes"),
            "released": _info.get("released"), "frontend_only": False,
            "progress": _progress, "error": _error, "checked_at": _checked_at,
            "last_check_error": _last_check_error,
            "platform": _platform_name(), "update_method": "guided",
            "can_prepare": bool(_info.get("can_prepare")),
            "can_open": _state == UpdateState.READY and bool(_ready_path),
            "ready_path": _ready_path, "message": message, "manual_url": MANUAL_URL,
            **_load_settings(),
        }


def _manifest_info(manifest):
    if not isinstance(manifest, dict):
        raise ValueError("The release source did not return a release object.")
    version = manifest.get("version")
    _parse_ver(version)
    platform = _platform_name()
    packages = manifest.get("platforms")
    package = packages.get(platform) if isinstance(packages, dict) else manifest
    result = {"version": version, "notes": str(manifest.get("notes", ""))[:32000],
              "released": manifest.get("release_date", manifest.get("released")), "can_prepare": False}
    if not isinstance(package, dict):
        result["message"] = "No update package is published for this computer. See the download page for supported installations."
        return result
    if getattr(sys, "frozen", False):
        result["message"] = "This installation uses a legacy native backend. Download a current package and follow its setup and update instructions."
        return result
    if package.get("updater", manifest.get("updater")) != "guided-v1" or manifest.get("frontend_only") is True:
        result["message"] = "This release needs a manual download. Use an updater-equipped release to keep your existing TLI folder and saved data."
        return result
    url = _https_url(package.get("url", package.get("download_url")))
    digest = package.get("sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", digest):
        raise ValueError("This update has no valid SHA-256 checksum. No files were downloaded or changed.")
    result.update(download_url=url, sha256=digest.lower(), can_prepare=True)
    return result


def _https_context():
    # urllib does not use requests' bundled CAs. Some Python installations have
    # only a partial system trust store, so include Mozilla's roots as well.
    # Keep platform/administrator roots, hostname checks and strict TLS defaults.
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())
    return context


def _open_url(url, timeout):
    class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            _https_url(newurl)
            return super().redirect_request(req, fp, code, msg, headers, newurl)
    _https_url(url)
    request = urllib.request.Request(url, headers={"User-Agent": f"TLI/{S.TLI_VERSION}", "Cache-Control": "no-cache"})
    return urllib.request.build_opener(
        HTTPSRedirect(), urllib.request.HTTPSHandler(context=_https_context()),
    ).open(request, timeout=timeout)


def _failure_message(prefix, error):
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, ssl.SSLCertVerificationError):
        detail = getattr(reason, "verify_message", None) or str(reason)
        return (f"{prefix}: TLI could not verify the update server's HTTPS certificate ({detail}). "
                "Check this computer's date and time. Use Download from releases to get the release "
                "in your browser, then follow its TLI_Update instructions. "
                "No application files were changed.")
    return f"{prefix}: {error}"


def check(update_url=None, *, automatic=False):
    global _state, _info, _error, _progress, _checked_at
    global _checking, _last_attempt, _last_check_error
    with _lock:
        _restore_prepared()
        if _checking or _state in _BUSY or _state == UpdateState.READY:
            return get_status()
        settings = _load_settings()
        if automatic and (not settings["auto_check"] or not settings["update_url"]):
            return get_status()
        url = update_url if update_url is not None else settings["update_url"]
        generation = _settings_revision
        previous = (_state, _info, _error, _progress)
        _checking, _last_attempt = True, time.monotonic()
        if not automatic:
            _state, _error, _progress, _info = UpdateState.CHECKING, "", 0, {}
    info, failure = None, ""
    try:
        if not url:
            raise ValueError("No update URL configured. Restore the release source in Settings → Software Updates.")
        with _open_url(url, 15) as response:
            raw = response.read(MAX_MANIFEST_BYTES + 1)
        if len(raw) > MAX_MANIFEST_BYTES:
            raise ValueError("The release source returned too much data.")
        info = _manifest_info(json.loads(raw.decode("utf-8")))
    except Exception as error:
        failure = _failure_message("Could not check for updates", error)
    finally:
        with _lock:
            _checking = False
            # A changed preference or an explicitly started download wins over
            # an older background response. Never replace its selected manifest.
            if generation != _settings_revision:
                if not automatic and _state == UpdateState.CHECKING:
                    _state, _info, _error, _progress = previous
                _auto_wake.set()
            elif _state not in {UpdateState.DOWNLOADING, UpdateState.VERIFYING, UpdateState.PREPARING, UpdateState.READY}:
                _checked_at = datetime.now(timezone.utc).isoformat()
                _last_check_error = failure
                if failure:
                    if not automatic:
                        _state, _error = UpdateState.ERROR, failure
                else:
                    _info, _error, _progress = info, "", 0
                    _state = UpdateState.AVAILABLE if _is_newer(info["version"], S.TLI_VERSION) else UpdateState.UP_TO_DATE
    return get_status()


def apply(*, check=None):
    """Prepare a package. This never changes installed code or stops the host."""
    global _state, _progress, _error
    if check: check()
    with _lock:
        if check: check()
        if _state != UpdateState.AVAILABLE or not _info.get("can_prepare"):
            return False
        manifest = dict(_info)
        _state, _progress, _error = UpdateState.DOWNLOADING, 0, ""
    try:
        if check: check()
        threading.Thread(target=_apply_pipeline, args=(manifest,), kwargs={"check": check}, daemon=True).start()
    except Exception as error:
        with _lock:
            _state, _error = UpdateState.ERROR, f"Could not start the download: {error}"
        return False
    return True


def _apply_pipeline(manifest, *, check=None):
    global _state, _progress, _error, _ready_path
    job = None
    try:
        if check: check()
        import update_install
        updates = _updates_dir()
        if check: check()
        updates.mkdir(parents=True, exist_ok=True)
        job = updates / ("job-" + uuid.uuid4().hex)
        job.mkdir()
        archive = job / "release.zip"
        sha, downloaded = hashlib.sha256(), 0
        if check: check()
        with _open_url(manifest["download_url"], 120) as response:
            if check: check()
            total = int(response.headers.get("Content-Length", 0))
            if total < 0 or total > MAX_DOWNLOAD_BYTES:
                raise ValueError("The update package exceeds the download limit.")
            if total and shutil.disk_usage(updates).free < total * 2 + 256 * 1024 * 1024:
                raise ValueError("Free more disk space before downloading this update.")
            if check: check()
            with archive.open("xb") as output:
                while True:
                    if check: check()
                    chunk = response.read(1024 * 1024)
                    if check: check()
                    if not chunk: break
                    downloaded += len(chunk)
                    if downloaded > MAX_DOWNLOAD_BYTES:
                        raise ValueError("The update package exceeds the download limit.")
                    output.write(chunk)
                    sha.update(chunk)
                    with _lock:
                        _progress = min(80, int(downloaded / total * 80)) if total else 0
            if total and downloaded != total:
                raise ValueError("The download was incomplete. Check your connection and try again.")
        with _lock:
            if check: check()
            _state, _progress = UpdateState.VERIFYING, 85
        if sha.hexdigest() != manifest["sha256"]:
            raise ValueError("The download checksum does not match this release. No application files were changed.")
        with _lock:
            _state, _progress = UpdateState.PREPARING, 90
        package = job / "package"
        inventory = update_install.extract_archive(archive, package, expected_version=manifest["version"], expected_platform=_platform_name(),
                                                   **({"check": check} if check else {}))
        update_install.require_full_release(inventory, _platform_name())
        if check: check()
        _write_json(package / "update-target.json", {"target": str(Path(S.BASE_DIR).resolve())})
        fingerprint = update_install._hash(package / "TLI_RELEASE.json", check=check)[1]
        if check: check()
        _write_json(updates / "prepared.json", {"version": manifest["version"], "folder": job.name,
                    "sha256": manifest["sha256"], "manifest_sha256": fingerprint, "notes": manifest.get("notes", "")})
        archive.unlink()
        with _lock:
            if check: check()
            _state, _progress, _ready_path = UpdateState.READY, 100, str(package)
    except Exception as error:
        with _lock:
            _state, _error = UpdateState.ERROR, _failure_message("Update preparation failed", error)
        if job is not None:
            shutil.rmtree(job, ignore_errors=True)


def prepared_for_install(*, check):
    """Return only the fixed staged-job identity; validate every file at review."""
    import host_control as H
    import update_install
    check()
    with _lock:
        check()
        status = get_status()
        check()
        if not status["can_open"] or _updates_dir() != Path(S.BASE_DIR).resolve() / "data" / "updates":
            raise ValueError("Prepare a verified update in this installation before reviewing installation.")
        receipt = H.read_json(update_install._no_links(_updates_dir() / "prepared.json"), 256 * 1024)
        check()
        package = {key: receipt.get(key) for key in ("folder", "version", "manifest_sha256")}
        if package["version"] != status["latest_version"] or str(_updates_dir() / str(package["folder"]) / "package") != _ready_path:
            raise ValueError("The prepared update changed. Check for updates and review it again.")
    check()
    return package


def open_prepared_folder(*, check=None):
    if check: check()
    with _lock:
        if check: check()
        status = get_status()
        if not status["can_open"]:
            raise ValueError("No verified update folder is ready. Check for updates first.")
        path = Path(_ready_path)
        updates = _updates_dir()
        if path.resolve() != path or path.parent.parent != updates or not (path / "TLI_RELEASE.json").is_file():
            raise ValueError("The prepared update folder is no longer available. Download it again.")
    args = ["explorer.exe", str(path)] if sys.platform == "win32" else ["open" if sys.platform == "darwin" else "xdg-open", str(path)]
    if check: check()
    subprocess.Popen(args, shell=False, **hidden_process_kwargs())
    if check: check()


def auto_check_on_startup():
    """One cancellable, preference-aware checker for each running host."""
    global _auto_thread, _auto_stop, _auto_wake, _last_attempt
    with _lock:
        if _auto_thread is not None and _auto_thread.is_alive() and not _auto_stop.is_set():
            return
        _auto_stop, _auto_wake = threading.Event(), threading.Event()
        _last_attempt = None
        _auto_thread = threading.Thread(target=_automatic_loop, args=(_auto_stop, _auto_wake),
                                        name="tli-update-check", daemon=True)
        _auto_thread.start()


def _automatic_delay():
    with _lock:
        settings = _load_settings()
        if not settings["auto_check"] or not settings["update_url"]:
            return AUTO_CHECK_INTERVAL
        if _last_attempt is None:
            return 0
        return max(0, AUTO_CHECK_INTERVAL - (time.monotonic() - _last_attempt))


def _automatic_loop(stop, wake):
    if stop.wait(AUTO_START_DELAY):
        return
    while not stop.is_set():
        wake.clear()
        if stop.is_set():
            return
        delay = _automatic_delay()
        if delay <= 0:
            check(automatic=True)
            # Busy downloads/checks are revisited locally without another request.
            delay = max(60, _automatic_delay())
        if not stop.is_set():
            wake.wait(delay)


def stop_auto_check():
    """Wake the scheduler on host shutdown without waiting for a network timeout."""
    global _settings_revision
    with _lock:
        _settings_revision += 1
        _auto_stop.set()
        _auto_wake.set()
