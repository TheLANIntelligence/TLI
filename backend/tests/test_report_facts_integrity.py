"""Independent corrupt-number and subject-binding regressions, synthetic only."""
import copy

import pytest

from intelligence import answer_evidence, outcome_answers, report_facts
from intelligence.store import write_private, read_private
from tests.test_outcome_chat_routes import isolated, result, PATHS


def sample_report():
    return {"id": "owned-report", "kind": "performance", "host": {"id": "host-a", "name": "Synthetic A"},
            "created_at": "2026-09-08T12:00:00Z", "checks": [], "target": None,
            "performance": {"schema_version": 1, "host": {"id": "host-a", "name": "Synthetic A"},
                "process": {"pid": 10, "create_time": 123.0, "name": "Synthetic app"},
                "started_at": "2026-09-08T11:59:58Z", "finished_at": "2026-09-08T12:00:00Z",
                "duration_seconds": 2, "requested_duration_seconds": 2, "status": "completed",
                "sample_count": 2, "expected_samples": 2,
                "samples": [{key: 2 for key in report_facts.METRICS} for _ in range(2)]}}


@pytest.mark.parametrize("number", [1e308, 10**400, 2**63])
def test_extreme_byte_numbers_remain_unavailable_without_overflow_or_source_mutation(number):
    saved = sample_report()
    for row in saved["performance"]["samples"]:
        row["host_ram_used_bytes"] = number
    original = copy.deepcopy(saved)
    facts = report_facts.build(saved)
    metric = next(m for m in facts["measurements"] if m["key"] == "host_ram_used_bytes")
    assert metric["valid_samples"] == 0 and metric["mean"] is None
    assert facts["status"] == "unknown"
    # This legacy compatibility projection also counted raw samples. It must
    # not crash after the new summary correctly rejected an extreme integer.
    projected = outcome_answers.project_report(saved)
    assert projected["recorded_facts"] == facts
    assert saved == original


def test_host_conflict_cannot_transfer_process_identity_or_observation_interval():
    saved = sample_report()
    saved["performance"]["host"]["id"] = "host-b"
    original = copy.deepcopy(saved)
    facts = report_facts.build(saved)
    assert facts["host"]["id"] == "host-a" and facts["recorded_at"] == saved["created_at"]
    assert facts["status"] == "unknown" and facts["measurements"] == []
    assert facts["process"] is None
    assert all(facts[key] is None for key in ("started_at", "finished_at", "duration_seconds",
                                            "requested_duration_seconds", "recorded_samples", "expected_samples"))
    answer = outcome_answers.answer("Summarize this report", report=outcome_answers.project_report(saved))
    assert "Synthetic app" not in answer["text"] and "PID 10" not in answer["text"]
    assert saved == original


@pytest.mark.parametrize("number", [float("inf"), float("nan"), 10**400])
def test_nonfinite_or_unrepresentable_process_start_is_rejected_in_public_receipts(number):
    facts = report_facts.build(sample_report())
    facts["process"]["create_time"] = number
    assert report_facts.public_summary(facts) is None


def test_saved_report_receipt_must_bind_its_exact_target():
    saved = {"id": "target-report", "kind": "device", "host": {"id": "host-a"},
             "target": {"id": "printer-a"}, "created_at": "2026-09-08T12:00:00Z",
             "checks": [{"status": "pass", "label": "Reachability"}]}
    receipt = answer_evidence.build(report=outcome_answers.project_report(saved))
    assert receipt["recorded_report"]["target"]["id"] == "printer-a"
    wrong = copy.deepcopy(receipt)
    wrong["recorded_report"]["target"]["id"] = "printer-b"
    assert answer_evidence.public_receipt(wrong) is None
    wrong["recorded_report"]["target"] = None
    assert answer_evidence.public_receipt(wrong) is None


def test_zero_measurements_are_preserved_while_zero_pid_is_unknown():
    saved = sample_report()
    for row in saved["performance"]["samples"]:
        row.update({key: 0 for key in row})
    facts = report_facts.build(saved)
    assert facts["status"] == "completed"
    assert all(m["mean"] == 0 and m["valid_samples"] == 2 for m in facts["measurements"])
    saved["performance"]["process"]["pid"] = 0
    facts = report_facts.build(saved)
    assert facts["status"] == "unknown" and facts["process"]["pid"] is None


@pytest.mark.parametrize("path", PATHS)
def test_corrupt_numeric_saved_report_is_readable_and_never_claims_completed_sampling(path, client, isolated):
    saved = sample_report()
    for row in saved["performance"]["samples"]:
        row["host_ram_used_bytes"] = 10**400
    write_private("local", "diagnostics", [saved])
    before = copy.deepcopy(read_private("local", "diagnostics", []))
    read = client.get("/api/intelligence/diagnostics/owned-report")
    assert read.status_code == 200, read.text
    assert read.json()["recorded_facts"]["status"] == "unknown"
    response = client.post(path, json={"message": "Summarize this report", "diagnostic_id": "owned-report",
                                        "use_saved_memory": False, "brain": "lmstudio"})
    value = result(response)
    assert value["handled_by"] == "recorded_outcome"
    assert value["evidence_context"]["recorded_report"]["status"] == "unknown"
    assert "Planned sampling completed" not in value["reply"]
    assert read_private("local", "diagnostics", []) == before
