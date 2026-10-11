"""Narrow passive utility answers; synthetic registries and no HTTP/device calls."""
from datetime import datetime, timezone
import json
from types import SimpleNamespace

import pytest

from intelligence import utility_answers as utility


@pytest.mark.parametrize("question,topic", [
    ("What date is it?", "clock"), ("What is today's date?", "clock"),
    ("What time is it now?", "clock"), ("What year is it?", "clock"),
    ("Please show USB devices", "usb"), ("What's plugged in to my computer?", "usb"),
    ("Is my Vault unlocked?", "vault"), ("Check vault status", "vault"),
    ("Is the Vault set up?", "vault"), ("List other TLI computers", "mesh"),
    ("Which mesh nodes are connected?", "mesh"), ("Mesh status", "mesh"),
    ("Show smart devices", "registry"), ("What smart plugs do I have?", "registry"),
    ("List Shelly devices", "registry"),
])
def test_narrow_current_utility_question(question, topic):
    assert utility.classify(question) == topic


@pytest.mark.parametrize("question", [
    "Write Python to list Shelly devices", "How do I list mesh computers?",
    "Explain USB", "What is a Vault?", "Turn on the smart plug", "Reset my Vault",
    "What password unlocks my Vault?", "Show the files in my vault",
    "Back up my computer", "What date format does JavaScript use?", "What is the time complexity?",
    "Why is my Wi-Fi slow?", "How much disk space do I have?", "Is my CPU overloaded?",
    "Is my printer connected?", "Print the date", "List smart devices then turn them off",
    "Is my Vault unlocked on another computer?", "What time is it in Tokyo?",
])
def test_general_coding_action_other_target_and_observed_questions_do_not_read(question):
    def forbidden():
        pytest.fail("An unmatched question must not read a registry")
    assert utility.answer(None, question, readers={key: forbidden for key in ("mesh", "vault", "registry")}) is None


def test_clock_reports_host_timezone_with_no_reader():
    result = utility.answer(None, "What time is it?", readers={}, now=datetime(2026, 9, 7, 16, 4, 3, tzinfo=timezone.utc))
    assert "Monday, September 07, 2026" in result and "04:04:03 PM UTC" in result
    assert "host's local time" in result and "phone's time zone" in result


def test_usb_question_never_enumerates_or_claims_none():
    result = utility.answer(None, "List USB devices", readers={})
    assert "no confirmed cached USB inventory" in result
    assert "Printers & USB" in result and "No enumeration was run" in result
    assert "does not mean that no USB devices" in result


@pytest.mark.parametrize("initialized,unlocked,expected", [
    (False, False, "not set up"), (True, False, "locked for this TLI account"),
    (True, True, "unlocked for this TLI account"),
])
def test_vault_status_uses_strict_existing_account_state(initialized, unlocked, expected):
    result = utility.answer(None, "Is my Vault locked?", readers={"vault": lambda: {"is_initialized": initialized, "is_unlocked_for_user": unlocked}})
    assert f"**{expected}**" in result and "No Vault files or secrets were opened" in result


def test_default_vault_reader_passes_actual_request_through_owner_auth(monkeypatch):
    from routers import system_routes
    import vault_security
    request = SimpleNamespace(headers={"authorization": "Bearer synthetic"})
    calls = []
    def auth(*, request):
        calls.append(request)
        return "synthetic-owner"
    def status(owner):
        calls.append(owner)
        return {"is_initialized": True, "is_unlocked_for_user": False}
    monkeypatch.setattr(system_routes, "require_session", auth)
    monkeypatch.setattr(vault_security, "get_status", status)
    assert "locked for this TLI account" in utility.answer(request, "Vault status")
    assert calls == [request, "synthetic-owner"]


@pytest.mark.parametrize("topic,question,value", [
    ("vault", "Vault status", {"is_initialized": True, "is_unlocked_for_user": "false"}),
    ("mesh", "Mesh status", []), ("registry", "Show smart devices", {"devices": []}),
])
def test_malformed_passive_results_are_unavailable_never_empty_success(topic, question, value):
    result = utility.answer(None, question, readers={topic: lambda: value})
    assert "could not be read" in result and "Current status is unconfirmed" in result
    assert "No entries" not in result and "No computers are recorded" not in result


def test_registry_read_error_does_not_leak_exception_or_invent_empty_result():
    def failed():
        raise OSError("PRIVATE PATH C:/synthetic/private.key")
    result = utility.answer(None, "Show smart devices", readers={"registry": failed})
    assert "unconfirmed" in result and "PRIVATE" not in result and "No entries" not in result


def test_duplicate_mesh_names_retain_ids_and_do_not_become_confirmed_online():
    result = utility.answer(None, "List TLI computers", readers={"mesh": lambda: {
        "node-a": {"node_name": "Studio", "status": "online", "last_seen": "2026-09-01T10:00:00Z"},
        "node-b": {"node_name": "Studio"},
    }})
    assert result.count("**Studio**") == 2 and "ID node-a" in result and "ID node-b" in result
    assert "recorded status: online" in result and "recorded status: unknown" in result
    assert "current reachability was not checked" in result and "time unavailable" in result
    assert "No LAN scan or peer request was run" in result


def test_registry_preserves_actual_relay_identifier_and_unspecified_target():
    result = utility.answer(None, "List Shelly devices", readers={"registry": lambda: [
        ("Shelly registry", {"name": "Studio", "id": "relay-one", "ip": "192.0.2.4", "relay": 1}),
        ("Shelly registry", {"name": "Studio", "id": "unspecified", "ip": "192.0.2.4"}),
        ("Smart devices registry", {"name": "Other", "id": "other-device", "relay": 0}),
    ]})
    assert "relay 1 · ID relay-one" in result and "relay not specified · ID unspecified" in result
    assert "relay 0 · ID other-device" in result and result.count("**Studio**") == 2
    assert "current power and reachability were not checked" in result and "No device was contacted or controlled" in result


def test_default_registry_reads_are_bounded_read_only_and_distinguish_corruption(tmp_path, monkeypatch):
    import tli_state as S
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "SHELLY_REGISTRY_PATH", tmp_path / "shelly.json")
    monkeypatch.setattr(S, "MESH_DIRECTORY_PATH", tmp_path / "mesh.json")
    assert utility._registry() == [] and utility._mesh() == {}
    assert list(tmp_path.iterdir()) == []
    shelly = tmp_path / "shelly.json"
    mesh = tmp_path / "mesh.json"
    shelly.write_text(json.dumps([{"name": "Synthetic", "relay": 1}]))
    mesh.write_text(json.dumps({"test-node": {"node_name": "Synthetic"}}))
    before = {path: path.read_bytes() for path in (shelly, mesh)}
    assert utility._registry() == [("Shelly registry", {"name": "Synthetic", "relay": 1})]
    assert utility._mesh() == {"test-node": {"node_name": "Synthetic"}}
    assert {path: path.read_bytes() for path in before} == before
    shelly.write_text("invalid")
    assert "could not be read" in utility.answer(None, "Show smart devices")
    mesh.write_text("{}" * (1024 * 1024))
    with pytest.raises(ValueError, match="bounded read"):
        utility._mesh()


def test_registry_bounds_rows_and_escapes_recorded_names():
    records = [("Shelly registry", {"name": "[name](https://invalid.test) <tag>", "id": str(index)}) for index in range(30)]
    result = utility.answer(None, "Show smart devices", readers={"registry": lambda: records})
    assert "Showing 24 of 30 registered entries" in result
    assert "\\[name\\]" in result and "\\<tag\\>" in result and "ID 24" not in result


def test_legacy_adapter_delegates_without_http_or_device_probes(monkeypatch):
    from ai import ai_routes
    calls = []
    monkeypatch.setattr(utility, "answer", lambda request, text: calls.append((request, text)) or "passive result")
    request = SimpleNamespace(base_url="https://untrusted-host.invalid")
    assert ai_routes._tool_answer(request, "Show smart devices") == "passive result"
    assert calls == [(request, "Show smart devices")]
