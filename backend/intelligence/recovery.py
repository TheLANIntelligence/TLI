"""Reviewed, separate-copy recovery from existing owner-scoped v1 archives.

Never changes the running installation or activates the output. Decrypted
records exist in memory only; every staged store uses new normal TLI keys.
"""
from __future__ import annotations

import base64
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import sys
import threading
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException

import data_protection
import tli_state as S
from intelligence import backups

REVIEW_TTL = 600
MAX_REVIEWS = 64
SPACE_RESERVE = 16 * 1024 * 1024
TARGET_OWNER = "local"
_owner_hash = hashlib.sha256(TARGET_OWNER.encode()).hexdigest()
STORE_FILES = ("data/memory_local.json", "data/conversations.json",
               f"data/intelligence/diagnostics-{_owner_hash}.json",
               f"data/intelligence/recovery-origin-{_owner_hash}.json",
               "data/memory_key.bin", "data/conversations_key.bin")
LIMITATIONS = [
    "Creates only a separate copy of saved notes, AI conversations and diagnostic reports, with a normal data/ layout. It contains no TLI executable.",
    "The archived account and its legacy conversation associations are explicitly mapped to the new copy's local account. Original ownership is retained in encrypted recovery metadata.",
    "The running installation, its data and active account are unchanged. The recovered copy is not activated, merged, paired or served on the network.",
    "Fresh encryption keys protect this copy. On Windows they are bound to the operating-system account that creates it; source keys, PIN, identity, TLS and Companion credentials are not copied.",
    "The recovered local account has no PIN configured. Before any separate activation or network access, set up access protection; otherwise browser visitors would share that local account.",
    "References to excluded documents, images, devices or other files remain historical references. Those resources are not recovered.",
    "Atomic publication prevents replacement of an existing destination. Recovery after sudden power loss has not been verified; keep the original archive.",
]
_lock = threading.Lock()
_reviews = OrderedDict()


def _iso(stamp=None):
    return datetime.fromtimestamp(time.time() if stamp is None else stamp, timezone.utc).isoformat()


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _digest(value):
    return hashlib.sha256(_json(value)).hexdigest()


@contextmanager
def _operation():
    if not _lock.acquire(blocking=False):
        raise HTTPException(409, "A separate-copy recovery operation is already running. Wait for its result; no automatic retry was started.")
    try:
        yield
    finally:
        _lock.release()


def _owner(owner):
    if not isinstance(owner, str) or not 1 <= len(owner) <= 256:
        raise HTTPException(422, "The current account could not be confirmed for recovery.")
    return owner


def _identity(info):
    return (info.st_dev, info.st_ino)


def _reparse(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


@dataclass(frozen=True)
class Destination:
    path: Path
    ancestors: tuple

    @property
    def parent(self):
        return self.path.parent


def _drive_type(anchor):
    import ctypes
    from ctypes import wintypes
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.GetDriveTypeW.argtypes = [wintypes.LPCWSTR]
    api.GetDriveTypeW.restype = wintypes.UINT
    return api.GetDriveTypeW(anchor)


def _destination(raw, *, conflict=False):
    code = 409 if conflict else 422
    if (not isinstance(raw, str) or not 1 <= len(raw) <= 1024 or raw != raw.strip()
            or any(ord(char) < 32 for char in raw) or ".." in raw.replace("\\", "/").split("/")):
        raise HTTPException(code, "Choose an absolute path for a new recovery folder under an existing local folder.")
    path = Path(raw)
    if not path.is_absolute():
        raise HTTPException(code, "The recovery destination must be an absolute path on the TLI host.")
    if os.name == "nt":
        if not re.fullmatch(r"[a-zA-Z]:", path.drive):
            raise HTTPException(code, "Choose a local drive for this recovery copy. Network shares and device paths are not supported.")
        try:
            drive_type = _drive_type(path.anchor)
        except Exception as exc:
            raise HTTPException(503, "The destination drive type could not be confirmed. No recovery copy was created.") from exc
        if drive_type not in (2, 3, 6):
            raise HTTPException(code, "Choose an available local writable drive. Mapped network drives and unconfirmed drive types are not supported for recovery.")
        for part in path.parts[1:]:
            if (part.endswith((".", " ")) or any(char in '<>:"|?*' for char in part)
                    or re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part, re.I)):
                raise HTTPException(code, "The recovery destination contains an unsupported Windows path component.")
    path = Path(os.path.abspath(path))
    if os.path.lexists(path):
        raise HTTPException(code, "The destination already exists. Choose a new folder name; recovery never replaces even an empty existing folder.")
    ancestors = []
    try:
        for parent in reversed(path.parents):
            info = parent.lstat()
            if _reparse(info) or not stat.S_ISDIR(info.st_mode):
                raise ValueError("Linked or nondirectory path")
            ancestors.append((str(parent), *_identity(info)))
        candidate = path.resolve(strict=False)
        active_roots = {Path(S.DATA_DIR).resolve(), Path(S.BASE_DIR).resolve(), Path(__file__).resolve().parents[2]}
        if os.environ.get("TLI_ROOT"):
            active_roots.add(Path(os.environ["TLI_ROOT"]).resolve())
        if any(candidate == active or candidate.is_relative_to(active) or active.is_relative_to(candidate) for active in active_roots):
            raise ValueError("Active installation overlap")
        # Compare inode identity as well, so a short-name alias cannot bypass
        # the active data-directory exclusion on Windows.
        if any(active.exists() and _identity(active.stat()) in {(item[1], item[2]) for item in ancestors} for active in active_roots):
            raise ValueError("Active persistence identity overlap")
    except (OSError, ValueError) as exc:
        raise HTTPException(code, "The destination must have existing ordinary parent folders outside the current TLI installation and its data. Links, junctions and overlapping paths are not allowed.") from exc
    return Destination(path, tuple(ancestors))


class _ParentLease:
    """Keep Windows ancestors from being renamed; pin the POSIX parent fd.

    Identity checks accompany each phase. All creation/publication on POSIX is
    relative to the opened parent, and final publication never replaces a name.
    """
    def __init__(self, destination):
        self.destination, self.handles, self.fd = destination, [], None

    def __enter__(self):
        try:
            if os.name == "nt":
                import ctypes
                from ctypes import wintypes
                api = ctypes.WinDLL("kernel32", use_last_error=True)
                api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                           wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
                api.CreateFileW.restype = wintypes.HANDLE
                api.CloseHandle.argtypes = [wintypes.HANDLE]
                api.CloseHandle.restype = wintypes.BOOL
                self.api = api
                for name, _, _ in self.destination.ancestors:
                    handle = api.CreateFileW(name, 0x1, 0x1 | 0x2, None, 3, 0x02000000 | 0x00200000, None)
                    if handle == ctypes.c_void_p(-1).value:
                        raise OSError(ctypes.get_last_error(), "Could not protect the destination parent")
                    self.handles.append(handle)
            else:
                self.fd = os.open(self.destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.check()
            return self
        except Exception:
            self.__exit__(None, None, None)
            raise

    def check(self):
        current = _destination(str(self.destination.path), conflict=True)
        if current.ancestors != self.destination.ancestors:
            raise HTTPException(409, "The recovery destination's parent changed. Review a new destination before trying again.")
        if self.fd is not None and _identity(os.fstat(self.fd)) != self.destination.ancestors[-1][1:]:
            raise HTTPException(409, "The opened recovery parent changed. Review the destination again.")

    def mkdir(self, name):
        if self.fd is None:
            os.mkdir(self.destination.parent / name, 0o700)
        else:
            os.mkdir(name, 0o700, dir_fd=self.fd)

    def __exit__(self, *_):
        for handle in reversed(self.handles):
            self.api.CloseHandle(handle)
        self.handles = []
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def _atomic_publish(stage, destination, lease):
    """Atomic directory publication with an explicit no-replacement guarantee."""
    if os.name == "nt":
        # Rename through our still-open DELETE-capable staging handle. Closing
        # it before os.rename would permit replacement of the checked stage.
        import ctypes
        from ctypes import wintypes
        encoded_name = str(destination).encode("utf-16-le")
        class RenameInfo(ctypes.Structure):
            _fields_ = [("ReplaceIfExists", wintypes.BOOL), ("RootDirectory", wintypes.HANDLE),
                        ("FileNameLength", wintypes.DWORD), ("FileName", wintypes.WCHAR * (len(encoded_name) // 2 + 1))]
        info = RenameInfo()
        info.ReplaceIfExists = False
        info.FileNameLength = len(encoded_name)
        info.FileName = str(destination)
        api = lease.api
        api.SetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
        api.SetFileInformationByHandle.restype = wintypes.BOOL
        if not api.SetFileInformationByHandle(lease.stage_handle, 3, ctypes.byref(info), ctypes.sizeof(info)):
            error = ctypes.get_last_error()
            if os.path.lexists(destination):
                raise FileExistsError(errno.EEXIST, "The recovery destination already exists")
            raise OSError(error, "The new recovery destination could not be published without replacement")
        return
    import ctypes
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith("linux"):
        function, flag = getattr(library, "renameat2", None), 1  # RENAME_NOREPLACE
    elif sys.platform == "darwin":
        function, flag = getattr(library, "renameatx_np", None), 4  # RENAME_EXCL
    else:
        function = None
    if function is None:
        raise OSError(errno.ENOTSUP, "Atomic no-replace directory publication is unavailable")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(lease.fd, os.fsencode(stage.name), lease.fd, os.fsencode(destination.name), flag):
        code = ctypes.get_errno()
        raise OSError(code, "The new recovery destination could not be published without replacement")


def _archive(blob, password):
    backups.password_bytes(password)
    raw = backups._decrypt(blob, password)
    try:
        entries = backups._unpack(raw)
        backups._check_version(blob, entries)
        _, source, counts = backups._validate_entries(entries)
        values = {kind: backups._load_json(entries[kind + ".json"]) for kind in counts}
        return values, source, counts
    except Exception as exc:
        raise HTTPException(422, "Archive integrity or saved-data compatibility validation failed. No recovery copy was created.") from exc


def _mapped(values, source):
    owners = {identifier: record["user_id"] for identifier, record in values["conversations"].items()}
    return {**values, "conversations": {identifier: {**record, "user_id": TARGET_OWNER} for identifier, record in values["conversations"].items()},
            "origin": {"schema_version": 1, "source": source, "conversation_owners": owners, "recovered_owner": TARGET_OWNER}}


def _validate_mapped(mapped):
    from intelligence.recovery_readback import validate_values, canonical_digest
    try:
        counts = validate_values(mapped)
        for value in mapped.values():
            canonical_digest(value)  # The mapped areas must remain within reader limits.
        return counts
    except Exception as exc:
        raise HTTPException(422, "The archive contains records that the current application could not reopen individually. No recovery copy was created; preserve the original archive.") from exc


def _space(parent, mapped):
    # Envelope overhead plus a reserve; no model, full installation or archived
    # key is part of this estimate. Check again immediately before staging.
    required = sum(math.ceil(len(_json(value)) * 4 / 3) + 256 for value in mapped.values()) + SPACE_RESERVE
    try:
        free = shutil.disk_usage(parent).free
        if type(free) is not int or free < 0:
            raise ValueError("Unknown storage capacity")
    except Exception as exc:
        raise HTTPException(503, "Destination free space could not be checked. No recovery copy was created.") from exc
    if free < required:
        raise HTTPException(507, "The destination does not have enough free space for the encrypted copy and its safety reserve. Free space, then review again.")
    return required, free


def _summary(destination, sha, source, counts):
    spec = backups.format_spec(2 if "cases" in counts else 1)
    return {"ok": True, "schema_version": 1, "scope": "separate-data-copy", "destination": str(destination.path),
            "archive_sha256": sha, "source": source, "counts": counts,
            "owner_mapping": {"source_owner": source["owner_id"], "target_owner": TARGET_OWNER},
            "activated": False, "included": list(spec["included"]), "excluded": list(spec["excluded"]), "limitations": list(LIMITATIONS)}


def review_archive(blob, password, owner, destination):
    with _operation():
        _owner(owner)
        _ensure_readback_available()
        target = _destination(destination)
        values, source, counts = _archive(blob, password)
        mapped = _mapped(values, source)
        if _validate_mapped(mapped) != counts:
            raise HTTPException(422, "The archive's record counts could not be verified for recovery.")
        required, free = _space(target.parent, mapped)
        sha = hashlib.sha256(blob).hexdigest()
        now, wall = time.monotonic(), time.time()
        for token in list(_reviews):
            if _reviews[token]["expires"] <= now:
                del _reviews[token]
        while len(_reviews) >= MAX_REVIEWS:
            _reviews.popitem(last=False)
        token = secrets.token_urlsafe(32)
        _reviews[token] = {"owner": owner, "archive_sha256": sha, "destination": str(target.path),
                           "ancestors": target.ancestors, "source_owner": source["owner_id"], "expires": now + REVIEW_TTL}
        return {**_summary(target, sha, source, counts), "review_token": token,
                "checked_at": _iso(wall), "expires_at": _iso(wall + REVIEW_TTL),
                "required_free_bytes": required, "available_free_bytes": free}


def _write(path, raw, *, parent_fd=None):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    descriptor = os.open(path if parent_fd is None else path.name, flags, 0o600, dir_fd=parent_fd)
    with os.fdopen(descriptor, "wb") as handle:
        if handle.write(raw) != len(raw):
            raise OSError(errno.ENOSPC, "Incomplete recovery write")
        handle.flush()
        os.fsync(handle.fileno())


def _store(stage, relative, value, key, aad=None, *, lease):
    nonce = os.urandom(12)
    encrypted = AESGCM(key).encrypt(nonce, _json(value), aad)
    lease.write(relative, _json({"_tli_enc": 1, "data": base64.b64encode(nonce + encrypted).decode("ascii")}))


class _StageLease:
    """Scope all writes to owned directories, never to a replaced path.

    Windows handles deny deletion/replacement through publication. POSIX
    writes use the held directory descriptors, with exclusive no-follow opens.
    The standard key format is unchanged, but existing keys are never adopted.
    """
    DIRECTORIES = ("data", "data/vault", "data/tools", "data/tools/scripts", "data/tools/tasks", "data/mesh", "data/intelligence")

    def __init__(self, stage, identity, parent_lease):
        self.stage, self.identity, self.parent_lease = stage, identity, parent_lease
        self.handles, self.identities = {}, {}

    def _pin(self, relative):
        path = self.stage / relative
        info = path.lstat()
        if _reparse(info) or not stat.S_ISDIR(info.st_mode) or (relative == "." and _identity(info) != self.identity):
            raise ValueError("The staging directory changed before it could be protected")
        if os.name == "nt":
            import ctypes
            api = self.parent_lease.api
            handle = api.CreateFileW(str(path), (0x10000 if relative == "." else 0) | 0x1,
                                    0x1 | 0x2, None, 3, 0x02000000 | 0x00200000, None)
            if handle == ctypes.c_void_p(-1).value:
                raise OSError(ctypes.get_last_error(), "Could not protect the staging directory")
            self.handles[relative] = handle
            # Recheck while the handle prevents subsequent path replacement.
            current = path.lstat()
            if _reparse(current) or _identity(current) != _identity(info):
                raise ValueError("The staging directory changed while being protected")
            if relative == ".":
                self.parent_lease.stage_handle = handle
        else:
            parent = Path(relative).parent.as_posix()
            descriptor = os.open(self.stage.name if relative == "." else Path(relative).name,
                                 os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                 dir_fd=self.parent_lease.fd if relative == "." else self.handles[parent])
            self.handles[relative] = descriptor
            if _identity(os.fstat(descriptor)) != _identity(info):
                raise ValueError("The opened staging directory changed")
        self.identities[relative] = _identity(info)

    def __enter__(self):
        try:
            self._pin(".")
            for relative in self.DIRECTORIES:
                if os.name == "nt":
                    os.mkdir(self.stage / relative, 0o700)
                else:
                    os.mkdir(Path(relative).name, 0o700, dir_fd=self.handles[Path(relative).parent.as_posix()])
                self._pin(relative)
            self.check()
            return self
        except Exception:
            self.__exit__(None, None, None)
            raise

    def check(self):
        for relative, identity in self.identities.items():
            info = (self.stage / relative).lstat()
            if _reparse(info) or not stat.S_ISDIR(info.st_mode) or _identity(info) != identity:
                raise ValueError("A protected staging directory changed")

    def write(self, relative, raw):
        self.check()
        _write(self.stage / relative, raw, parent_fd=None if os.name == "nt" else self.handles[Path(relative).parent.as_posix()])

    def finish_writes(self):
        # Windows directory rename requires child-directory handles closed.
        # No writes occur after this point. Keep the root's DELETE-capable
        # handle held, so publication still identifies the original stage.
        if os.name == "nt":
            for relative in reversed(list(self.handles)):
                if relative != ".":
                    self.parent_lease.api.CloseHandle(self.handles.pop(relative))

    def __exit__(self, *_):
        for handle in reversed(list(self.handles.values())):
            self.parent_lease.api.CloseHandle(handle) if os.name == "nt" else os.close(handle)
        self.handles = {}


def _new_key(lease, relative):
    key = os.urandom(32)
    blob = data_protection.dpapi_protect(key) if data_protection.is_windows() else key
    if not isinstance(blob, bytes) or not blob or len(blob) > 65536:
        raise data_protection.KeyUnavailableError("A new protected key could not be created")
    lease.write(relative, blob)
    return key


def _stage_files(stage, mapped, lease):
    memory_key = _new_key(lease, "data/memory_key.bin")
    conversation_key = _new_key(lease, "data/conversations_key.bin")
    _store(stage, STORE_FILES[0], mapped["notebook"], memory_key, lease=lease)
    _store(stage, STORE_FILES[1], mapped["conversations"], conversation_key, lease=lease)
    _store(stage, STORE_FILES[2], mapped["diagnostics"], memory_key, b"diagnostics:local", lease=lease)
    _store(stage, STORE_FILES[3], mapped["origin"], memory_key, b"recovery-origin:local", lease=lease)
    if "cases" in mapped:
        _store(stage, f"data/intelligence/cases-{hashlib.sha256(b'local').hexdigest()}.json", mapped["cases"], memory_key, b"cases:local", lease=lease)


def _hash_files(stage, with_cases=False):
    result = {}
    files = STORE_FILES + ((f"data/intelligence/cases-{hashlib.sha256(b'local').hexdigest()}.json",) if with_cases else ())
    for relative in files:
        path = stage / relative
        info = path.lstat()
        if _reparse(info) or not stat.S_ISREG(info.st_mode):
            raise ValueError("Recovery store changed type")
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        result[relative] = digest.hexdigest()
    return result


def _ensure_readback_available():
    if getattr(sys, "frozen", False):
        raise HTTPException(409, "Separate-copy recovery is not supported by this packaged runtime. Use the ZIP/source Python installation for this checkpoint; no copy was created.")
    from intelligence.recovery_readback import ensure_available
    try:
        ensure_available()
    except Exception as exc:
        raise HTTPException(503, "Current-application recovery verification is unavailable in this runtime. No copy was created.") from exc


def _readback(stage, expected):
    from intelligence.recovery_readback import run_readback
    return run_readback(stage, expected)


def _cleanup(stage, identity, target):
    if stage is None:
        return
    try:
        # Remove only the random staging directory this call created and whose
        # original parent and inode still match. Never follow a replacement.
        if stage.parent != target.parent or not stage.name.startswith(".tli-recovery-"):
            return
        for name, dev, ino in target.ancestors:
            info = Path(name).lstat()
            if _reparse(info) or _identity(info) != (dev, ino):
                return
        info = stage.lstat()
        if _reparse(info) or _identity(info) != identity:
            return
        shutil.rmtree(stage)
    except OSError:
        pass  # An unpublished encrypted staging directory may remain.


def create_copy(blob, password, owner, destination, review_token):
    with _operation():
        _owner(owner)
        if not isinstance(review_token, str) or len(review_token) > 128:
            raise HTTPException(409, "Review this archive and destination before creating a copy.")
        reviewed = _reviews.pop(review_token, None)  # One attempt, including failures.
        if not reviewed or reviewed["expires"] <= time.monotonic() or not secrets.compare_digest(reviewed["owner"].encode("utf-8"), owner.encode("utf-8")):
            raise HTTPException(409, "This recovery review expired, was used or belongs to another account. Review again before creating a copy.")
        _ensure_readback_available()
        if not isinstance(blob, bytes) or not secrets.compare_digest(reviewed["archive_sha256"], hashlib.sha256(blob).hexdigest()):
            raise HTTPException(409, "The archive changed after review. Review it again; no copy was created.")
        target = _destination(destination, conflict=True)
        if str(target.path) != reviewed["destination"] or target.ancestors != reviewed["ancestors"]:
            raise HTTPException(409, "The destination changed after review. Review it again; no copy was created.")
        values, source, counts = _archive(blob, password)
        if source["owner_id"] != reviewed["source_owner"]:
            raise HTTPException(409, "The archive's source account changed. Review it again.")
        mapped = _mapped(values, source)
        if _validate_mapped(mapped) != counts:
            raise HTTPException(422, "The archive's record counts could not be verified for recovery.")
        _space(target.parent, mapped)
        expected = {key: _digest(value) for key, value in mapped.items()}
        expected.update(owner=TARGET_OWNER, counts=counts)
        stage = None
        stage_identity = None
        try:
            with _ParentLease(target) as lease:
                stage = target.parent / (".tli-recovery-" + secrets.token_hex(16))
                lease.mkdir(stage.name)
                stage_identity = _identity(stage.lstat())
                with _StageLease(stage, stage_identity, lease) as stage_lease:
                    _stage_files(stage, mapped, stage_lease)
                    hashes = _hash_files(stage, True) if "cases" in mapped else _hash_files(stage)
                    lease.check()
                    readback = _readback(stage, expected)
                    checks = ("encrypted_payloads", "current_readers", "record_identifiers", "stored_metadata", "owner_mapping", "files_unchanged")
                    if (not isinstance(readback, dict) or readback.get("ok") is not True or readback.get("schema_version") != 1
                            or readback.get("reader") != "current-application" or readback.get("owner") != TARGET_OWNER
                            or readback.get("counts") != counts or not isinstance(readback.get("checked_at"), str)
                            or not isinstance(readback.get("checks"), dict) or any(readback["checks"].get(name) is not True for name in checks)):
                        raise ValueError("Current-reader verification did not confirm this copy")
                    stage_lease.check()
                    if (_hash_files(stage, True) if "cases" in mapped else _hash_files(stage)) != hashes:
                        raise ValueError("Staged stores changed during verification")
                    result = {**_summary(target, reviewed["archive_sha256"], source, counts), "completed_at": _iso(), "readback": readback}
                    stage_lease.write("recovery-receipt.json", _json(result))
                    lease.check()
                    stage_lease.check()
                    if (_hash_files(stage, True) if "cases" in mapped else _hash_files(stage)) != hashes:
                        raise ValueError("Staged stores changed before publication")
                    stage_lease.finish_writes()
                    stage_lease.check()
                    _atomic_publish(stage, target.path, lease)
                    stage = None  # Publication succeeded; never clean the completed copy.
                    return result
        except HTTPException:
            raise
        except FileExistsError as exc:
            raise HTTPException(409, "The destination appeared after review. It was preserved; choose a new folder and review again.") from exc
        except OSError as exc:
            code = 507 if exc.errno in (errno.ENOSPC, errno.EDQUOT) else 503
            raise HTTPException(code, "The separate recovery copy could not be safely written or published. The running data and existing destinations were preserved; review again before another attempt.") from exc
        except Exception as exc:
            raise HTTPException(503, "The recovered stores could not be verified with the current application readers. No copy was published or activated; original data was preserved.") from exc
        finally:
            _cleanup(stage, stage_identity, target)
