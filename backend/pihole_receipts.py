"""Credential-free, append-only recovery receipts for deliberate Pi-hole changes.

Reservations must be confirmed on disk before a remote write. Outcomes are separate
immutable files so an interrupted write retains the original recovery information.
There is no automatic replay, pruning or repair. This is single-host coordination;
it cannot serialize another Pi-hole administrator or protect against hostile OS IO.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import stat
from threading import RLock
import uuid

from fastapi import HTTPException
import tli_state as S

MAX_RECORDS = 256
MAX_BYTES = 256 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024
LOCK = RLock()
_UNCERTAIN = set()
_SEEN = {}
_ID = re.compile(r"[0-9a-f]{32}\Z")
_OUTCOMES = {"confirmed", "accepted", "unknown", "mismatch", "not_attempted"}


def unavailable():
    return HTTPException(503, "Pi-hole recovery records are unavailable or a save could not be confirmed. "
        "Existing evidence was preserved. Stop TLI and review the saved records before restarting; do not repeat the change.")


def _check(check):
    if check is not None:
        check()


def _text(value, limit=4096, nullable=False):
    if value is None and nullable:
        return True
    return isinstance(value, str) and len(value.encode("utf-8")) <= limit


def _ids(value):
    return (isinstance(value, list) and len(value) <= 256 and
            all(type(item) is int and 0 <= item <= 2**53 - 1 for item in value) and len(set(value)) == len(value))


def _timestamp(value):
    return type(value) is int and 0 <= value <= 2**53 - 1


def _iso(value):
    return _text(value, 64) and datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None


def _record(value):
    if not isinstance(value, dict) or set(value) != {"origin", "tls_mode", "pin", "client", "before", "after_groups", "action"}:
        raise ValueError()
    # Reuse the same origin policy; no network is performed by configuration().
    from pihole_transport import configuration, project_clients, project_groups
    config = configuration(value["origin"], value["pin"])
    if config["origin"] != value["origin"] or config["fingerprint"] != value["pin"] or value["tls_mode"] not in {"system_trust", "certificate_pin"}:
        raise ValueError()
    if bool(value["pin"]) != (value["tls_mode"] == "certificate_pin"):
        raise ValueError()
    if value["action"] not in {"groups", "pause", "restore"} or not _ids(value["after_groups"]):
        raise ValueError()
    before = value["before"]
    if not isinstance(before, dict) or set(before) != {"clientrecord", "groups"}:
        raise ValueError()
    client = before["clientrecord"]
    if not isinstance(client, dict) or set(client) != {"id", "client", "comment", "groups", "date_added", "date_modified", "editable"}:
        raise ValueError()
    address = ipaddress.ip_address(value["client"])
    private = (address.version == 4 and any(address in ipaddress.ip_network(net) for net in
               ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))) or (address.version == 6 and address in ipaddress.ip_network("fc00::/7"))
    if not private or client["client"] != value["client"] or client["editable"] is not True or not _ids([client["id"]]):
        raise ValueError()
    if not _text(client["comment"], nullable=True) or not _ids(client["groups"]) or not all(_timestamp(client[k]) for k in ("date_added", "date_modified")):
        raise ValueError()
    groups = before["groups"]
    if not isinstance(groups, list) or len(groups) > 256:
        raise ValueError()
    ids = []
    for group in groups:
        if not isinstance(group, dict) or set(group) != {"id", "name", "enabled", "description", "date_added", "date_modified"}:
            raise ValueError()
        if not _ids([group["id"]]) or not _text(group["name"]) or not _text(group["description"], nullable=True) or type(group["enabled"]) is not bool:
            raise ValueError()
        if not all(_timestamp(group[k]) for k in ("date_added", "date_modified")):
            raise ValueError()
        ids.append(group["id"])
    if len(set(ids)) != len(ids) or not set(client["groups"] + value["after_groups"]).issubset(ids):
        raise ValueError()
    if project_clients({"clients": [client]}) != [client] or project_groups({"groups": [
            {**{k: v for k, v in group.items() if k != "description"}, "comment": group["description"]}
            for group in groups]}) != groups:
        raise ValueError()
    return value


def _outcome(value):
    if (not isinstance(value, dict) or set(value) != {"outcome", "attempted", "acknowledged", "membership_verified", "summary", "checked_at"}
            or value["outcome"] not in _OUTCOMES or any(type(value[k]) is not bool for k in ("attempted", "acknowledged", "membership_verified"))
            or not _text(value["summary"], 1024) or not _iso(value["checked_at"])):
        raise ValueError()
    attempted, acknowledged, verified = (value[k] for k in ("attempted", "acknowledged", "membership_verified"))
    kind = value["outcome"]
    if ((kind == "not_attempted" and (attempted or acknowledged or verified))
            or (kind != "not_attempted" and not attempted)
            or (verified != (kind == "confirmed"))
            or (kind == "accepted" and not acknowledged)
            or (kind == "unknown" and acknowledged)):
        raise ValueError()
    return value


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


def _directory(owner):
    if not _text(owner, 4096) or not owner:
        raise unavailable()
    return Path(S.DATA_DIR).absolute() / "integrations" / "pihole" / "receipts" / hashlib.sha256(owner.encode("utf-8")).hexdigest()


def _plain(info, directory=False):
    return (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1) and not getattr(info, "st_file_attributes", 0) & 0x400


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
            current.mkdir()  # exclusive; concurrent external creation requires a new deliberate request
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
    # Windows lstat and fstat have different ctime semantics. Compare ctime only
    # within each API while comparing identity/size/mtime across the two APIs.
    stamp = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
    if (len(raw) > MAX_BYTES or stamp(before) != stamp(opened) or stamp(opened) != stamp(after)
            or stamp(after) != stamp(latest) or before.st_ctime_ns != latest.st_ctime_ns
            or opened.st_ctime_ns != after.st_ctime_ns or not _plain(latest)):
        raise unavailable()
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    _encode(value)
    return value, hashlib.sha256(raw).hexdigest()


def _scan(directory, check):
    key = str(directory)
    if key in _UNCERTAIN:
        raise unavailable()
    if not _chain(directory, check):
        if _SEEN.get(key):
            _UNCERTAIN.add(key)
            raise unavailable()
        return {}
    entries, hashes = {}, {}
    for count, path in enumerate(directory.iterdir()):
        _check(check)
        if count >= MAX_RECORDS * 2 or not re.fullmatch(r"[0-9a-f]{32}(?:\.outcome)?\.json", path.name):
            raise unavailable()
        value, digest = _read(path, check)
        entries[path.name] = value
        hashes[path.name] = digest
    if any(hashes.get(name) != digest for name, digest in _SEEN.get(key, {}).items()):
        _UNCERTAIN.add(key)
        raise unavailable()
    result = {}
    for name, value in entries.items():
        if name.endswith(".outcome.json"):
            if name.replace(".outcome.json", ".json") not in entries:
                raise unavailable()
            _outcome(value)
            continue
        ident = name[:-5]
        if not isinstance(value, dict) or set(value) != {"version", "id", "created_at", "record"} or type(value["version"]) is not int or value["version"] != 1 or value["id"] != ident or not _iso(value["created_at"]):
            raise unavailable()
        _record(value["record"])
        outcome = entries.get(ident + ".outcome.json")
        if outcome is None:
            outcome = {"outcome": "prepared", "attempted": False, "acknowledged": False, "membership_verified": False,
                       "summary": "Outcome not yet recorded; check the saved client state before another change.", "checked_at": value["created_at"]}
        else:
            _outcome(outcome)
        result[ident] = {**value["record"], "id": ident, "created_at": value["created_at"], "outcome": outcome}
    _check(check)
    _SEEN[key] = hashes
    return result


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
        # After publication, confirm bytes even if access has just ended. This
        # private bookkeeping grants neither another effect nor disclosure.
        saved, digest = _read(path, None)
        if saved != value:
            raise OSError()
        _SEEN.setdefault(str(directory), {})[name] = digest
    except Exception:
        if started or path.exists():
            _UNCERTAIN.add(str(directory))
        raise
    _check(check)


def _operation(owner, check, action):
    _check(check)
    directory = _directory(owner)
    with LOCK:
        _check(check)
        try:
            result = action(directory)
        except Exception as error:
            _check(check)
            if isinstance(error, HTTPException) and error.status_code in (401, 403, 404, 409):
                raise
            raise unavailable() from None
    _check(check)
    return deepcopy(result)


def reserve(owner, record, check):
    def save(directory):
        _record(record)
        rows = _scan(directory, check)
        # Leave room for each immutable outcome and keep status/restore usable
        # within the browser's bounded response reader. Never evict recovery.
        size = sum(len(_encode(row)) + 2048 for row in rows.values())
        if len(rows) >= MAX_RECORDS or size + len(_encode(record)) + 4096 > MAX_TOTAL_BYTES:
            raise HTTPException(409, "Pi-hole recovery record capacity reached. Stop TLI and archive reviewed records before another change.")
        ident = uuid.uuid4().hex
        value = {"version": 1, "id": ident, "created_at": datetime.now(timezone.utc).isoformat(), "record": deepcopy(record)}
        _publish(directory, ident + ".json", value, check)
        return _scan(directory, check)[ident]
    return _operation(owner, check, save)


def finish(owner, ident, outcome):
    """Internal private outcome retention only; callers must check before disclosure."""
    def save(directory):
        if not isinstance(ident, str) or not _ID.fullmatch(ident):
            raise ValueError()
        _outcome(outcome)
        rows = _scan(directory, None)
        if ident not in rows:
            raise ValueError()
        previous = rows[ident]["outcome"]
        if previous["outcome"] != "prepared":
            if previous != outcome:
                raise ValueError()
            return rows[ident]
        _publish(directory, ident + ".outcome.json", outcome, None)
        return _scan(directory, None)[ident]
    return _operation(owner, None, save)


def list_receipts(owner, check):
    return _operation(owner, check, lambda directory: sorted(_scan(directory, check).values(), key=lambda row: (row["created_at"], row["id"]), reverse=True))


def get(owner, ident, check):
    def read(directory):
        if not isinstance(ident, str) or not _ID.fullmatch(ident):
            raise HTTPException(404, "Pi-hole recovery record not found.")
        result = _scan(directory, check).get(ident)
        if result is None:
            raise HTTPException(404, "Pi-hole recovery record not found.")
        return result
    return _operation(owner, check, read)
