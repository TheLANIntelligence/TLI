"""Logical-room controls, capped group adjustment and partial delivery receipts."""
from __future__ import annotations

import copy

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import sonos_service as sonos
import sonos_local
from routers import sonos_routes
from tests.test_sonos_service import house, effects, parse_topology


@pytest.fixture
def grouped(house):
    fake, first, second = house
    fake.groups[0]["members"] += fake.groups.pop()["members"]
    fake.volumes = {first["uid"]: 10, second["uid"]: 20}
    return fake, first, second


def bond_rear(fake, primary, cap=18):
    address, uid = "192.168.4.12", "RINCON_REAR000001"
    fake.identities[address] = {**fake.identities[primary["ip"]], "ip": address, "uid": uid}
    rear = sonos.enroll("alice", address, volume_cap=cap)["device"]
    member = next(row for row in fake.groups[0]["members"] if row["uid"] == primary["uid"])
    member.update(bonded=True, bond_source="satellite_parent")
    fake.groups[0]["members"].append({"uid": uid, "ip": address, "name": primary["name"],
        "bonded": True, "parent_uid": primary["uid"], "bond_source": "satellite", "invisible": True})
    return rear


def test_status_shows_one_control_per_logical_room_with_bonded_cap(grouped):
    fake, first, second = grouped
    rear = bond_rear(fake, first)
    controls = sonos.status("alice", first["id"])["volume_controls"]
    rooms = {row["uid"]: row for row in controls["rooms"]}
    assert set(rooms) == {first["uid"], second["uid"]}
    assert rooms[first["uid"]] == {"device_id": first["id"], "uid": first["uid"], "name": "Lounge",
        "volume": 10, "muted": False, "volume_cap": 18}
    assert rooms[second["uid"]]["volume"] == 20
    assert controls["group"] == {"volume": 15, "max": 26, "muted": False}
    assert not any(row[0] == "volume_reading" and row[1] == rear["uid"] for row in fake.calls)


def test_lightweight_volume_controls_read_only_room_levels(grouped, monkeypatch):
    fake, first, second = grouped
    rear = bond_rear(fake, first)
    fake.calls.clear()
    monkeypatch.setattr(sonos, "_clip", lambda *args, **kwargs: pytest.fail("Do not probe clips for sliders"))
    monkeypatch.setattr(fake, "reading", lambda *args: pytest.fail("Do not read playback tracks for sliders"))
    result = sonos.volume_controls("alice", first["id"])
    assert result["ok"] and result["device_id"] == first["id"]
    assert result["protocol"] == sonos.PROTOCOL and result["checked_at"].endswith("Z")
    assert [row["uid"] for row in result["volume_controls"]["rooms"]] == [first["uid"], second["uid"]]
    assert result["volume_controls"]["rooms"][0]["volume_cap"] == 18
    assert {row[0] for row in fake.calls} == {"identity", "topology", "volume_reading"}
    assert not any(row[0] == "volume_reading" and row[1] == rear["uid"] for row in fake.calls)
    assert not effects(fake)


def test_lightweight_controls_keep_owned_room_in_partial_group(grouped):
    fake, first, second = grouped
    sonos.remove("alice", second["id"])
    fake.calls.clear()
    controls = sonos.volume_controls("alice", first["id"])["volume_controls"]
    assert controls["group"] is None and [row["uid"] for row in controls["rooms"]] == [first["uid"]]
    assert not any(second["ip"] in row or second["uid"] in row for row in fake.calls)


def test_lightweight_volume_controls_require_own_enrollment(grouped):
    fake, first, _ = grouped
    with pytest.raises(HTTPException) as caught:
        sonos.volume_controls("bob", first["id"])
    assert caught.value.status_code == 404 and not fake.calls


def test_lightweight_volume_authority_loss_denies_disclosure(grouped, monkeypatch):
    fake, first, _ = grouped
    allowed = [True]
    def check():
        if not allowed[0]:
            raise HTTPException(401, "Locked")
    original = fake.volume_reading
    def reading(*args):
        result = original(*args)
        allowed[0] = False
        return result
    monkeypatch.setattr(fake, "volume_reading", reading)
    with pytest.raises(HTTPException) as caught:
        sonos.volume_controls("alice", first["id"], check)
    assert caught.value.status_code == 401 and not effects(fake)
    assert len([row for row in fake.calls if row[0] == "volume_reading"]) == 1


def test_lightweight_volume_reading_retains_operation_deadline(grouped, monkeypatch):
    fake, first, _ = grouped
    clock = [100.0]
    monkeypatch.setattr(sonos.time, "monotonic", lambda: clock[0])
    def reading(*args):
        assert sonos.LOCAL.deadline == 124
        clock[0] = 125
        sonos._check()
    monkeypatch.setattr(fake, "volume_reading", reading)
    with pytest.raises(HTTPException) as caught:
        sonos.volume_controls("alice", first["id"])
    assert caught.value.status_code == 504 and not effects(fake)
    assert not hasattr(sonos.LOCAL, "deadline")


def test_lightweight_controls_reject_room_cap_change_during_read(grouped, monkeypatch):
    fake, first, second = grouped
    original = fake.volume_reading
    def reading(*args):
        output = original(*args)
        data = sonos._load("alice")
        data["devices"][second["id"]]["volume_cap"] = 15
        sonos._save("alice", data)
        return output
    monkeypatch.setattr(fake, "volume_reading", reading)
    with pytest.raises(HTTPException) as caught:
        sonos.volume_controls("alice", first["id"])
    assert caught.value.status_code == 409 and not effects(fake)


def test_volume_controls_route_captures_authority_and_disables_cache(grouped, monkeypatch):
    fake, first, _ = grouped
    checks = []
    monkeypatch.setattr(sonos_routes, "authority", lambda request, response: ("alice", lambda: checks.append(True)))
    app = FastAPI()
    app.include_router(sonos_routes.router)
    with TestClient(app) as client:
        response = client.get("/api/sonos/devices/" + first["id"] + "/volume-controls")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert len(checks) > 3 and response.json()["volume_controls"]["rooms"]
    assert not effects(fake)


def test_individual_room_volume_reserves_its_satellites_and_obeys_lowest_cap(grouped):
    fake, first, _ = grouped
    rear = bond_rear(fake, first)
    with pytest.raises(HTTPException) as caught:
        sonos.prepare("alice", first["id"], "volume", {"volume": 19})
    assert caught.value.status_code == 422 and not effects(fake)
    review = sonos.prepare("alice", first["id"], "volume", {"volume": 16})
    assert {row["uid"] for row in review["affected"]} == {first["uid"], rear["uid"]}
    result = sonos.execute("alice", review["review_id"], "room-volume-123456")
    assert result["ok"] and result["volume_controls"]["rooms"][0]["volume"] == 16
    assert effects(fake) == [("perform", first["uid"], "volume", {"volume": 16})]
    with pytest.raises(HTTPException) as caught:
        sonos.prepare("alice", rear["id"], "volume", {"volume": 10})
    assert caught.value.status_code == 422


def test_flat_stereo_map_identifies_one_master_without_inventing_parent(monkeypatch):
    group = parse_topology(monkeypatch, '''<ZoneGroups><ZoneGroup Coordinator="RINCON_LEFT001">
      <ZoneGroupMember UUID="RINCON_LEFT001" Location="http://192.168.4.10:1400/xml/device_description.xml"
        ChannelMapSet="RINCON_LEFT001:LF,LF;RINCON_RIGHT001:RF,RF"/>
      <ZoneGroupMember UUID="RINCON_RIGHT001" Location="http://192.168.4.11:1400/xml/device_description.xml"
        Invisible="1" ChannelMapSet="RINCON_LEFT001:LF,LF;RINCON_RIGHT001:RF,RF"/>
    </ZoneGroup></ZoneGroups>''')[0]
    assert all(member["parent_uid"] is None for member in group["members"])
    assert sonos._room_layout({}, group) == [{"uid": "RINCON_LEFT001", "member_uids": ["RINCON_LEFT001", "RINCON_RIGHT001"]}]


def test_ambiguous_bond_requires_validated_local_partition(grouped, monkeypatch):
    fake, first, _ = grouped
    fake.groups[0]["members"][0].update(bonded=True, bond_source="channel_map")
    def unavailable(*args):
        raise HTTPException(409, "Unverified group")
    monkeypatch.setattr(sonos_local, "room_members", unavailable)
    with pytest.raises(HTTPException):
        sonos.prepare("alice", first["id"], "group_volume", {"volume": 20})
    assert not effects(fake)


def test_partially_enrolled_group_retains_complete_owned_room_control(grouped):
    fake, first, second = grouped
    sonos.remove("alice", second["id"])
    fake.calls.clear()
    controls = sonos.status("alice", first["id"])["volume_controls"]
    assert controls["group"] is None and len(controls["rooms"]) == 1
    assert controls["rooms"][0]["device_id"] == first["id"]
    assert controls["rooms"][0]["volume"] == 10
    assert not any(row[0] == "identity" and row[1] == second["ip"] for row in fake.calls)
    assert not any(row[0] == "volume_reading" and row[1] == second["uid"] for row in fake.calls)


def test_partially_enrolled_bond_does_not_invent_a_control(grouped, monkeypatch):
    fake, first, second = grouped
    rear = bond_rear(fake, first)
    sonos.remove("alice", rear["id"])
    controls = sonos.status("alice", first["id"])["volume_controls"]
    assert controls["group"] is None
    assert [room["uid"] for room in controls["rooms"]] == [second["uid"]]
    fake.groups[0]["members"][0]["bond_source"] = "unknown"
    fake.groups[0]["members"][-1].pop("parent_uid")
    monkeypatch.setattr(sonos_local, "room_members", lambda *args: pytest.fail("Incomplete group must not invoke modern topology fallback"))
    assert sonos.status("alice", first["id"])["volume_controls"]["rooms"] == []


def test_group_adjustment_preserves_balance_and_returns_all_room_levels(grouped):
    fake, first, second = grouped
    review = sonos.prepare("alice", first["id"], "group_volume", {"volume": 24})
    result = sonos.execute("alice", review["review_id"], "group-volume-123456")
    assert result["ok"] and result["outcome"] == "accepted"
    assert [(row[1], row[3]["volume"]) for row in effects(fake)] == [(first["uid"], 16), (second["uid"], 32)]
    assert result["volume_controls"]["group"]["volume"] == 24
    assert [row["outcome"] for row in result["room_results"]] == ["accepted", "accepted"]
    assert sonos.execute("alice", review["review_id"], "group-volume-123456") == result
    assert len(effects(fake)) == 2


def test_group_plan_is_calculated_from_execution_time_volumes(grouped):
    fake, first, second = grouped
    review = sonos.prepare("alice", first["id"], "group_volume", {"volume": 20})
    fake.volumes.update({first["uid"]: 20, second["uid"]: 10})
    result = sonos.execute("alice", review["review_id"], "fresh-volume-123456")
    assert [row["before"] for row in result["room_results"]] == [20, 10]
    assert [row["target"] for row in result["room_results"]] == [27, 13]


def test_group_plan_never_exceeds_each_room_cap(grouped):
    fake, first, second = grouped
    sonos.enroll("alice", first["ip"], volume_cap=15)
    review = sonos.prepare("alice", first["id"], "group_volume", {"volume": 25})
    result = sonos.execute("alice", review["review_id"], "capped-volume-123456")
    assert [row["target"] for row in result["room_results"]] == [15, 35]
    with pytest.raises(HTTPException) as caught:
        sonos.prepare("alice", first["id"], "group_volume", {"volume": 26})
    assert caught.value.status_code == 422


@pytest.mark.parametrize("change", ["topology", "cap"])
def test_group_changes_after_review_prevent_all_effects(grouped, change):
    fake, first, second = grouped
    review = sonos.prepare("alice", first["id"], "group_volume", {"volume": 20})
    if change == "topology":
        fake.groups[0]["members"].pop()
    else:
        sonos.enroll("alice", second["ip"], volume_cap=30)
    with pytest.raises(HTTPException):
        sonos.execute("alice", review["review_id"], "changed-volume-123456")
    assert not effects(fake)


def test_group_mute_preserves_volume_levels(grouped):
    fake, first, second = grouped
    before = dict(fake.volumes)
    review = sonos.prepare("alice", first["id"], "group_mute", {"muted": True})
    result = sonos.execute("alice", review["review_id"], "group-mute-12345678")
    assert result["ok"] and result["volume_controls"]["group"]["muted"]
    assert fake.volumes == before
    assert all(row[2] == "mute" and row[3] == {"muted": True} for row in effects(fake))


def test_mid_group_timeout_retains_completed_unknown_and_unattempted_rooms(grouped, monkeypatch):
    fake, first, second = grouped
    address, uid = "192.168.4.13", "RINCON_ZZZ000001"
    fake.identities[address] = {**fake.identities[first["ip"]], "uid": uid, "ip": address}
    third = sonos.enroll("alice", address)["device"]
    fake.groups[0]["members"].append({"uid": uid, "ip": address, "name": "Third", "bonded": False})
    fake.volumes = {first["uid"]: 5, second["uid"]: 5, third["uid"]: 5}
    original = fake.perform
    def perform(device, *args, **kwargs):
        durable = sonos._load("alice")["receipts"]["partial-volume-12345"]
        assert len(durable["room_results"]) == 3
        assert next(row for row in durable["room_results"] if row["uid"] == device["uid"])["outcome"] == "unknown"
        if device["uid"] == second["uid"]:
            fake.fail = True
        return original(device, *args, **kwargs)
    monkeypatch.setattr(fake, "perform", perform)
    review = sonos.prepare("alice", first["id"], "group_volume", {"volume": 15})
    result = sonos.execute("alice", review["review_id"], "partial-volume-12345")
    assert result["outcome"] == "partial" and not result["ok"]
    assert [row["outcome"] for row in result["room_results"]] == ["accepted", "unknown", "not_attempted"]
    assert len(effects(fake)) == 2
    sonos.execute("alice", review["review_id"], "partial-volume-12345")
    assert len(effects(fake)) == 2


def test_access_loss_after_first_ack_retains_private_partial_result(grouped, monkeypatch):
    fake, first, _ = grouped
    allowed = [True]
    def check():
        if not allowed[0]:
            raise HTTPException(401, "Locked")
    original = fake.perform
    def perform(*args, **kwargs):
        output = original(*args, **kwargs)
        allowed[0] = False
        return output
    monkeypatch.setattr(fake, "perform", perform)
    review = sonos.prepare("alice", first["id"], "group_volume", {"volume": 24}, check)
    with pytest.raises(HTTPException) as caught:
        sonos.execute("alice", review["review_id"], "locked-volume-123456", check)
    assert caught.value.status_code == 401
    retained = sonos._load("alice")["receipts"]["locked-volume-123456"]
    assert retained["outcome"] == "partial"
    assert [row["outcome"] for row in retained["room_results"]] == ["accepted", "not_attempted"]
    assert len(effects(fake)) == 1


@pytest.mark.parametrize(("action", "params"), [("group_volume", {"volume": True}),
    ("group_volume", {"volume": -1}), ("group_mute", {"muted": "true"}),
    ("group_volume", {"volume": 20, "device_id": "anything"})])
def test_group_parameters_are_strict(grouped, action, params):
    fake, first, _ = grouped
    with pytest.raises(HTTPException) as caught:
        sonos.prepare("alice", first["id"], action, params)
    assert caught.value.status_code == 422 and not effects(fake)
