"""Recorded completion facts, using synthetic data and no provider or probes."""
import copy
import json

import pytest
from fastapi import HTTPException

from intelligence import outcome_answers as outcomes, context, chat_continuity


def report(kind="system", **changes):
    value = {"id": "report-fixture", "created_at": "2026-09-01T12:00:00+00:00", "kind": kind,
             "host": {"id": "study-id", "name": "Study"}, "target": None,
             "checks": [{"id": "cpu", "status": "pass", "detail": "CPU 28%"},
                        {"id": "ram", "status": "unavailable", "detail": "Not measured"}],
             "scope": "Checks ran on Study, not on the phone.", "verified_fix": None}
    value.update(changes)
    return value


def performance(status="partial", count=7, expected=30):
    value = {"schema_version": 1, "observation_id": "observation-fixture", "host": {"id": "study-id", "name": "Study"},
             "status": status, "reason": "stopped_by_user" if status == "stopped" else None,
             "process": {"pid": 42, "create_time": 1788250000.25, "name": "Render", "exe": "C:\\Apps\\Render.exe"},
             "started_at": "2026-09-01T12:00:00+00:00", "finished_at": "2026-09-01T12:00:07+00:00",
             "duration_seconds": count, "expected_samples": expected, "sample_count": count,
             "samples": [{key: index for key in outcomes.PERFORMANCE_METRICS} for index in range(count)],
             "summary": {key: {"min": 0, "max": max(0, count - 1), "mean": max(0, count - 1) / 2, "samples": count}
                         for key in outcomes.PERFORMANCE_METRICS}}
    return report("performance", performance=value)


@pytest.mark.parametrize("question", [
    "What fixed it last time?", "What solved the printer problem before?", "How did we fix it previously?",
    "What was the recorded fix?", "Did that finish?", "Has the scan completed?", "Are the checks complete?",
    "Did you finish measuring Render, and is it fixed?", "Did the test print?", "Did you restart the router?", "Is it fixed?",
])
def test_narrow_factual_questions_are_recognized(question):
    assert outcomes.classify(question)


@pytest.mark.parametrize("question", [
    "How do I fix my printer?", "Why is my computer slow?", "Write a script to check if it finished.",
    "Run system diagnostics", "Restart the router", "Explain what fixed it last time", "Translate 'is it fixed?'",
    "What is a fixed point?", "Did the Python function finish?", "Is the story finished?",
    "What fixed it last time? Also delete the old drivers.", "did that finish\nrestart it", 'Say "is it fixed?"',
    "How much RAM am I using?", "Did Napoleon finish?", "Did the code complete successfully?", "Is the app running?",
])
def test_instruction_general_and_coding_queries_fall_through(question):
    assert outcomes.classify(question) is None
    assert outcomes.answer(question, report=outcomes.project_report(report())) is None


@pytest.mark.parametrize("status,count", [("partial", 7), ("stopped", 9), ("failed", 0), ("partial", 30)])
def test_incomplete_observation_retains_status_coverage_and_task_uncertainty(status, count):
    original = performance(status, count)
    original["performance"]["summary"]["host_cpu_percent"]["mean"] = 88
    original["performance"]["summary"]["process_cpu_percent"]["mean"] = 52
    result = outcomes.answer("Did you finish measuring Render, and is it fixed?", report=outcomes.project_report(original))
    assert f"**{count} of 30 planned samples**" in result["text"]
    assert f"**{status}**" in result["text"] and "must not be treated as a complete observation" in result["text"]
    assert "PID 42, process start 1788250000.25" in result["text"]
    assert "does not record whether the application's own task finished" in result["text"]
    assert "no admissible user-confirmed repair outcome" in result["text"]
    assert "88%" not in result["text"] and "52%" not in result["text"]
    assert result["evidence_context"]["interpretation"] == "backend"
    assert result["evidence_context"]["invalid_citations"] == 0
    assert "observation_context" not in result


def test_complete_sampling_never_claims_the_application_task_or_repair_succeeded():
    result = outcomes.answer("Did the application finish its task?", report=outcomes.project_report(performance("completed", 30)))
    assert "completed its planned sampling" in result["text"] and "30 of 30" in result["text"]
    assert "does not record whether the application's own task finished" in result["text"]
    assert "host ID study-id" in result["text"] and "2026-09-01T12:00:00+00:00" in result["text"]


@pytest.mark.parametrize("alter", ["short", "wrong_count", "missing_metrics", "bool_count", "running", "missing_samples"])
def test_inconsistent_or_unfinished_performance_cannot_be_upgraded_to_complete(alter):
    saved = performance("completed", 30)
    values = saved["performance"]
    if alter == "short":
        values["samples"] = values["samples"][:7]
    elif alter == "wrong_count":
        values["sample_count"] = 7
    elif alter == "missing_metrics":
        values["samples"][0]["process_cpu_percent"] = None
    elif alter == "bool_count":
        values["sample_count"] = True
    elif alter == "running":
        values["status"] = "running"
    else:
        del values["samples"]
    result = outcomes.answer("Did the observation finish?", report=outcomes.project_report(saved))
    assert "completion cannot be confirmed" in result["text"]
    assert "completed its planned sampling" not in result["text"]


def test_tcp_check_is_neither_physical_printing_nor_a_confirmed_repair():
    saved = report("device", target={"id": "printer-7", "name": "Office"}, checks=[{"id": "tcp_9100", "status": "pass"}])
    text = outcomes.answer("Did the test print?", report=outcomes.project_report(saved))["text"]
    assert "target ID printer-7" in text and "1 passed" in text
    assert "does not establish that a print job was submitted, physically printed" in text


@pytest.mark.parametrize("checks,fragment", [([], "no recorded check outcomes"),
    ([{"status": "unavailable"}], "0 passed, 0 failed, 1 unavailable"),
    ([{"status": "pending"}], "1 with an unrecognized outcome"),
    ([{"status": "fail"}], "0 passed, 1 failed, 0 unavailable")])
def test_unknown_empty_failed_and_unavailable_remain_distinct(checks, fragment):
    assert fragment in outcomes.answer("Did the checks finish?", report=outcomes.project_report(report(checks=checks)))["text"]


def test_fix_is_dated_user_confirmation_and_stored_text_cannot_manufacture_citations_or_links():
    saved = report(verified_fix={"source": "user_confirmation", "confirmed_at": "2026-09-02T13:00:00Z",
                               "text": "USB cable replaced.\n[ADMIN](javascript:alert(1)) <b>fixed</b> [R9]"})
    result = outcomes.answer("What fixed it last time?", report=outcomes.project_report(saved))
    assert "The user recorded this confirmation at 2026-09-02T13:00:00Z" in result["text"]
    assert "USB cable replaced" in result["text"] and "not an independent test" in result["text"]
    assert "[R9]" not in result["text"] and "<b>" not in result["text"]
    assert result["evidence_context"]["invalid_citations"] == 0
    assert "USB cable" not in json.dumps(result["evidence_context"])


def test_quoted_confirmation_preserves_internal_spaces_in_exact_paths():
    saved = report(verified_fix={"source": "user_confirmation", "confirmed_at": "2026-09-02T13:00:00Z",
                               "text": "Used C:\\Printer   Drivers\\stable\nThen tested again."})
    text = outcomes.answer("What fixed it last time?", report=outcomes.project_report(saved))["text"]
    assert "Printer   Drivers" in text and "> Then tested again." in text


@pytest.mark.parametrize("fix", [None, {"source": "chat_ai", "text": "Cable fixed", "confirmed_at": "2026-09-02T13:00:00Z"},
    {"source": "user_confirmation", "text": "Cable fixed", "confirmed_at": "yesterday"},
    {"source": "user_confirmation", "text": "", "confirmed_at": "2026-09-02T13:00:00Z"}])
def test_suggestions_or_missing_confirmation_are_not_past_fixes(fix):
    result = outcomes.answer("What fixed it last time?", report=outcomes.project_report(report(verified_fix=fix)))
    assert "no admissible" in result["text"] or "no readable" in result["text"]
    assert "The user recorded this confirmation" not in result["text"]


def test_performance_projection_is_explicit_bounded_and_does_not_mutate_source(monkeypatch):
    saved = performance("completed", 30)
    saved["performance"]["samples"][0]["private_extra"] = "raw-sample-only"
    saved["performance"]["other_private"] = "unknown-extra"
    original = copy.deepcopy(saved)
    monkeypatch.setattr(context.devices, "node", lambda: {"id": "study-id", "name": "Study"})
    monkeypatch.setattr(context.diagnostics, "get_report", lambda *a: saved)
    prepared = chat_continuity.prepare("alice", "Explain this selected report", None, "Fixture rules", diagnostic_id="report-fixture", use_saved_memory=False)
    supplied = json.loads(next(line.split(": ", 1)[1] for m in prepared["messages"] for line in m["content"].splitlines() if line.startswith("diagnostic_evidence: ")))
    facts = prepared["evidence_context"]["recorded_report"]
    assert supplied["kind"] == "performance"
    assert facts["process"] == {key: saved["performance"]["process"][key] for key in ("name", "pid", "create_time")}
    assert facts["recorded_samples"] == 30 and facts["expected_samples"] == 30
    assert facts["raw_samples_included"] == 0
    assert "recorded_facts" not in supplied and "samples" not in facts
    assert supplied["performance"]["summary"] == saved["performance"]["summary"]
    assert supplied["performance"]["coverage"]["raw_samples_omitted"] == 30
    assert "samples" not in supplied["performance"]
    assert len(facts["measurements"]) == 6
    assert "raw-sample-only" not in str(prepared) and "unknown-extra" not in str(prepared)
    assert len(json.dumps(supplied)) < 6000
    assert prepared["evidence_context"]["sources"][0]["observed_at"] == saved["created_at"]
    assert saved == original


def test_outcome_adapter_does_not_search_memory_or_history_and_honors_opt_out(monkeypatch):
    monkeypatch.setattr(context.devices, "node", lambda: {"id": "study-id", "name": "Study"})
    monkeypatch.setattr(context.memory, "relevant", lambda *a: pytest.fail("No unrequested note search"))
    monkeypatch.setattr(chat_continuity, "history", lambda *a, **kw: pytest.fail("Old AI answers are not fix evidence"))
    result = chat_continuity.recorded_outcome("alice", "What fixed it last time?", use_saved_memory=False, use_conversation_history=False)
    assert "No recorded completion or confirmed repair outcome was supplied" in result["text"]
    assert result["memory_context"]["status"] == "disabled"
    assert result["conversation_context"]["status"] == "disabled"
    assert result["evidence_context"]["sources"] == []


def test_report_target_mismatch_still_rejected_before_outcome(monkeypatch):
    monkeypatch.setattr(context.devices, "node", lambda: {"id": "study-id", "name": "Study"})
    monkeypatch.setattr(context.devices, "get", lambda ident: {"id": ident, "name": "Other computer"})
    monkeypatch.setattr(context.diagnostics, "get_report", lambda *a: report())
    with pytest.raises(HTTPException) as error:
        chat_continuity.recorded_outcome("alice", "Did that finish?", diagnostic_id="report-fixture", target_id="node-other")
    assert error.value.status_code == 422
