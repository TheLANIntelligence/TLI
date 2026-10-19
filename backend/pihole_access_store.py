"""Append-only device approvals and guest command reservations.

Only hashes of guest credentials are stored. Grants, revocations, command
reservations and receipt links are immutable. A command reservation precedes
receipt creation; its link must be durable before the caller can issue a PUT.
An interruption between those writes is deliberately not recoverable by retry.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
from threading import RLock

from fastapi import HTTPException

import pihole_receipts
import tli_state as S

MAX_GRANTS = 256
MAX_COMMANDS = 128
MAX_BYTES = 256 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024
LOCK = RLock()
_SEEN = {}
_UNCERTAIN = set()
_ID = re.compile(r"[0-9a-f]{32}\Z")
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_CLIENT_KEYS = {"id", "client", "comment", "groups", "date_added", "date_modified", "editable"}
_GROUP_KEYS = {"id", "name", "enabled", "description", "date_added", "date_modified"}
_GRANT_KEYS = {"id", "owner", "token_hash", "pin_stamp", "origin", "tls_mode", "pin", "client", "groups", "name", "created_at"}


def unavailable():
    return HTTPException(503, "Saved Pi-hole device access is unavailable or a save could not be confirmed. "
                         "Existing evidence was preserved. Stop TLI and review the saved records before restarting; do not repeat the change.")


def _check(check):
    if check is not None:
        try:
            check()
        except Exception as error:
            # A broker stopping can use 409 and unavailable protection can use
            # 503. Neither observation implies that disk evidence changed.
            try:
                error._pihole_access_check_failure = True
            except Exception:
                pass
            raise


def _text(value, limit=4096, empty=False):
    return isinstance(value, str) and (empty or bool(value)) and len(value.encode("utf-8")) <= limit


def _ident(value):
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def _iso(value):
    return _text(value, 64) and datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None


def _now():
    return datetime.now(timezone.utc).isoformat()


def _configuration(record):
    from pihole_transport import configuration
    config = configuration(record["origin"], record["pin"])
    if (config["origin"] != record["origin"] or config["fingerprint"] != record["pin"]
            or record["tls_mode"] not in {"system_trust", "certificate_pin"}
            or bool(record["pin"]) != (record["tls_mode"] == "certificate_pin")):
        raise ValueError()


def _client_and_groups(client, groups):
    from pihole_transport import project_clients, project_groups
    if (not isinstance(client, dict) or set(client) != _CLIENT_KEYS
            or not isinstance(groups, list) or len(groups) > 256
            or any(not isinstance(group, dict) or set(group) != _GROUP_KEYS for group in groups)):
        raise ValueError()
    if project_clients({"clients": [client]}) != [client] or client["editable"] is not True:
        raise ValueError()
    address = ipaddress.ip_address(client["client"])
    networks = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16") if address.version == 4 else ("fc00::/7",)
    if not any(address in ipaddress.ip_network(net) for net in networks):
        raise ValueError()
    raw_groups = [{**{key: value for key, value in row.items() if key != "description"},
                   "comment": row["description"]} for row in groups]
    if project_groups({"groups": raw_groups}) != groups or not set(client["groups"]).issubset(row["id"] for row in groups):
        raise ValueError()


def _grant(record):
    if (not isinstance(record, dict) or set(record) != _GRANT_KEYS or not _ident(record["id"])
            or not _text(record["owner"]) or not _text(record["name"], 512)
            or len(record["name"]) > 128 or any(ord(char) < 32 for char in record["name"])
            or not record["name"].strip() or not _iso(record["created_at"])
            or any(not isinstance(record[key], str) or not _HASH.fullmatch(record[key]) for key in ("token_hash", "pin_stamp"))):
        raise ValueError()
    _configuration(record)
    _client_and_groups(record["client"], record["groups"])
    if not record["client"]["groups"]:
        raise ValueError()
    return record


def _command_record(record, grant):
    if (not isinstance(record, dict) or set(record) != {"origin", "tls_mode", "pin", "client", "before", "after_groups", "action"}
            or record["action"] not in {"pause", "restore"}
            or not isinstance(record["before"], dict) or set(record["before"]) != {"clientrecord", "groups"}):
        raise ValueError()
    _configuration(record)
    client = record["before"]["clientrecord"]
    _client_and_groups(client, record["before"]["groups"])
    after = record["after_groups"]
    if (not isinstance(after, list) or len(after) > 256 or any(type(item) is not int or not 0 <= item <= 2**53 - 1 for item in after)
            or len(set(after)) != len(after) or not set(after).issubset(row["id"] for row in record["before"]["groups"])):
        raise ValueError()
    if (any(record[key] != grant[key] for key in ("origin", "tls_mode", "pin"))
            or record["client"] != grant["client"]["client"]
            or any(client[key] != grant["client"][key] for key in ("id", "client", "date_added"))
            or (record["action"] == "pause" and after)
            or (record["action"] == "restore" and set(after) != set(grant["client"]["groups"]))):
        raise ValueError()
    return record


def _encode(value):
    raw = json.dumps(value, allow_nan=False, ensure_ascii=False, sort_keys=True).encode("utf-8")
    if len(raw) > MAX_BYTES:
        raise ValueError()
    return raw


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def _root():
    return Path(S.DATA_DIR).absolute() / "integrations" / "pihole" / "access"


def _plain(info, directory=False):
    return ((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
            and not getattr(info, "st_file_attributes", 0) & 0x400)


def _chain(directory, check, create=False):
    current = Path(directory.anchor)
    for part in directory.parts[1:]:
        _check(check)
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if not create:
                return False
            _check(check)
            current.mkdir()
            _check(check)
            info = current.lstat()
        if not _plain(info, directory=True):
            raise unavailable()
    return True


def _read(path, check):
    _check(check)
    before = path.lstat()
    if not _plain(before) or before.st_size > MAX_BYTES:
        raise unavailable()
    with path.open("rb") as handle:
        opened = os.fstat(handle.fileno())
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino) or not _plain(opened):
            raise unavailable()
        _check(check)
        raw = handle.read(MAX_BYTES + 1)
        after = os.fstat(handle.fileno())
    _check(check)
    latest = path.lstat()
    stamp = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
    if (len(raw) > MAX_BYTES or stamp(before) != stamp(opened) or stamp(opened) != stamp(after)
            or stamp(after) != stamp(latest) or before.st_ctime_ns != latest.st_ctime_ns
            or opened.st_ctime_ns != after.st_ctime_ns or not _plain(latest)):
        raise unavailable()
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    _encode(value)
    return value, hashlib.sha256(raw).hexdigest(), len(raw)


def _files(directory, pattern, limit, check):
    key = str(directory)
    if key in _UNCERTAIN:
        raise unavailable()
    try:
        if not _chain(directory, check):
            if _SEEN.get(key):
                raise unavailable()
            return {}
        entries, hashes, size = {}, {}, 0
        for count, path in enumerate(directory.iterdir()):
            _check(check)
            if count >= limit or not re.fullmatch(pattern, path.name):
                raise unavailable()
            value, digest, length = _read(path, check)
            size += length
            if size > MAX_TOTAL_BYTES:
                raise unavailable()
            entries[path.name], hashes[path.name] = value, digest
        if any(hashes.get(name) != digest for name, digest in _SEEN.get(key, {}).items()):
            raise unavailable()
        _check(check)
        _SEEN[key] = hashes
        return entries
    except Exception as error:
        if not getattr(error, "_pihole_access_check_failure", False):
            _UNCERTAIN.add(key)
        raise


def _publish(directory, name, value, check):
    raw = _encode(value)
    _chain(directory, check, create=True)
    path = directory / name
    _check(check)
    started = False
    try:
        with path.open("xb") as handle:
            started = True
            _check(check)
            if handle.write(raw) != len(raw):
                raise OSError()
            handle.flush()
            os.fsync(handle.fileno())
        saved, digest, _ = _read(path, None)
        if saved != value:
            raise OSError()
        _SEEN.setdefault(str(directory), {})[name] = digest
    except Exception:
        if started or path.exists():
            _UNCERTAIN.add(str(directory))
        raise
    _check(check)


def _scan_grants(check):
    directory = _root() / "grants"
    entries = _files(directory, r"[0-9a-f]{32}(?:\.revoked)?\.json", MAX_GRANTS * 2, check)
    result, hashes = {}, set()
    for name, value in entries.items():
        _check(check)
        if name.endswith(".revoked.json"):
            if (name.replace(".revoked.json", ".json") not in entries or not isinstance(value, dict)
                    or set(value) != {"version", "id", "owner", "revoked_at"} or type(value["version"]) is not int
                    or value["version"] != 1 or value["id"] != name[:-13] or not _iso(value["revoked_at"])):
                raise unavailable()
            continue
        ident = name[:-5]
        if (not isinstance(value, dict) or set(value) != {"version", "record"}
                or type(value["version"]) is not int or value["version"] != 1):
            raise unavailable()
        record = _grant(value["record"])
        if record["id"] != ident or record["token_hash"] in hashes:
            raise unavailable()
        hashes.add(record["token_hash"])
        revoked = entries.get(ident + ".revoked.json")
        if revoked is not None and (revoked.get("owner") != record["owner"] or revoked.get("id") != ident):
            raise unavailable()
        result[ident] = {**record, "revoked": revoked is not None, "revoked_at": revoked["revoked_at"] if revoked else None}
    _check(check)
    return result


def _required_grant(ident, check):
    if not _ident(ident):
        raise HTTPException(404, "Pi-hole device approval not found.")
    grant = _scan_grants(check).get(ident)
    if grant is None:
        raise HTTPException(404, "Pi-hole device approval not found.")
    return grant


def _command_directory(ident):
    if not _ident(ident):
        raise HTTPException(404, "Pi-hole device approval not found.")
    return _root() / "commands" / ident


def _scan_commands(grant, check):
    entries = _files(_command_directory(grant["id"]), r"[0-9a-f]{32}(?:\.receipt)?\.json", MAX_COMMANDS * 2, check)
    receipts = ({row["id"]: row for row in pihole_receipts.list_receipts(grant["owner"], check)}
                if any(name.endswith(".receipt.json") for name in entries) else {})
    result = {}
    for name, value in entries.items():
        _check(check)
        if name.endswith(".receipt.json"):
            if (name.replace(".receipt.json", ".json") not in entries or not isinstance(value, dict)
                    or set(value) != {"version", "receipt_id"} or type(value["version"]) is not int
                    or value["version"] != 1 or not _ident(value["receipt_id"])):
                raise unavailable()
            continue
        ident = name[:-5]
        if (not isinstance(value, dict) or set(value) != {"version", "grant_id", "operation_id", "created_at", "record"}
                or type(value["version"]) is not int or value["version"] != 1 or value["grant_id"] != grant["id"]
                or value["operation_id"] != ident or not _iso(value["created_at"])):
            raise unavailable()
        _command_record(value["record"], grant)
        linked = entries.get(ident + ".receipt.json")
        receipt = None
        if linked is not None:
            if not isinstance(linked, dict) or not _ident(linked.get("receipt_id")):
                raise unavailable()
            receipt = receipts.get(linked["receipt_id"])
            if receipt is None or any(receipt.get(key) != val for key, val in value["record"].items()):
                raise unavailable()
        result[ident] = {"operation_id": ident, "created_at": value["created_at"],
                         "receipt_id": linked["receipt_id"] if linked else None,
                         "receipt": receipt, "uncertain": linked is None}
    _check(check)
    return result


def _operation(check, action):
    _check(check)
    with LOCK:
        _check(check)
        try:
            result = action()
        except Exception as error:
            _check(check)
            if isinstance(error, HTTPException) and error.status_code in (401, 403, 404, 409):
                raise
            raise unavailable() from None
    _check(check)
    return deepcopy(result)


def create(record, check):
    def save():
        _grant(record)
        rows = _scan_grants(check)
        if record["id"] in rows or any(row["token_hash"] == record["token_hash"] for row in rows.values()):
            raise HTTPException(409, "This Pi-hole device approval already exists.")
        if len(rows) >= MAX_GRANTS or sum(len(_encode(row)) + 512 for row in rows.values()) + len(_encode(record)) + 1024 > MAX_TOTAL_BYTES:
            raise HTTPException(409, "Pi-hole device approval capacity reached. Review saved access before approving another device.")
        _publish(_root() / "grants", record["id"] + ".json", {"version": 1, "record": deepcopy(record)}, check)
        return _required_grant(record["id"], check)
    return _operation(check, save)


def get(ident, check):
    return _operation(check, lambda: _required_grant(ident, check))


def find_token(token_hash, check):
    def read():
        if not isinstance(token_hash, str) or not _HASH.fullmatch(token_hash):
            return None
        return next((row for row in _scan_grants(check).values() if row["token_hash"] == token_hash), None)
    return _operation(check, read)


def list_grants(owner, check):
    def read():
        if not _text(owner):
            raise ValueError()
        return sorted((row for row in _scan_grants(check).values() if row["owner"] == owner), key=lambda row: (row["created_at"], row["id"]))
    return _operation(check, read)


def revoke(owner, ident, check):
    def save():
        grant = _required_grant(ident, check)
        if grant["owner"] != owner:
            raise HTTPException(404, "Pi-hole device approval not found.")
        if not grant["revoked"]:
            _publish(_root() / "grants", ident + ".revoked.json",
                     {"version": 1, "id": ident, "owner": owner, "revoked_at": _now()}, check)
        return _required_grant(ident, check)
    return _operation(check, save)


def command(grant_id, operation_id, check):
    def read():
        if not _ident(operation_id):
            raise HTTPException(404, "Pi-hole command record not found.")
        grant = _required_grant(grant_id, check)
        return _scan_commands(grant, check).get(operation_id)
    return _operation(check, read)


def list_commands(grant_id, check):
    def read():
        grant = _required_grant(grant_id, check)
        return sorted(_scan_commands(grant, check).values(), key=lambda row: (row["created_at"], row["operation_id"]))
    return _operation(check, read)


def reserve_command(grant_id, operation_id, record, check):
    def save():
        if not _ident(operation_id):
            raise ValueError()
        grant = _required_grant(grant_id, check)
        if grant["revoked"]:
            raise HTTPException(403, "This Pi-hole device approval was revoked.")
        _command_record(record, grant)
        commands = _scan_commands(grant, check)
        if operation_id in commands:
            raise HTTPException(409, "This Pi-hole command was already reserved. Read its saved outcome; do not repeat it.")
        if any(row["uncertain"] for row in commands.values()):
            raise HTTPException(409, "An earlier Pi-hole command reservation is incomplete. The owner must review saved recovery evidence before another change.")
        if len(commands) >= MAX_COMMANDS or sum(len(_encode(row)) + 2048 for row in commands.values()) + len(_encode(record)) + 4096 > MAX_TOTAL_BYTES:
            raise HTTPException(409, "Pi-hole device command history is full. The owner must review saved recovery evidence before another change.")
        directory = _command_directory(grant_id)
        _publish(directory, operation_id + ".json", {"version": 1, "grant_id": grant_id,
                 "operation_id": operation_id, "created_at": _now(), "record": deepcopy(record)}, check)
        receipt = pihole_receipts.reserve(grant["owner"], record, check)
        _publish(directory, operation_id + ".receipt.json", {"version": 1, "receipt_id": receipt["id"]}, check)
        return _scan_commands(grant, check)[operation_id]
    return _operation(check, save)


def finish_command(grant_id, operation_id, outcome):
    """Private outcome retention after an effect; this grants no disclosure."""
    def save():
        if not _ident(operation_id):
            raise ValueError()
        grant = _required_grant(grant_id, None)
        saved = _scan_commands(grant, None).get(operation_id)
        if saved is None or saved["uncertain"]:
            raise unavailable()
        pihole_receipts.finish(grant["owner"], saved["receipt_id"], outcome)
        return _scan_commands(grant, None)[operation_id]
    return _operation(None, save)


def approve(owner, record, check):
    if not isinstance(record, dict) or record.get("owner") != owner:
        raise HTTPException(404, "Pi-hole device approval not found.")
    return create(record, check)


grants = list_grants
