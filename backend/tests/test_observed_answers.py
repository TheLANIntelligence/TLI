"""The same passive observations answer direct questions on either chat route."""
from datetime import datetime, timezone
import json
from pathlib import Path
import socket
import sys
from types import SimpleNamespace

import pytest

from intelligence import observed_answers as answers

NOW = 1_800_000_000.0
STAMP = datetime.fromtimestamp(NOW, timezone.utc).isoformat()
HOST = {"id": "synthetic-host", "name": "Studio test host"}


def readers(topic, data):
    calls = []
    def read():
        calls.append(topic)
        return data
    return {"host": lambda: HOST, topic: read}, calls


@pytest.mark.parametrize("query,topic", [
    ("What is my CPU usage?", "cpu"), ("Show CPU usage", "cpu"),
    ("Is my CPU overloaded?", "cpu"), ("Check this computer's processor load", "cpu"),
    ("How busy is my CPU right now?", "cpu"),
    ("How much RAM do I have?", "ram"), ("How much RAM is my computer using?", "ram"),
    ("How much memory is available?", "ram"), ("How much RAM am I using?", "ram"),
    ("How much RAM is in my computer?", "ram"), ("What is my memory usage?", "ram"),
    ("Show my RAM", "ram"), ("Is my RAM full?", "ram"),
    ("Show disk space", "storage"), ("What is my disk space?", "storage"),
    ("How much free space do I have?", "storage"), ("Which drives are full?", "storage"),
    ("Which drives need attention?", "storage"), ("What drives can be cleaned?", "storage"),
    ("How much space is left?", "storage"), ("Is my disk full?", "storage"),
    ("What is my network status?", "network"), ("Show my network interfaces", "network"),
    ("What is my IP address?", "network"), ("What is this host's local IP address?", "network"),
    ("Show my Wi-Fi status", "network"),
    ("What is my default printer?", "printers"), ("Which printers are installed?", "printers"),
    ("What printers do I have?", "printers"), ("What is my printer?", "printers"),
    ("Show my system status", "system"), ("CPU and RAM usage", "system"),
])
def test_narrow_host_questions_select_one_topic(query, topic):
    assert answers.classify(query) == {"topic": topic, "resource": None}


@pytest.mark.parametrize("query", [
    "What is RAM?", "What is a CPU?", "What is disk space?", "What is storage?",
    "What is an IP address?", "Explain RAM", "Explain CPU utilization", "Show my memory",
    "Why is my Wi-Fi slow?", "Why is my CPU overloaded?", "Why is my computer slow?",
    "What is taking up space on my drive?", "How do I free disk space?", "How can I clean my drive?",
    "Write a Python script to check CPU usage", "Show how to print a list in Python",
    "What is a printer in C++?", "Write network code", "How much RAM do I need for a model?",
    "Should I buy a new drive?", "Drive to the airport", "This conversation is full of surprises",
    "Turn on CPU", "Restart my computer", "Print my report", "Scan my LAN",
    "Who is on my network?", "Check whether the printer needs ink", "Check the print queue",
    "What is my other computer's CPU usage?", "What is the bedroom computer's RAM usage?",
    "What is my CPU usage and fix it", "CPU usage; delete my files", "Show my network and scan all devices",
    "What model are you running?", "Help me with this attached report", "",
])
def test_general_causal_coding_actions_and_other_targets_do_not_probe(query):
    def forbidden():
        pytest.fail("An unmatched request must not consume observations")
    probes = {key: forbidden for key in ["host", *answers.TOPICS]}
    assert answers.classify(query) is None
    assert answers.answer(query, readers=probes, now=NOW) is None


def test_attached_context_takes_precedence_without_reading_the_default_host():
    def forbidden():
        pytest.fail("Selected context must not be replaced by the default host")
    assert answers.answer("What is my CPU usage?", has_context=True, readers={"cpu": forbidden}, now=NOW) is None


def test_cpu_answer_uses_cpu_and_never_storage_or_ai():
    probe, calls = readers("cpu", {"ok": True, "observed_at": STAMP, "cpu_pct": 91.2, "ram_pct": 42})
    result = answers.answer("Is my CPU overloaded?", readers=probe, now=NOW)
    assert calls == ["cpu"]
    assert "91.2%" in result["text"] and "Studio test host" in result["text"]
    assert "does not establish sustained overload or its cause" in result["text"]
    assert "Storage" not in result["text"] and "RAM:" not in result["text"]
    receipt = result["observation_context"]
    assert receipt["topic"] == "cpu" and receipt["host"] == HOST
    assert receipt["status"] == "current" and receipt["observed_at"] == STAMP


def test_ram_answer_reports_available_and_total_memory_instead_of_disks():
    probe, calls = readers("ram", {"ok": True, "observed_at": STAMP, "ram_pct": 40, "used_gb": 12.8, "total_gb": 32, "available_gb": 19.2})
    result = answers.answer("How much RAM do I have?", readers=probe, now=NOW)
    assert calls == ["ram"]
    assert "32.0 GiB" in result["text"] and "19.2 GiB" in result["text"] and "40%" in result["text"]
    assert "storage" not in result["text"].lower()


@pytest.mark.parametrize("age,expected", [(0, "current"), (30, "current"), (30.01, "stale"), (3600, "stale")])
def test_cpu_freshness_uses_observation_time_not_response_time(age, expected):
    probe, _ = readers("cpu", {"ok": True, "observed_at": NOW - age, "cpu_pct": 20})
    result = answers.answer("CPU usage", readers=probe, now=NOW)
    assert result["observation_context"]["status"] == expected
    assert "stale; previous readings only" in result["text"] if expected == "stale" else "freshness window" in result["text"]


@pytest.mark.parametrize("stamp", [None, 0, True, "invalid", "2026-09-07T12:00:00", NOW + 300])
def test_unconfirmed_timestamp_never_presents_initial_cpu_zero_as_a_current_reading(stamp):
    probe, _ = readers("cpu", {"ok": True, "observed_at": stamp, "cpu_pct": 0})
    result = answers.answer("CPU usage", readers=probe, now=NOW)
    assert result["observation_context"]["status"] == "unknown"
    assert "**0%**" not in result["text"] and "current readings unknown" in result["text"]


@pytest.mark.parametrize("value", [None, True, -1, 101, float("nan"), float("inf")])
def test_missing_or_invalid_cpu_is_unavailable_not_zero(value):
    probe, _ = readers("cpu", {"ok": True, "observed_at": STAMP, "cpu_pct": value})
    result = answers.answer("CPU usage", readers=probe, now=NOW)
    assert result["observation_context"]["status"] == "unavailable"
    assert "**0%**" not in result["text"] and "unavailable" in result["text"]


def test_failed_probe_does_not_become_an_empty_success_or_model_fallback():
    def failing():
        raise OSError("Synthetic path and credential must not leak")
    result = answers.answer("Show disk space", readers={"storage": failing, "host": lambda: HOST}, now=NOW)
    assert result is not None and result["observation_context"]["status"] == "unavailable"
    assert "credential" not in result["text"] and "no drives" not in result["text"]


def test_failed_cached_probe_preserves_previous_values_and_the_successful_timestamp():
    probe, calls = readers("cpu", {"ok": False, "observed_at": NOW - 90, "cpu_pct": 72})
    result = answers.answer("CPU usage", readers=probe, now=NOW)
    assert calls == ["cpu"] and "**72%**" in result["text"]
    assert "latest check failed" in result["text"] and "not current measurements" in result["text"]
    assert result["observation_context"]["status"] == "unavailable"
    assert result["observation_context"]["observed_at"] == answers._iso(NOW - 90)
    assert result["observation_context"]["checked_at"] == answers._iso(NOW)


def test_wifi_causal_question_remains_for_provider_reasoning_without_passive_or_active_checks():
    def forbidden():
        pytest.fail("A causal question must not trigger a keyword-matched observation")
    assert answers.answer("Why is my Wi-Fi slow?", readers={topic: forbidden for topic in answers.TOPICS}) is None
    probe, calls = readers("network", {"ok": True, "observed_at": STAMP, "interfaces": [{"name": "Wi-Fi", "addresses": ["192.0.2.8"], "is_up": True}]})
    status = answers.answer("What is my Wi-Fi status?", readers=probe, now=NOW)
    assert calls == ["network"] and "reported link up" in status["text"]
    assert "storage" not in status["text"].lower() and "No LAN scan, ping" in status["text"]


def test_explicit_drive_selects_the_requested_volume_and_preserves_observation_scope():
    rows = [{"mount": "C:\\", "free_gb": 5, "total_gb": 500, "pct": 99}, {"mount": "N:\\", "free_gb": 470, "total_gb": 931.5, "pct": 49.5}]
    probe, calls = readers("storage", {"ok": True, "observed_at": STAMP, "drives": rows})
    result = answers.answer("How much space is free on N:\\?", readers=probe, now=NOW)
    assert calls == ["storage"] and "470.0 GiB free" in result["text"]
    assert "500.0" not in result["text"] and result["observation_context"]["resource"] == "N:\\"
    assert "inaccessible mounts may be omitted" in result["text"] and "no cleanup was performed" in result["text"]


def test_missing_requested_drive_is_unconfirmed_instead_of_replaced_with_c_drive():
    probe, _ = readers("storage", {"ok": True, "observed_at": STAMP, "drives": [{"mount": "C:\\", "pct": 20}]})
    result = answers.answer("Is N:\\ full?", readers=probe, now=NOW)
    assert result["observation_context"]["status"] == "unavailable"
    assert "requested drive N:" in result["text"] and "capacity and accessibility are unconfirmed" in result["text"]
    assert "20%" not in result["text"]


def test_storage_lists_more_than_five_volumes_and_labels_any_display_limit():
    rows = [{"mount": f"/volume-{index}", "free_gb": 1, "total_gb": 10, "pct": 90} for index in range(30)]
    probe, _ = readers("storage", {"ok": True, "observed_at": STAMP, "drives": rows})
    result = answers.answer("Which drives are full?", readers=probe, now=NOW)
    assert "/volume-12" in result["text"] and "Showing 24 of 30 reported volumes" in result["text"]
    assert "/volume-24" not in result["text"] and "real-time" not in result["text"]


@pytest.mark.parametrize("rows", [None, [], [{"mount": "C:\\"}], [{"pct": 90}]])
def test_missing_storage_fields_do_not_claim_full_coverage_or_zero_use(rows):
    probe, _ = readers("storage", {"ok": True, "observed_at": STAMP, "drives": rows})
    result = answers.answer("Show disk space", readers=probe, now=NOW)
    assert result["observation_context"]["status"] == "unavailable"
    assert "0%" not in result["text"] and "0.0 GiB" not in result["text"]


def test_network_reports_interfaces_without_claiming_lan_discovery_or_internet_health():
    probe, calls = readers("network", {"ok": True, "observed_at": STAMP, "interfaces": [{"name": "Ethernet", "addresses": ["192.0.2.8"], "is_up": True}]})
    result = answers.answer("What is my network status?", readers=probe, now=NOW)
    assert calls == ["network"] and "192.0.2.8" in result["text"] and "reported link up" in result["text"]
    assert "No LAN scan, ping, DNS" in result["text"] and "internet-speed" in result["text"]
    assert "online" not in result["text"] and "healthy" not in result["text"]


def test_empty_network_interfaces_are_an_observation_not_an_internet_diagnosis():
    probe, _ = readers("network", {"ok": True, "observed_at": STAMP, "interfaces": []})
    result = answers.answer("What is my IP address?", readers=probe, now=NOW)
    assert "No non-loopback IP addresses were returned" in result["text"]
    assert "does not establish internet availability" in result["text"]


def test_cached_printers_remain_historical_and_do_not_claim_physical_readiness():
    probe, calls = readers("printers", {"ok": True, "observed_at": NOW - 3600, "printers": [{"name": "Studio printer", "is_default": True, "status": "ready"}]})
    result = answers.answer("What is my default printer?", readers=probe, now=NOW)
    assert calls == ["printers"] and result["observation_context"]["status"] == "stale"
    assert "recorded default" in result["text"] and "recorded status: ready" in result["text"]
    assert "no refresh, queue check, device contact or physical print check" in result["text"]


@pytest.mark.parametrize("data,status,expected", [
    ({"ok": None}, "unknown", "could not be confirmed"),
    ({"ok": False}, "unavailable", "could not be confirmed"),
    ({"ok": True, "observed_at": STAMP, "printers": []}, "current", "saved inventory contains no printers"),
    ({"ok": True, "observed_at": STAMP, "printers": None}, "unavailable", "No readable printer inventory"),
])
def test_printer_failure_missing_cache_and_real_empty_are_distinct(data, status, expected):
    probe, _ = readers("printers", data)
    result = answers.answer("What printers do I have?", readers=probe, now=NOW)
    assert result["observation_context"]["status"] == status and expected in result["text"]


def test_host_and_resource_labels_are_literal_and_unknown_identity_is_explicit():
    probe, _ = readers("printers", {"ok": True, "observed_at": STAMP, "printers": [{"name": "[Danger](https://invalid.test) <img>"}]})
    probe["host"] = lambda: {"id": None, "name": None}
    result = answers.answer("Show printers", readers=probe, now=NOW)
    assert result["observation_context"]["host"] == {"id": "unknown", "name": "Unknown TLI host"}
    assert "\\[Danger\\]" in result["text"] and "\\<img\\>" in result["text"]


def test_public_receipt_is_bounded_and_copies_only_the_agreed_schema():
    probe, _ = readers("cpu", {"ok": True, "observed_at": STAMP, "cpu_pct": 0})
    value = answers.answer("CPU usage", readers=probe, now=NOW)["observation_context"]
    copy = answers.public_receipt(value)
    assert copy == value and copy is not value and copy["host"] is not value["host"]
    for invalid in [{**value, "secret": "excluded"}, {**value, "schema_version": True}, {**value, "observed_at": None}, {**value, "checked_at": "not a time"}, {**value, "coverage": "x" * 1001}, {**value, "host": {**HOST, "key": "excluded"}}]:
        assert answers.public_receipt(invalid) is None


def test_default_printer_reader_never_initializes_or_refreshes_cache(tmp_path, monkeypatch):
    import tli_state as S
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    assert answers._printers() == {"ok": None, "printers": None, "observed_at": None}
    assert list(tmp_path.iterdir()) == []
    cache = tmp_path / "intelligence" / "printer_cache.json"
    cache.parent.mkdir()
    cache.write_text(json.dumps({"checked_at": STAMP, "printers": []}))
    before = cache.read_bytes()
    assert answers._printers()["observed_at"] == STAMP
    assert cache.read_bytes() == before
    cache.write_text("broken")
    with pytest.raises(ValueError):
        answers._printers()


def test_default_network_reader_only_uses_passive_local_interface_apis(monkeypatch):
    calls = []
    def addresses():
        calls.append("addresses")
        return {"Wi-Fi": [SimpleNamespace(family=socket.AF_INET, address="192.0.2.8"), SimpleNamespace(family=socket.AF_INET6, address="::1")], "Loopback": [SimpleNamespace(family=socket.AF_INET, address="127.0.0.1")]}
    def stats():
        calls.append("link-state")
        return {"Wi-Fi": SimpleNamespace(isup=True)}
    monkeypatch.setitem(sys.modules, "psutil", SimpleNamespace(net_if_addrs=addresses, net_if_stats=stats))
    result = answers._network()
    assert calls == ["addresses", "link-state"]
    assert result["interfaces"] == [{"name": "Wi-Fi", "addresses": ["192.0.2.8"], "is_up": True}]
