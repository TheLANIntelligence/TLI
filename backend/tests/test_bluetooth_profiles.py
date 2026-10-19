"""Code-owned catalog tests; synthetic profiles make no real compatibility claim."""
import copy
from dataclasses import FrozenInstanceError, replace

import pytest

import bluetooth_profiles as P


EXPECTED = {"id": "govee_h6125_v1", "vendor": "govee_ble", "brand": "Govee", "model": "H6125",
            "id_prefix": "govee-ble-", "capabilities": ["switch.on", "switch.off"], "validation": "experimental"}
RECORD = {"device_id": "retained-original-id", "vendor": "govee_ble", "name": "Saved name",
          "ip": "ble://AA:BB:CC:DD:EE:FF", "relay": 0, "capabilities": ["switch.on", "switch.off"],
          "extra": {"transport": "bluetooth", "profile": "govee_h6125_v1", "model": "H6125",
                    "address": "AA:BB:CC:DD:EE:FF", "future": {"kept": [1]}}, "future": ["metadata"]}


def test_only_current_experimental_profile_and_exact_public_shape():
    assert P.list_profiles() == [EXPECTED]
    assert P.get_profile("govee_h6125_v1") == EXPECTED
    assert P.model_profiles("H6125") == [EXPECTED]


@pytest.mark.parametrize("method", [lambda: P.list_profiles()[0], lambda: P.get_profile("govee_h6125_v1"),
                                     lambda: P.model_profiles("H6125")[0], lambda: P.record_profile(RECORD)])
def test_public_results_cannot_mutate_descriptors(method):
    result = method()
    result["brand"] = "Changed"
    result["capabilities"].append("script.run")
    assert P.list_profiles() == [EXPECTED]
    assert method() == EXPECTED


def test_descriptor_is_immutable():
    with pytest.raises(FrozenInstanceError):
        P._PROFILES[0].brand = "Changed"
    assert isinstance(P._PROFILES, tuple)
    assert P._PROFILES[0].capabilities == ("switch.on", "switch.off")


@pytest.mark.parametrize("profile_id", [None, 1, {}, [], "", "GOVEE_H6125_V1", "govee_h6125_v1 ", "arbitrary_module:run", "govee_h6130_v1"])
def test_unknown_or_malformed_profile_never_resolves(profile_id):
    assert P.get_profile(profile_id) is None


@pytest.mark.parametrize("model", [None, 1, {}, "", "h6125", " H6125", "H6125_FB8F", "H6130"])
def test_legacy_selection_is_exact_model_only(model):
    assert P.model_profiles(model) == []


@pytest.mark.parametrize("name", ["H6125", "h6125", "Govee_H6125_1234", "ihoment-H6125", "Light (H6125)"])
def test_advertised_model_is_only_a_hint(name):
    assert P.discovery_hints(name) == ["govee_h6125_v1"]


@pytest.mark.parametrize("name", [None, 12, {}, "", "Govee", "H6130", "XH6125", "H61250", "H6125X", "X" * 128 + " H6125"])
def test_no_brand_wide_or_substring_match(name):
    assert P.discovery_hints(name) == []


def test_preserves_saved_identity_and_all_unknown_metadata():
    record = copy.deepcopy(RECORD)
    before = copy.deepcopy(record)
    assert P.record_profile(record) == EXPECTED
    assert record == before
    alias = {**record, "device_id": "another-existing-id"}
    assert P.record_profile(alias) == EXPECTED
    del record["relay"]  # legacy ordinary default remains channel zero
    assert P.record_profile(record) == EXPECTED


@pytest.mark.parametrize("field,value", [
    ("vendor", "hue"), ("vendor", "GOVEE_BLE"), ("ip", "192.0.2.1"),
    ("ip", "ble://00:11:22:33:44:55"), ("ip", "BLE://AA:BB:CC:DD:EE:FF"),
    ("relay", 1), ("relay", False), ("relay", None),
    ("capabilities", []), ("capabilities", ["switch.on", "switch.off", "switch.toggle"]),
    ("capabilities", ["switch.off", "switch.on"]), ("capabilities", ["switch.on", "switch.on"]),
    ("capabilities", ("switch.on", "switch.off")), ("extra", None), ("extra", []),
])
def test_invalid_registered_binding_is_not_a_profile(field, value):
    record = copy.deepcopy(RECORD)
    record[field] = value
    before = copy.deepcopy(record)
    assert P.record_profile(record) is None
    assert record == before


@pytest.mark.parametrize("field,value", [
    ("transport", "wifi"), ("transport", "Bluetooth"), ("model", "H6130"), ("model", None),
    ("profile", "unknown"), ("profile", None), ("profile", {}),
    ("address", "aa:bb:cc:dd:ee:ff"), ("address", "AA:BB:CC:DD:EE:FF\n"),
    ("address", "AA-BB-CC-DD-EE-FF"), ("address", None),
])
def test_invalid_extra_binding_preserved_not_supported(field, value):
    record = copy.deepcopy(RECORD)
    record["extra"][field] = value
    assert P.record_profile(record) is None
    assert P.is_bluetooth_record(record) is True


@pytest.mark.parametrize("row", [
    {"vendor": "govee_ble"}, {"vendor": "GOVEE_BLE"}, {"extra": {"transport": "bluetooth"}},
    {"extra": {"transport": "Bluetooth", "profile": "unknown"}}, {"ip": "ble://unknown"},
    {"ip": "BLE://unknown"}, {"vendor": "hue", "extra": {"profile": "govee_h6125_v1"}},
])
def test_claimed_ble_cannot_downgrade_to_legacy_dispatch(row):
    assert P.is_bluetooth_record(row) is True
    assert P.record_profile(row) is None


@pytest.mark.parametrize("row", [None, [], "ble://something", {}, {"vendor": "hue"},
                                      {"extra": {"profile": "unknown"}}, {"ip": "http://lamp.local"}])
def test_ordinary_non_ble_records_are_not_reclassified(row):
    assert P.is_bluetooth_record(row) is False
    assert P.record_profile(row) is None


def test_synthetic_second_brand_is_data_and_unknown_radio_stays_unknown(monkeypatch):
    synthetic = P.Profile(id="fixture_light_v1", vendor="fixture_ble", brand="Test fixture brand",
                          model="T9001", id_prefix="fixture-ble-", capabilities=("switch.on", "switch.off"))
    monkeypatch.setattr(P, "_PROFILES", (*P._PROFILES, synthetic))
    profile = P.get_profile("fixture_light_v1")
    assert P.discovery_hints("Fixture_T9001") == ["fixture_light_v1"]
    assert P.discovery_hints("Other_Brand_T9002") == []
    assert P.model_profiles("T9001") == [profile]
    record = copy.deepcopy(RECORD)
    record.update(vendor="fixture_ble", device_id="retained-fixture-id")
    record["extra"].update(profile="fixture_light_v1", model="T9001")
    assert P.record_profile(record) == profile
    assert P.is_bluetooth_record({"vendor": "fixture_ble"}) is True


def test_duplicate_model_is_explicitly_ambiguous_not_first_match(monkeypatch):
    synthetic = P.Profile(id="fixture_other_v1", vendor="fixture_ble", brand="Test fixture brand",
                          model="H6125", id_prefix="fixture-ble-", capabilities=("switch.on", "switch.off"))
    monkeypatch.setattr(P, "_PROFILES", (*P._PROFILES, synthetic))
    assert len(P.model_profiles("H6125")) == 2
    assert P.discovery_hints("H6125") == ["govee_h6125_v1", "fixture_other_v1"]


@pytest.mark.parametrize("capabilities", [["switch.on"], (), ("switch.toggle",), ("script.run",), ("switch.on", "switch.on")])
def test_source_descriptor_refuses_unbounded_capability_language(capabilities):
    with pytest.raises(ValueError):
        P.Profile(id="fixture_light_v1", vendor="fixture_ble", brand="Test fixture brand", model="T9001",
                  id_prefix="fixture-ble-", capabilities=capabilities)


@pytest.mark.parametrize("variant", ["duplicate_id", "duplicate_vendor_model", "duplicate_prefix", "too_many", "mutable", "empty", "non_descriptor"])
@pytest.mark.parametrize("helper", [P.list_profiles, lambda: P.get_profile("govee_h6125_v1"),
                                    lambda: P.model_profiles("H6125"), lambda: P.discovery_hints("H6125"),
                                    lambda: P.record_profile(RECORD), lambda: P.is_bluetooth_record(RECORD)])
def test_invalid_source_extension_fails_closed_for_all_catalog_access(monkeypatch, variant, helper):
    original = P._PROFILES[0]
    second = P.Profile(id="fixture_light_v1", vendor="fixture_ble", brand="Test fixture brand", model="T9001",
                       id_prefix="fixture-ble-", capabilities=("switch.on", "switch.off"))
    if variant == "duplicate_id":
        profiles = (original, replace(second, id=original.id))
    elif variant == "duplicate_vendor_model":
        profiles = (original, replace(second, vendor=original.vendor, model=original.model))
    elif variant == "duplicate_prefix":
        profiles = (original, replace(second, id_prefix=original.id_prefix))
    elif variant == "too_many":
        profiles = tuple(replace(second, id=f"fixture_{i}", model=f"T{i}", id_prefix=f"fixture-{i}-") for i in range(33))
    elif variant == "mutable":
        profiles = [original]
    elif variant == "empty":
        profiles = ()
    else:
        profiles = (original, dict(EXPECTED))
    monkeypatch.setattr(P, "_PROFILES", profiles)
    with pytest.raises(ValueError, match="Bluetooth profile catalog"):
        helper()
