"""The local playback path never retries or contacts a response-supplied URL."""
from __future__ import annotations

import copy
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import sonos_local as local


@pytest.fixture
def wire(monkeypatch):
    coordinator = "RINCON_BEAM001"
    other = "RINCON_AMP0001"
    rear = "RINCON_REAR001"
    group_id = coordinator + ":12345"
    group = {"coordinator": coordinator, "members": [
        {"uid": coordinator, "ip": "192.168.4.30", "bonded": True, "parent_uid": None},
        {"uid": other, "ip": "192.168.4.31", "bonded": False, "parent_uid": None},
        {"uid": rear, "ip": "192.168.4.32", "bonded": True, "parent_uid": coordinator},
    ]}
    info = {"playerId": coordinator, "device": {"id": coordinator},
            "householdId": "Sonos_HH.123", "groupId": group_id,
            "restUrl": "https://203.0.113.10:1443/", "websocketUrl": "wss://203.0.113.10/"}
    groups = {"partial": False, "groups": [{"id": group_id, "coordinatorId": coordinator,
        "playerIds": [coordinator, other]}], "players": [
            {"id": coordinator, "deviceIds": [coordinator, rear]},
            {"id": other, "deviceIds": [other]}]}
    state = SimpleNamespace(group=group, device=group["members"][1], info=info, groups=groups,
        responses=[(200, info), (200, groups), (200, copy.deepcopy(info)), (200, {})],
        connections=[], requests=[], timers=[], fail_after_post=False, headers={}, hook=None)

    class Response:
        def __init__(self, status, body):
            self.status = status
            self.body = body if isinstance(body, bytes) else json.dumps(body).encode()

        def getheader(self, name):
            return state.headers.get(name)

        def read1(self, count):
            if state.hook:
                state.hook()
            result, self.body = self.body[:count], self.body[count:]
            return result

    class Connection:
        def __init__(self, ip, port, *, timeout, context):
            self.ip, self.port, self.timeout, self.context = ip, port, timeout, context
            self.sock = SimpleNamespace(shutdown=lambda how: None)
            self.closed = False
            state.connections.append(self)

        def connect(self):
            pass

        def request(self, method, path, body=None, headers=None):
            state.requests.append((self.ip, method, path, body, headers))
            self.method = method

        def getresponse(self):
            if self.method == "POST" and state.fail_after_post:
                raise OSError("Reply lost after transmission")
            return Response(*state.responses.pop(0))

        def close(self):
            self.closed = True

    class Timer:
        def __init__(self, seconds, callback):
            self.seconds, self.callback, self.cancelled = seconds, callback, False
            state.timers.append(self)

        def start(self):
            pass

        def cancel(self):
            self.cancelled = True

    monkeypatch.setattr(local.http.client, "HTTPSConnection", Connection)
    monkeypatch.setattr(local.threading, "Timer", Timer)
    monkeypatch.setattr(local, "_api_key", lambda: "test-integration-key")
    return state


@pytest.mark.parametrize(("action", "endpoint"), [
    ("play", "play"), ("pause", "pause"), ("stop", "pause"),
    ("next", "skipToNextTrack"), ("previous", "skipToPreviousTrack")])
def test_transport_uses_current_coordinator_once_and_preserves_source(wire, action, endpoint):
    assert local.perform(wire.device, wire.group, action) == {}
    assert [request[1] for request in wire.requests] == ["GET", "GET", "GET", "POST"]
    assert all(request[0] == "192.168.4.30" for request in wire.requests)
    assert wire.requests[-1][2] == "/api/v1/groups/RINCON_BEAM001%3A12345/playback/" + endpoint
    assert wire.requests[-1][3] == b"{}"
    assert all(request[4]["X-Sonos-Api-Key"] == "test-integration-key" for request in wire.requests)
    assert all(connection.port == 1443 and 0 < connection.timeout <= 3 and connection.closed for connection in wire.connections)
    assert all(0 < timer.seconds <= 12 and timer.cancelled for timer in wire.timers)


@pytest.mark.parametrize("field", ["playerId", "device"])
def test_current_coordinator_identity_must_match_before_any_effect(wire, field):
    wire.info[field] = "RINCON_OTHER001" if field == "playerId" else {"id": "RINCON_OTHER001"}
    with pytest.raises(HTTPException) as caught:
        local.perform(wire.device, wire.group, "play")
    assert caught.value.status_code == 409
    assert all(request[1] == "GET" for request in wire.requests)


@pytest.mark.parametrize("change", ["extra", "missing", "coordinator", "partial", "duplicate", "unexpanded", "ordinary"])
def test_modern_topology_must_match_every_reviewed_member(wire, change):
    if change == "extra":
        wire.groups["players"][0]["deviceIds"].append("RINCON_OTHER001")
    elif change == "missing":
        wire.groups["players"][0]["deviceIds"].remove("RINCON_REAR001")
    elif change == "coordinator":
        wire.groups["groups"][0]["coordinatorId"] = "RINCON_AMP0001"
    elif change == "partial":
        wire.groups["partial"] = True
    elif change == "duplicate":
        wire.groups["players"].append(copy.deepcopy(wire.groups["players"][0]))
    elif change == "unexpanded":
        del wire.groups["players"][0]["deviceIds"]
    elif change == "ordinary":
        wire.groups["groups"][0]["playerIds"].remove("RINCON_AMP0001")
        wire.groups["players"][0]["deviceIds"].append("RINCON_AMP0001")
    with pytest.raises(HTTPException) as caught:
        local.perform(wire.device, wire.group, "play")
    assert caught.value.status_code == 409
    assert all(request[1] == "GET" for request in wire.requests)


def test_group_changed_after_topology_check_prevents_effect(wire):
    wire.responses[2][1]["groupId"] = "RINCON_BEAM001:99999"
    with pytest.raises(HTTPException) as caught:
        local.perform(wire.device, wire.group, "play")
    assert caught.value.status_code == 409
    assert len(wire.requests) == 3


@pytest.mark.parametrize("identifier", ["../other", "https://192.168.1.1", "x?y", "x\r\nHost:evil", "x" * 257])
def test_identifiers_cannot_inject_paths_or_headers(wire, identifier):
    wire.info["groupId"] = identifier
    with pytest.raises(HTTPException):
        local.perform(wire.device, wire.group, "play")
    assert len(wire.requests) == 1


def test_access_loss_after_connect_blocks_the_post(wire):
    def check():
        if len(wire.connections) == 4:
            raise HTTPException(401, "Locked")
    with pytest.raises(HTTPException) as caught:
        local.perform(wire.device, wire.group, "play", check)
    assert caught.value.status_code == 401
    assert len(wire.requests) == 3
    assert all(connection.closed for connection in wire.connections)


def test_access_loss_after_effect_prevents_disclosure_and_never_retries(wire):
    def check():
        if any(request[1] == "POST" for request in wire.requests):
            raise HTTPException(401, "Locked")
    with pytest.raises(HTTPException) as caught:
        local.perform(wire.device, wire.group, "play", check)
    assert caught.value.status_code == 401
    assert [request[1] for request in wire.requests].count("POST") == 1


@pytest.mark.parametrize(("code", "retained"), [
    ("ERROR_PLAYBACK_FAILED", "ERROR_PLAYBACK_FAILED"),
    ("ERROR_NO_CONTENT", "ERROR_NO_CONTENT"),
    ("ERROR_PLAYBACK_NO_CONTENT", "ERROR_PLAYBACK_NO_CONTENT"),
    ("Private stream URL https://example.test/secret", "ERROR_COMMAND_REJECTED")])
def test_explicit_rejection_is_sanitized_and_not_retried(wire, code, retained):
    wire.responses[-1] = (499, {"errorCode": code, "reason": "Private source metadata"})
    assert local.perform(wire.device, wire.group, "play") == {"rejected": True, "error_code": retained}
    assert [request[1] for request in wire.requests].count("POST") == 1


@pytest.mark.parametrize(("status", "body"), [
    (302, {"location": "https://203.0.113.10/"}), (500, {}),
    (200, {"errorCode": "ERROR_PLAYBACK_FAILED"}), (200, b"not json"),
    (200, b'{"accepted":true,"accepted":false}')])
def test_ambiguous_replies_raise_without_following_or_retrying(wire, status, body):
    wire.responses[-1] = (status, body)
    with pytest.raises(HTTPException) as caught:
        local.perform(wire.device, wire.group, "play")
    assert caught.value.status_code == 502
    assert len(wire.requests) == 4


def test_lost_post_reply_is_unknown_and_never_retried(wire):
    wire.fail_after_post = True
    with pytest.raises(HTTPException) as caught:
        local.perform(wire.device, wire.group, "play")
    assert caught.value.status_code == 502
    assert not isinstance(caught.value, local.NotSent)
    assert [request[1] for request in wire.requests].count("POST") == 1


@pytest.mark.parametrize("announced", [False, True])
def test_oversize_response_is_bounded(wire, announced):
    if announced:
        wire.headers["Content-Length"] = str(local.MAX_BYTES + 1)
    else:
        wire.responses[0] = (200, b" " * (local.MAX_BYTES + 1))
    with pytest.raises(HTTPException) as caught:
        local.perform(wire.device, wire.group, "play")
    assert caught.value.status_code == 502
    assert len(wire.requests) == 1


def test_whole_operation_deadline_stops_slow_drips(wire, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(local.time, "monotonic", lambda: clock[0])
    wire.hook = lambda: clock.__setitem__(0, clock[0] + 13)
    with pytest.raises(HTTPException) as caught:
        local.perform(wire.device, wire.group, "play")
    assert caught.value.status_code == 504
    assert len(wire.requests) == 1
    assert wire.timers[0].seconds == 12


def test_truncated_body_does_not_count_as_acknowledged(wire):
    wire.headers["Content-Length"] = "999999"
    with pytest.raises(HTTPException) as caught:
        local.perform(wire.device, wire.group, "play")
    assert caught.value.status_code == 502
    assert len(wire.requests) == 1


def test_optional_dependency_failure_precedes_any_contact(wire, monkeypatch):
    def missing():
        raise HTTPException(503, "Optional Sonos packages missing")
    monkeypatch.setattr(local, "_api_key", missing)
    with pytest.raises(HTTPException) as caught:
        local.perform(wire.device, wire.group, "play")
    assert caught.value.status_code == 503
    assert isinstance(caught.value, local.NotSent)
    assert not wire.connections


@pytest.mark.parametrize("address", ["8.8.8.8", "speaker.local", "127.0.0.1", "https://192.168.4.30"])
def test_only_literal_private_coordinator_address_is_contacted(wire, address):
    wire.group["members"][0]["ip"] = address
    with pytest.raises(HTTPException):
        local.perform(wire.device, wire.group, "play")
    assert not wire.connections


def test_room_members_reads_exact_logical_partition_without_effect(wire):
    assert local.room_members(wire.device, wire.group) == [
        {"uid": "RINCON_AMP0001", "member_uids": ["RINCON_AMP0001"]},
        {"uid": "RINCON_BEAM001", "member_uids": ["RINCON_BEAM001", "RINCON_REAR001"]},
    ]
    assert [request[1] for request in wire.requests] == ["GET", "GET"]
    assert all(request[0] == "192.168.4.30" for request in wire.requests)
