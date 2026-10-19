"""Synthetic Sonos identity, ownership, topology, no-replay and browser contracts."""
from __future__ import annotations
import copy
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import sonos_service as sonos
import tli_state as S
from routers.sonos_routes import router


class FakeSonos:
    def __init__(self):
        self.identities = {
            "192.168.4.10": {"uid": "RINCON_BEAM000001", "ip": "192.168.4.10", "name": "Living room", "model": "Sonos Beam", "firmware": "test"},
            "192.168.4.11": {"uid": "RINCON_PLAY000001", "ip": "192.168.4.11", "name": "Kitchen", "model": "Sonos PLAY:1", "firmware": "test"},
        }
        self.groups = [{"coordinator": row["uid"], "members": [{"uid": row["uid"], "ip": ip, "name": row["name"], "bonded": False}]} for ip, row in self.identities.items()]
        self.calls = []
        self.fail = False
        self.fav = [{"id": "FV:2/1", "name": "Our playlist", "queue": True, "uri": "x-test:favorite", "meta": "metadata"}]
        self.volume = 20
        self.volumes = {}
        self.mutes = {}

    def identity(self, ip, check=None):
        sonos._check(check)
        self.calls.append(("identity", ip))
        return copy.deepcopy(self.identities[ip])

    def topology(self, ip, check=None):
        sonos._check(check)
        self.calls.append(("topology", ip))
        return copy.deepcopy(self.groups)

    def reading(self, device, group, check=None):
        sonos._check(check)
        self.calls.append(("reading", device["uid"]))
        return {"playback": "PAUSED_PLAYBACK", "volume": self.volumes.get(device["uid"], self.volume), "muted": self.mutes.get(device["uid"], False), "title": "A song", "position": "0:00:02"}

    def volume_reading(self, device, check=None):
        sonos._check(check)
        self.calls.append(("volume_reading", device["uid"]))
        return {"volume": self.volumes.get(device["uid"], self.volume), "muted": self.mutes.get(device["uid"], False)}

    def favorites(self, ip, check=None):
        return copy.deepcopy(self.fav)

    def perform(self, device, group, action, params, favorite=None, check=None):
        sonos._check(check)
        self.calls.append(("perform", device["uid"], action, copy.deepcopy(params)))
        if self.fail:
            raise TimeoutError("Response lost after delivery")
        if action == "volume":
            self.volume = params["volume"]
            self.volumes[device["uid"]] = params["volume"]
        if action == "mute":
            self.mutes[device["uid"]] = params["muted"]
        if action == "announce":
            return {"clip_id": "clip-owned-123", "clip_state": "scheduled"}
        return {}


@pytest.fixture
def house(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(sonos, "REVIEWS", {})
    monkeypatch.setattr(sonos, "DISCOVERIES", {})
    monkeypatch.setattr(sonos, "RUNNING", set())
    monkeypatch.setattr(sonos, "REQUESTS", set())
    fake = FakeSonos()
    monkeypatch.setattr(sonos, "ADAPTER", fake)
    monkeypatch.setattr(sonos, "availability", lambda: {"music": True, "clips_runtime": True, "hardware_verified": False})
    monkeypatch.setattr(sonos, "_clip", lambda device, operation, params=None, check=None: {"supported": device["model"] != "Sonos PLAY:1", "state": "advertised" if device["model"] != "Sonos PLAY:1" else "unsupported"})
    first = sonos.enroll("alice", "192.168.4.10", room="Lounge")["device"]
    second = sonos.enroll("alice", "192.168.4.11", room="Kitchen")["device"]
    fake.calls.clear()
    return fake, first, second


def effects(fake):
    return [row for row in fake.calls if row[0] == "perform"]


def parse_topology(monkeypatch, xml):
    adapter = sonos.SonosAdapter()
    monkeypatch.setattr(adapter, "soap", lambda *args: {"ZoneGroupState": xml})
    return adapter.topology("192.168.4.10")


def test_topology_xml_reports_nested_satellite_parent_without_name_inference(monkeypatch):
    groups = parse_topology(monkeypatch, '''<ZoneGroupState><ZoneGroups>
      <ZoneGroup Coordinator="RINCON_BEAM001" ID="g1">
        <ZoneGroupMember UUID="RINCON_BEAM001" ZoneName="Theater" Location="http://192.168.4.10:1400/xml/device_description.xml">
          <Satellite UUID="RINCON_PLAY001" ZoneName="Theater" Location="http://192.168.4.11:1400/xml/device_description.xml" Invisible="1"/>
          <Satellite UUID="RINCON_PLAY002" ZoneName="Theater" Location="http://192.168.4.12:1400/xml/device_description.xml" Invisible="1"/>
        </ZoneGroupMember>
      </ZoneGroup>
      <ZoneGroup Coordinator="RINCON_AMP0001" ID="g2">
        <ZoneGroupMember UUID="RINCON_AMP0001" ZoneName="Theater" Location="http://192.168.4.13:1400/xml/device_description.xml"/>
      </ZoneGroup>
    </ZoneGroups></ZoneGroupState>''')
    members = {m["uid"]: m for g in groups for m in g["members"]}
    assert len(groups) == 2 and len(groups[0]["members"]) == 3
    assert members["RINCON_BEAM001"]["parent_uid"] is None
    assert members["RINCON_BEAM001"]["bond_source"] == "satellite_parent"
    for uid in ("RINCON_PLAY001", "RINCON_PLAY002"):
        assert members[uid]["parent_uid"] == "RINCON_BEAM001"
        assert members[uid]["bonded"] and members[uid]["bond_source"] == "satellite"
        assert "channel" not in members[uid] and "role" not in members[uid]
    assert members["RINCON_AMP0001"]["parent_uid"] is None
    assert members["RINCON_AMP0001"]["bonded"] is False


@pytest.mark.parametrize("attribute,source", [("ChannelMapSet", "channel_map"), ("HTSatChanMapSet", "home_theater_map")])
def test_flat_legacy_channel_maps_do_not_invent_parent_links(monkeypatch, attribute, source):
    groups = parse_topology(monkeypatch, f'''<ZoneGroups><ZoneGroup Coordinator="RINCON_PAIR001">
      <ZoneGroupMember UUID="RINCON_PAIR001" ZoneName="Same room" Location="http://192.168.4.10:1400/xml/device_description.xml" {attribute}="RINCON_PAIR001:LF,LF;RINCON_PAIR002:RF,RF"/>
      <ZoneGroupMember UUID="RINCON_PAIR002" ZoneName="Same room" Location="http://192.168.4.11:1400/xml/device_description.xml" Invisible="1"/>
    </ZoneGroup></ZoneGroups>''')
    assert groups[0]["members"][0]["bond_source"] == source
    assert groups[0]["members"][1]["bond_source"] == "invisible"
    assert all(m["parent_uid"] is None for m in groups[0]["members"])


def test_invisible_bridge_is_distinguishable_from_confirmed_satellite(monkeypatch):
    groups = parse_topology(monkeypatch, '''<ZoneGroups><ZoneGroup Coordinator="RINCON_BRIDGE1">
      <ZoneGroupMember UUID="RINCON_BRIDGE1" ZoneName="BRIDGE" Location="http://192.168.4.10:1400/xml/device_description.xml" Invisible="1" IsZoneBridge="1"/>
    </ZoneGroup></ZoneGroups>''')
    member = groups[0]["members"][0]
    assert member["bonded"] is True  # Existing conservative join/leave restriction.
    assert member["bond_source"] == "invisible" and member["parent_uid"] is None


def test_orphan_satellite_topology_is_rejected_instead_of_omitted(monkeypatch):
    with pytest.raises(HTTPException) as error:
        parse_topology(monkeypatch, '''<ZoneGroups><ZoneGroup Coordinator="RINCON_BEAM001">
          <ZoneGroupMember UUID="RINCON_BEAM001" Location="http://192.168.4.10:1400/xml/device_description.xml"/>
          <Satellite UUID="RINCON_PLAY001" Location="http://192.168.4.11:1400/xml/device_description.xml"/>
        </ZoneGroup></ZoneGroups>''')
    assert error.value.status_code == 502


def test_status_topology_is_owner_scoped_without_addresses_or_extra_contact(house):
    fake, first, second = house
    for address, uid in (("192.168.4.30", "RINCON_OTHER001"), ("192.168.4.31", "RINCON_OTHER002")):
        fake.identities[address] = {**fake.identities[first["ip"]], "uid": uid, "ip": address, "name": "Private other-owner label"}
        sonos.enroll("bob", address, name="Other account custom label")
    custom = sonos.enroll("alice", first["ip"], name="My cinema", room="Downstairs")["device"]
    fake.groups[0]["members"] += fake.groups.pop()["members"]
    fake.groups[0]["members"][0].update(parent_uid="RINCON_OTHER001", bonded=True, bond_source="satellite")
    fake.groups[0]["members"][1].update(parent_uid=first["uid"], bonded=True, bond_source="satellite")
    fake.groups[0]["members"].append({"uid": "RINCON_OTHER001", "ip": "192.168.4.30", "name": "Private topology label", "bonded": False})
    fake.groups.append({"coordinator": "RINCON_OTHER002", "members": [{"uid": "RINCON_OTHER002", "ip": "192.168.4.31", "name": "Private topology room", "bonded": False}]})
    fake.calls.clear()
    result = sonos.status("alice", first["id"])
    topology = result["topology"]
    assert topology["checked_at"].endswith("Z") and len(topology["groups"]) == 1
    public = topology["groups"][0]
    assert public["member_count"] == 3 and public["complete"] is False and len(public["members"]) == 2
    assert public["coordinator"] == first["uid"]
    members = {m["uid"]: m for m in public["members"]}
    assert members[first["uid"]]["device_id"] == custom["id"]
    assert members[first["uid"]]["name"] == "My cinema" and members[first["uid"]]["room"] == "Downstairs"
    assert members[first["uid"]]["parent_uid"] is None
    assert members[second["uid"]]["parent_uid"] == first["uid"]
    encoded = json.dumps(topology)
    assert "192.168." not in encoded and "RINCON_OTHER" not in encoded and "Private" not in encoded and "Other account" not in encoded
    assert fake.calls == [("identity", first["ip"]), ("topology", first["ip"]), ("identity", first["ip"]), ("reading", first["uid"])]


def test_status_topology_hides_changed_addresses_and_unenrolled_coordinator(house):
    fake, first, second = house
    fake.groups[0]["members"] += fake.groups.pop()["members"]
    fake.groups[0]["members"][1]["ip"] = "192.168.4.99"
    fake.groups[0]["coordinator"] = second["uid"]
    result = sonos.status("alice", first["id"])
    assert result["reading"]["playback"] == "UNKNOWN"
    group = result["topology"]["groups"][0]
    assert group["coordinator"] is None and group["complete"] is False and group["member_count"] == 2
    assert [m["uid"] for m in group["members"]] == [first["uid"]]
    assert result["volume_controls"]["group"] is None
    assert [row["uid"] for row in result["volume_controls"]["rooms"]] == [first["uid"]]
    assert fake.calls == [("identity", first["ip"]), ("topology", first["ip"]),
        ("identity", first["ip"]), ("volume_reading", first["uid"])]


def test_review_topology_contains_only_its_exact_snapshot_groups(house):
    fake, first, second = house
    status = sonos.status("alice", first["id"])
    assert len(status["topology"]["groups"]) == 2
    volume = sonos.prepare("alice", first["id"], "volume", {"volume": 20})
    assert len(volume["topology"]["groups"]) == 1 and volume["topology"]["groups"][0]["complete"]
    joining = sonos.prepare("alice", first["id"], "join", {"target_id": second["id"]})
    assert len(joining["topology"]["groups"]) == 2
    assert "192.168." not in json.dumps(joining["topology"])
    assert not effects(fake)


def test_changed_satellite_parent_invalidates_review_before_effect(house):
    fake, first, second = house
    fake.groups[0]["members"] += fake.groups.pop()["members"]
    child = fake.groups[0]["members"][1]
    child.update(parent_uid=first["uid"], bonded=True, bond_source="satellite")
    review = sonos.prepare("alice", first["id"], "pause")
    before = sonos._digest(sonos.REVIEWS[review["review_id"]]["snapshot"])
    child["parent_uid"] = None
    fresh, *_ = sonos._snapshot("alice", first["id"], "pause", {})
    assert sonos._digest(fresh) != before
    with pytest.raises(HTTPException) as error:
        sonos.execute("alice", review["review_id"], "changed-bond-123456")
    assert error.value.status_code == 409 and not effects(fake)


def test_listing_and_resolution_do_not_contact_speakers(house):
    fake, first, _ = house
    assert len(sonos.list_devices("alice")["devices"]) == 2
    assert sonos.list_devices("bob")["devices"] == []
    assert sonos.resolve_target("alice", "living room")["id"] == first["id"]
    assert sonos.resolve_target("alice", "Lounge")["id"] == first["id"]
    assert fake.calls == []
    with pytest.raises(HTTPException) as error:
        sonos.status("bob", first["id"])
    assert error.value.status_code == 404 and fake.calls == []


def test_discovery_verifies_deduplicates_and_never_enrolls(house, monkeypatch):
    fake, first, _ = house
    fake.identities["192.168.4.12"] = {**fake.identities[first["ip"]], "ip": "192.168.4.12"}
    monkeypatch.setattr(sonos, "_discovery_hints", lambda check: [first["ip"], "192.168.4.12", "192.168.4.11"])
    result = sonos.discover("bob")
    assert result["enrolled"] is False and result["expires_in_seconds"] == 120
    assert len(result["candidates"]) == 2
    assert {row["name"] for row in result["candidates"]} == {"Living room", "Kitchen"}
    assert all(row["model"] and row["room"] and not row["already_enrolled"] for row in result["candidates"])
    assert all("ip" not in row and len(row["discovery_id"]) == 48 for row in result["candidates"])
    assert sonos.list_devices("bob")["devices"] == [] and not effects(fake)


def test_discovered_selection_is_owner_bound_expiring_and_single_use(house, monkeypatch):
    fake, first, _ = house
    monkeypatch.setattr(sonos, "_discovery_hints", lambda check: [first["ip"]])
    candidate = sonos.discover("bob")["candidates"][0]
    fake.calls.clear()
    with pytest.raises(HTTPException) as error:
        sonos.enroll("alice", discovery_id=candidate["discovery_id"])
    assert error.value.status_code == 409 and not fake.calls
    added = sonos.enroll("bob", discovery_id=candidate["discovery_id"])["device"]
    assert added["uid"] == first["uid"] and added["volume_cap"] == 35
    assert fake.calls == [("identity", first["ip"])]
    fake.calls.clear()
    with pytest.raises(HTTPException):
        sonos.enroll("bob", discovery_id=candidate["discovery_id"])
    assert not fake.calls
    expired = sonos.discover("bob")["candidates"][0]["discovery_id"]
    sonos.DISCOVERIES[expired]["expires"] = 0
    fake.calls.clear()
    with pytest.raises(HTTPException):
        sonos.enroll("bob", discovery_id=expired)
    assert not fake.calls


def test_discovered_enrollment_rechecks_identity_without_saving_changed_speaker(house, monkeypatch):
    fake, first, _ = house
    monkeypatch.setattr(sonos, "_discovery_hints", lambda check: [first["ip"]])
    discovery_id = sonos.discover("bob")["candidates"][0]["discovery_id"]
    fake.identities[first["ip"]]["uid"] = "RINCON_OTHER001"
    with pytest.raises(HTTPException) as error:
        sonos.enroll("bob", discovery_id=discovery_id)
    assert error.value.status_code == 409 and sonos.list_devices("bob")["devices"] == []


def test_discovered_existing_speaker_refresh_preserves_user_metadata(house, monkeypatch):
    fake, first, _ = house
    saved = sonos.enroll("alice", first["ip"], name="My cinema", room="Downstairs", volume_cap=19)["device"]
    new_ip = "192.168.4.99"
    fake.identities[new_ip] = {**fake.identities[first["ip"]], "ip": new_ip, "name": "Sonos renamed room"}
    monkeypatch.setattr(sonos, "_discovery_hints", lambda check: [new_ip])
    candidate = sonos.discover("alice")["candidates"][0]
    assert candidate["already_enrolled"] and candidate["device_id"] == saved["id"]
    assert (candidate["name"], candidate["room"]) == ("My cinema", "Downstairs")
    assert sonos._device("alice", saved["id"])["ip"] == first["ip"]
    refreshed = sonos.enroll("alice", discovery_id=candidate["discovery_id"])["device"]
    for key in ("id", "uid", "name", "room", "volume_cap", "enrolled_at"):
        assert refreshed[key] == saved[key]
    assert refreshed["ip"] == new_ip and refreshed["revision"] != saved["revision"]


def test_discovery_verification_limits_targets_and_returns_partial(house, monkeypatch):
    fake, first, _ = house
    addresses = [f"192.168.4.{number}" for number in range(30, 42)]
    for number, address in enumerate(addresses):
        fake.identities[address] = {**fake.identities[first["ip"]], "ip": address, "uid": f"RINCON_TEST{number:04}"}
    monkeypatch.setattr(sonos, "_discovery_hints", lambda check: addresses)
    result = sonos.discover("bob")
    assert len(fake.calls) == sonos.MAX_DISCOVERY_TARGETS == len(result["candidates"]) == 8
    assert result["partial"] is True and not effects(fake)


def test_discovery_deadline_retains_verified_results_and_stops_contact(house, monkeypatch):
    fake, first, second = house
    clock = [100.0]
    monkeypatch.setattr(sonos.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(sonos, "_discovery_hints", lambda check: [first["ip"], second["ip"], "192.168.4.99"])
    identity = fake.identity
    def slow(address, check):
        value = identity(address, check)
        clock[0] += 1 if address == first["ip"] else 13
        return value
    fake.identity = slow
    result = sonos.discover("bob")
    assert result["partial"] is True and len(result["candidates"]) == 1
    assert fake.calls == [("identity", first["ip"]), ("identity", second["ip"])]
    assert not hasattr(sonos.LOCAL, "deadline")


def test_discovery_revocation_discards_results_before_next_target(house, monkeypatch):
    fake, first, second = house
    monkeypatch.setattr(sonos, "_discovery_hints", lambda check: [first["ip"], second["ip"]])
    def check():
        if fake.calls:
            raise HTTPException(401, "revoked")
    with pytest.raises(HTTPException) as error:
        sonos.discover("bob", check)
    assert error.value.status_code == 401 and fake.calls == [("identity", first["ip"])]
    assert not sonos.DISCOVERIES


def test_discovery_routes_require_exact_selection_and_keep_manual_fallback(house, monkeypatch):
    fake, first, _ = house
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    monkeypatch.setattr(sonos, "_discovery_hints", lambda check: [first["ip"]])
    app = FastAPI()
    app.include_router(router)
    headers = {"Origin": "http://localhost"}
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 1234)) as client:
        assert client.post("/api/sonos/discover").status_code == 403
        result = client.post("/api/sonos/discover", headers=headers)
        assert result.status_code == 200
        token = result.json()["candidates"][0]["discovery_id"]
        for invalid in ({}, {"ip": first["ip"], "discovery_id": token}, {"discovery_id": token, "volume_cap": 35}):
            assert client.post("/api/sonos/devices", headers=headers, json=invalid).status_code == 422
        added = client.post("/api/sonos/devices", headers=headers, json={"discovery_id": token})
        assert added.status_code == 200 and added.json()["device"]["uid"] == first["uid"]
        assert client.post("/api/sonos/devices", headers=headers, json={"ip": first["ip"], "name": "Manual name"}).status_code == 200


def test_ssdp_scan_bounds_targets_and_uses_only_matching_lan_hints(house, monkeypatch):
    received = []
    packets = [(b"HTTP/1.1 200 OK\r\nLOCATION: http://8.8.8.8:1400/xml/device_description.xml\r\n", ("192.168.4.2", 1900))]
    packets += [(f"HTTP/1.1 200 OK\r\nLOCATION: http://192.168.4.{n}:1400/xml/device_description.xml\r\n".encode(), (f"192.168.4.{n}", 1900)) for n in range(10, 20)]
    class Socket:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def settimeout(self, value): assert value == .2
        def sendto(self, packet, address): assert address == ("239.255.255.250", 1900)
        def recvfrom(self, size):
            received.append(True)
            return packets.pop(0)
    monkeypatch.setattr(sonos.socket, "socket", lambda *args: Socket())
    hints = sonos._discovery_hints()
    assert len(hints) == 8 and len(received) == 9 and "192.168.4.2" not in hints


def test_review_is_read_only_execute_once_and_reads_after_ack(house):
    fake, first, _ = house
    review = sonos.prepare("alice", first["id"], "volume", {"volume": 24})
    assert review["actions_performed"] is False and not effects(fake)
    request_id = "request-volume-12345"
    result = sonos.execute("alice", review["review_id"], request_id)
    assert result["outcome"] == "accepted" and result["observed"]["volume"] == 24
    assert sonos.execute("alice", review["review_id"], request_id) == result
    assert len(effects(fake)) == 1
    with pytest.raises(HTTPException):
        sonos.execute("alice", review["review_id"], "a-different-request")


def test_uncertain_delivery_persists_without_replay_even_after_restart(house, monkeypatch):
    fake, first, _ = house
    review = sonos.prepare("alice", first["id"], "next")
    fake.fail = True
    result = sonos.execute("alice", review["review_id"], "unknown-delivery-123")
    assert result["outcome"] == "unknown"
    monkeypatch.setattr(sonos, "REVIEWS", {})
    assert sonos.execute("alice", review["review_id"], "unknown-delivery-123")["outcome"] == "unknown"
    assert len(effects(fake)) == 1


def test_crashed_pending_receipt_is_unknown_and_never_replayed(house):
    fake, first, _ = house
    with sonos.LOCK:
        data = sonos._load("alice")
        data["receipts"]["crashed-request-123"] = {"request_id": "crashed-request-123", "review_id": "lost-review", "device_id": first["id"], "outcome": "pending", "ok": False}
        sonos._save("alice", data)
    assert sonos.execute("alice", "lost-review", "crashed-request-123")["outcome"] == "unknown"
    assert not effects(fake)


def test_changed_topology_or_rebound_address_blocks_before_effect(house):
    fake, first, second = house
    review = sonos.prepare("alice", first["id"], "pause")
    fake.groups[0]["members"] += fake.groups.pop()["members"]
    with pytest.raises(HTTPException) as error:
        sonos.execute("alice", review["review_id"], "changed-topology-123")
    assert error.value.status_code == 409 and not effects(fake)
    fake.identities[first["ip"]]["uid"] = "RINCON_IMPOSTER0001"
    with pytest.raises(HTTPException):
        sonos.prepare("alice", first["id"], "play")
    assert not effects(fake)


def test_unenrolled_group_member_cannot_receive_transport_effect(house):
    fake, first, second = house
    fake.groups[0]["members"] += fake.groups.pop()["members"]
    sonos.remove("alice", second["id"])
    with pytest.raises(HTTPException) as error:
        sonos.prepare("alice", first["id"], "pause")
    assert error.value.status_code == 409 and not effects(fake)
    # A speaker-only volume operation does not command the other room.
    assert sonos.prepare("alice", first["id"], "volume", {"volume": 20})["affected"] == [{"uid": first["uid"], "name": first["name"]}]


def test_group_join_reviews_both_groups_and_bonded_speakers_refused(house):
    fake, first, second = house
    review = sonos.prepare("alice", first["id"], "join", {"target_id": second["id"]})
    assert {m["uid"] for m in review["affected"]} == {first["uid"], second["uid"]}
    result = sonos.execute("alice", review["review_id"], "join-request-123456")
    assert result["outcome"] == "accepted" and effects(fake)[0][3]["coordinator_uid"] == second["uid"]
    fake.groups[0]["members"][0]["bonded"] = True
    with pytest.raises(HTTPException) as error:
        sonos.prepare("alice", first["id"], "leave")
    assert error.value.status_code == 422


@pytest.mark.parametrize("action,params", [("volume", {"volume": 36}), ("volume", {"volume": True}), ("mute", {"muted": "false"}), ("favorite", {"favorite_id": "FV:2/1", "replace_queue": False}), ("play", {"url": "https://example.org"}), ("shell", {})])
def test_parameters_and_volume_ceiling_are_strict(house, action, params):
    fake, first, _ = house
    with pytest.raises(HTTPException) as error:
        sonos.prepare("alice", first["id"], action, params)
    assert error.value.status_code == 422 and not effects(fake)


def test_favorite_is_exact_and_changed_metadata_invalidates_review(house):
    fake, first, _ = house
    assert sonos.favorites("alice", first["id"])["items"] == [{"id": "FV:2/1", "name": "Our playlist", "queue": True}]
    review = sonos.prepare("alice", first["id"], "favorite", {"favorite_id": "FV:2/1", "replace_queue": True})
    fake.fav[0]["uri"] = "x-test:different"
    with pytest.raises(HTTPException):
        sonos.execute("alice", review["review_id"], "favorite-request-123")
    assert not effects(fake)


def test_play1_overlay_is_gated_and_no_playback_fallback(house):
    fake, first, play1 = house
    url = "http://192.168.4.2:8090/voice/media/token.wav"
    with pytest.raises(HTTPException):
        sonos.announce("alice", play1["id"], url, 20, "play1-announce-1234")
    assert not effects(fake)
    result = sonos.announce("alice", first["id"], url, 20, "beam-announce-12345")
    assert result["clip_id"] == "clip-owned-123" and result["clip_state"] == "scheduled"
    assert sonos.announce("alice", first["id"], url, 20, "beam-announce-12345") == result
    with pytest.raises(HTTPException):
        sonos.announce("alice", first["id"], url, 21, "beam-announce-12345")
    assert len(effects(fake)) == 1
    with pytest.raises(HTTPException):
        sonos.cancel_announcement("alice", first["id"], "someone-elses-clip")
    sonos.cancel_announcement("alice", first["id"], "clip-owned-123")
    assert effects(fake)[-1][2] == "cancel_announcement"


def test_all_affected_speakers_share_execution_lock(house):
    fake, first, second = house
    fake.groups[0]["members"] += fake.groups.pop()["members"]
    review = sonos.prepare("alice", first["id"], "pause")
    other = sonos.prepare("alice", second["id"], "volume", {"volume": 22})
    started, release = threading.Event(), threading.Event()
    perform = fake.perform
    def delayed(*args, **kwargs):
        started.set()
        assert release.wait(5)
        return perform(*args, **kwargs)
    fake.perform = delayed
    with ThreadPoolExecutor(2) as pool:
        pending = pool.submit(sonos.execute, "alice", review["review_id"], "concurrent-first-123")
        assert started.wait(2)
        with pytest.raises(HTTPException) as error:
            sonos.execute("alice", other["review_id"], "concurrent-second-123")
        assert error.value.status_code == 409
        release.set()
        assert pending.result()["outcome"] == "accepted"
    assert len(effects(fake)) == 1


def test_durable_write_failure_prevents_command(house, monkeypatch):
    fake, first, _ = house
    review = sonos.prepare("alice", first["id"], "stop")
    def fail(*args):
        raise HTTPException(503, "disk unavailable")
    monkeypatch.setattr(sonos, "_save", fail)
    with pytest.raises(HTTPException):
        sonos.execute("alice", review["review_id"], "disk-failure-123456")
    assert not effects(fake) and not sonos.RUNNING


def test_corrupt_store_is_not_silently_replaced(house):
    fake, first, _ = house
    path = sonos._path("alice")
    path.write_text("{broken", encoding="utf-8")
    with pytest.raises(HTTPException):
        sonos.list_devices("alice")
    assert path.read_text() == "{broken"


def test_revoked_check_blocks_before_contact(house):
    fake, first, _ = house
    def revoked():
        raise HTTPException(401, "revoked")
    with pytest.raises(HTTPException):
        sonos.prepare("alice", first["id"], "pause", check=revoked)
    assert not fake.calls


@pytest.mark.parametrize("address", ["127.0.0.1", "169.254.169.254", "8.8.8.8", "0.0.0.0", "speaker.local", "192.168.4.10:1400", "http://192.168.4.10", "::1"])
def test_manual_enrollment_rejects_non_lan_literal_without_contact(house, address):
    fake, _, _ = house
    with pytest.raises(HTTPException):
        sonos.enroll("alice", address)
    assert not fake.calls


def test_routes_require_browser_authority_and_forbid_arbitrary_clip_urls(house, monkeypatch):
    fake, first, _ = house
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    app = FastAPI()
    app.include_router(router)
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 1234)) as client:
        assert client.get("/api/sonos/devices").status_code == 200
        assert client.post("/api/sonos/devices", json={"ip": "192.168.4.10"}).status_code == 403
        headers = {"Origin": "http://localhost"}
        assert client.post("/api/sonos/devices", json={"ip": "192.168.4.10"}, headers=headers).status_code == 200
        response = client.post("/api/sonos/devices/" + first["id"] + "/review", headers=headers, json={"action": "announce", "params": {"url": "http://192.168.4.3/private", "volume": 20}})
        assert response.status_code == 422
        assert client.get("/api/sonos/devices", headers={"Authorization": "Bearer companion"}).status_code == 403
    assert not effects(fake)


def test_real_soco_codec_uses_fixed_bounded_transport_without_probing(monkeypatch):
    pytest.importorskip("soco")
    calls = []
    def request(ip, method, path, body=None, headers=None, check=None):
        calls.append((ip, method, path, body, headers))
        return b'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:PlayResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>'
    monkeypatch.setattr(sonos, "_request", request)
    result = sonos.SonosAdapter().soap("192.168.4.10", "avTransport", "Play", [("InstanceID", 0), ("Speed", "1")])
    assert result == {}
    assert len(calls) == 1
    assert calls[0][1:3] == ("POST", "/MediaRenderer/AVTransport/Control")
    assert b"<Speed>1</Speed>" in calls[0][3]
    assert calls[0][4]["SOAPACTION"].endswith("#Play")


@pytest.mark.parametrize("uri,kind,label,external", [
    ("x-sonos-vli:RINCON_TEST:2,spotify:private-session", "spotify_connect", "Spotify Connect", True),
    ("x-sonos-vli:RINCON_TEST:2,airplay:private-session", "airplay", "AirPlay", True),
    ("x-sonos-vli:RINCON_TEST:2,other:private-session", "external", "External app", True),
    ("x-sonos-spotify:track:123", "spotify", "Spotify on Sonos", False),
    ("x-sonos-htastream:RINCON_TEST:spdif", "tv", "TV", False),
    ("x-rincon-stream:RINCON_TEST", "line_in", "Line-in", False),
    ("x-rincon-queue:RINCON_TEST#0", "queue", "Sonos queue", False),
    ("x-rincon-mp3radio:https://radio.example/private", "radio", "Internet radio", False),
    ("https://example.test/music?token=private", "sonos", "Sonos music", False),
    ("", "none", "No source selected", False),
])
def test_source_labels_do_not_expose_urls_or_provider_sessions(uri, kind, label, external):
    assert sonos._playback_source(uri) == {"kind": kind, "label": label, "external": external}


@pytest.mark.parametrize("action", ["play", "pause", "stop", "next", "previous"])
@pytest.mark.parametrize("source", ["spotify", "airplay", "other"])
def test_external_source_controls_use_group_api_once_without_replacing_queue(house, monkeypatch, action, source):
    import sonos_local
    _, first, second = house
    group = {"coordinator": first["uid"], "members": [first, second]}
    adapter, calls = sonos.SonosAdapter(), []
    def soap(ip, service, command, args, check=None):
        calls.append((ip, command))
        assert command == "GetMediaInfo"  # Never play, reset source, or touch queue through SOAP.
        return {"CurrentURI": f"x-sonos-vli:{first['uid']}:2,{source}:private-session"}
    def local(device, reviewed, command, check):
        calls.append(("local", command))
        assert device == second and reviewed == group
        check()
        return {}
    authority = lambda: None
    monkeypatch.setattr(adapter, "soap", soap)
    monkeypatch.setattr(sonos_local, "perform", local)
    assert adapter.perform(second, group, action, {}, check=authority) == {}
    assert calls == [(first["ip"], "GetMediaInfo"), ("local", action)]


def test_external_source_timeout_never_falls_back_to_soap_play(house, monkeypatch):
    import sonos_local
    _, first, _ = house
    group = {"coordinator": first["uid"], "members": [first]}
    adapter, calls = sonos.SonosAdapter(), []
    def soap(ip, service, command, args, check=None):
        calls.append(command)
        return {"CurrentURI": "x-sonos-vli:device:2,spotify:session"}
    def local(*args):
        raise TimeoutError("Response lost")
    monkeypatch.setattr(adapter, "soap", soap)
    monkeypatch.setattr(sonos_local, "perform", local)
    with pytest.raises(TimeoutError):
        adapter.perform(first, group, "play", {})
    assert calls == ["GetMediaInfo"]


def test_failed_source_read_is_known_not_sent(house, monkeypatch):
    _, first, _ = house
    adapter, calls = sonos.SonosAdapter(), []
    def soap(ip, service, command, args, check=None):
        calls.append(command)
        raise TimeoutError("Read did not complete")
    monkeypatch.setattr(adapter, "soap", soap)
    with pytest.raises(sonos.SonosCommandNotSent) as error:
        adapter.perform(first, {"coordinator": first["uid"], "members": [first]}, "play", {})
    assert "No playback command was sent" in error.value.detail
    assert calls == ["GetMediaInfo"]


@pytest.mark.parametrize("uri", ["x-rincon-queue:device#0", "x-sonosapi-stream:radio", "x-file-cifs:library/song", "x-sonos-spotify:track"])
def test_sonos_managed_sources_resume_existing_uri_without_resetting_it(house, monkeypatch, uri):
    _, first, second = house
    group = {"coordinator": first["uid"], "members": [first, second]}
    adapter, calls = sonos.SonosAdapter(), []
    def soap(ip, service, command, args, check=None):
        calls.append((ip, command, args))
        return {"CurrentURI": uri} if command == "GetMediaInfo" else {}
    monkeypatch.setattr(adapter, "soap", soap)
    adapter.perform(second, group, "play", {})
    assert calls == [(first["ip"], "GetMediaInfo", [("InstanceID", 0)]),
                     (first["ip"], "Play", [("InstanceID", 0), ("Speed", "1")])]


@pytest.mark.parametrize("playback,confirmed,phrase", [
    ("PLAYING", True, "reports playing"), ("PAUSED_PLAYBACK", False, "still paused"),
    ("STOPPED", False, "still stopped"), ("TRANSITIONING", False, "starting playback"),
    ("UNKNOWN", False, "could not be verified"),
])
def test_play_receipt_distinguishes_acknowledgement_from_observed_playback(house, monkeypatch, playback, confirmed, phrase):
    fake, first, _ = house
    monkeypatch.setattr(fake, "reading", lambda *args: {"playback": playback, "source": sonos._playback_source("x-sonos-vli:device:2,spotify:session")})
    review = sonos.prepare("alice", first["id"], "play")
    result = sonos.execute("alice", review["review_id"], "source-playback-result-123")
    assert result["outcome"] == "accepted"  # Acceptance is retained independently of the state read.
    assert result["playback_confirmed"] is confirmed and phrase in result["summary"]
    assert len(effects(fake)) == 1
    assert sonos.receipts("alice")["receipts"][0]["summary"] == result["summary"]


def test_local_preparation_failure_retains_clear_no_command_receipt(house, monkeypatch):
    fake, first, _ = house
    def fail(*args):
        raise sonos.SonosCommandNotSent(409, "The Sonos group changed. Refresh the rooms before trying again.")
    monkeypatch.setattr(fake, "perform", fail)
    review = sonos.prepare("alice", first["id"], "play")
    result = sonos.execute("alice", review["review_id"], "local-preflight-failure-123")
    assert result["outcome"] == "failed" and result["command_sent"] is False
    assert "group changed" in result["summary"] and not effects(fake)
    assert sonos.execute("alice", review["review_id"], "local-preflight-failure-123") == result


def test_local_no_content_rejection_is_not_an_uncertain_delivery(house, monkeypatch):
    fake, first, _ = house
    monkeypatch.setattr(fake, "perform", lambda *args: {"rejected": True, "error_code": "ERROR_NO_CONTENT"})
    review = sonos.prepare("alice", first["id"], "play")
    result = sonos.execute("alice", review["review_id"], "local-no-content-123")
    assert result["outcome"] == "failed" and not result["ok"]
    assert "no playable content" in result["summary"]


def test_real_soco_favorites_serialize_playable_reference_resources(monkeypatch):
    pytest.importorskip("soco")
    from soco.data_structures import DidlFavorite, DidlMusicTrack, DidlResource, to_didl_string
    track = DidlMusicTrack("Synthetic track", "0", "track-1", resources=[DidlResource("x-test:track", "http-get:*:audio/mpeg:*")])
    favorite = DidlFavorite("Synthetic favorite", "FV:2", "FV:2/1")
    favorite.reference = track
    adapter = sonos.SonosAdapter()
    monkeypatch.setattr(adapter, "soap", lambda *args: {"Result": to_didl_string(favorite)})
    rows = adapter.favorites("192.168.4.10")
    assert rows[0]["uri"] == "x-test:track" and rows[0]["queue"] is True
    assert "x-test:track" in rows[0]["meta"]
    assert rows[0]["id"] == "FV:2/1"


@pytest.mark.parametrize("dropped", [False, True])
def test_real_websocket_codec_sends_mutation_once_and_preserves_zero_volume(monkeypatch, dropped):
    library = pytest.importorskip("sonos_websocket")
    from types import SimpleNamespace
    payloads = []
    class Websocket:
        closed = False
        async def send_json(self, payload):
            payloads.append(payload)
        async def receive(self):
            command = payloads[-1][0].get("command")
            if command == "loadAudioClip" and dropped:
                raise TimeoutError("ack lost")
            value = [{"householdId": "Sonos_test", "success": True}, {}]
            if command == "getGroups":
                value[1] = {"players": [{"id": "RINCON_BEAM000001", "websocketUrl": "wss://192.168.4.10:1443/websocket/api", "capabilities": ["AUDIO_CLIP"]}]}
            elif command == "loadAudioClip":
                value[1] = {"id": "test-clip-123"}
            return SimpleNamespace(data=json.dumps(value), json=lambda: value)
        async def close(self):
            self.closed = True
    async def connect(self):
        self.ws = Websocket()
    monkeypatch.setattr(library.SonosWebsocket, "connect", connect)
    device = {"ip": "192.168.4.10", "uid": "RINCON_BEAM000001"}
    if dropped:
        with pytest.raises(TimeoutError):
            sonos._clip(device, "play", {"url": "http://192.168.4.2/media/test.wav", "volume": 0})
    else:
        assert sonos._clip(device, "play", {"url": "http://192.168.4.2/media/test.wav", "volume": 0})["clip_id"] == "test-clip-123"
    mutations = [p for p in payloads if p[0].get("command") == "loadAudioClip"]
    assert len(mutations) == 1 and mutations[0][1]["volume"] == 0


def test_real_websocket_session_rejects_redirect_before_following(monkeypatch):
    library = pytest.importorskip("sonos_websocket")
    visited = []
    async def redirect(self):
        visited.append(self.uri)
        assert self.session.trust_env is False
        await self.session.trace_configs[0].on_request_redirect.send(self.session, None, None)
        visited.append("redirect must not be followed")
    monkeypatch.setattr(library.SonosWebsocket, "connect", redirect)
    with pytest.raises(HTTPException) as error:
        sonos._clip({"ip": "192.168.4.10", "uid": "RINCON_BEAM000001"}, "play",
                    {"url": "http://192.168.4.2/media/test.wav", "volume": 20})
    assert error.value.status_code == 502
    assert visited == ["wss://192.168.4.10:1443/websocket/api"]


def test_http_header_drip_has_wall_deadline_without_network(monkeypatch):
    stopped = threading.Event()
    limits, closed = [], []
    real_timer = threading.Timer
    class Socket:
        def shutdown(self, how):
            stopped.set()
    class Connection:
        sock = Socket()
        def __init__(self, host, port, timeout):
            assert (host, port, timeout) == ("192.168.4.10", 1400, 3)
        def connect(self):
            pass
        def request(self, *args, **kwargs):
            pass
        def getresponse(self):
            assert stopped.wait(1), "The exact connection must be interrupted"
            raise TimeoutError("synthetic stalled header interrupted")
        def close(self):
            closed.append(True)
    def timer(seconds, callback):
        limits.append(seconds)
        return real_timer(.02, callback)
    monkeypatch.setattr(sonos.http.client, "HTTPConnection", Connection)
    monkeypatch.setattr(sonos.threading, "Timer", timer)
    with pytest.raises(TimeoutError):
        sonos._request("192.168.4.10", "GET", "/xml/device_description.xml")
    assert len(limits) == 1 and 0 < limits[0] <= 4 and closed == [True]
