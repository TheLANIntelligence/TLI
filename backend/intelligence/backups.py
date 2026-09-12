"""Portable, owner-scoped Notebook & history archives; never restore live data."""
from __future__ import annotations

import base64
from collections import OrderedDict
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time
import zipfile

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from fastapi import HTTPException

import data_protection
import tli_state as S
from intelligence import data_health
from intelligence.store import LOCK

PROTOCOL = "tli-notebook-history-backup-v1"
MAGIC = b"TLI-NOTEBOOK-HISTORY\x00\x01"
MAX_SOURCE_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_ENTRY_BYTES = 16 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
ENTRY_NAMES = ("account.json", "notebook.json", "conversations.json", "diagnostics.json")
ALL_NAMES = ("manifest.json", *ENTRY_NAMES)
PROTOCOL_V2 = "tli-saved-work-backup-v2"
MAGIC_V2 = b"TLI-NOTEBOOK-HISTORY\x00\x02"
SCOPE = "Notebook & history backup"
SCOPE_ID = "owner-notebook-history"
INCLUDED_IDS = ["notebook", "ai_conversations", "saved_diagnostics", "account_metadata"]
EXCLUDED_IDS = ["vault", "host_credentials_and_keys", "companion_credentials", "other_owners",
                "unowned_device_memory_and_lan_chat", "models_and_configuration", "external_files", "other_saved_areas"]
INCLUDED = ["All saved Notebook records for the exporting account, including legacy and deleted records retained in its store",
            "All saved AI conversations owned by that account, with their messages and saved provenance",
            "All saved diagnostic reports for that account",
            "Exporting account label, source host label, TLI version, export time and original ownership associations"]
EXCLUDED = ["Vault files, Vault metadata, secrets and passphrases",
            "Host PIN, passwords, encryption keys and cryptographic node identity",
            "Companion pairing credentials and sessions",
            "Other accounts' Notebook, conversations and reports",
            "Unowned legacy device memory and LAN chat threads",
            "Models, runtime binaries, device settings, automations and installation configuration",
            "Image or screenshot files, original document attachments and other filesystem files",
            "Activity review, cleanup receipts, saved places, storage scan history and other stores outside the three named saved-data areas"]
LIMITATIONS = ["This is an owner-scoped Notebook & history backup, not a whole-installation backup.",
               "The archive password is required to decrypt it. TLI cannot recover a lost password.",
               "Verification checks archive integrity and readable saved-data formats in an isolated copy. It does not run or restore a live TLI installation.",
               "Recovery requires a separate review and explicit account mapping into a new copy. Verification itself does not recover, import or merge data.",
               "Archived messages may reference excluded files or devices. Those external resources are not restored by this archive."]


def format_spec(version=1):
    if type(version) is not int or version not in (1, 2):
        raise ValueError("Unsupported saved-work format")
    return {"version": version, "protocol": PROTOCOL if version == 1 else PROTOCOL_V2,
            "names": ENTRY_NAMES if version == 1 else (*ENTRY_NAMES, "cases.json"),
            "magic": MAGIC if version == 1 else MAGIC_V2,
            "scope": SCOPE if version == 1 else "Saved work backup",
            "scope_id": SCOPE_ID if version == 1 else "owner-saved-work",
            "included_ids": INCLUDED_IDS if version == 1 else [*INCLUDED_IDS, "troubleshooting"],
            "included": INCLUDED if version == 1 else [*INCLUDED, "Troubleshooting problems, attempted steps, user-confirmed outcomes and evidence pointers for the exporting account"],
            "excluded": EXCLUDED if version == 1 else [*EXCLUDED[:-1], EXCLUDED[-1].replace("three named", "four named")],
            "limitations": LIMITATIONS if version == 1 else [LIMITATIONS[0].replace("Notebook & history", "saved-work"), *LIMITATIONS[1:], "Troubleshooting links retain their original revision and may be changed or unavailable after recovery; no diagnosis or action is repeated."]}

_operation_lock = threading.Lock()
_recent_requests: OrderedDict[tuple[str, str], float] = OrderedDict()
_REQUEST_TTL = 30 * 60
_MAX_REQUESTS = 256


@contextmanager
def operation():
    if not _operation_lock.acquire(blocking=False):
        raise HTTPException(409, "A Notebook & history backup operation is already running. Wait for it to finish; no automatic retry was started.")
    try:
        yield
    finally:
        _operation_lock.release()


def claim_request(owner, request_id):
    """Called under operation(); retain only bounded request IDs, never payloads."""
    if not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{16,80}", request_id):
        raise HTTPException(422, "Use a new valid backup request identifier.")
    now = time.monotonic()
    while _recent_requests and next(iter(_recent_requests.values())) < now - _REQUEST_TTL:
        _recent_requests.popitem(last=False)
    key = (owner, request_id)
    if key in _recent_requests:
        raise HTTPException(409, "This backup request was already handled or attempted. Check its result before explicitly starting a new request.")
    _recent_requests[key] = now
    while len(_recent_requests) > _MAX_REQUESTS:
        _recent_requests.popitem(last=False)


def password_bytes(password):
    try:
        valid = isinstance(password, str) and 12 <= len(password) <= 1024 and bool(password.strip())
        raw = password.encode("utf-8", errors="strict") if valid else b""
    except UnicodeError:
        raw = b""
    if not raw or len(raw) > 1024:
        raise HTTPException(422, "Use a backup password with at least 12 characters and no more than 1024 UTF-8 bytes.")
    return raw


def _key(password, salt):
    # Fixed by format version; uploaded archives cannot request arbitrary KDF
    # cost or downgrade its parameters. Random salt prevents key reuse.
    return Scrypt(salt=salt, length=32, n=131072, r=8, p=1).derive(password_bytes(password))


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _load_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    def invalid_constant(_):
        raise ValueError("Non-JSON number")
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid_constant)


def _validate_data(kind, value, owner):
    if kind == "cases":
        from intelligence.cases import validate_store
        return validate_store(value)
    data_health._valid(value, kind, owner)
    if kind == "conversations":
        allowed = {owner, "bundled-ai"} if owner == "local" else {owner}
        for ident, conversation in value.items():
            if not isinstance(ident, str) or not ident or conversation.get("user_id") not in allowed:
                raise ValueError("Invalid conversation ownership")
            for turn in conversation.get("messages", []):
                if not isinstance(turn, dict) or turn.get("role") not in ("user", "assistant", "system") or not isinstance(turn.get("content"), str):
                    raise ValueError("Invalid conversation message")
    return len(value["facts"]) if kind == "notebook" else len(value)


def _read_existing(path, key_name, *, aad=None, encrypted_required=False, source_limit=None):
    limit = MAX_SOURCE_BYTES if source_limit is None else source_limit
    try:
        with Path(path).open("rb") as handle:
            raw = handle.read(limit + 1)
    except FileNotFoundError:
        return None, "not_created"
    if len(raw) > limit:
        label = "the 16 MiB backup limit" if source_limit is None else "its encrypted-envelope backup read limit"
        raise HTTPException(413, f"A saved data store exceeds {label}. No partial archive was created; preserve the original store.")
    value = _load_json(raw)
    if isinstance(value, dict) and value.get("_tli_enc"):
        if value.get("_tli_enc") != 1:
            raise ValueError("Unsupported encryption envelope")
        blob = base64.b64decode(value["data"], validate=True)
        key = data_protection.load_existing_key(Path(S.DATA_DIR) / key_name)
        value = _load_json(AESGCM(key).decrypt(blob[:12], blob[12:], aad))
        return value, "encrypted"
    if encrypted_required:
        raise ValueError("Unsupported plaintext diagnostic store")
    return value, "legacy_plaintext"


def _snapshot(owner, version=1):
    if not isinstance(owner, str) or not owner or len(owner) > 256:
        raise HTTPException(422, "The current account label cannot be represented in this backup format.")
    # Lock only while reading. KDF and archive verification do not hold the
    # application's store locks or create/replace any source key.
    with LOCK, S.CONVERSATIONS_LOCK:
        try:
            notes, note_format = _read_existing(S.memory_path_for_user(owner), "memory_key.bin")
            conversations, conv_format = _read_existing(S.CONVERSATIONS_FILE, "conversations_key.bin")
            diagnostics, diagnostic_format = _read_existing(
                Path(S.DATA_DIR) / "intelligence" / f"diagnostics-{hashlib.sha256(owner.encode()).hexdigest()}.json",
                "memory_key.bin", aad=f"diagnostics:{owner}".encode(), encrypted_required=True)
            if conversations is not None and (not isinstance(conversations, dict) or any(not isinstance(c, dict) for c in conversations.values())):
                raise ValueError("Invalid conversation store")
            allowed = {owner, "bundled-ai"} if owner == "local" else {owner}
            conversations = {ident: value for ident, value in (conversations or {}).items() if value.get("user_id") in allowed}
            values = {"notebook.json": notes if notes is not None else {"facts": [], "last_updated": None},
                      "conversations.json": conversations, "diagnostics.json": diagnostics if diagnostics is not None else []}
            counts = {kind: _validate_data(kind, values[kind + ".json"], owner) for kind in ("notebook", "conversations", "diagnostics")}
            if version == 2:
                from intelligence.cases import MAX_BYTES, read_all
                read_all(owner)  # Same no-replacement/link/missing-key guards as the normal reader.
                cases, case_format = _read_existing(
                    Path(S.DATA_DIR) / "intelligence" / f"cases-{hashlib.sha256(owner.encode()).hexdigest()}.json",
                    "memory_key.bin", aad=f"cases:{owner}".encode(), encrypted_required=True,
                    # Match the normal cases reader's bounded base64 envelope;
                    # decrypted data still passes its 16 MiB validation below.
                    source_limit=MAX_BYTES * 4 // 3 + 4096)
                values["cases.json"] = cases if cases is not None else {"version": 1, "cases": [], "creates": {}}
                counts["cases"] = _validate_data("cases", values["cases.json"], owner)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, "Notebook & history backup could not read all selected saved stores or their matching keys. No partial backup was created and originals were preserved. Check saved data before trying again.") from exc
    exported_at = datetime.now(timezone.utc).isoformat()
    formats = {"notebook": note_format, "conversations": conv_format, "diagnostics": diagnostic_format}
    if version == 2:
        formats["cases"] = case_format
    values["account.json"] = {"owner_id": owner, "conversation_owner_ids": sorted(allowed),
                              "exported_at": exported_at, "tli_version": str(S.TLI_VERSION),
                              "source_host": data_health._host(), "source_formats": formats}
    return values, counts, exported_at


def _pack(values, counts, exported_at, version=1):
    spec = format_spec(version)
    names = spec["names"]
    encoded = {name: _json(values[name]) for name in names}
    if any(len(raw) > MAX_ENTRY_BYTES for raw in encoded.values()):
        raise HTTPException(413, "A saved-data export exceeds the 16 MiB per-area limit. No partial archive was created.")
    manifest = {"schema_version": version, "protocol": spec["protocol"], "scope": spec["scope"], "created_at": exported_at,
                "scope_id": spec["scope_id"], "included_areas": spec["included_ids"], "excluded_areas": EXCLUDED_IDS,
                "included": spec["included"], "excluded": spec["excluded"], "limitations": spec["limitations"],
                "entries": [{"name": name, "bytes": len(encoded[name]), "sha256": hashlib.sha256(encoded[name]).hexdigest(),
                             "records": counts.get(name.removesuffix(".json"), 1)} for name in names]}
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        archive.writestr("manifest.json", _json(manifest))
        for name in names:
            archive.writestr(name, encoded[name])
    raw = stream.getvalue()
    if len(raw) + len(MAGIC) + 44 > MAX_ARCHIVE_BYTES:
        raise HTTPException(413, "The Notebook & history archive exceeds the 64 MiB limit. No partial archive was created.")
    return raw


def _encrypt(raw, password, version=1):
    salt, nonce = os.urandom(16), os.urandom(12)
    header = format_spec(version)["magic"] + salt + nonce
    return header + AESGCM(_key(password, salt)).encrypt(nonce, raw, header)


def create_archive(owner, password, format=None):
    password_bytes(password)
    if format not in (None, "saved-work-v2"):
        raise HTTPException(422, "Choose a supported saved-work backup format.")
    version = 2 if format == "saved-work-v2" else 1
    values, counts, exported_at = _snapshot(owner, version)
    raw = _pack(values, counts, exported_at, version)
    _validate_entries(_unpack(raw))
    encrypted = _encrypt(raw, password, version)
    return encrypted


def _decrypt(blob, password):
    if not isinstance(blob, bytes) or len(blob) > MAX_ARCHIVE_BYTES:
        raise HTTPException(413, "Choose a Notebook & history backup file no larger than 64 MiB.")
    size = len(MAGIC) + 16 + 12
    if len(blob) <= size + 16 or not blob.startswith((MAGIC, MAGIC_V2)):
        raise HTTPException(422, "This is not a supported Notebook & history backup archive.")
    header, encrypted = blob[:size], blob[size:]
    salt, nonce = header[len(MAGIC):len(MAGIC) + 16], header[-12:]
    try:
        return AESGCM(_key(password, salt)).decrypt(nonce, encrypted, header)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, "The archive could not be decrypted. Check its password and whether the file is complete and unchanged.") from exc


def _unpack(raw):
    """Reject compression, paths, duplicates, links, excess entries and bytes."""
    with zipfile.ZipFile(io.BytesIO(raw), "r") as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)) or set(names) not in (set(ALL_NAMES), {*ALL_NAMES, "cases.json"}):
            raise ValueError("Unexpected archive entries")
        entries = {}
        for info in infos:
            limit = MAX_MANIFEST_BYTES if info.filename == "manifest.json" else MAX_ENTRY_BYTES
            file_type = (info.external_attr >> 16) & 0o170000
            if (info.orig_filename != info.filename or info.compress_type != zipfile.ZIP_STORED or info.flag_bits & 1 or info.is_dir()
                    or file_type not in (0, 0o100000) or info.file_size > limit
                    or info.compress_size != info.file_size):
                raise ValueError("Unsupported archive member")
            with archive.open(info) as member:
                content = member.read(limit + 1)
            if len(content) != info.file_size or len(content) > limit:
                raise ValueError("Invalid archive member size")
            entries[info.filename] = content
    return entries


def _check_version(blob, entries):
    manifest = _load_json(entries["manifest.json"])
    if format_spec(manifest.get("schema_version"))["magic"] != blob[:len(MAGIC)]:
        raise ValueError("Archive envelope differs from the declared scope version")


def _validate_entries(entries):
    manifest = _load_json(entries["manifest.json"])
    spec = format_spec(manifest.get("schema_version") if isinstance(manifest, dict) else None)
    names = spec["names"]
    if set(entries) != {"manifest.json", *names}:
        raise ValueError("Archive entries differ from its declared version")
    def prose(value):
        return isinstance(value, list) and 1 <= len(value) <= 12 and all(isinstance(line, str) and 1 <= len(line) <= 3000 for line in value)
    if (not isinstance(manifest, dict) or set(manifest) != {"schema_version", "protocol", "scope", "scope_id", "included_areas", "excluded_areas", "created_at", "included", "excluded", "limitations", "entries"}
            or manifest.get("protocol") != spec["protocol"]
            or manifest.get("scope_id") != spec["scope_id"] or manifest.get("included_areas") != spec["included_ids"] or manifest.get("excluded_areas") != EXCLUDED_IDS
            or not isinstance(manifest.get("scope"), str) or not 1 <= len(manifest["scope"]) <= 120
            or not all(prose(manifest.get(field)) for field in ("included", "excluded", "limitations"))):
        raise ValueError("Unsupported recovery scope")
    rows = manifest.get("entries")
    if not isinstance(rows, list) or len(rows) != len(names) or {row.get("name") for row in rows if isinstance(row, dict)} != set(names):
        raise ValueError("Invalid manifest")
    for row in rows:
        if set(row) != {"name", "bytes", "sha256", "records"}:
            raise ValueError("Invalid manifest fields")
        raw = entries[row["name"]]
        if type(row.get("bytes")) is not int or row["bytes"] != len(raw) or row.get("sha256") != hashlib.sha256(raw).hexdigest():
            raise ValueError("Manifest checksum mismatch")
    values = {name: _load_json(entries[name]) for name in names}
    account = values["account.json"]
    if (not isinstance(account, dict) or set(account) != {"owner_id", "conversation_owner_ids", "exported_at", "tli_version", "source_host", "source_formats"}
            or not isinstance(account.get("owner_id"), str)
            or not 1 <= len(account["owner_id"]) <= 256 or not isinstance(account.get("tli_version"), str)
            or not 1 <= len(account["tli_version"]) <= 64 or not isinstance(account.get("exported_at"), str)
            or not 1 <= len(account["exported_at"]) <= 64 or account.get("exported_at") != manifest.get("created_at")):
        raise ValueError("Invalid account metadata")
    datetime.fromisoformat(account["exported_at"])
    owner = account["owner_id"]
    if account.get("conversation_owner_ids") != sorted({owner, "bundled-ai"} if owner == "local" else {owner}):
        raise ValueError("Invalid ownership mapping")
    host = account.get("source_host")
    if not isinstance(host, dict) or set(host) != {"id", "name"} or any(not isinstance(host.get(key), str) or not 1 <= len(host[key]) <= 256 for key in ("id", "name")):
        raise ValueError("Invalid source host")
    formats = account.get("source_formats")
    kinds = ("notebook", "conversations", "diagnostics") + (("cases",) if spec["version"] == 2 else ())
    if not isinstance(formats, dict) or set(formats) != set(kinds) or any(value not in ("not_created", "encrypted", "legacy_plaintext") for value in formats.values()):
        raise ValueError("Invalid original formats")
    counts = {kind: _validate_data(kind, values[kind + ".json"], owner) for kind in kinds}
    if any(formats.get(kind) == "legacy_plaintext" for kind in ("diagnostics", "cases")) or any(formats[kind] == "not_created" and count for kind, count in counts.items()):
        raise ValueError("Inconsistent source formats")
    if formats.get("cases") == "not_created" and values["cases.json"] != {"version": 1, "cases": [], "creates": {}}:
        raise ValueError("Uncreated troubleshooting store contains retained metadata")
    for row in rows:
        if type(row.get("records")) is not int or row["records"] != counts.get(row["name"].removesuffix(".json"), 1):
            raise ValueError("Invalid record count")
    return manifest, account, counts


def _isolated_readback(entries):
    # Even temporary filesystem entries remain encrypted. The verification key
    # exists only in memory, is unrelated to live keys and is never exported.
    key = AESGCM(os.urandom(32))
    with tempfile.TemporaryDirectory(prefix="tli-backup-verify-") as directory:
        root = Path(directory)
        for name in entries:
            nonce = os.urandom(12)
            (root / (name + ".enc")).write_bytes(nonce + key.encrypt(nonce, entries[name], name.encode()))
        restored = {}
        for name in entries:
            with (root / (name + ".enc")).open("rb") as handle:
                blob = handle.read(MAX_ENTRY_BYTES + MAX_MANIFEST_BYTES + 29)
            restored[name] = key.decrypt(blob[:12], blob[12:], name.encode())
            if restored[name] != entries[name]:
                raise ValueError("Isolated copy mismatch")
        return _validate_entries(restored)


def verify_archive(blob, password):
    password_bytes(password)
    raw = _decrypt(blob, password)
    try:
        entries = _unpack(raw)
        _check_version(blob, entries)
        _validate_entries(entries)
        manifest, account, counts = _isolated_readback(entries)
    except Exception as exc:
        raise HTTPException(422, "Archive integrity or saved-data compatibility verification failed. No live data was restored or changed.") from exc
    # Stable scope IDs define compatibility. Descriptions may evolve without
    # rejecting old archives, and uploaded prose cannot invent recovery scope.
    spec = format_spec(manifest["schema_version"])
    display_manifest = {**manifest, **{key: spec[key] for key in ("scope", "included", "excluded", "limitations")}}
    return {"ok": True, "schema_version": spec["version"], "protocol": spec["protocol"],
            "checked_at": datetime.now(timezone.utc).isoformat(), "archive_sha256": hashlib.sha256(blob).hexdigest(),
            "archive_integrity": "verified", "contents_readable": True, "restored_live": False,
            "recovery_scope": spec["scope"], "source": account, "counts": counts, "manifest": display_manifest,
            "detail": "This uploaded Notebook & history backup decrypted successfully and its saved-data formats were read back from an isolated encrypted temporary copy. A live TLI restoration has not been performed."}
