"""Explicit Pi-hole v6 client policy and DNS observations for one PIN browser.

Credentials and reviews live only in memory. Credential-free receipts are
reserved durably before a membership PUT; neither expiry nor unlock replays it.
"""
from __future__ import annotations

import copy
import hashlib
import ipaddress
import json
import secrets
import threading
import time
from datetime import datetime, timezone
from urllib.parse import quote, urlencode

from fastapi import HTTPException

import pihole_transport as transport
import tli_state as S

PROTOCOL = "tli-pihole-v1"
TTL = 900
REVIEW_TTL = 120
MAX_CONNECTIONS = 64
MAX_REVIEWS = 256
LOCK = threading.RLock()
CONNECTIONS = {}
REVIEWS = {}
PENDING = {}
BUSY = set()
TARGETS = set()


def _store():
    import pihole_receipts
    return pihole_receipts


def _stamp(when=None):
    return datetime.fromtimestamp(time.time() if when is None else when, timezone.utc).isoformat().replace("+00:00", "Z")


def _result(**values):
    return {"protocol": PROTOCOL, "ok": True, **values}


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()


def _sticky(authorize):
    failure = None
    def check():
        nonlocal failure
        if failure is not None:
            raise failure
        try:
            if not callable(authorize):
                raise HTTPException(403, "Current browser authority is required for Pi-hole.")
            authorize()
        except Exception as error:
            failure = error if isinstance(error, HTTPException) else HTTPException(503, "Browser security state is unavailable. Reopen TLI before continuing.")
            raise failure from None
    return check


def _admit(request, check):
    check = _sticky(check)
    check()
    token = request.cookies.get("tli_session")
    epoch = S.session_revocation_epoch()
    if S.load_pin_config()["enabled"] is not True or not token or not S.validate_session_token(token):
        check()
        raise HTTPException(401, "Set and unlock the TLI PIN before connecting Pi-hole.")
    owner = S.get_session_user_id(token)
    def original():
        check()
        if (S.session_revocation_epoch() is not epoch or S.load_pin_config()["enabled"] is not True
                or not S.validate_session_token(token) or S.get_session_user_id(token) != owner):
            raise HTTPException(401, "The original PIN browser session ended. No further Pi-hole operation is authorized.")
        check()
    original = _sticky(original)
    original()
    return token, owner, original


def _erase(value):
    value.pop("sid", None)


def _drop_connection(ident):
    value = CONNECTIONS.pop(ident, None)
    if value:
        _erase(value)
    for key, review_record in list(REVIEWS.items()):
        if review_record["connection_id"] == ident:
            REVIEWS.pop(key, None)


def _purge():
    now = time.monotonic()
    for ident, value in list(CONNECTIONS.items()):
        if value["deadline"] <= now:
            _drop_connection(ident)
    for ident, value in list(REVIEWS.items()):
        if value["deadline"] <= now:
            REVIEWS.pop(ident, None)


def revoke_browser_session(token):
    """Release local credentials only; revocation never authorizes remote work."""
    with LOCK:
        PENDING.pop(token, None)
        for ident, value in list(CONNECTIONS.items()):
            if value["browser"] == token:
                _drop_connection(ident)


def revoke_all_connections():
    with LOCK:
        for value in CONNECTIONS.values():
            _erase(value)
        CONNECTIONS.clear()
        REVIEWS.clear()
        PENDING.clear()


def _lease(token, check):
    check()
    with LOCK:
        check()
        if token in BUSY:
            raise HTTPException(409, "Another Pi-hole operation for this browser is running. No competing operation started.")
        BUSY.add(token)


def _release(token):
    with LOCK:
        BUSY.discard(token)


def _summary(value):
    return {"id": value["id"], "origin": value["config"]["origin"], "expires_at": value["expires_at"],
            "tls_mode": value["tls_mode"], "certificate_sha256": value["config"]["fingerprint"]}


def _connection(request, ident, check):
    token, owner, original = _admit(request, check)
    with LOCK:
        original()
        _purge()
        value = CONNECTIONS.get(ident)
        if value is None or value["browser"] != token or value["owner"] != owner:
            raise HTTPException(409, "This Pi-hole connection expired or belongs to another browser. Connect deliberately again.")
    def live():
        original()
        value["authorize"]()
        with LOCK:
            original()
            if CONNECTIONS.get(value["id"]) is not value or value["deadline"] <= time.monotonic() or not value.get("sid"):
                raise HTTPException(409, "The temporary Pi-hole connection expired or was disconnected. No automatic reconnect runs.")
    live = _sticky(live)
    live()
    return value, live


def _fetch(value, method, path, check, *, body=None, on_attempt=None):
    check()
    try:
        result = transport.exchange(value["config"], method, path, check, sid=value["sid"], body=body, on_attempt=on_attempt)
    except Exception:
        check()
        raise
    check()
    return result


def _snapshot(value, check):
    clients = transport.project_clients(_fetch(value, "GET", "/api/clients", check))
    check()
    groups = transport.project_groups(_fetch(value, "GET", "/api/groups", check))
    check()
    return clients, groups


def _exact_client(clients, ident):
    if not isinstance(ident, str):
        raise HTTPException(422, "Select one existing Pi-hole client by its exact IP address.")
    rows = [row for row in clients if row["client"] == ident]
    if len(rows) != 1 or rows[0].get("editable") is not True:
        raise HTTPException(409, "Select an existing exact-IP client. Hostnames, MAC addresses, subnets and inferred devices cannot be changed here.")
    return copy.deepcopy(rows[0])


def _identity(row):
    return {key: row[key] for key in ("id", "client", "date_added")}


def _semantic_groups(groups):
    return sorted(copy.deepcopy(groups), key=lambda row: row["id"])


def _revision(client, groups):
    row = copy.deepcopy(client)
    row["groups"] = sorted(row["groups"])
    return _digest({"client": row, "groups": _semantic_groups(groups)})


def _record(receipt):
    return receipt.get("record", receipt)


def _restore_groups(value, client, groups, receipt, check):
    check()
    old = _record(receipt)
    try:
        original = old["before"]["clientrecord"]
        if (old["origin"] != value["config"]["origin"] or old["tls_mode"] != value["tls_mode"]
                or old["pin"] != value["config"]["fingerprint"] or old["client"] != client["client"]
                or _identity(original) != _identity(client)
                or sorted(client["groups"]) != sorted(old["after_groups"])):
            raise ValueError()
        old_definitions = {row["id"]: row for row in old["before"]["groups"]}
        current_definitions = {row["id"]: row for row in groups}
        for ident in original["groups"]:
            if ident not in old_definitions or old_definitions[ident] != current_definitions.get(ident):
                raise ValueError()
        result = sorted(original["groups"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(409, "This receipt no longer matches the Pi-hole origin, client identity, current memberships or original group definitions. Read and review the current policy instead.") from None
    check()
    return result


def status(request, check):
    token, owner, check = _admit(request, check)
    try:
        with LOCK:
            check()
            _purge()
            rows = []
            for value in CONNECTIONS.values():
                if value["browser"] == token:
                    value["authorize"]()
                    rows.append(_summary(value))
        receipts = _store().list_receipts(owner, check)
        check()
        return _result(connections=rows, receipts=receipts, checked_at=_stamp())
    except Exception:
        check()
        raise


def connect(request, data, check):
    token, owner, check = _admit(request, check)
    ticket = object()
    _lease(token, check)
    try:
        config = transport.configuration(data.get("origin"), data.get("certificate_sha256", ""))
        password = data.get("password")
        if not isinstance(password, str) or not 1 <= len(password) <= 512:
            raise HTTPException(422, "Enter a Pi-hole application password.")
        # The current TLI listener is never a Pi-hole authentication destination.
        if ipaddress.ip_address(config["host"]).is_loopback:
            request_port = request.url.port or (443 if request.url.scheme == "https" else 80)
            server = request.scope.get("server")
            if config["port"] == request_port or server and config["port"] == server[1]:
                raise HTTPException(422, "Choose the Pi-hole listener, not the current TLI listener.")
        with LOCK:
            check()
            _purge()
            owned = any(value["browser"] == token for value in CONNECTIONS.values())
            if len(CONNECTIONS) + len(PENDING) >= MAX_CONNECTIONS and not owned:
                raise HTTPException(429, "The temporary Pi-hole connection limit was reached.")
            PENDING[token] = ticket
        def candidate():
            check()
            with LOCK:
                check()
                if PENDING.get(token) is not ticket:
                    raise HTTPException(409, "The pending Pi-hole connection was disconnected. Its late response was discarded.")
        candidate = _sticky(candidate)
        try:
            auth = transport.validate_session(transport.exchange(config, "POST", "/api/auth", candidate, body={"password": password}))
        finally:
            password = None
            data["password"] = ""
        candidate()
        duration = min(TTL, auth["validity"])
        value = {"id": secrets.token_hex(16), "browser": token, "owner": owner, "config": config,
                 "sid": auth["sid"], "authorize": check, "deadline": time.monotonic() + duration,
                 "expires_at": _stamp(time.time() + duration),
                 "tls_mode": "certificate_pin" if config["fingerprint"] else "system_trust"}
        with LOCK:
            candidate()
            for ident, previous in list(CONNECTIONS.items()):
                if previous["browser"] == token:
                    _drop_connection(ident)
            CONNECTIONS[value["id"]] = value
        check()
        return _result(connection=_summary(value), actions_performed=False)
    except Exception:
        check()
        raise
    finally:
        data["password"] = ""
        with LOCK:
            if PENDING.get(token) is ticket:
                PENDING.pop(token, None)
        _release(token)


def inventory(request, data, check):
    value, check = _connection(request, data.get("connection_id"), check)
    _lease(value["browser"], check)
    try:
        clients, groups = _snapshot(value, check)
        check()
        return _result(connection_id=value["id"], clients=clients, groups=groups, checked_at=_stamp(), actions_performed=False)
    except Exception:
        check()
        raise
    finally:
        _release(value["browser"])


def activity(request, data, check):
    value, check = _connection(request, data.get("connection_id"), check)
    _lease(value["browser"], check)
    try:
        # A policy client's exact IP is a deliberate DNS filter, never a name inference.
        clients = transport.project_clients(_fetch(value, "GET", "/api/clients", check))
        client = _exact_client(clients, data.get("client"))
        query_ip = str(ipaddress.ip_address(client["client"]))
        until = int(time.time())
        start = until - 900
        query = urlencode({"client_ip": query_ip, "from": start, "until": until, "length": 100, "disk": "false"})
        activity_value = transport.project_queries(_fetch(value, "GET", "/api/queries?" + query, check), query_ip, start=start, until=until)
        check()
        return _result(connection_id=value["id"], client=client["client"], **activity_value,
                       **{"from": start, "until": until}, checked_at=_stamp(), actions_performed=False,
                       scope="Up to 100 Pi-hole-reported DNS queries for this exact IP during the last 15 minutes. This is not browsing history or proof of a page visit.")
    except Exception:
        check()
        raise
    finally:
        _release(value["browser"])


def review(request, data, check):
    value, check = _connection(request, data.get("connection_id"), check)
    _lease(value["browser"], check)
    try:
        action = data.get("action")
        requested = data.get("groups")
        receipt_id = data.get("receipt_id")
        if action not in ("groups", "pause", "restore") or not isinstance(requested, list):
            raise HTTPException(422, "Review a client group assignment, pause, or explicit restoration.")
        if len(requested) > 256 or any(type(ident) is not int or ident < 0 for ident in requested) or len(set(requested)) != len(requested):
            raise HTTPException(422, "Select unique existing Pi-hole group identifiers.")
        if action == "groups" and (not requested or receipt_id is not None):
            raise HTTPException(422, "Select one or more groups. Use Pause for an empty membership list.")
        if action in ("pause", "restore") and requested or action == "pause" and receipt_id is not None:
            raise HTTPException(422, "Pause and Restore derive their exact memberships from the reviewed state or receipt.")
        if action == "restore" and (not isinstance(receipt_id, str) or not receipt_id):
            raise HTTPException(422, "Select the saved receipt to restore.")
        clients, groups = _snapshot(value, check)
        client = _exact_client(clients, data.get("client"))
        if action == "restore":
            receipt = _store().get(value["owner"], receipt_id, check)
            target = _restore_groups(value, client, groups, receipt, check)
        else:
            target = sorted(requested) if action == "groups" else []
        definitions = {row["id"]: row for row in groups}
        if any(ident not in definitions for ident in client["groups"]):
            raise HTTPException(409, "The client refers to an unavailable group definition. Refresh Pi-hole before reviewing a change.")
        if any(ident not in definitions for ident in target):
            raise HTTPException(409, "A selected group no longer exists. Read the current groups and review again.")
        if sorted(client["groups"]) == target:
            raise HTTPException(409, "This client already has those group memberships. No change is needed.")
        duration = min(REVIEW_TTL, value["deadline"] - time.monotonic())
        ident = secrets.token_hex(32)
        record = {"id": ident, "connection_id": value["id"], "browser": value["browser"],
                  "deadline": time.monotonic() + duration, "expires_at": _stamp(time.time() + duration),
                  "client": client, "groups": groups, "revision": _revision(client, groups),
                  "after_groups": target, "action": action, "source_receipt": receipt_id, "running": False,
                  "receipt_id": None}
        with LOCK:
            check()
            _purge()
            if len(REVIEWS) >= MAX_REVIEWS or sum(row["browser"] == value["browser"] for row in REVIEWS.values()) >= 8:
                raise HTTPException(429, "Too many active Pi-hole reviews. Wait for their expiry before reviewing again.")
            REVIEWS[ident] = record
        check()
        return _result(review_id=ident, expires_at=record["expires_at"], target={"client": client["client"], "origin": value["config"]["origin"]},
                       before_groups=sorted(client["groups"]), after_groups=target,
                       group_names=[{"id": row["id"], "name": row["name"]} for row in groups], action=action,
                       scope="One exact client's group memberships will change. Other administrators can race this review. Pause remains in Pi-hole until explicitly restored; no timer runs. Membership verification does not verify DNS behavior.")
    except Exception:
        check()
        raise
    finally:
        _release(value["browser"])


def _acknowledged(raw, client):
    if not isinstance(raw, dict) or "error" in raw:
        return False
    processed = raw.get("processed")
    if not isinstance(processed, dict) or processed.get("errors") or processed.get("failed"):
        return False
    success = processed.get("success")
    return isinstance(success, list) and any(isinstance(row, dict) and row.get("item") == client for row in success)


def execute(request, data, check):
    value, check = _connection(request, data.get("connection_id"), check)
    if data.get("reviewed") is not True:
        check()
        raise HTTPException(422, "Confirm the displayed Pi-hole membership review before submitting it.")
    _lease(value["browser"], check)
    active = None
    target_key = None
    try:
        existing_receipt = None
        with LOCK:
            check()
            _purge()
            active = REVIEWS.get(data.get("review_id"))
            if not active or active["connection_id"] != value["id"] or active["browser"] != value["browser"]:
                raise HTTPException(409, "This Pi-hole review expired or changed. Read and review the client again.")
            if active["receipt_id"] is not None:
                existing_receipt = active["receipt_id"]
            else:
                target_key = (value["config"]["origin"], str(ipaddress.ip_address(active["client"]["client"])))
                if active["running"] or target_key in TARGETS:
                    target_key = None
                    raise HTTPException(409, "Another operation for this exact Pi-hole client is running. No second request was submitted.")
                TARGETS.add(target_key)
                active["running"] = True
        # Receipt operations call authority checks while holding their own lock.
        # Never acquire that lock while the connection/review lock is held.
        if existing_receipt is not None:
            receipt = _store().get(value["owner"], existing_receipt, check)
            check()
            return _result(receipt=receipt)
        def prepare_check():
            check()
            with LOCK:
                check()
                if REVIEWS.get(active["id"]) is not active or active["deadline"] <= time.monotonic():
                    raise HTTPException(409, "This Pi-hole review expired before submission. No new membership request is authorized.")
        prepare_check()
        clients, groups = _snapshot(value, prepare_check)
        client = _exact_client(clients, active["client"]["client"])
        if _revision(client, groups) != active["revision"]:
            with LOCK:
                REVIEWS.pop(active["id"], None)
            raise HTTPException(409, "The client or group definitions changed since review. No membership update was submitted. Review again.")
        if active["action"] == "restore":
            old = _store().get(value["owner"], active["source_receipt"], check)
            if _restore_groups(value, client, groups, old, check) != active["after_groups"]:
                raise HTTPException(409, "The saved restoration no longer matches this review.")
        prepare_check()
        reserved = _store().reserve(value["owner"], {
            "origin": value["config"]["origin"], "tls_mode": value["tls_mode"], "pin": value["config"]["fingerprint"],
            "client": client["client"], "before": {"clientrecord": client, "groups": groups},
            "after_groups": active["after_groups"], "action": active["action"]}, prepare_check)
        # The durable reservation consumes the review even if authority is lost next.
        with LOCK:
            active["receipt_id"] = reserved["id"]
        attempted = False
        acknowledged = False
        outcome = {"outcome": "not_attempted", "attempted": False, "acknowledged": False, "membership_verified": False,
                   "summary": "The durable receipt was reserved, but no membership request was submitted. No automatic retry runs."}
        def mark_attempt():
            nonlocal attempted
            prepare_check()
            attempted = True
        try:
            check()
            raw = _fetch(value, "PUT", "/api/clients/" + quote(client["client"], safe=""), check,
                         body={"groups": active["after_groups"], "comment": client["comment"]}, on_attempt=mark_attempt)
            acknowledged = _acknowledged(raw, client["client"])
            outcome.update(outcome="accepted" if acknowledged else "unknown", attempted=attempted, acknowledged=acknowledged,
                           summary="Pi-hole acknowledged the membership request; a current membership read is still required." if acknowledged else "Pi-hole did not confirm the membership request. Read its current state before any further action.")
            readback = transport.project_clients(_fetch(value, "GET", "/api/clients", check))
            final_client = _exact_client(readback, client["client"])
            matched = (_identity(final_client) == _identity(client) and sorted(final_client["groups"]) == active["after_groups"]
                       and final_client["comment"] == client["comment"])
            outcome.update(outcome="confirmed" if matched else "mismatch", membership_verified=matched,
                           summary="Pi-hole reported the requested client memberships. DNS behavior has not been verified." if matched else "Pi-hole's current client record does not match the requested memberships and preserved identity. No automatic repair or retry runs.")
        except Exception:
            outcome.update(attempted=attempted, acknowledged=acknowledged)
            if attempted:
                outcome.update(outcome="accepted" if acknowledged else "unknown",
                               summary="Pi-hole acknowledged the request, but membership verification was unavailable. Read the current policy before another action." if acknowledged else "The membership request may have reached Pi-hole, but its outcome is unconfirmed. Read the current policy before another action; nothing will retry automatically.")
        outcome["checked_at"] = _stamp()
        # Internal receipt retention deliberately precedes a potentially denied disclosure.
        receipt = _store().finish(value["owner"], reserved["id"], outcome)
        check()
        return _result(receipt=receipt)
    except Exception:
        check()
        raise
    finally:
        with LOCK:
            if active is not None:
                active["running"] = False
            if target_key is not None:
                TARGETS.discard(target_key)
        _release(value["browser"])


def disconnect(request, data, check):
    token, owner, check = _admit(request, check)
    try:
        with LOCK:
            check()
            value = CONNECTIONS.get(data.get("connection_id"))
            if value is not None and (value["browser"] != token or value["owner"] != owner):
                raise HTTPException(404, "This Pi-hole connection belongs to another browser.")
            PENDING.pop(token, None)
            if value is not None:
                _drop_connection(value["id"])
        check()
        return _result(disconnected=True, scope="TLI forgot this session. Pi-hole's API session expires separately; an already submitted membership change remains until explicitly changed or restored.")
    except Exception:
        check()
        raise
