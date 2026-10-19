"""Bounded local Sonos playback for sources controlled outside the SOAP queue.

The caller supplies a freshly verified, fully enrolled SOAP group. Advertised
UIDs are checked again on the coordinator's local HTTPS endpoint; the speaker's
self-signed certificate is not a cryptographic household identity. No URL from
a response is followed, no action is retried, and no queue or source is replaced.

Sonos' playback namespace exposes pause rather than a separate stop command.
For these sources, stop therefore sends pause once, which can result in PAUSED
or IDLE depending on the source (docs.sonos.com/reference/playback-pause-groupid).
"""
from __future__ import annotations

import http.client
import ipaddress
import json
import re
import socket
import ssl
import threading
import time
from urllib.parse import quote

from fastapi import HTTPException

MAX_BYTES = 2 * 1024 * 1024
MAX_MEMBERS = 64
OPERATION_SECONDS = 12
NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
IDENTIFIER = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,255}$")
ACTIONS = {"play": "play", "pause": "pause", "stop": "pause",
           "next": "skipToNextTrack", "previous": "skipToPreviousTrack"}
# Only known, non-private protocol values can enter a retained command receipt.
ERROR_CODES = frozenset({
    "ERROR_PLAYBACK_FAILED", "ERROR_INVALID_PARAMETER", "ERROR_MISSING_PARAMETER",
    "ERROR_INVALID_OBJECT", "ERROR_NOT_CAPABLE", "ERROR_NOT_SUPPORTED",
    "ERROR_UPNP_AVT_TRANSITION_NOT_AVAILABLE", "ERROR_COMMAND_FAILED",
    "ERROR_NO_CONTENT", "ERROR_PLAYBACK_NO_CONTENT",
})


class NotSent(HTTPException):
    """Preparation failed before entering the single mutating exchange."""


def _guard(check, deadline):
    if check is not None:
        check()
    if time.monotonic() >= deadline:
        raise HTTPException(504, "The Sonos operation reached its deadline. No automatic retry runs.")


def _identifier(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise HTTPException(502, "Sonos returned an invalid local playback identity.")
    return value


def _ip(value):
    try:
        address = ipaddress.ip_address(value)
        if address.version != 4 or not any(address in network for network in NETWORKS):
            raise ValueError()
        return str(address)
    except (ValueError, TypeError):
        raise HTTPException(422, "Use a literal private LAN IPv4 address for the speaker.") from None


def _api_key():
    try:
        from sonos_websocket.const import API_KEY
    except ImportError:
        raise HTTPException(503, "Control of this Sonos source needs the optional requirements-sonos.txt packages on Python 3.11+.") from None
    if not isinstance(API_KEY, str) or not API_KEY or len(API_KEY) > 256 or any(ord(c) < 33 or ord(c) > 126 for c in API_KEY):
        raise HTTPException(503, "The optional Sonos local playback package is unavailable.")
    return API_KEY


def _json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON field")
            result[key] = value
        return result

    result = json.loads(raw, object_pairs_hook=pairs)
    if not isinstance(result, dict):
        raise ValueError("Invalid JSON response")
    return result


def _request(ip, method, path, key, check, deadline):
    """Perform one fixed-endpoint exchange, bounded even for slow response drips."""
    _guard(check, deadline)
    if method not in {"GET", "POST"} or not path.startswith("/api/v1/") or any(c in path for c in "\r\n?#"):
        raise HTTPException(422, "Invalid Sonos local playback request.")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE  # Sonos local API serves self-signed TLS.
    connection = http.client.HTTPSConnection(_ip(ip), 1443,
        timeout=max(.01, min(3, deadline - time.monotonic())), context=context)
    timer = None
    try:
        connection.connect()
        _guard(check, deadline)
        peer_socket = connection.sock

        def interrupt():
            try:
                peer_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        timer = threading.Timer(max(.01, deadline - time.monotonic()), interrupt)
        timer.daemon = True
        timer.start()
        _guard(check, deadline)  # Recheck after connection setup, before any effect.
        connection.request(method, path, body=b"{}" if method == "POST" else None,
            headers={"X-Sonos-Api-Key": key, "Accept": "application/json",
                     "Content-Type": "application/json", "Connection": "close"})
        response = connection.getresponse()
        length = response.getheader("Content-Length")
        if length is not None and (not length.isdecimal() or int(length) > MAX_BYTES):
            raise ValueError("Invalid response length")
        chunks, total = [], 0
        while True:
            _guard(check, deadline)
            chunk = response.read1(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_BYTES:
                raise ValueError("Response exceeds limit")
            chunks.append(chunk)
        if length is not None and total != int(length):
            raise ValueError("Incomplete response")
        payload = _json(b"".join(chunks)) if total else {}
        _guard(check, deadline)
        return response.status, payload
    except (OSError, ValueError, TypeError, RecursionError, http.client.HTTPException):
        _guard(check, deadline)
        raise HTTPException(502, "Sonos did not provide a readable local playback response. No automatic retry runs.") from None
    finally:
        if timer:
            timer.cancel()
        connection.close()


def _read(ip, path, key, check, deadline):
    status, payload = _request(ip, "GET", path, key, check, deadline)
    if status != 200 or "errorCode" in payload:
        raise HTTPException(502, "Sonos local playback information is unavailable. No command was sent.")
    return payload


def _info(payload, coordinator):
    device = payload.get("device")
    if not isinstance(device, dict) or payload.get("playerId") != coordinator or device.get("id") != coordinator:
        raise HTTPException(409, "The Sonos coordinator identity changed. Refresh the rooms before trying again.")
    return _identifier(payload.get("householdId")), _identifier(payload.get("groupId"))


def _validate_group(payload, group_id, coordinator, members):
    groups, players = payload.get("groups"), payload.get("players")
    if payload.get("partial") is not False or not isinstance(groups, list) or not isinstance(players, list):
        raise HTTPException(409, "Sonos did not return a complete current group. Refresh the rooms before trying again.")
    if not 1 <= len(groups) <= MAX_MEMBERS or not 1 <= len(players) <= MAX_MEMBERS:
        raise HTTPException(502, "Sonos returned invalid local playback groups.")
    if any(not isinstance(row, dict) for row in groups + players):
        raise HTTPException(502, "Sonos returned invalid local playback groups.")
    matching = [row for row in groups if row.get("id") == group_id]
    if len(matching) != 1 or matching[0].get("coordinatorId") != coordinator:
        raise HTTPException(409, "The Sonos group coordinator changed. Refresh the rooms before trying again.")
    ids = matching[0].get("playerIds")
    if not isinstance(ids, list) or not 1 <= len(ids) <= MAX_MEMBERS or any(not isinstance(uid, str) for uid in ids):
        raise HTTPException(502, "Sonos returned invalid local playback group members.")
    reviewed = {member["uid"] for member in members}
    ordinary = {member["uid"] for member in members if not member.get("bonded")}
    if len(set(ids)) != len(ids) or coordinator not in ids or not ordinary <= set(ids) or not set(ids) <= reviewed:
        raise HTTPException(409, "The Sonos group changed. Refresh the rooms before trying again.")
    expanded = set()
    for uid in ids:
        rows = [player for player in players if player.get("id") == uid]
        devices = rows[0].get("deviceIds") if len(rows) == 1 else None
        if (not isinstance(devices, list) or not 1 <= len(devices) <= MAX_MEMBERS
                or any(not isinstance(value, str) for value in devices)
                or len(set(devices)) != len(devices) or uid not in devices
                or expanded.intersection(devices)):
            raise HTTPException(409, "Sonos did not confirm every reviewed group member. Refresh the rooms before trying again.")
        expanded.update(devices)
    if expanded != reviewed:
        raise HTTPException(409, "The Sonos group changed. Refresh the rooms before trying again.")


def _prepare(device, group, action, check, deadline):
    _guard(check, deadline)
    if action not in ACTIONS:
        raise HTTPException(422, "Unsupported Sonos local playback operation.")
    members = group.get("members")
    coordinator = _identifier(group.get("coordinator"))
    if not isinstance(members, list) or not 1 <= len(members) <= MAX_MEMBERS:
        raise HTTPException(409, "A verified Sonos group is required.")
    if any(not isinstance(member, dict) for member in members):
        raise HTTPException(409, "A verified Sonos group is required.")
    uids = [_identifier(member.get("uid")) for member in members]
    targets = [member for member in members if member["uid"] == coordinator]
    selected = [member for member in members if member["uid"] == device.get("uid") and member.get("ip") == device.get("ip")]
    if len(set(uids)) != len(uids) or len(targets) != 1 or len(selected) != 1:
        raise HTTPException(409, "A verified Sonos coordinator and selected room are required.")
    ip = _ip(targets[0].get("ip"))
    key = _api_key()
    info_path = "/api/v1/players/local/info"
    household_id, group_id = _info(_read(ip, info_path, key, check, deadline), coordinator)
    groups_path = "/api/v1/households/" + quote(household_id, safe="") + "/groups"
    _validate_group(_read(ip, groups_path, key, check, deadline), group_id, coordinator, members)
    if _info(_read(ip, info_path, key, check, deadline), coordinator) != (household_id, group_id):
        raise HTTPException(409, "The Sonos group changed. Refresh the rooms before trying again.")
    _guard(check, deadline)
    path = "/api/v1/groups/" + quote(group_id, safe="") + "/playback/" + ACTIONS[action]
    return ip, path, key


def perform(device, group, action, check=None):
    """Send one local playback command to the caller's verified coordinator.

    Return {} on acknowledgement, or a sanitized explicit rejection. NotSent
    means preparation ended before any mutating exchange. Other exceptions
    mean delivery is unknown and must never trigger fallback. The caller owns
    durable no-replay receipts and must recheck authority before disclosure.
    """
    deadline = time.monotonic() + OPERATION_SECONDS
    try:
        ip, path, key = _prepare(device, group, action, check, deadline)
    except HTTPException as exc:
        raise NotSent(exc.status_code, exc.detail) from None
    status, payload = _request(ip, "POST", path, key, check, deadline)
    _guard(check, deadline)
    if 200 <= status < 300 and "errorCode" not in payload:
        return {}
    code = payload.get("errorCode")
    if 400 <= status < 600 and isinstance(code, str) and code:
        return {"rejected": True, "error_code": code if code in ERROR_CODES else "ERROR_COMMAND_REJECTED"}
    raise HTTPException(502, "Sonos did not acknowledge local playback. No redirect or retry ran.")


def room_members(device, group, check=None):
    """Read the exact logical-room partition, without sending a command."""
    deadline = time.monotonic() + OPERATION_SECONDS
    _guard(check, deadline)
    coordinator = group["coordinator"]
    target = next(member for member in group["members"] if member["uid"] == coordinator)
    key = _api_key()
    household, group_id = _info(_read(target["ip"], "/api/v1/players/local/info", key, check, deadline), coordinator)
    payload = _read(target["ip"], "/api/v1/households/" + quote(household, safe="") + "/groups", key, check, deadline)
    _validate_group(payload, group_id, coordinator, group["members"])
    ids = next(row["playerIds"] for row in payload["groups"] if row["id"] == group_id)
    result = [{"uid": uid, "member_uids": sorted(next(player["deviceIds"] for player in payload["players"] if player["id"] == uid))} for uid in ids]
    _guard(check, deadline)
    return sorted(result, key=lambda row: row["uid"])
