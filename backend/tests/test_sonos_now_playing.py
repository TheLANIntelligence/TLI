"""Foreground playback polling is bounded, owner-scoped, and read-only."""
from __future__ import annotations

import copy
import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import sonos_service as sonos
from routers import sonos_routes
from tests.test_sonos_service import house, effects


@pytest.fixture
def playing_house(house, monkeypatch):
    fake, first, second = house
    monkeypatch.setattr(sonos, "PLAYBACK_CURSORS", {})
    fake.playback = {first["uid"]: "PLAYING", second["uid"]: "PAUSED_PLAYBACK"}
    def playback_reading(device, group, check=None):
        sonos._check(check)
        fake.calls.append(("playback_reading", device["uid"]))
        return {"playback": fake.playback[device["uid"]], "title": "Current track", "artist": "Current artist",
                "source": sonos._playback_source("x-sonos-vli:secret-device:session,spotify:secret")}
    monkeypatch.setattr(fake, "playback_reading", playback_reading, raising=False)
    monkeypatch.setattr(sonos, "_clip", lambda *args, **kwargs: pytest.fail("Polling must not probe clips"))
    return fake, first, second


def test_poll_returns_current_groups_without_full_status_or_effects(playing_house):
    fake, first, second = playing_house
    result = sonos.now_playing("alice")
    assert result["devices_count"] == 2 and result["connected_count"] == 2
    assert result["unavailable_count"] == 0 and result["partial"] is False
    assert [row["device_id"] for row in result["groups"]] == [first["id"], second["id"]]
    assert [row["playback"] for row in result["groups"]] == ["PLAYING", "PAUSED_PLAYBACK"]
    assert result["groups"][0]["title"] == "Current track" and result["groups"][0]["artist"] == "Current artist"
    assert result["groups"][0]["name"] == "Lounge"
    assert {row[0] for row in fake.calls} == {"identity", "topology", "playback_reading"}
    assert not effects(fake)
    encoded = json.dumps(result)
    assert "192.168." not in encoded and "secret" not in encoded


def test_grouped_hardware_is_reported_once_and_satellite_labels_are_omitted(playing_house):
    fake, first, second = playing_house
    fake.groups[0]["members"] += fake.groups.pop()["members"]
    fake.groups[0]["members"][1].update(parent_uid=first["uid"], invisible=True, bonded=True, bond_source="satellite")
    result = sonos.now_playing("alice")
    assert len(result["groups"]) == 1
    assert result["groups"][0]["device_id"] == first["id"]
    assert result["groups"][0]["member_names"] == ["Lounge"]
    assert fake.calls == [("identity", first["ip"]), ("topology", first["ip"]), ("playback_reading", first["uid"])]


def test_offline_first_speaker_does_not_suppress_reachable_group(playing_house, monkeypatch):
    fake, first, second = playing_house
    original = fake.identity
    def identity(ip, check=None):
        if ip == first["ip"]:
            fake.calls.append(("offline", ip))
            raise TimeoutError("Offline")
        return original(ip, check)
    monkeypatch.setattr(fake, "identity", identity)
    result = sonos.now_playing("alice")
    assert [row["device_id"] for row in result["groups"]] == [second["id"]]
    assert result["unavailable_count"] == 1 and result["partial"]
    assert fake.calls.count(("offline", first["ip"])) == 1
    assert not effects(fake)


def test_missing_or_rebound_coordinator_is_never_contacted(playing_house):
    fake, first, second = playing_house
    fake.groups[0]["members"] += fake.groups.pop()["members"]
    fake.groups[0]["coordinator"] = second["uid"]
    fake.groups[0]["members"][1]["ip"] = "192.168.4.99"
    result = sonos.now_playing("alice")
    assert result["groups"] == [] and result["partial"]
    assert not any(row[0] == "playback_reading" for row in fake.calls)
    assert not any("192.168.4.99" in row for row in fake.calls)


def test_address_identity_mismatch_does_not_read_private_track(playing_house, monkeypatch):
    fake, first, second = playing_house
    original = fake.identity
    def identity(ip, check=None):
        info = original(ip, check)
        return {**info, "uid": "RINCON_STRANGER"} if ip == first["ip"] else info
    monkeypatch.setattr(fake, "identity", identity)
    result = sonos.now_playing("alice")
    assert [row["uid"] for row in result["groups"]] == [second["uid"]]
    assert ("playback_reading", first["uid"]) not in fake.calls


def test_unrelated_owner_labels_never_enter_poll(playing_house):
    fake, first, second = playing_house
    sonos.remove("alice", second["id"])
    sonos.enroll("bob", second["ip"], name="Bob private room", room="Secret room")
    fake.groups[0]["members"] += fake.groups.pop()["members"]
    fake.calls.clear()
    result = sonos.now_playing("alice")
    assert result["groups"][0]["member_names"] == ["Lounge"]
    encoded = json.dumps(result)
    assert "Secret" not in encoded and "Bob" not in encoded and "Kitchen" not in encoded
    assert not any(row[0] == "identity" and row[1] == second["ip"] for row in fake.calls)


def test_no_saved_devices_is_disconnected_without_network(playing_house):
    fake, _, _ = playing_house
    result = sonos.now_playing("new-owner")
    assert result["devices_count"] == 0 and result["connected_count"] == 0 and result["groups"] == []
    assert result["partial"] is False and not fake.calls


def test_each_poll_is_fresh_and_never_retains_stale_playing(playing_house, monkeypatch):
    fake, first, second = playing_house
    assert any(row["playback"] == "PLAYING" for row in sonos.now_playing("alice")["groups"])
    fake.playback[first["uid"]] = "STOPPED"
    assert all(row["playback"] != "PLAYING" for row in sonos.now_playing("alice")["groups"])
    monkeypatch.setattr(fake, "playback_reading", lambda *args: (_ for _ in ()).throw(TimeoutError("Offline")))
    assert sonos.now_playing("alice")["groups"] == []


def test_authority_loss_after_read_denies_whole_poll(playing_house, monkeypatch):
    fake, _, _ = playing_house
    allowed = [True]
    def check():
        if not allowed[0]:
            raise HTTPException(401, "Locked")
    original = fake.playback_reading
    def reading(*args):
        result = original(*args)
        allowed[0] = False
        return result
    monkeypatch.setattr(fake, "playback_reading", reading)
    with pytest.raises(HTTPException) as caught:
        sonos.now_playing("alice", check)
    assert caught.value.status_code == 401
    assert not effects(fake)


def test_revoked_authority_prevents_all_reads(playing_house):
    fake, _, _ = playing_house
    def check():
        raise HTTPException(401, "Locked")
    with pytest.raises(HTTPException):
        sonos.now_playing("alice", check)
    assert not fake.calls


def test_target_limit_rotates_to_previously_unchecked_room(playing_house, monkeypatch):
    fake, first, second = playing_house
    monkeypatch.setattr(sonos, "PLAYBACK_TARGETS", 1)
    first_poll = sonos.now_playing("alice")
    second_poll = sonos.now_playing("alice")
    assert [row["uid"] for row in first_poll["groups"]] == [first["uid"]]
    assert [row["uid"] for row in second_poll["groups"]] == [second["uid"]]
    assert first_poll["partial"] and second_poll["partial"]


def test_short_target_deadline_is_restored_before_other_rooms(playing_house, monkeypatch):
    fake, first, second = playing_house
    clock = [100.0]
    monkeypatch.setattr(sonos.time, "monotonic", lambda: clock[0])
    original = fake.identity
    def identity(ip, check=None):
        if ip == first["ip"]:
            assert sonos.LOCAL.deadline == 102
            clock[0] = 102.1
            sonos._check(check)
        return original(ip, check)
    monkeypatch.setattr(fake, "identity", identity)
    result = sonos.now_playing("alice")
    assert [row["uid"] for row in result["groups"]] == [second["uid"]]
    assert result["partial"] and not hasattr(sonos.LOCAL, "deadline")


def test_enrollment_change_during_read_prevents_stale_target_disclosure(playing_house, monkeypatch):
    fake, first, _ = playing_house
    original = fake.playback_reading
    def reading(*args):
        output = original(*args)
        data = sonos._load("alice")
        data["devices"][first["id"]]["revision"] = "changed"
        sonos._save("alice", data)
        return output
    monkeypatch.setattr(fake, "playback_reading", reading)
    with pytest.raises(HTTPException) as caught:
        sonos.now_playing("alice")
    assert caught.value.status_code == 409


def test_playback_adapter_reads_transport_and_track_only(monkeypatch):
    adapter, calls = sonos.SonosAdapter(), []
    device = {"uid": "RINCON_PLAY001", "ip": "192.168.4.10"}
    group = {"coordinator": device["uid"], "members": [device]}
    def soap(ip, service, action, args, check):
        calls.append(action)
        return {"CurrentTransportState": "PLAYING"} if action == "GetTransportInfo" else {
            "TrackURI": "x-sonos-vli:private-session,spotify:private-id",
            "TrackMetaData": '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/"><item><dc:title>Song</dc:title><dc:creator>Artist</dc:creator></item></DIDL-Lite>',
            "RelTime": "0:01:02"}
    monkeypatch.setattr(adapter, "soap", soap)
    result = adapter.playback_reading(device, group)
    assert calls == ["GetTransportInfo", "GetPositionInfo"]
    assert result["title"] == "Song" and result["artist"] == "Artist"
    assert result["source"]["kind"] == "spotify_connect"
    assert "private" not in json.dumps(result)


def test_now_playing_route_captures_authority_and_disables_http_cache(playing_house, monkeypatch):
    fake, _, _ = playing_house
    checks = []
    monkeypatch.setattr(sonos_routes, "authority", lambda request, response: ("alice", lambda: checks.append(True)))
    app = FastAPI()
    app.include_router(sonos_routes.router)
    with TestClient(app) as client:
        response = client.get("/api/sonos/now-playing")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert len(checks) > 3 and response.json()["groups"]
    assert not effects(fake)
