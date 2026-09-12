"""Reviewed portable Vault recovery into a new, unpublished installation root."""
from __future__ import annotations

import base64
from collections import OrderedDict
import errno
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException

import vault_backup as archive
import vault_security as security
from intelligence import recovery as paths

REVIEWS = OrderedDict()
TTL = 600
ORIGIN = "data/vault-backup-origin.enc"
ORIGIN_AAD = b"tli-vault-recovery-origin-v1"


def available():
    from vault_backup_readback import ensure_available
    try:
        ensure_available()
    except Exception as exc:
        raise HTTPException(409, "Vault recovery checking requires a ZIP/source Python installation for this checkpoint. This packaged runtime cannot create verified recovery copies.") from exc


def stream_hash(handle):
    handle.seek(0)
    digest = hashlib.sha256()
    total = 0
    for chunk in iter(lambda: handle.read(archive.CHUNK), b""):
        total += len(chunk)
        if total > archive.MAX_ARCHIVE:
            raise HTTPException(413, "The portable Vault archive is larger than the supported limit.")
        digest.update(chunk)
    handle.seek(0)
    return digest.hexdigest()


def _space(target, manifest):
    needed = manifest["total_bytes"] + len(manifest["entries"]) * 4096 + archive.MAX_MANIFEST + archive.RESERVE
    if shutil.disk_usage(target.parent).free < needed:
        raise HTTPException(507, "The destination drive does not have enough free space for this separate Vault copy.")


def review(handle, password, owner, destination):
    available()  # Before decoding, destination staging or subprocess creation.
    target = paths._destination(destination)
    digest = stream_hash(handle)
    try:
        manifest = archive.scan_archive(handle, password)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, "The portable Vault archive could not be verified for recovery. No destination was created.") from exc
    _space(target, manifest)
    if stream_hash(handle) != digest:
        raise HTTPException(409, "The archive changed during review. No destination was created.")
    now = time.monotonic()
    for token, value in list(REVIEWS.items()):
        if value["expires"] <= now:
            REVIEWS.pop(token, None)
    while len(REVIEWS) >= 64:
        REVIEWS.popitem(last=False)
    token = secrets.token_urlsafe(32)
    REVIEWS[token] = {"owner": owner, "digest": digest, "destination": str(target.path),
                      "ancestors": target.ancestors, "expires": now + TTL}
    return {**archive.summary(manifest), "review_token": token, "expires_in_seconds": TTL,
            "archive_sha256": digest, "destination": str(target.path), "recovered_owner": "local",
            "limitations": limitations(), "reviewed": True, "created": False}


def limitations():
    return ["Creates a separate data folder, not a TLI executable or an activated installation.",
            "Recovered shared files and notes remain shared; the archived account's secrets and logins map to the new local account.",
            "A new Vault passphrase protects the copy. It starts locked with extension access disabled; the original passphrase and unlock sessions are not copied.",
            "The copy has no TLI PIN or network credentials. Set up TLI access protection before separately activating or sharing it.",
            "No existing folder, live Vault, account or encryption metadata is replaced. Sudden power-loss durability and native packaged activation are not verified."]


class StageLease(paths._StageLease):
    def encrypted(self, relative, key, chunks):
        self.check()
        path = self.stage / relative
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        parent_fd = None if os.name == "nt" else self.handles[Path(relative).parent.as_posix()]
        descriptor = os.open(path if parent_fd is None else path.name, flags, 0o600, dir_fd=parent_fd)
        with os.fdopen(descriptor, "wb") as handle:
            nonce = os.urandom(12)
            handle.write(nonce)
            writer = archive.EncryptedWriter(handle, key, nonce)
            for chunk in chunks:
                writer.write(chunk)
            writer.finish()
            handle.flush()
            os.fsync(handle.fileno())
        self.check()


def _new_metadata(password):
    archive.password_bytes(password)
    salt, hashed = security._hash_password(password)
    encryption_salt = os.urandom(16)
    now = security._now().isoformat()
    meta = {"password_salt": base64.b64encode(salt).decode("ascii"),
            "password_hash": base64.b64encode(hashed).decode("ascii"),
            "encryption_salt": base64.b64encode(encryption_salt).decode("ascii"),
            "failed_attempts": 0, "locked_until": None, "created_at": now, "updated_at": now}
    return meta, security._derive_encryption_key(password, encryption_salt)


def snapshot(stage, manifest):
    names = ["vault_meta.json", ORIGIN] + ["data/vault/" + entry["name"] for entry in manifest["entries"]]
    return {name: archive.file_hash(stage / name) for name in names}


def create(handle, password, owner, destination, review_token, new_password, authorize=None):
    available()
    if authorize:
        authorize()
    archive.password_bytes(new_password)
    if not isinstance(review_token, str) or len(review_token) > 128:
        raise HTTPException(409, "Review the archive and destination first.")
    reviewed = REVIEWS.pop(review_token, None)
    if not reviewed or reviewed["expires"] <= time.monotonic() or reviewed["owner"] != owner:
        raise HTTPException(409, "This Vault recovery review expired, was used or belongs to another account. Review again.")
    target = paths._destination(destination, conflict=True)
    if (str(target.path) != reviewed["destination"] or target.ancestors != reviewed["ancestors"]
            or stream_hash(handle) != reviewed["digest"]):
        raise HTTPException(409, "The archive or destination changed after review. Review again; no copy was created.")
    try:
        manifest = archive.scan_archive(handle, password)
    except Exception as exc:
        raise HTTPException(422, "The reviewed Vault archive could not be authenticated. No recovery copy was created.") from exc
    _space(target, manifest)
    meta, key = _new_metadata(new_password)
    stage, identity = None, None
    try:
        with paths._ParentLease(target) as parent:
            stage = target.parent / (".tli-recovery-" + secrets.token_hex(16))
            parent.mkdir(stage.name)
            identity = paths._identity(stage.lstat())
            with StageLease(stage, identity, parent) as lease:
                lease.write("vault_meta.json", archive.json_bytes(meta))
                origin = {"schema_version": 1, "source_owner": manifest["source_owner"],
                          "recovered_owner": "local", "archive_sha256": reviewed["digest"],
                          "manifest_sha256": hashlib.sha256(archive.json_bytes(manifest)).hexdigest()}
                nonce = os.urandom(12)
                lease.write(ORIGIN, nonce + AESGCM(key).encrypt(nonce, archive.json_bytes(origin), ORIGIN_AAD))
                def save(entry, chunks):
                    if authorize:
                        authorize()
                    lease.encrypted("data/vault/" + entry["name"], key, chunks)
                written_manifest = archive.scan_archive(handle, password, save)
                if written_manifest != manifest or stream_hash(handle) != reviewed["digest"]:
                    raise ValueError("The archive changed during recovery")
                before = snapshot(stage, manifest)
                from vault_backup_readback import run_readback
                checked = run_readback(stage, new_password, manifest, origin)
                expected_counts = archive.summary(manifest)["counts"]
                if (checked.get("ok") is not True or checked.get("reader") != "current-application"
                        or checked.get("counts") != expected_counts or checked.get("checks") != {
                            "passphrase_authenticated": True, "current_readers": True, "exact_content": True,
                            "owner_mapping": True, "locked_without_sessions": True, "files_unchanged": True}):
                    raise ValueError("Current-reader check did not confirm recovery")
                lease.check()
                parent.check()
                if snapshot(stage, manifest) != before:
                    raise ValueError("Recovered files changed during verification")
                result = {**archive.summary(manifest), "created": True, "restored": False,
                          "destination": str(target.path), "archive_sha256": reviewed["digest"],
                          "recovered_owner": "local", "completed_at": archive.iso(), "readback": checked,
                          "limitations": limitations()}
                lease.write("vault-recovery-receipt.json", archive.json_bytes(result))
                if snapshot(stage, manifest) != before:
                    raise ValueError("Recovered files changed before publication")
                parent.check()
                if authorize:
                    authorize()
                lease.finish_writes()
                lease.check()
                paths._atomic_publish(stage, target.path, parent)
                stage = None
                return result
    except HTTPException:
        raise
    except FileExistsError as exc:
        raise HTTPException(409, "The destination appeared after review. It was preserved; choose a new folder.") from exc
    except Exception as exc:
        status = 507 if isinstance(exc, OSError) and exc.errno in (errno.ENOSPC, errno.EDQUOT) else 503
        raise HTTPException(status, "The separate Vault copy could not be safely written and verified. No copy was published or activated. The original Vault and existing destination were preserved.") from exc
    finally:
        paths._cleanup(stage, identity, target)
