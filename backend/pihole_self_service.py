"""Explicitly armed Pi-hole broker and separately approved device credentials.

The application password is process memory only. Durable device grants confer
only their fixed client's pause/restore operation, never owner-browser access.
"""
from __future__ import annotations

import copy
import hashlib
import ipaddress
import re
import secrets
import threading
import time
import uuid
from contextlib import contextmanager
from urllib.parse import quote

from fastapi import HTTPException

import pihole_bridge as private
import pihole_transport as transport
import tli_state as S

PROTOCOL = "tli-pihole-access-v1"
COOKIE = "tli_pihole_access"
PENDING_TTL = 600
MAX_PENDING = 128
MAX_RATE_ENTRIES = 512
LOCK = threading.RLock()
SERVICE = None
PENDING = {}
RATES = {}
BUSY = set()
_COOKIE = re.compile(r"([0-9a-f]{32})\.([0-9a-f]{64})\Z")


def _store():
    import pihole_access_store
    return pihole_access_store


def _stamp():
    return private._stamp()


def _result(check, **values):
    check()
    return {"protocol": PROTOCOL, "ok": True, **values, "_access_check": check}


def _hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _pin_stamp():
    try:
        value = S.load_pin_config()
        if value.get("enabled") is not True:
            raise ValueError()
        return private._digest({key: value.get(key) for key in ("enabled", "hash", "salt")})
    except Exception:
        raise HTTPException(503, "Pi-hole device access requires available, enabled TLI PIN protection.") from None


def _source(request):
    try:
        address = ipaddress.ip_address(request.client.host)
        if not any(address.version == net.version and address in net for net in transport.LAN_NETWORKS):
            raise ValueError()
        if request.url.scheme != "https":
            raise ValueError()
        if (request.headers.getlist("authorization") or any(
                key == "forwarded" or key.startswith("x-forwarded-") or key.startswith("x-tli-peer-")
                for key in request.headers)):
            raise ValueError()
        return str(address)
    except Exception:
        raise HTTPException(403, "Use a direct HTTPS connection from the approved device on this private network.") from None


def _cookie(request):
    raw = request.cookies.get(COOKIE)
    if not isinstance(raw, str) or not _COOKIE.fullmatch(raw):
        return None
    return raw, raw.split(".", 1)[0], _hash(raw)


def _owner(request, check):
    _, owner, captured = private._admit(request, check)
    return owner, captured


def revoke_all_connections():
    """Global PIN/session protection changes stop service; no network cleanup."""
    global SERVICE
    with LOCK:
        if SERVICE is not None:
            SERVICE.pop("password", None)
        SERVICE = None
        PENDING.clear()
        RATES.clear()


def _service(check, *, owner=None):
    check = private._sticky(check)
    check()
    with LOCK:
        current = SERVICE
    if current is None:
        raise HTTPException(409, "Device access is offline. The owner must enable Pi-hole access on the host.")
    if owner is not None and current["owner"] != owner:
        raise HTTPException(403, "This Pi-hole service belongs to another TLI account.")
    def live():
        global SERVICE
        check()
        try:
            stamp = _pin_stamp()
        except Exception:
            with LOCK:
                if SERVICE is current:
                    current.pop("password", None)
                    SERVICE = None
                    PENDING.clear()
            raise
        epoch = S.session_revocation_epoch()
        with LOCK:
            valid = (SERVICE is current and bool(current.get("password")) and
                     current["epoch"] is epoch and current["pin_stamp"] == stamp)
            if SERVICE is current and not valid:
                current.pop("password", None)
                SERVICE = None
                PENDING.clear()
        if not valid:
            raise HTTPException(409, "Pi-hole device access stopped or protection changed. The owner must enable it again.")
        check()
    live = private._sticky(live)
    live()
    return current, live


def _summary(grant):
    return {"id": grant["id"], "name": grant["name"], "client": grant["client"]["client"], "revoked": grant["revoked"]}


def _purge():
    now = time.monotonic()
    for ident, pending in list(PENDING.items()):
        if pending["deadline"] <= now:
            PENDING.pop(ident, None)
    for ip, deadline in list(RATES.items()):
        if deadline <= now:
            RATES.pop(ip, None)


def _pending_check(current, pending, base):
    def live():
        base()
        with LOCK:
            valid = (SERVICE is current and PENDING.get(pending["id"]) is pending
                     and pending["deadline"] > time.monotonic())
        if not valid:
            raise HTTPException(409, "This device request expired or changed. Request access again deliberately.")
        base()
    return private._sticky(live)


def _exchange(current, method, path, check, **kwargs):
    check()
    try:
        value = transport.exchange(current["config"], method, path, check, **kwargs)
    except Exception:
        check()
        raise
    check()
    return value


@contextmanager
def _session(current, check):
    """One authentication per explicit operation; no retained SID or retry."""
    check()
    sid = None
    try:
        with LOCK:
            password = current.get("password")
        check()
        if not password:
            raise HTTPException(409, "Pi-hole device access stopped.")
        try:
            raw = _exchange(current, "POST", "/api/auth", check, body={"password": password})
        finally:
            password = None
        sid = transport.validate_session(raw)["sid"]
        check()
        yield sid
    finally:
        # Access loss authorizes neither logout nor another network request.
        if sid is not None:
            try:
                check()
            except Exception:
                pass
            else:
                try:
                    _exchange(current, "DELETE", "/api/auth", check, sid=sid)
                except Exception:
                    # Logout failure never changes a completed effect into a retry.
                    pass
        check()


def _snapshot(current, sid, check):
    clients = transport.project_clients(_exchange(current, "GET", "/api/clients", check, sid=sid))
    check()
    groups = transport.project_groups(_exchange(current, "GET", "/api/groups", check, sid=sid))
    check()
    return clients, groups


@contextmanager
def _target(current, client, check):
    key = (current["config"]["origin"], str(ipaddress.ip_address(client)))
    check()
    with private.LOCK:
        if key in private.TARGETS:
            raise HTTPException(409, "Another operation for this Pi-hole client is running. Nothing was repeated.")
        private.TARGETS.add(key)
    try:
        check()
        yield
    finally:
        with private.LOCK:
            private.TARGETS.discard(key)


@contextmanager
def _busy(ident, check):
    check()
    with LOCK:
        if ident in BUSY:
            raise HTTPException(409, "Another operation for this device is running. Wait before an explicit new request.")
        BUSY.add(ident)
    try:
        check()
        yield
    finally:
        with LOCK:
            BUSY.discard(ident)


def owner_status(request, check):
    owner, check = _owner(request, check)
    rows = _store().list_grants(owner, check)
    with LOCK:
        _purge()
        current = SERVICE
        pending = list(PENDING.values()) if current and current["owner"] == owner else []
    enabled = False
    if current is not None and current["owner"] == owner:
        _, live = _service(check, owner=owner)
        live()
        enabled = True
    return _result(check, enabled=enabled, origin=current["config"]["origin"] if enabled else None,
                   requests=[{key: value[key] for key in ("id", "name", "source_ip", "expires_at")} for value in pending],
                   grants=[_summary(row) for row in rows], checked_at=_stamp())


def enable(request, data, check):
    global SERVICE
    owner, check = _owner(request, check)
    password = data.get("password")
    try:
        if not isinstance(password, str) or not 1 <= len(password) <= 512:
            raise HTTPException(422, "Enter a dedicated Pi-hole application password.")
        config = transport.configuration(data.get("origin"), data.get("certificate_sha256", ""))
        if ipaddress.ip_address(config["host"]).is_loopback:
            port = request.url.port or (443 if request.url.scheme == "https" else 80)
            server = request.scope.get("server")
            if config["port"] == port or server and config["port"] == server[1]:
                raise HTTPException(422, "Choose the Pi-hole listener, not this TLI listener.")
        with LOCK:
            old = SERVICE
            if old is not None and old["owner"] != owner:
                raise HTTPException(403, "The enabled Pi-hole service belongs to another TLI account.")
        epoch = S.session_revocation_epoch()
        stamp = _pin_stamp()
        def candidate():
            check()
            if S.session_revocation_epoch() is not epoch or _pin_stamp() != stamp:
                raise HTTPException(409, "PIN protection changed before Pi-hole device access was enabled.")
            with LOCK:
                if SERVICE is not old:
                    raise HTTPException(409, "Pi-hole device access changed during connection. Start a new deliberate request.")
        candidate = private._sticky(candidate)
        value = {"id": secrets.token_hex(16), "owner": owner, "config": config, "password": password,
                 "epoch": epoch, "pin_stamp": stamp,
                 "tls_mode": "certificate_pin" if config["fingerprint"] else "system_trust"}
        _store().list_grants(owner, candidate)
        with _session(value, candidate):
            pass
        candidate()
        with LOCK:
            # The owner may have been revoked while publication waited for this
            # lock. Only its original live authority may retain a password.
            candidate()
            if SERVICE is not old:
                raise HTTPException(409, "Pi-hole device access changed during connection.")
            if old is not None:
                old.pop("password", None)
            SERVICE = value
            PENDING.clear()
            RATES.clear()
        _, live = _service(check, owner=owner)
        return _result(live, enabled=True, origin=config["origin"])
    except Exception:
        check()
        raise
    finally:
        data["password"] = ""
        password = None


def disable(request, data, check):
    global SERVICE
    owner, check = _owner(request, check)
    check()
    with LOCK:
        # An expired owner queued here must not disable a later armed service.
        check()
        current = SERVICE
        if current is not None and current["owner"] != owner:
            raise HTTPException(403, "This Pi-hole service belongs to another TLI account.")
        if current is not None:
            current.pop("password", None)
        SERVICE = None
        PENDING.clear()
        RATES.clear()
    return _result(check, enabled=False)


def owner_inventory(request, data, check):
    owner, check = _owner(request, check)
    current, check = _service(check, owner=owner)
    with _busy("owner:" + owner, check), _session(current, check) as sid:
        clients, groups = _snapshot(current, sid, check)
    return _result(check, clients=clients, groups=groups, checked_at=_stamp())


def request_access(request, data, transport_check):
    transport_check = private._sticky(transport_check)
    transport_check()
    ip = _source(request)
    current, check = _service(transport_check)
    name = data.get("name")
    if (not isinstance(name, str) or not name.strip() or len(name) > 64 or
            any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in name)):
        raise HTTPException(422, "Enter a device name up to 64 characters.")
    credential = _cookie(request)
    if credential:
        raw, ident, digest = credential
        grant = _store().find_token(digest, check)
        if grant and not grant["revoked"]:
            raise HTTPException(409, "This browser already has device access. Check its saved access or forget it before requesting again.")
        with LOCK:
            _purge()
            previous = PENDING.get(ident)
        if previous and previous["token_hash"] == digest and previous["source_ip"] == ip:
            live = _pending_check(current, previous, check)
            return _result(live, state="pending", source_ip=ip, expires_at=previous["expires_at"])
    check()
    with LOCK:
        _purge()
        if SERVICE is not current:
            raise HTTPException(409, "Pi-hole device access changed.")
        if ip in RATES:
            raise HTTPException(429, "Wait 30 seconds before requesting access again from this address.")
        if len(PENDING) >= MAX_PENDING:
            raise HTTPException(429, "Too many device requests are waiting. Wait for one to expire.")
        if len(RATES) >= MAX_RATE_ENTRIES:
            raise HTTPException(429, "Too many device addresses requested access recently. Wait 30 seconds before another request.")
        ident = secrets.token_hex(16)
        raw = ident + "." + secrets.token_hex(32)
        pending = {"id": ident, "name": name.strip(), "source_ip": ip, "token_hash": _hash(raw),
                   "expires_at": private._stamp(time.time() + PENDING_TTL), "deadline": time.monotonic() + PENDING_TTL}
        PENDING[ident] = pending
        RATES[ip] = time.monotonic() + 30
    live = _pending_check(current, pending, check)
    return _result(live, state="pending", source_ip=ip, expires_at=pending["expires_at"], _credential=raw)


def approve(request, data, check):
    owner, check = _owner(request, check)
    current, check = _service(check, owner=owner)
    if data.get("reviewed") is not True:
        raise HTTPException(422, "Confirm the device IP and its current filtering groups before approving access.")
    with LOCK:
        _purge()
        pending = PENDING.get(data.get("request_id"))
    if pending is None:
        raise HTTPException(409, "This device request expired. Ask the device to request access again.")
    pending_check = _pending_check(current, pending, check)
    with _busy("owner:" + owner, pending_check), _session(current, pending_check) as sid:
        clients, groups = _snapshot(current, sid, pending_check)
        client = private._exact_client(clients, data.get("client"))
        if str(ipaddress.ip_address(client["client"])) != pending["source_ip"]:
            raise HTTPException(409, "The Pi-hole client IP must match this device's direct request address exactly.")
        definitions = [row for row in groups if row["id"] in client["groups"]]
        if not client["groups"] or len(definitions) != len(client["groups"]):
            raise HTTPException(409, "Approve a client with existing filtering groups. Empty or missing policies cannot establish the restore baseline.")
        for previous in _store().list_grants(owner, pending_check):
            if (not previous["revoked"] and previous["origin"] == current["config"]["origin"]
                    and str(ipaddress.ip_address(previous["client"]["client"])) == pending["source_ip"]):
                raise HTTPException(409, "This client already has approved device access. Revoke the previous browser before approving another.")
        grant = _store().create({"id": pending["id"], "owner": owner, "token_hash": pending["token_hash"],
            "pin_stamp": current["pin_stamp"], "origin": current["config"]["origin"], "tls_mode": current["tls_mode"],
            "pin": current["config"]["fingerprint"], "client": client, "groups": definitions,
            "name": pending["name"], "created_at": _stamp()}, pending_check)
    # Publication creates independent, explicitly scoped authority. Losing the
    # owner browser afterwards cannot invalidate or repeat this saved grant.
    with LOCK:
        if PENDING.get(pending["id"]) is pending:
            PENDING.pop(pending["id"], None)
    return _result(check, grant=_summary(grant))


def revoke(request, data, check):
    owner, check = _owner(request, check)
    grant = _store().revoke(owner, data.get("grant_id"), check)
    return _result(check, grant=_summary(grant))


def _guest(request, transport_check):
    transport_check = private._sticky(transport_check)
    transport_check()
    ip = _source(request)
    credential = _cookie(request)
    if credential is None:
        raise HTTPException(401, "This browser has not been approved for device DNS access.")
    raw, ident, digest = credential
    current, base = _service(transport_check)
    grant = _store().find_token(digest, base)
    if not grant or grant["id"] != ident or grant["revoked"]:
        raise HTTPException(401, "This device credential is unknown or revoked. Request owner approval again.")
    def live():
        base()
        if _source(request) != ip or str(ipaddress.ip_address(grant["client"]["client"])) != ip:
            raise HTTPException(403, "This browser's current IP differs from its approved Pi-hole client. The owner must review its address again.")
        saved = _store().get(ident, base)
        if saved != grant or saved["revoked"] or saved["token_hash"] != digest:
            raise HTTPException(401, "Device access was revoked or changed. Remaining steps were stopped.")
        if (grant["owner"] != current["owner"] or grant["origin"] != current["config"]["origin"]
                or grant["pin"] != current["config"]["fingerprint"] or grant["tls_mode"] != current["tls_mode"]
                or grant["pin_stamp"] != current["pin_stamp"]):
            raise HTTPException(403, "The saved device approval no longer matches the enabled Pi-hole service. Ask the owner to review access.")
        base()
    live = private._sticky(live)
    live()
    return current, grant, live


def _policy(grant, clients, groups, commands):
    try:
        client = private._exact_client(clients, grant["client"]["client"])
        if private._identity(client) != private._identity(grant["client"]):
            return "changed", client, None
        definitions = {row["id"]: row for row in groups}
        if any(definitions.get(row["id"]) != row for row in grant["groups"]):
            return "changed", client, None
        latest = None
        for command in commands:
            receipt = command.get("receipt")
            if command.get("uncertain") or not receipt or receipt["outcome"]["outcome"] == "prepared":
                return "changed", client, None
            if receipt["outcome"].get("attempted"):
                latest = receipt
        if sorted(client["groups"]) == sorted(grant["client"]["groups"]):
            return "on", client, None
        if client["groups"] == [] and latest is not None:
            record = private._record(latest)
            if (record["action"] == "pause" and record["after_groups"] == [] and
                    sorted(record["before"]["clientrecord"]["groups"]) == sorted(grant["client"]["groups"])):
                return "off", client, latest
        return "changed", client, None
    except (HTTPException, KeyError, TypeError, ValueError):
        return "changed", None, None


def _view(grant, state, *, outcome=None):
    detail = {"on": "Pi-hole reports this client's approved filtering groups. Actual DNS behavior can differ.",
              "off": "This client's filtering groups are paused until explicitly restored. No timer runs.",
              "changed": "Pi-hole's policy or a saved command needs owner review. No automatic changes run."}[state]
    result = {"state": state, "name": grant["name"], "client": grant["client"]["client"], "checked_at": _stamp(), "detail": detail}
    if outcome is not None:
        result["outcome"] = copy.deepcopy(outcome)
    return result


def guest_status(request, transport_check):
    transport_check = private._sticky(transport_check)
    transport_check()
    ip = _source(request)
    with LOCK:
        current = SERVICE
        _purge()
    if current is None:
        return _result(transport_check, state="offline", checked_at=_stamp(), detail="The host must enable Pi-hole device access. Existing pauses remain until restored.")
    current, base = _service(transport_check)
    credential = _cookie(request)
    if credential is None:
        return _result(base, state="unpaired", checked_at=_stamp(), detail="Request access, then ask the owner to approve this device.")
    _, ident, digest = credential
    approved = _store().find_token(digest, base)
    with LOCK:
        pending = PENDING.get(ident)
    if not approved and pending and pending["token_hash"] == digest and pending["source_ip"] == ip:
        live = _pending_check(current, pending, base)
        return _result(live, state="pending", name=pending["name"], client=ip,
                       expires_at=pending["expires_at"], checked_at=_stamp(), detail="Waiting for the owner to approve this exact device IP.")
    current, grant, check = _guest(request, transport_check)
    with _busy(grant["id"], check), _session(current, check) as sid:
        clients, groups = _snapshot(current, sid, check)
        commands = _store().list_commands(grant["id"], check)
        state, _, _ = _policy(grant, clients, groups, commands)
    return _result(check, **_view(grant, state))


def _operation_id(raw):
    try:
        if not isinstance(raw, str) or len(raw) not in (32, 36):
            raise ValueError()
        value = uuid.UUID(raw)
        if raw.lower() not in (value.hex, str(value)):
            raise ValueError()
        return value.hex
    except (ValueError, AttributeError):
        raise HTTPException(422, "Provide one fresh device operation identifier.") from None


def filtering(request, data, transport_check):
    current, grant, check = _guest(request, transport_check)
    if type(data.get("enabled")) is not bool:
        raise HTTPException(422, "Choose filtering on or off.")
    ident = _operation_id(data.get("operation_id"))
    desired = "on" if data["enabled"] else "off"
    with _busy(grant["id"], check), _target(current, grant["client"]["client"], check):
        existing = _store().command(grant["id"], ident, check)
        if existing is not None:
            # Repeated submission retrieves evidence only; it never authenticates
            # to Pi-hole again or silently uses a different requested state.
            receipt = existing.get("receipt")
            if existing.get("uncertain") or not receipt:
                raise HTTPException(409, "This operation was already reserved but its outcome is unavailable. Ask the owner to review it.")
            record = private._record(receipt)
            expected = sorted(grant["client"]["groups"]) if data["enabled"] else []
            if sorted(record["after_groups"]) != expected:
                raise HTTPException(409, "This operation identifier belongs to a different filtering request.")
            # A saved outcome is not a new live observation.
            return _result(check, **_view(grant, "changed", outcome=receipt["outcome"]))
        with _session(current, check) as sid:
            clients, groups = _snapshot(current, sid, check)
            commands = _store().list_commands(grant["id"], check)
            state, client, paused = _policy(grant, clients, groups, commands)
            if state == "changed":
                return _result(check, **_view(grant, state))
            if state == desired:
                # An acknowledged no-op also consumes its operation identifier:
                # a delayed retry must not reverse a later deliberate change.
                record = {"origin": current["config"]["origin"], "tls_mode": current["tls_mode"],
                          "pin": current["config"]["fingerprint"], "client": client["client"],
                          "before": {"clientrecord": client, "groups": groups}, "after_groups": sorted(client["groups"]),
                          "action": "restore" if data["enabled"] else "pause"}
                _store().reserve_command(grant["id"], ident, record, check)
                outcome = {"outcome": "not_attempted", "attempted": False, "acknowledged": False,
                           "membership_verified": False, "checked_at": _stamp(),
                           "summary": "Pi-hole already reported the requested memberships. No change was submitted; this operation will not replay."}
                finished = _store().finish_command(grant["id"], ident, outcome)
                return _result(check, **_view(grant, state, outcome=finished["receipt"]["outcome"]))
            if desired == "on":
                value = {"config": current["config"], "tls_mode": current["tls_mode"]}
                after = private._restore_groups(value, client, groups, paused, check)
                if sorted(after) != sorted(grant["client"]["groups"]):
                    raise HTTPException(409, "The pause no longer matches this device's approved filtering policy.")
            else:
                after = []
            # Refresh immediately before reservation. Pi-hole has no conditional
            # write API; unrelated administrators can still race these requests.
            fresh_clients, fresh_groups = _snapshot(current, sid, check)
            fresh = private._exact_client(fresh_clients, client["client"])
            if private._revision(fresh, fresh_groups) != private._revision(client, groups):
                return _result(check, **_view(grant, "changed"))
            record = {"origin": current["config"]["origin"], "tls_mode": current["tls_mode"],
                      "pin": current["config"]["fingerprint"], "client": client["client"],
                      "before": {"clientrecord": client, "groups": groups}, "after_groups": after,
                      "action": "restore" if data["enabled"] else "pause"}
            _store().reserve_command(grant["id"], ident, record, check)
            attempted = acknowledged = False
            outcome = {"outcome": "not_attempted", "attempted": False, "acknowledged": False, "membership_verified": False,
                       "summary": "No membership request was submitted. No automatic retry runs.", "checked_at": _stamp()}
            def attempt():
                nonlocal attempted
                check()
                attempted = True
            try:
                raw = _exchange(current, "PUT", "/api/clients/" + quote(client["client"], safe=""), check,
                                sid=sid, body={"groups": after, "comment": client["comment"]}, on_attempt=attempt)
                acknowledged = private._acknowledged(raw, client["client"])
                readback, final_groups = _snapshot(current, sid, check)
                final = private._exact_client(readback, client["client"])
                final_definitions = {row["id"]: row for row in final_groups}
                matched = (private._identity(final) == private._identity(client) and sorted(final["groups"]) == sorted(after)
                           and final["comment"] == client["comment"]
                           and all(final_definitions.get(row["id"]) == row for row in grant["groups"]))
                outcome.update(outcome="confirmed" if matched else "mismatch", attempted=attempted,
                               acknowledged=acknowledged, membership_verified=matched,
                               summary="Pi-hole reported the requested client memberships. DNS behavior has not been verified." if matched else
                               "Pi-hole's current membership differs from the submitted request. Ask the owner to review it; no automatic repair runs.")
            except Exception:
                outcome.update(attempted=attempted, acknowledged=acknowledged)
                if attempted:
                    outcome.update(outcome="accepted" if acknowledged else "unknown", summary=
                                   "The membership request may have completed, but verification is unavailable. No automatic retry runs.")
            outcome["checked_at"] = _stamp()
            # Outcome retention is deliberately independent of subsequent grant
            # revocation; it never authorizes another effect or disclosure.
            finished = _store().finish_command(grant["id"], ident, outcome)
            check()
            final_state = desired if outcome["membership_verified"] else "changed"
        return _result(check, **_view(grant, final_state, outcome=finished["receipt"]["outcome"]))


def forget(request, data, transport_check):
    transport_check = private._sticky(transport_check)
    transport_check()
    ip = _source(request)
    credential = _cookie(request)
    if credential is not None:
        _, ident, digest = credential
        with LOCK:
            pending = PENDING.get(ident)
            if pending and pending["token_hash"] == digest and pending["source_ip"] == ip:
                PENDING.pop(ident, None)
        # Forgetting remains available while the broker is offline. It grants
        # only revocation of this exact credential, never Pi-hole network work.
        grant = _store().find_token(digest, transport_check)
        if grant is not None and grant["id"] == ident and not grant["revoked"]:
            if str(ipaddress.ip_address(grant["client"]["client"])) != ip:
                raise HTTPException(403, "The current address differs from this device approval. Ask the owner to revoke it.")
            _store().revoke(grant["owner"], ident, transport_check)
    return _result(transport_check, state="unpaired", forgotten=True, checked_at=_stamp(),
                   detail="This browser's access was forgotten. An existing Pi-hole pause remains until explicitly restored.")
