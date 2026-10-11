"""Actual route presentation, account boundaries and unchanged saved reports."""
import copy

import pytest
import tli_state as S
from intelligence import diagnostics, report_facts
from intelligence.store import write_private, read_private
from tests.test_outcome_chat_routes import isolated, result, saved_report, PATHS


@pytest.mark.parametrize("path", PATHS)
def test_selected_report_summary_is_deterministic_and_saved_with_same_facts(path, client, isolated):
    before = copy.deepcopy(read_private("local", "diagnostics", []))
    response = client.post(path, json={"message": "Summarize this report", "diagnostic_id": "owned-report", "use_saved_memory": False, "brain": "lmstudio"})
    data = result(response)
    assert data["handled_by"] == "recorded_outcome"
    facts = data["evidence_context"]["recorded_report"]
    assert facts == report_facts.build(before[0])
    assert facts["target"]["id"] == "printer-7" and facts["checks"][0]["scope"] == "host_to_device"
    assert "physical printing" in data["reply"]
    turns = [turn for row in S.load_conversations().values() for turn in row["messages"] if turn["role"] == "assistant"]
    assert turns[-1]["evidence_context"]["recorded_report"] == facts
    assert read_private("local", "diagnostics", []) == before


def test_get_report_and_list_add_facts_without_rewriting_store(client, isolated):
    before = copy.deepcopy(read_private("local", "diagnostics", []))
    value = client.get("/api/intelligence/diagnostics/owned-report")
    assert value.status_code == 200, value.text
    assert value.json()["recorded_facts"] == report_facts.build(before[0])
    rows = client.get("/api/intelligence/diagnostics").json()["reports"]
    assert rows[0] == value.json()
    assert diagnostics.get_report("local", "owned-report") == before[0]
    assert read_private("local", "diagnostics", []) == before


def test_foreign_report_facts_are_not_exposed(client, isolated):
    other = saved_report(); other["id"] = "private-other-report"
    other["host"]["name"] = "Other-account-marker"
    write_private("another-owner", "diagnostics", [other])
    response = client.get("/api/intelligence/diagnostics/private-other-report")
    assert response.status_code == 404 and "Other-account-marker" not in response.text
    assert "Other-account-marker" not in client.get("/api/intelligence/diagnostics").text


@pytest.mark.parametrize("path", PATHS)
def test_summary_target_conflict_rejects_without_probes(path, client, isolated):
    response = client.post(path, json={"message": "Summarize this report", "diagnostic_id": "owned-report", "target_id": "other-device"})
    assert response.status_code == 422 and "different computer or device" in response.text
