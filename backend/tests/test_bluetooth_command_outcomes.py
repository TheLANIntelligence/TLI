"""Conservative transport receipts without any hardware adapter."""
from unittest.mock import Mock

import pytest

import device_commands as commands


@pytest.fixture(autouse=True)
def clean_commands(monkeypatch):
    monkeypatch.setattr(commands, "_requests", {})
    monkeypatch.setattr(commands, "_running", set())


@pytest.mark.parametrize("output,expected,phrase", [
    ({"ok": True}, "accepted", "acknowledged"),
    ({"ok": True, "acknowledged": False}, "sent", "not confirmed"),
    ({"ok": False, "outcome": "unknown"}, "unknown", "unconfirmed"),
    ({"ok": False, "outcome": "not_sent"}, "failed", "did not confirm"),
])
def test_transport_outcomes_are_truthful_and_cached_without_retry(output, expected, phrase):
    operation = Mock(return_value=output)
    value = commands.run("alice", ("govee_ble", "ble://synthetic"), "switch.on", "a" * 32, operation)
    assert value["outcome"] == expected and phrase in value["summary"]
    assert commands.run("alice", ("govee_ble", "ble://synthetic"), "switch.on", "a" * 32, operation) == value
    operation.assert_called_once()


def test_disconnect_exception_remains_unknown_without_automatic_retry():
    operation = Mock(side_effect=TimeoutError("private adapter detail"))
    value = commands.run("alice", ("govee_ble", "ble://synthetic"), "switch.off", "a" * 32, operation)
    assert value["ok"] is False and value["outcome"] == "unknown"
    assert "private" not in value["summary"]
    assert commands.run("alice", ("govee_ble", "ble://synthetic"), "switch.off", "a" * 32, operation) == value
    operation.assert_called_once()
