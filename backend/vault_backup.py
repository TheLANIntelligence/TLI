"""Portable, account-scoped Vault archives. Plaintext is never spooled to disk.

Version 1: MAGIC || scrypt salt(16) || GCM nonce(12) || encrypted USTAR ||
GCM tag(16). The complete fixed header is authenticated as AAD. Parsing starts
only after a complete authentication pass; entry hashes independently bind the
manifest to the restored bytes. Files are copied through bounded buffers.
"""
from __future__ import annotations

from collections import OrderedDict
from contextlib import contextmanager
from datetime import datetime, timezone
import codecs
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tarfile
import tempfile
import threading
import time

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from fastapi import HTTPException

from intelligence.backups import password_bytes, _key, _load_json
import vault_security as security

PROTOCOL = "tli-vault-backup-v1"
MAGIC = b"TLI-PORTABLE-VAULT\0\1"
CHUNK = 1024 * 1024
MAX_FILE = 250 * 1024 * 1024
MAX_TOTAL = 4 * 1024 * 1024 * 1024
MAX_ENTRIES = 10000
MAX_MANIFEST = 8 * 1024 * 1024
MAX_ARCHIVE = MAX_TOTAL + MAX_MANIFEST + MAX_ENTRIES * 1024 + 32768
RESERVE = 16 * 1024 * 1024
_lock = threading.Lock()
_requests = OrderedDict()
KINDS = ("file", "note", "secrets", "logins")
SCOPE = "Shared Vault files and Vault notes, plus this account's secrets and saved logins."
EXCLUSIONS = ["Other accounts' secrets and saved logins", "TLI PIN, identity, TLS and Companion credentials",
              "Machine keys, unlock sessions and browser-extension access keys", "Notes & fixes and AI conversation history"]


def iso():
    return datetime.now(timezone.utc).isoformat()


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


@contextmanager
def operation():
    if not _lock.acquire(blocking=False):
        raise HTTPException(409, "A Vault backup operation is running. Wait for its result before retrying.")
    try:
        yield
    finally:
        _lock.release()


def claim(owner, request_id):
    if not isinstance(owner, str) or not 1 <= len(owner) <= 256:
        raise HTTPException(422, "The current TLI account could not be confirmed.")
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id):
        raise HTTPException(422, "Supply a new request identifier.")
    now = time.monotonic()
    while _requests and next(iter(_requests.values())) < now - 1800:
        _requests.popitem(last=False)
    if (owner, request_id) in _requests:
        raise HTTPException(409, "This Vault backup request was already attempted. Check its result before starting another.")
    _requests[owner, request_id] = now
    while len(_requests) > 256:
        _requests.popitem(last=False)


def _ordinary(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or bool(getattr(info, "st_file_attributes", 0) & 0x400)):
        raise ValueError("Linked or unsupported Vault file")
    return info


def file_hash(path, limit=MAX_ARCHIVE, check=None):
    info = _ordinary(path)
    if info.st_size > limit:
        raise ValueError("File exceeds the supported inspection limit")
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as handle:
        if (os.fstat(handle.fileno()).st_dev, os.fstat(handle.fileno()).st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("Vault file changed while opening")
        for chunk in iter(lambda: handle.read(CHUNK), b""):
            if check:
                check()
            total += len(chunk)
            if total > limit:
                raise ValueError("File grew beyond the inspection limit")
            digest.update(chunk)
    after = _ordinary(path)
    if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError("Vault file changed during inspection")
    return digest.hexdigest()


class DecryptedReader:
    """Streaming AES-GCM reader with explicit final authentication."""
    def __init__(self, handle, key, *, header=b"", nonce=None, offset=0, total=None, check=None, maximum=None, expected_digest=None):
        self.handle = handle
        self.check = check
        handle.seek(0, os.SEEK_END)
        end = handle.tell() if total is None else total
        if maximum is not None and end > maximum:
            raise ValueError("Encrypted source exceeds its size limit")
        if nonce is None:
            handle.seek(offset)
            nonce = handle.read(12)
            offset += 12
        if end - offset < 16:
            raise ValueError("Truncated encrypted file")
        handle.seek(end - 16)
        tag = handle.read(16)
        self.expected_digest = expected_digest
        self.source_digest = hashlib.sha256(nonce) if expected_digest is not None else None
        self.tag = tag
        self.cipher = Cipher(algorithms.AES(key), modes.GCM(nonce, tag)).decryptor()
        if header:
            self.cipher.authenticate_additional_data(header)
        handle.seek(offset)
        self.remaining = end - offset - 16
        self.done = False

    def read(self, size=CHUNK):
        if self.check:
            self.check()
        if size < 0:
            raise ValueError("Unbounded plaintext reads are disabled")
        size = min(size, CHUNK, self.remaining)
        if size:
            raw = self.handle.read(size)
            if len(raw) != size:
                raise ValueError("Truncated encrypted content")
            self.remaining -= size
            if self.source_digest is not None:
                self.source_digest.update(raw)
            return self.cipher.update(raw)
        if not self.done:
            self.cipher.finalize()
            if self.source_digest is not None:
                self.source_digest.update(self.tag)
                if self.source_digest.hexdigest() != self.expected_digest:
                    raise ValueError("Encrypted source bytes changed between snapshot reads")
            self.done = True
        return b""

    def finish(self):
        for _ in iter(lambda: self.read(CHUNK), b""):
            pass


class EncryptedWriter:
    def __init__(self, handle, key, nonce, header=b""):
        self.handle = handle
        self.cipher = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
        if header:
            self.cipher.authenticate_additional_data(header)

    def write(self, raw):
        result = self.cipher.update(raw)
        if self.handle.write(result) != len(result):
            raise OSError("Incomplete encrypted write")
        return len(raw)

    def finish(self):
        tail = self.cipher.finalize() + self.cipher.tag
        if self.handle.write(tail) != len(tail):
            raise OSError("Incomplete encrypted tag")


def validate_plain(kind, chunks):
    """Hash exact bytes; validate current-reader forms without normalization."""
    digest, size = hashlib.sha256(), 0
    decoder = codecs.getincrementaldecoder("utf-8")("strict") if kind == "note" else None
    raw = bytearray() if kind in ("secrets", "logins") else None
    for chunk in chunks:
        size += len(chunk)
        if size > MAX_FILE:
            raise ValueError("Vault entry exceeds 250 MiB")
        digest.update(chunk)
        if decoder:
            decoder.decode(chunk)
        if raw is not None:
            raw.extend(chunk)
    records = 1
    if decoder:
        decoder.decode(b"", final=True)
    if raw is not None:
        value = _load_json(bytes(raw))
        if kind == "secrets":
            if not isinstance(value, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in value.items()):
                raise ValueError("Unsupported secrets require explicit repair before backup")
        elif (not isinstance(value, list) or any(not isinstance(row, dict)
                or any(not isinstance(row.get(k), str) for k in ("id", "name", "domain", "username", "password")) for row in value)
                or any(not row["id"] for row in value) or len({row["id"] for row in value}) != len(value)):
            raise ValueError("Unsupported or duplicate saved-login identifiers")
        records = len(value)
    return {"size": size, "sha256": digest.hexdigest(), "records": records}


def _source_entries(owner):
    import tli_state as S
    from routers import vault_routes as routes
    directory = Path(S.VAULT_DIR)
    if directory.is_symlink() or directory.resolve() != directory.absolute():
        raise ValueError("Linked Vault directory")
    own = {Path(routes._vault_secrets_path(owner)).name: "secrets", Path(routes._vault_logins_path(owner)).name: "logins"}
    entries, names = [], set()
    for path in sorted(directory.iterdir()):
        if not path.name.lower().endswith(".vault"):
            continue
        if not re.fullmatch(r"[A-Za-z0-9_-]+\.vault", path.name):
            raise ValueError("Unsupported Vault filename")
        if path.name in own:
            kind = own[path.name]
        elif path.name.startswith("__note_"):
            kind = "note"
        elif path.name.startswith(("__secrets_", "__logins_")):
            continue
        elif path.name.startswith("__"):
            raise ValueError("Unknown internal Vault content must not be omitted")
        else:
            kind = "file"
        _ordinary(path)
        if not 28 <= path.stat().st_size <= MAX_FILE + 28:
            raise ValueError("Vault file exceeds size limits or is incomplete")
        target = f"__{kind}_local.vault" if kind in ("secrets", "logins") else path.name
        if target.casefold() in names:
            raise ValueError("Case-insensitive Vault filename collision")
        names.add(target.casefold())
        entries.append((path, kind, target))
        if len(entries) > MAX_ENTRIES:
            raise ValueError("Vault contains more than 10000 entries")
    return entries


def _access(owner, key):
    current = security.get_encryption_key(owner)
    if not current or current != key:
        raise HTTPException(403, "Vault access ended during backup. No complete archive was created.")


def _chunks(reader, owner=None, key=None):
    while True:
        if owner is not None:
            _access(owner, key)
        chunk = reader.read(CHUNK)
        if not chunk:
            break
        yield chunk


def _tar_info(name, size):
    info = tarfile.TarInfo(name)
    info.size, info.mode, info.mtime = size, 0o600, 0
    return info


def _snapshot_source(owner, key, check):
    security.read_existing_meta()
    meta_hash = file_hash(Path(security.VAULT_META_PATH), 65536)
    source = _source_entries(owner)
    entries, originals, total = [], {}, 0
    for path, kind, target in source:
        check()
        originals[path.name] = file_hash(path, MAX_FILE + 28, check)
        with path.open("rb") as handle:
            detail = validate_plain(kind, _chunks(DecryptedReader(handle, key, check=check, maximum=MAX_FILE + 28,
                                                                 expected_digest=originals[path.name])))
        total += detail["size"]
        if total > MAX_TOTAL:
            raise ValueError("Vault exceeds the 4 GiB total limit")
        entries.append({"kind": kind, "name": target, **detail})
    manifest = {"protocol": PROTOCOL, "created_at": iso(), "source_owner": owner,
                "scope": SCOPE, "entries": entries, "total_bytes": total}
    validate_manifest(manifest)
    return manifest, source, originals, meta_hash


def _unchanged(owner, source, originals, meta_hash, check=None):
    if (_source_entries(owner) != source or file_hash(Path(security.VAULT_META_PATH), 65536) != meta_hash
            or any(file_hash(path, MAX_FILE + 28, check) != originals[path.name] for path, _, _ in source)):
        raise ValueError("Vault content or security metadata changed during the check")


def check_source(owner, authorize=None):
    """Explicit, source-only authenticated read; no archive or key is written."""
    with security.content_transaction():
        key = security.get_encryption_key(owner)
        if not key:
            raise HTTPException(403, "Unlock this account's Vault before checking its content.")
        def check():
            if authorize:
                authorize()
            _access(owner, key)
        try:
            manifest, source, originals, meta_hash = _snapshot_source(owner, key, check)
            check()
            _unchanged(owner, source, originals, meta_hash, check)
            check()
            result = summary(manifest)
            result["checks"] = {"source_authenticated": True, "all_entries_readable": True, "source_unchanged": True}
            return {**result, "checked": True, "source_unchanged": True, "archive_created": False}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(422, "TLI could not verify every item in this Vault's backup scope. Existing files and metadata were preserved; no archive was created.") from exc


def create_archive(owner, password, authorize=None):
    """Return an owned ciphertext temporary path and a content-free receipt."""
    password_bytes(password)
    temporary = None
    def check():
        if authorize:
            authorize()
        _access(owner, key)
    with security.content_transaction():
        key = security.get_encryption_key(owner)
        if not key:
            raise HTTPException(403, "Unlock this account's Vault before creating its portable backup.")
        try:
            manifest, source, originals, meta_hash = _snapshot_source(owner, key, check)
            entries, total = manifest["entries"], manifest["total_bytes"]
            raw_manifest = json_bytes(manifest)
            if len(raw_manifest) > MAX_MANIFEST:
                raise ValueError("Vault manifest is too large")
            needed = total + len(raw_manifest) + len(entries) * 1024 + RESERVE
            if shutil.disk_usage(tempfile.gettempdir()).free < needed:
                raise HTTPException(507, "There is not enough temporary storage for this encrypted Vault archive.")
            salt, nonce = os.urandom(16), os.urandom(12)
            header = MAGIC + salt + nonce
            archive_key = _key(password, salt)
            with tempfile.NamedTemporaryFile(prefix="tli-vault-backup-", suffix=".encrypted", delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(header)
                writer = EncryptedWriter(handle, archive_key, nonce, header)
                with tarfile.open(mode="w|", fileobj=writer, format=tarfile.USTAR_FORMAT) as tar:
                    tar.addfile(_tar_info("manifest.json", len(raw_manifest)), io.BytesIO(raw_manifest))
                    for index, (path, kind, _) in enumerate(source):
                        _access(owner, key)
                        with path.open("rb") as payload:
                            reader = DecryptedReader(payload, key, check=check, maximum=MAX_FILE + 28,
                                                     expected_digest=originals[path.name])
                            tar.addfile(_tar_info(f"payload/{index:05d}", entries[index]["size"]), reader)
                            reader.finish()
                writer.finish()
                handle.flush()
                os.fsync(handle.fileno())
            with temporary.open("rb") as handle:
                verified = verify_archive(handle, password)
            check()
            _unchanged(owner, source, originals, meta_hash, check)
            result = {**verified, "archive_sha256": file_hash(temporary, check=check), "archive_bytes": temporary.stat().st_size}
            check()
            output, temporary = temporary, None
            return output, result
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(422, "The complete Vault backup could not be verified. Check for unreadable files, unsupported records or the stated limits. Existing Vault content was preserved.") from exc
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def _open_archive(handle, password):
    handle.seek(0, os.SEEK_END)
    total = handle.tell()
    if not len(MAGIC) + 44 <= total <= MAX_ARCHIVE:
        raise ValueError("Archive size is outside supported limits")
    handle.seek(0)
    header = handle.read(len(MAGIC) + 28)
    if not header.startswith(MAGIC):
        raise ValueError("This is not a portable Vault archive")
    key = _key(password, header[len(MAGIC):len(MAGIC) + 16])
    options = {"header": header, "nonce": header[-12:], "offset": len(header), "total": total}
    DecryptedReader(handle, key, **options).finish()  # Authenticate BEFORE parsing.
    return DecryptedReader(handle, key, **options)


def validate_manifest(value):
    if (not isinstance(value, dict) or set(value) != {"protocol", "created_at", "source_owner", "scope", "entries", "total_bytes"}
            or value["protocol"] != PROTOCOL or value["scope"] != SCOPE
            or not isinstance(value["source_owner"], str) or not 1 <= len(value["source_owner"]) <= 256
            or not isinstance(value["created_at"], str) or len(value["created_at"]) > 64
            or not isinstance(value["entries"], list) or len(value["entries"]) > MAX_ENTRIES):
        raise ValueError("Unsupported Vault manifest")
    datetime.fromisoformat(value["created_at"])
    names, internal, total = set(), set(), 0
    for entry in value["entries"]:
        if (not isinstance(entry, dict) or set(entry) != {"kind", "name", "size", "sha256", "records"}
                or entry["kind"] not in KINDS or not isinstance(entry["name"], str)
                or not re.fullmatch(r"[A-Za-z0-9_-]+\.vault", entry["name"]) or len(entry["name"]) > 255
                or re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\.vault", entry["name"], re.I)
                or type(entry["size"]) is not int or not 0 <= entry["size"] <= MAX_FILE
                or type(entry["records"]) is not int or not 0 <= entry["records"] <= MAX_FILE
                or not isinstance(entry["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", entry["sha256"])):
            raise ValueError("Unsupported Vault archive entry")
        kind, name = entry["kind"], entry["name"]
        if ((kind == "file" and name.startswith("__")) or (kind == "note" and not name.startswith("__note_"))
                or (kind in ("secrets", "logins") and (name != f"__{kind}_local.vault" or kind in internal))
                or name.casefold() in names):
            raise ValueError("Ambiguous or unsafe recovered Vault entry")
        names.add(name.casefold())
        internal.add(kind)
        total += entry["size"]
    if type(value["total_bytes"]) is not int or value["total_bytes"] != total or total > MAX_TOTAL:
        raise ValueError("Vault archive total differs")
    return value


def scan_archive(handle, password, consumer=None):
    """Authenticate, validate, then stream exact entry bytes to an optional sink.

    Consumer(entry, chunks) must exhaust its generator. Only unpublished,
    encrypted destinations may be written; the entire scan must succeed.
    """
    reader = _open_archive(handle, password)
    # Parse only the small fixed USTAR subset we produce. A general TAR parser
    # consumes GNU/PAX extension lengths before callers can reject them.
    # Reject extensions, links and sparse entries from their 512-byte header.
    position = 0
    def exact(count):
        nonlocal position
        result = bytearray()
        while len(result) < count:
            chunk = reader.read(min(CHUNK, count - len(result)))
            if not chunk:
                raise ValueError("Incomplete Vault TAR")
            result.extend(chunk)
        position += len(result)
        return bytes(result)
    def header(name, maximum, size=None):
        block = exact(512)
        info = tarfile.TarInfo.frombuf(block, "utf-8", "strict")
        if (info.type != tarfile.REGTYPE or info.name != name or info.linkname
                or block[257:265] != tarfile.POSIX_MAGIC or not 0 <= info.size <= maximum
                or (size is not None and info.size != size)):
            raise ValueError("Unsupported Vault TAR header")
        return info.size
    def padding(size):
        if any(exact((-size) % 512)):
            raise ValueError("Invalid TAR padding")
    manifest_size = header("manifest.json", MAX_MANIFEST)
    if not manifest_size:
        raise ValueError("Missing Vault manifest")
    manifest = validate_manifest(_load_json(exact(manifest_size)))
    padding(manifest_size)
    for index, entry in enumerate(manifest["entries"]):
        header(f"payload/{index:05d}", MAX_FILE, entry["size"])
        digest, size = hashlib.sha256(), 0
        def chunks():
            nonlocal size
            while size < entry["size"]:
                chunk = exact(min(CHUNK, entry["size"] - size))
                size += len(chunk)
                digest.update(chunk)
                yield chunk
        if consumer is None:
            result = validate_plain(entry["kind"], chunks())
            if result["records"] != entry["records"]:
                raise ValueError("Vault record count differs")
        else:
            consumer(entry, chunks())
        if size != entry["size"] or digest.hexdigest() != entry["sha256"]:
            raise ValueError("Vault payload content differs")
        padding(size)
    trailing = 0
    for chunk in iter(lambda: reader.read(CHUNK), b""):
        trailing += len(chunk)
        if trailing > 10240 or any(chunk):
            raise ValueError("Unexpected data after Vault entries")
    if trailing < 1024 or (position + trailing) % 10240:
        raise ValueError("Incomplete Vault TAR terminator")
    return manifest


def summary(manifest):
    counts = {kind: sum(row["records"] for row in manifest["entries"] if row["kind"] == kind) for kind in KINDS}
    return {"ok": True, "protocol": PROTOCOL, "checked_at": iso(), "created_at": manifest["created_at"],
            "scope": SCOPE, "excluded": EXCLUSIONS, "source_owner": manifest["source_owner"],
            "counts": counts, "entries": len(manifest["entries"]), "total_bytes": manifest["total_bytes"],
            "checks": {"archive_authenticated": True, "all_entries_readable": True, "entry_hashes": True},
            "restored": False}


def verify_archive(handle, password):
    try:
        return summary(scan_archive(handle, password))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, "This portable Vault archive could not be verified. Check its password and file. No Vault data was changed.") from exc
