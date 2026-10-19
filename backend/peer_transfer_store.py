"""Bounded encrypted transfer store. No sender-supplied filesystem paths.

All files belong to this store; existing files and unreadable state are never
replaced with an empty store. Callers serialize transactions with LOCK.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import threading

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import tli_state as S
from peer_trust import fail, canonical
from peer_transfer_paths import Directory, make_directory, ordinary

LOCK = threading.RLock()
MAX_FILE = 250 * 1024 * 1024
CHUNK = 64 * 1024
MAX_RAW = 1024 * 1024 * 1024
MAX_DISK = 2 * 1024 * 1024 * 1024
MAX_RECORDS = 256
MAX_META = 1024 * 1024


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
        fail(422, "invalid_transfer_id", "Invalid transfer identifier.")
    return value


def filename(value):
    try:
        encoded_size = len(value.encode("utf-8")) if isinstance(value, str) else 0
    except UnicodeError:
        fail(422, "invalid_filename", "The filename contains invalid Unicode.")
    if (not isinstance(value, str) or not 1 <= len(value) <= 180
            or encoded_size > 220 or value != value.strip()
            or value.endswith(".") or value in (".", "..")
            or re.search(r'[<>:"/\\|?*\x00-\x1f\x7f]', value)
            or value.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(10)], *[f"LPT{i}" for i in range(10)]}):
        fail(422, "invalid_filename", "Choose a plain filename without path separators or reserved names.")
    return value


def root():
    return Path(S.MESH_DATA_DIR) / "secure_transfers"


def inspect(path, missing=False):
    """Lexical ancestors must be real directories, never symlinks/junctions."""
    for part in reversed((path, *path.parents)):
        try:
            info = part.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("linked transfer storage")
        if part != path and not stat.S_ISDIR(info.st_mode):
            raise ValueError("invalid transfer parent")
        if part == path and stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
            raise ValueError("linked transfer file")


def unavailable():
    fail(503, "transfer_storage_unavailable", "Encrypted transfer storage is unavailable. Existing files were preserved; check Data & Recovery.")


def read_bytes(path, maximum):
    try:
        with Directory(path.parent) as directory:
            ordinary(directory.info(path.name))
            fd = directory.open(path.name, os.O_RDONLY)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError()
                raw = stream.read(maximum + 1)
                current = directory.info(path.name)
                ordinary(current)
                if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino) or len(raw) > maximum:
                    raise ValueError()
                return raw
    except Exception:
        unavailable()


def write_bytes(path, raw, *, exclusive=False):
    try:
        with Directory(path.parent) as directory:
            temporary = path.name if exclusive else path.name + "." + secrets.token_hex(12) + ".tmp"
            created_identity = None
            try:
                try: ordinary(directory.info(path.name))
                except FileNotFoundError: pass
                fd = directory.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
                with os.fdopen(fd, "wb") as stream:
                    info = os.fstat(stream.fileno())
                    created_identity = (info.st_dev, info.st_ino)
                    if stream.write(raw) != len(raw):
                        raise OSError("Incomplete transfer write")
                    stream.flush(); os.fsync(stream.fileno())
                if not exclusive:
                    try: ordinary(directory.info(path.name))
                    except FileNotFoundError: pass
                    directory.replace(temporary, path.name)
                directory.sync()
            except Exception:
                if not exclusive and created_identity is not None:
                    try:
                        current = directory.info(temporary); ordinary(current)
                        if (current.st_dev, current.st_ino) == created_identity:
                            directory.unlink(temporary)
                    except (OSError, ValueError):
                        pass
                raise
    except Exception:
        unavailable()


def load_json(path):
    raw = read_bytes(path, MAX_META)
    try:
        envelope = json.loads(raw)
        if not isinstance(envelope, dict) or envelope.get("_tli_enc") != 1:
            raise ValueError()
        value = S.decrypt_jsonl_line(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except Exception:
        unavailable()


def save_json(path, value):
    raw = S.encrypt_jsonl_line(value).encode("utf-8")
    if len(raw) > MAX_META:
        unavailable()
    write_bytes(path, raw)


def index(*, create=False):
    path = root() / "index.jsonl"
    try:
        inspect(root(), missing=True)
        # A failed temporary cleanup is recovery-needed, never unlimited retries.
        if root().exists():
            with Directory(root()) as directory:
                if any(name.endswith(".tmp") for name in directory.names()):
                    unavailable()
        if not path.exists():
            with S._NODE_CONFIG_LOCK:
                from node_settings import assert_available
                assert_available(S.NODE_CONFIG_PATH)
                cfg = S._security.read_json(S.NODE_CONFIG_PATH, "node configuration", 1024 * 1024)
                if cfg.get("peer_transfers_established") or root().exists():
                    unavailable()
                if not create:
                    return {"version": 1, "records": {}}
                # Key must be established before publishing the durable marker.
                S.get_chat_key()
                cfg["peer_transfers_established"] = True
                S._security.write_json(S.NODE_CONFIG_PATH, cfg, "node configuration")
                make_directory(root())
                save_json(path, {"version": 1, "records": {}})
        value = load_json(path)
        records = value.get("records")
        if value.get("version") != 1 or not isinstance(records, dict) or len(records) > MAX_RECORDS:
            unavailable()
        for key, row in records.items():
            identifier(key)
            if (not isinstance(row, dict) or not isinstance(row.get("owner"), str)
                    or type(row.get("reserved")) is not int or not 0 <= row["reserved"] <= MAX_FILE):
                unavailable()
        return value
    except Exception:
        unavailable()


def save_index(value):
    save_json(root() / "index.jsonl", value)


def load(transfer_id):
    identifier(transfer_id)
    idx = index()
    if transfer_id not in idx["records"]:
        fail(404, "transfer_not_found", "Transfer not found.")
    result = load_json(root() / (transfer_id + ".jsonl"))
    if result.get("id") != transfer_id or result.get("owner") != idx["records"][transfer_id]["owner"]:
        unavailable()
    return result


def save(record):
    save_json(root() / (identifier(record["id"]) + ".jsonl"), record)


def create(record):
    idx = index(create=True)
    if record["id"] in idx["records"]:
        fail(409, "transfer_exists", "This transfer identifier is already recorded.")
    if len(idx["records"]) >= MAX_RECORDS or sum(x["reserved"] for x in idx["records"].values()) + record["size"] > MAX_RAW:
        fail(429, "transfer_capacity", "The bounded transfer Inbox is full. Discard unneeded transfers before starting another.")
    disk_usage = 0
    with Directory(root()) as directory:
        for count, name in enumerate(directory.names()):
            if count >= 70000:
                unavailable()
            info = directory.info(name); ordinary(info)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                unavailable()
            disk_usage += info.st_size
    # Reserve encrypted expansion and metadata, including orphaned attempts.
    reserved = sum(x["reserved"] for x in idx["records"].values()) + record["size"]
    if max(disk_usage + record["size"] + 1024 * 1024, reserved * 2 + MAX_RECORDS * MAX_META) > MAX_DISK:
        fail(429, "transfer_capacity", "Encrypted transfer storage has reached its bound.")
    idx["records"][record["id"]] = {"owner": record["owner"], "reserved": record["size"]}
    # Index first: a crash cannot hide a reserved incomplete record.
    save_index(idx)
    save(record)


def chunk_path(record, number):
    if type(number) is not int or not 0 <= number < MAX_FILE // CHUNK:
        fail(422, "invalid_chunk", "Invalid chunk index.")
    return root() / f"{identifier(record['id'])}.{number:04d}.blob"


def write_chunk(record, number, raw, checksum):
    nonce = os.urandom(12)
    aad = canonical([record["id"], number, checksum])
    encrypted = nonce + AESGCM(S.get_chat_key()).encrypt(nonce, raw, aad)
    write_bytes(chunk_path(record, number), encrypted, exclusive=True)


def read_chunk(record, number):
    raw = read_bytes(chunk_path(record, number), CHUNK + 28)
    try:
        checksum = record["chunks"][number]
        plain = AESGCM(S._store_key("chat_key.bin")).decrypt(raw[:12], raw[12:], canonical([record["id"], number, checksum]))
        if hashlib.sha256(plain).hexdigest() != checksum:
            raise ValueError()
        return plain
    except Exception:
        unavailable()


def discard(record, check):
    # Journal cancellation before deleting only this exact store's known names.
    record["state"] = "discarded"
    save(record)
    with Directory(root()) as directory:
        for number in range((record["size"] + CHUNK - 1) // CHUNK):
            check()
            path = chunk_path(record, number)
            try:
                info = directory.info(path.name)
            except FileNotFoundError:
                continue
            ordinary(info)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                unavailable()
            directory.unlink(path.name)
        directory.sync()
    idx = index()
    idx["records"][record["id"]]["reserved"] = 0
    save_index(idx)


def forget_expired(record):
    """Only an explicitly discarded expired offer can release its tombstone."""
    import time
    if record["state"] != "discarded" or record["expires_at"] + 60 >= time.time():
        return
    idx = index()
    del idx["records"][record["id"]]
    # Remove the index last: interrupted cleanup remains visibly unavailable.
    path = root() / (identifier(record["id"]) + ".jsonl")
    with Directory(root()) as directory:
        info = directory.info(path.name); ordinary(info)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            unavailable()
        directory.unlink(path.name)
        directory.sync()
    save_index(idx)
