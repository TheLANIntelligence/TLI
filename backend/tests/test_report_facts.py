"""Authoritative recorded measurements never imply app or repair success."""
import copy
import json

import pytest

from intelligence import report_facts, outcome_answers, answer_evidence, context, chat_continuity
from tests.test_outcome_answers import performance, report


def test_measured_values_use_samples_not_saved_free_text_or_summary():
    saved = performance("partial", 7)
    saved["findings"] = [{"certainty": "confirmed", "text": "The app finished and was repaired"}]
    saved["performance"]["summary"]["host_cpu_percent"] = {"mean": 100, "max": 100, "min": 100, "samples": 30}
    for row in saved["performance"]["samples"]:
        row["host_cpu_percent"] = 80
        row["process_cpu_percent"] = 12
    before = copy.deepcopy(saved)
    facts = report_facts.build(saved)
    metrics = {m["key"]: m for m in facts["measurements"]}
    assert metrics["host_cpu_percent"]["mean"] == 80
    assert metrics["process_cpu_percent"]["mean"] == 12
    assert metrics["host_cpu_percent"]["scope"] == "host"
    assert metrics["process_cpu_percent"]["scope"] == "selected_process"
    assert facts["status"] == "partial" and facts["recorded_samples"] == 7 and facts["expected_samples"] == 30
    assert "The app finished" not in json.dumps(facts) and saved == before


@pytest.mark.parametrize("bad", [None, True, -1, float("nan"), float("inf"), 101, "50"])
def test_missing_or_invalid_measurements_are_missing_not_zero(bad):
    saved = performance("completed", 30)
    for row in saved["performance"]["samples"]:
        row["host_cpu_percent"] = bad
    facts = report_facts.build(saved)
    metric = next(m for m in facts["measurements"] if m["key"] == "host_cpu_percent")
    assert metric["mean"] is None and metric["valid_samples"] == 0
    assert facts["status"] == "unknown"


@pytest.mark.parametrize("status", ["stopped", "partial", "failed"])
def test_terminal_sampling_status_remains_distinct_from_task_success(status):
    facts = report_facts.build(performance(status, 4))
    assert facts["status"] == status
    assert "application's task finished" in " ".join(facts["limitations"])
    assert facts["basis"] == "saved_report" and facts["raw_samples_included"] == 0


@pytest.mark.parametrize("change", ["count", "host", "pid", "rows", "schema", "status"])
def test_inconsistent_completion_is_not_certified(change):
    saved = performance("completed", 30)
    p = saved["performance"]
    if change == "count": p["sample_count"] = 29
    if change == "host": p["host"]["id"] = "another-host"
    if change == "pid": p["process"]["pid"] = True
    if change == "rows": del p["samples"]
    if change == "schema": p["schema_version"] = True
    if change == "status": p["status"] = "running"
    facts = report_facts.build(saved)
    assert facts["status"] == "unknown"
    if change == "host": assert facts["measurements"] == []
    answer = outcome_answers.answer("Did the observation finish?", report=outcome_answers.project_report(saved))
    assert "completion cannot be confirmed" in answer["text"]
    assert "completed its planned sampling" not in answer["text"]


def test_network_direction_and_unavailable_checks_are_explicit():
    saved = report("network", checks=[
        {"id": "internet", "label": "External TCP connection", "detail": "Connection failed", "status": "fail"},
        {"id": "dns", "label": "Host DNS lookup", "detail": "Name resolved", "status": "pass"},
        {"id": "gateway", "label": "Default route", "status": "unavailable"},
    ])
    facts = report_facts.build(saved)
    assert facts["status"] == "partial"
    assert [(c["id"], c["status"], c["scope"]) for c in facts["checks"]] == [
        ("internet", "fail", "host"), ("dns", "pass", "host"), ("gateway", "unavailable", "host")]
    text = outcome_answers.answer("Summarize this report", report=outcome_answers.project_report(saved))["text"]
    assert "External TCP connection: **fail**" in text and "Host DNS lookup: **pass**" in text
    assert "different paths" in text and "Reading this report runs no new check or repair" in text


def test_oversized_lists_are_bounded_with_visible_omissions():
    saved = report(checks=[{"status": "pass", "label": "Saved check"}] * 70)
    facts = report_facts.build(saved)
    assert len(facts["checks"]) == 64 and facts["omitted_checks"] == 6
    assert facts["status"] == "partial"
    saved["checks"] = [None] * 10001
    facts = report_facts.build(saved)
    assert facts["status"] == "unknown" and facts["checks"] == []


def test_receipt_facts_require_matching_report_and_host():
    projection = outcome_answers.project_report(performance("partial", 7))
    receipt = answer_evidence.build(report=projection)
    assert receipt["recorded_report"]["status"] == "partial"
    for key in ("report_id", "host"):
        wrong = copy.deepcopy(receipt)
        wrong["recorded_report"][key] = "other-report" if key == "report_id" else {"id": "other-host", "name": "Other"}
        assert answer_evidence.public_receipt(wrong) is None
    old = answer_evidence.build()
    assert "recorded_report" not in old and answer_evidence.public_receipt(old) == old


@pytest.mark.parametrize("question", ["Summarize this report", "What did this observation measure?", "Explain what this report shows"])
def test_summary_uses_backend_and_escaped_recorded_details(question):
    saved = performance("partial", 7)
    saved["performance"]["process"]["name"] = "<img> [N9]"
    result = outcome_answers.answer(question, report=outcome_answers.project_report(saved))
    assert result["evidence_context"]["interpretation"] == "backend"
    assert result["evidence_context"]["invalid_citations"] == 0
    assert "7 recorded of 30 planned" in result["text"] and "Observation partially completed" in result["text"]
    assert "<img>" not in result["text"] and "[N9]" not in result["text"]
    assert "Suggested next step" in result["text"]


@pytest.mark.parametrize("question", ["Summarize this report and restart the computer", "Write code to summarize this report", "Summarize this report; delete the notes", "What report should I run?", "Explain what fixed it last time"])
def test_summary_grammar_does_not_intercept_other_instructions(question):
    assert outcome_answers.classify(question, selected_report=True) is None


def test_model_context_excludes_receipt_facts_and_raw_private_extras(monkeypatch):
    saved = performance("partial", 7)
    saved["performance"]["samples"][0]["private_extra"] = "hidden-raw-marker"
    monkeypatch.setattr(context.devices, "node", lambda: {"id": "study-id", "name": "Study"})
    monkeypatch.setattr(context.diagnostics, "get_report", lambda *args: saved)
    prepared = chat_continuity.prepare("alice", "What are the differences?", None, "Fixture", diagnostic_id="report-fixture", use_saved_memory=False)
    supplied = next(m["content"] for m in prepared["messages"] if "diagnostic_evidence:" in m["content"])
    report = json.loads(next(line.split(": ", 1)[1] for line in supplied.splitlines() if line.startswith("diagnostic_evidence: ")))
    assert "recorded_facts" not in report and "summary" in report["performance"]
    assert "samples" not in report["performance"]
    assert "hidden-raw-marker" not in str(prepared)
    assert prepared["evidence_context"]["recorded_report"]["measurements"]
