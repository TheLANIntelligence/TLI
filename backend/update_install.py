"""Offline, manifest-verified application update and recovery.

This module deliberately imports no TLI application state. Installing requires
all processes for the selected installation to be stopped. It never starts or
kills a process, changes user data, or installs dependencies.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import uuid
import zipfile

MANIFEST_NAME = "TLI_RELEASE.json"
MAX_FILES = 20_000
MAX_BYTES = 8 * 1024**3
MAX_FILE_BYTES = 2 * 1024**3
MAX_MANIFEST_BYTES = 8 * 1024**2
BACKEND_DIRS = {"ai", "builder", "cleanup", "drivers", "game_configs", "intelligence", "providers", "routers"}
FRONTEND_DIRS = {"js", "css", "assets", "history"}
ROOT_FILES = {
    "README.md", "START_HERE.md", "LICENSE", "SECURITY.md", "TLI_MANUAL.md",
    "TLI.exe", "TLI_Start.bat", "TLI_Diagnostics.bat", "TLI_Bootstrap.ps1",
    "TLI_Setup.bat", "TLI_Setup.ps1", "tli_sentinel.ps1", "TLI_Start.command",
    "TLI_Start.sh", "TLI_Update.bat", "TLI_Update.ps1", "TLI_Update.command", "TLI_Update.sh",
    "Uninstall_TLI.bat", "TLI_Uninstall.ps1",
    "Uninstall_TLI.command", "Uninstall_TLI.sh",
}
PUBLIC_GUIDES = {
    "HOST_START.md", "TLI_HOST_START.md", "TLI_SMART_HUB_REFINEMENT.md",
    "TLI_CONNECTED_WORKFLOWS.md", "TLI_SIMPLIFICATION_RELEASE.md",
    "TLI_SIMPLIFICATION_ACCEPTANCE.md", "TLI_SIDEBAR_DIRECT_ACCESS.md",
    "TLI_CAPABILITIES.md", "TLI_ANNIVERSARY_COMPLETION_PROGRAM.md",
    "RELEASE_1.4.0_BETA.md", "RELEASE_1.4.1_BETA.md", "UPDATING_TLI.md", "TLI_UPDATES.md", "TLI_UNINSTALL.md",
}
PROTECTED_PARTS = {
    "data", "tli_data", "vault_data", "vault", "keys", "tls", "secrets", "models",
    "memory", "session", "sessions", "venv", ".venv", "__pycache__", "tests",
    "node_modules", ".git", ".ssh", ".aws", ".azure", ".gnupg",
}
PROTECTED_NAMES = {
    "active_model.json", "devices.json", "tli_model_config.json", "vault_meta.json",
    "credentials.json", "node_identity.json", "tli_pin.json", "tli_system_profile.json",
    "conversations.json", "vault_sessions.json", "startup.json", "printers_snmp.json",
    "secrets.json", "secrets.yaml", "secrets.yml", "credentials.yaml", "credentials.yml",
    "id_rsa", "id_ed25519",
}
RESERVED = re.compile(r"^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)", re.I)


class UpdateError(ValueError):
    """An update cannot safely be applied to the selected installation."""


def _path_parts(value: str) -> tuple[str, ...]:
    if not isinstance(value, str) or not value or len(value) > 512:
        raise UpdateError("Invalid package path")
    if "\\" in value or ":" in value or value.startswith("/"):
        raise UpdateError(f"Unsafe package path: {value!r}")
    parts = value.split("/")
    for part in parts:
        if (not part or part in {".", ".."} or part.endswith((".", " "))
                or RESERVED.match(part) or any(ord(c) < 32 or c in '<>\"|?*' for c in part)):
            raise UpdateError(f"Unsafe package path: {value!r}")
    return tuple(parts)


def is_application_path(value: str) -> bool:
    """Shared package allowlist; private and unknown destination files survive."""
    try:
        parts = _path_parts(value)
    except UpdateError:
        return False
    lowered = [part.casefold() for part in parts]
    if any(part in PROTECTED_PARTS or part.startswith(".") for part in lowered):
        return False
    if lowered[-1] in PROTECTED_NAMES:
        return False
    name, suffix = parts[-1], PurePosixPath(value).suffix.lower()
    if len(parts) == 1:
        return name in ROOT_FILES
    if parts[0] == "docs":
        return len(parts) == 2 and name in PUBLIC_GUIDES
    if parts[0] == "frontend":
        if value == "frontend/assets/fonts/Inter-LICENSE.txt":
            return True
        return ((len(parts) == 2 or parts[1] in FRONTEND_DIRS)
                and suffix in {".html", ".js", ".css", ".json", ".svg", ".png", ".jpg", ".jpeg",
                               ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".map", ".mp3", ".ogg", ".wav"})
    if parts[0] != "backend" or (len(parts) > 2 and parts[1] not in BACKEND_DIRS):
        return False
    if len(parts) >= 4 and parts[:3] == ("backend", "ai", "runtime"):
        return (suffix in {".exe", ".dll", ".so", ".dylib", ".txt", ".md", ".json", ".metal", ".metallib"}
                or name in {"llama-server", "llama_server", "LICENSE", "README"} or ".so." in name)
    return (suffix == ".py" or value == "backend/requirements.txt"
            or suffix == ".txt" and "prompts" in parts
            or suffix == ".json" and parts[1] == "game_configs")


def _manifest(raw: bytes, expected_version=None, expected_platform=None) -> dict:
    if len(raw) > MAX_MANIFEST_BYTES:
        raise UpdateError("Release manifest is too large")
    def no_duplicate_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise UpdateError("Duplicate release manifest key")
            result[key] = value
        return result
    try:
        manifest = json.loads(raw, object_pairs_hook=no_duplicate_keys)
    except (ValueError, UnicodeError) as exc:
        raise UpdateError(f"Invalid release manifest: {exc}") from exc
    if (not isinstance(manifest, dict) or type(manifest.get("schema_version")) is not int
            or manifest["schema_version"] != 1):
        raise UpdateError("Unsupported release manifest schema")
    version, platform, files = manifest.get("version"), manifest.get("platform"), manifest.get("files")
    if not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}", version):
        raise UpdateError("Invalid release version")
    if not isinstance(platform, str) or platform not in {"windows", "macos", "all"}:
        raise UpdateError("Invalid release platform")
    if expected_version is not None and expected_version != version:
        raise UpdateError("Package version does not match the selected release")
    if expected_platform is not None and platform not in {expected_platform, "all"}:
        raise UpdateError("Package is for a different operating system")
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise UpdateError("Invalid release file count")
    seen, total = set(), 0
    for entry in files:
        if not isinstance(entry, dict) or not is_application_path(entry.get("path")):
            raise UpdateError("Release contains a non-application path")
        path = entry["path"]
        key = path.casefold()
        if key in seen or any("/".join(key.split("/")[:i]) in seen for i in range(1, len(key.split("/")))):
            raise UpdateError("Duplicate or conflicting release paths")
        seen.add(key)
        size, digest, mode = entry.get("size"), entry.get("sha256"), entry.get("mode")
        if type(size) is not int or not 0 <= size <= MAX_FILE_BYTES:
            raise UpdateError("Invalid release file size")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise UpdateError("Invalid release file hash")
        if type(mode) is not int or mode not in {0o644, 0o755}:
            raise UpdateError("Invalid release file permissions")
        total += size
    if total > MAX_BYTES:
        raise UpdateError("Release exceeds the installation size limit")
    for key in seen:
        if any("/".join(key.split("/")[:i]) in seen for i in range(1, len(key.split("/")))):
            raise UpdateError("Conflicting release paths")
    return manifest


def _digest_stream(stream, limit=MAX_FILE_BYTES):
    digest, total = hashlib.sha256(), 0
    while chunk := stream.read(1024 * 1024):
        total += len(chunk)
        if total > limit:
            raise UpdateError("File exceeds its declared size")
        digest.update(chunk)
    return total, digest.hexdigest()


def _hash(path):
    with path.open("rb") as stream:
        return _digest_stream(stream)


def _inspect_zip(zf, expected_version=None, expected_platform=None):
    infos = zf.infolist()
    if not 2 <= len(infos) <= MAX_FILES + 1:
        raise UpdateError("Invalid archive file count")
    seen = set()
    for info in infos:
        _path_parts(info.filename)
        kind = stat.S_IFMT(info.external_attr >> 16)
        if info.is_dir() or kind not in {0, stat.S_IFREG} or info.flag_bits & 1:
            raise UpdateError("Linked, special, directory or encrypted archive entries are unsupported")
        if info.filename.casefold() in seen:
            raise UpdateError("Duplicate archive path")
        seen.add(info.filename.casefold())
        if info.file_size > MAX_FILE_BYTES:
            raise UpdateError("Archive entry exceeds size limit")
    try:
        info = zf.getinfo(MANIFEST_NAME)
    except KeyError as exc:
        raise UpdateError("Archive is missing TLI_RELEASE.json; use a current release package") from exc
    if info.file_size > MAX_MANIFEST_BYTES:
        raise UpdateError("Release manifest is too large")
    manifest = _manifest(zf.read(info), expected_version, expected_platform)
    entries = {entry["path"]: entry for entry in manifest["files"]}
    if {info.filename for info in infos} != set(entries) | {MANIFEST_NAME}:
        raise UpdateError("Archive contains unlisted or missing files")
    if sum(info.file_size for info in infos) > MAX_BYTES + MAX_MANIFEST_BYTES:
        raise UpdateError("Archive exceeds the installation size limit")
    for path, entry in entries.items():
        info = zf.getinfo(path)
        if info.file_size != entry["size"]:
            raise UpdateError(f"Release size mismatch: {path}")
        with zf.open(info) as stream:
            size, digest = _digest_stream(stream, entry["size"])
        if size != entry["size"] or digest != entry["sha256"]:
            raise UpdateError(f"Release hash mismatch: {path}")
    return manifest


def validate_archive(archive: Path, expected_version=None, expected_platform=None) -> dict:
    """Validate a root-layout ZIP without creating files."""
    try:
        with zipfile.ZipFile(archive) as zf:
            return _inspect_zip(zf, expected_version, expected_platform)
    except (OSError, zipfile.BadZipFile, NotImplementedError, RuntimeError) as exc:
        raise UpdateError(f"Cannot read update archive: {exc}") from exc


def _linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _no_links(path):
    """Check the lexical path before resolve() can hide a junction/symlink."""
    absolute = Path(os.path.abspath(path))
    for parent in reversed((absolute,) + tuple(absolute.parents)):
        if os.path.lexists(parent) and _linked(parent):
            raise UpdateError(f"Linked installation paths are unsupported: {parent}")
    return absolute


def extract_archive(archive: Path, destination: Path, expected_version=None, expected_platform=None) -> dict:
    """Extract into a new staging directory, only after complete validation."""
    destination = _no_links(destination)
    if destination.exists():
        raise UpdateError("Staging destination must not already exist")
    try:
        with zipfile.ZipFile(archive) as zf:
            manifest = _inspect_zip(zf, expected_version, expected_platform)
            destination.mkdir(parents=True)
            try:
                for entry in manifest["files"]:
                    path = destination / entry["path"]
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(entry["path"]) as src, path.open("xb") as out:
                        shutil.copyfileobj(src, out, 1024 * 1024)
                    path.chmod(entry["mode"])
                (destination / MANIFEST_NAME).write_bytes(zf.read(MANIFEST_NAME))
                _validate_source(destination, expected_platform)
            except BaseException:
                shutil.rmtree(destination)
                raise
    except (OSError, zipfile.BadZipFile, NotImplementedError, RuntimeError) as exc:
        raise UpdateError(f"Cannot extract update archive: {exc}") from exc
    return manifest


def _platform():
    return "windows" if sys.platform == "win32" else "macos" if sys.platform == "darwin" else "linux"


def _validate_source(source, expected_platform=None):
    manifest_path = _no_links(source / MANIFEST_NAME)
    if not manifest_path.is_file() or manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
        raise UpdateError("Source is missing a valid release manifest")
    manifest = _manifest(manifest_path.read_bytes(), expected_platform=expected_platform)
    expected = {entry["path"] for entry in manifest["files"]} | {MANIFEST_NAME}
    found = set()
    for directory, dirs, files in os.walk(source, followlinks=False):
        # Normal setup can prepare Python or create private state in this source
        # folder. Prune those trees entirely: never inspect, inventory or install
        # their contents, including links inside a private model/environment tree.
        dirs[:] = [name for name in dirs if name.casefold() not in PROTECTED_PARTS]
        for name in dirs:
            path = Path(directory) / name
            if _linked(path):
                raise UpdateError("Linked update source is unsupported")
        for name in files:
            lowered = name.casefold()
            if lowered in PROTECTED_NAMES or lowered == ".env" or lowered.startswith(".env."):
                continue
            path = Path(directory) / name
            if _linked(path):
                raise UpdateError("Linked update source is unsupported")
            found.add(path.relative_to(source).as_posix())
    # The download workflow writes only this local handoff hint after extraction.
    # It is neither release content nor a file installed into the old application.
    found.discard("update-target.json")
    if found != expected:
        raise UpdateError("Extracted package contains unlisted or missing files")
    for entry in manifest["files"]:
        path = source / entry["path"]
        if not path.is_file() or _hash(path) != (entry["size"], entry["sha256"]):
            raise UpdateError(f"Extracted release hash mismatch: {entry['path']}")
    return manifest


def _inside(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def ensure_stopped(target: Path):
    """Fail closed for matching or uninspectable TLI processes; never stop one."""
    try:
        import psutil
    except ImportError as exc:
        raise UpdateError("Process verification needs psutil. Run this updater with the existing installation's .venv Python, or prepare TLI using its normal setup first.") from exc
    script_names = {"main.py", "host_control_server.py", "host_launcher.py", "desktop_launcher.py", "tli_sentinel.ps1", "tli_node.py"}
    binary_names = {"tli.exe", "tli_backend.exe", "tli_backend", "llama-server", "llama-server.exe", "llama_server.exe"}
    try:
        processes = psutil.process_iter(["pid", "name", "exe", "cmdline", "cwd"], ad_value=None)
        for process in processes:
            info = process.info
            if info.get("pid") == os.getpid():
                continue
            name = (info.get("name") or "").casefold()
            exe, args, cwd = info.get("exe"), info.get("cmdline"), info.get("cwd")
            if exe:
                executable = Path(exe).resolve()
                if (_inside(executable, target / "backend" / "ai" / "runtime")
                        or _inside(executable, target) and name in binary_names):
                    raise UpdateError(f"Close TLI and its model runtime before updating (PID {info['pid']}).")
            if args:
                for arg in args:
                    cleaned = arg.strip('"')
                    basename = Path(cleaned).name.casefold()
                    if basename not in script_names and basename not in binary_names:
                        continue
                    path = Path(cleaned)
                    if not path.is_absolute():
                        if not cwd:
                            raise UpdateError(f"Cannot verify the location of a TLI process (PID {info['pid']}). Close it before updating.")
                        path = Path(cwd) / path
                    if _inside(path.resolve(), target):
                        raise UpdateError(f"Close TLI, its launcher and helper before updating (PID {info['pid']}).")
                if cwd and _inside(Path(cwd).resolve(), target) and any(arg in {"main:app", "backend.main:app"} for arg in args):
                    raise UpdateError(f"Close the TLI server before updating (PID {info['pid']}).")
            if name in binary_names and (not exe or args is None):
                raise UpdateError(f"Cannot inspect a TLI/runtime process (PID {info['pid']}); close it before updating.")
            if name.startswith(("python", "pypy")) and args is None:
                raise UpdateError(f"Cannot inspect Python process {info['pid']}; close it or run the updater with permission to inspect it.")
    except psutil.Error as exc:
        raise UpdateError(f"Could not verify that TLI is stopped: {exc}") from exc


def _sync_directory(path):
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def _atomic_json(path, value):
    temp = path.with_name(path.name + ".tmp")
    _no_links(path)
    _no_links(temp)
    with temp.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
    _sync_directory(path.parent)


def _copy_atomic(source, destination, mode, expected=None):
    _no_links(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_name(destination.name + ".tli-update-" + uuid.uuid4().hex + ".tmp")
    try:
        with source.open("rb") as src, temp.open("xb") as out:
            shutil.copyfileobj(src, out, 1024 * 1024)
            out.flush()
            os.fsync(out.fileno())
        if expected is not None and _hash(temp) != expected:
            raise UpdateError(f"File changed while copying: {source.name}")
        temp.chmod(mode)
        os.replace(temp, destination)
        _sync_directory(destination.parent)
    finally:
        if temp.exists():
            temp.unlink()


def _target(path):
    target = _no_links(path).resolve()
    for rel in ("backend/tli_state.py", "frontend/index.html"):
        if not _no_links(target / rel).is_file():
            raise UpdateError("Select the existing TLI folder containing backend/tli_state.py and frontend/index.html")
    return target


def _backups(target):
    return _no_links(target / "data" / "updates" / "backups")


@contextmanager
def _installation_lock(target):
    """OS locks are released after a crash, so journal recovery remains available."""
    lock_path = _no_links(target / "data" / "updates" / "install.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as stream:
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise UpdateError("Another update or recovery is already running for this installation") from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _journals(target):
    root = _backups(target)
    if not root.exists():
        return []
    result = []
    for backup in root.iterdir():
        if _linked(backup):
            raise UpdateError("Linked update backup is unsupported")
        journal_path = backup / "journal.json"
        if backup.is_dir() and journal_path.exists():
            _no_links(journal_path)
            try:
                if journal_path.stat().st_size > MAX_MANIFEST_BYTES * 3:
                    raise UpdateError("Recovery journal is too large")
                journal = json.loads(journal_path.read_text(encoding="utf-8"))
                if not isinstance(journal, dict):
                    raise UpdateError("Invalid recovery journal")
            except (ValueError, OSError) as exc:
                raise UpdateError(f"Update recovery journal is unreadable: {journal_path}") from exc
            result.append((backup, journal))
    return sorted(result, key=lambda pair: pair[0].name)


def _restore(target, backup, journal):
    if (journal.get("schema_version") != 1 or journal.get("target") != str(target)
            or journal.get("status") not in ("prepared", "applying", "complete", "rolling_back")
            or not isinstance(journal.get("files"), list) or not 1 <= len(journal["files"]) <= MAX_FILES + 1):
        raise UpdateError("Invalid recovery journal")
    seen = set()
    for entry in journal["files"]:
        if not isinstance(entry, dict):
            raise UpdateError("Invalid recovery file record")
        rel = entry.get("path")
        if rel != MANIFEST_NAME and not is_application_path(rel):
            raise UpdateError("Recovery journal contains a protected path")
        if rel.casefold() in seen:
            raise UpdateError("Recovery journal contains duplicate paths")
        seen.add(rel.casefold())
        destination = _no_links(target / rel)
        if type(entry.get("existed")) is not bool:
            raise UpdateError("Invalid recovery file record")
        if not isinstance(entry.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
            raise UpdateError("Invalid recovery file hash")
        old_hash = None
        if entry["existed"]:
            saved = _no_links(backup / "files" / rel)
            old_hash = entry.get("original_sha256")
            if not saved.is_file() or _hash(saved)[1] != old_hash:
                raise UpdateError(f"Backup is missing or damaged: {rel}")
            if type(entry.get("original_mode")) is not int or not 0 <= entry["original_mode"] <= 0o777:
                raise UpdateError("Invalid recovery permissions")
        if destination.exists():
            if not destination.is_file() or _hash(destination)[1] not in {old_hash, entry.get("sha256")}:
                raise UpdateError(f"File changed after the update; preserve it before recovery: {rel}")
    journal["status"] = "rolling_back"
    _atomic_json(backup / "journal.json", journal)
    for entry in reversed(journal["files"]):
        destination = _no_links(target / entry["path"])
        if entry["existed"]:
            if not destination.exists() or _hash(destination)[1] != entry["original_sha256"]:
                _copy_atomic(backup / "files" / entry["path"], destination, entry["original_mode"])
            elif stat.S_IMODE(destination.stat().st_mode) & 0o777 != entry["original_mode"]:
                destination.chmod(entry["original_mode"])
        elif destination.exists():
            destination.unlink()
            _sync_directory(destination.parent)
    journal["status"] = "rolled_back"
    _atomic_json(backup / "journal.json", journal)
    return {"status": "rolled_back", "target": str(target), "backup": str(backup)}


def rollback(target: Path) -> dict:
    """Restore the latest retained update, including a journal interrupted mid-copy."""
    target = _target(target)
    with _installation_lock(target):
        return _rollback(target)


def _rollback(target):
    ensure_stopped(target)
    journals = _journals(target)
    if not journals:
        raise UpdateError("No update backup is available for this installation")
    backup, journal = journals[-1]
    if journal.get("status") == "rolled_back":
        raise UpdateError("The latest update has already been rolled back")
    return _restore(target, backup, journal)


def require_completed_update(root: Path):
    """Read-only startup guard: an interrupted application update needs recovery."""
    root = Path(root)
    if not (root / "data" / "updates" / "backups").exists():
        return
    try:
        for _, journal in _journals(root):
            if (journal.get("schema_version") != 1 or journal.get("target") != str(root.resolve())
                    or journal.get("status") not in ("complete", "rolled_back")
                    or not isinstance(journal.get("files"), list) or not journal["files"]):
                raise UpdateError("An update is incomplete or its recovery journal is damaged")
    except (UpdateError, OSError, ValueError) as exc:
        raise UpdateError(f"TLI cannot start until its application update is recovered. Keep TLI closed and run backend/update_install.py --target \"{root.resolve()}\" --rollback. {exc}") from exc


def require_full_release(manifest: dict, platform=None):
    """Require complete application source and the selected guided entry point."""
    required = {"backend/main.py", "backend/tli_state.py", "backend/requirements.txt",
                "backend/update_install.py", "frontend/index.html"}
    if platform in {"windows", "all"}:
        required.update({"TLI_Update.bat", "TLI_Update.ps1"})
    if platform in {"macos", "all"}:
        required.update({"TLI_Update.command", "TLI_Update.sh"})
    if platform == "linux":
        required.add("TLI_Update.sh")
    entries = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(entries, list) or any(not isinstance(entry, dict) for entry in entries):
        raise UpdateError("Use a complete release package for an in-place update")
    paths = {entry.get("path") for entry in entries if isinstance(entry.get("path"), str)}
    if not required.issubset(paths):
        missing = ", ".join(sorted(required - paths))
        raise UpdateError(f"Use a complete release package for an in-place update; missing: {missing}")


def install(source: Path, target: Path) -> dict:
    """Apply verified application files transactionally to a stopped installation."""
    source, target = _no_links(source).resolve(), _target(target)
    if source == target or _inside(target, source):
        raise UpdateError("Update source and installed TLI folder must be separate")
    if _inside(source, target) and not _inside(source, target / "data" / "updates"):
        raise UpdateError("An update inside the installation must be staged under data/updates")
    manifest = _validate_source(source, _platform())
    require_full_release(manifest)
    with _installation_lock(target):
        return _install(source, target, manifest)


def _install(source, target, manifest):
    ensure_stopped(target)
    for _, previous in _journals(target):
        if previous.get("status") not in ("complete", "rolled_back"):
            raise UpdateError("An earlier update was interrupted. Run this updater with --rollback first.")
    files = [dict(entry) for entry in manifest["files"]]
    # Make recovery and the startup guard available as early as possible when
    # upgrading a legacy installation. The installed manifest remains last.
    priorities = {"backend/update_install.py": 0, "backend/main.py": 1}
    files.sort(key=lambda entry: priorities.get(entry["path"], 2))
    manifest_size, manifest_hash = _hash(source / MANIFEST_NAME)
    files.append({"path": MANIFEST_NAME, "size": manifest_size, "sha256": manifest_hash, "mode": 0o644})
    for entry in files:
        destination = _no_links(target / entry["path"])
        if destination.exists() and not destination.is_file():
            raise UpdateError(f"Installation file is a directory: {entry['path']}")
        entry["existed"] = destination.exists()
        if entry["existed"]:
            entry["original_sha256"] = _hash(destination)[1]
            entry["original_mode"] = stat.S_IMODE(destination.stat().st_mode) & 0o777
    backup = _backups(target) / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ-") + uuid.uuid4().hex[:8])
    backup.mkdir(parents=True)
    for directory in (target, target / "data", target / "data" / "updates", backup.parent):
        _sync_directory(directory)
    # Finish and flush every backup before creating the durable write-ahead journal.
    for entry in files:
        if entry["existed"]:
            _copy_atomic(target / entry["path"], backup / "files" / entry["path"], entry["original_mode"])
            if _hash(backup / "files" / entry["path"])[1] != entry["original_sha256"]:
                raise UpdateError("Installation changed while preparing its backup; nothing was installed")
    journal = {"schema_version": 1, "target": str(target), "version": manifest["version"], "status": "prepared", "files": files}
    _atomic_json(backup / "journal.json", journal)
    try:
        ensure_stopped(target)
        journal["status"] = "applying"
        _atomic_json(backup / "journal.json", journal)
        for entry in files:
            src = _no_links(source / entry["path"])
            if _hash(src) != (entry["size"], entry["sha256"]):
                raise UpdateError(f"Update source changed: {entry['path']}")
            _copy_atomic(src, target / entry["path"], entry["mode"], (entry["size"], entry["sha256"]))
        journal["status"] = "complete"
        _atomic_json(backup / "journal.json", journal)
    except Exception as exc:
        try:
            if journal["status"] == "prepared":
                journal["status"] = "rolled_back"
                _atomic_json(backup / "journal.json", journal)
            else:
                _restore(target, backup, journal)
        except Exception as recovery:
            raise UpdateError(f"Update failed ({exc}). Recovery also failed ({recovery}); keep TLI closed and run --rollback. Backup: {backup}") from exc
        raise UpdateError(f"Update failed; previous application files were restored: {exc}") from exc
    return {"status": "installed", "version": manifest["version"], "target": str(target), "backup": str(backup)}


def _input_path(value):
    # Terminal drag-and-drop commonly surrounds a Windows path in quotes.
    return Path(value.strip().strip('\"').strip("'")).expanduser()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Update a stopped TLI installation while preserving its data and models.")
    parser.add_argument("--source", type=_input_path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--target", type=_input_path, help="Existing TLI installation folder")
    parser.add_argument("--rollback", action="store_true", help="Restore the latest retained application backup")
    args = parser.parse_args(argv)
    try:
        if not sys.stdin.isatty():
            raise UpdateError("Run the updater in a local terminal to review and confirm the installation folder")
        target = args.target or _input_path(input("Existing TLI folder (the folder containing backend and frontend): "))
        target = _target(target)
        print(f"\nExisting installation: {target}")
        if not args.rollback:
            manifest = _validate_source(_no_links(args.source).resolve(), _platform())
            print(f"Release to install: {manifest['version']} ({manifest['platform']})")
        print("Close TLI, its launcher, model runtime and optional helper before continuing.")
        print("Your data, accounts, conversations, vault, models and Python environment are preserved.")
        word = "ROLLBACK" if args.rollback else "UPDATE"
        if input(f"Type {word} to confirm this folder: ").strip() != word:
            print("Cancelled. No application files changed.")
            return 1
        receipt = rollback(target) if args.rollback else install(args.source, target)
        print(f"\n{'Recovery' if args.rollback else 'Update'} complete. Backup retained at: {receipt['backup']}")
        print("Open this installation's normal TLI launcher to prepare dependencies and restart.")
        return 0
    except (UpdateError, OSError, EOFError, KeyboardInterrupt) as exc:
        print(f"\nTLI update stopped: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
