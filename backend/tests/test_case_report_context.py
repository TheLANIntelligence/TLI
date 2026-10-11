"""Explicit case/report facts through actual routes; no implicit source bodies."""
import copy
import json

import pytest
from fastapi import HTTPException

from tests.test_case_context import fixture, ref, result, PATHS
from tests.test_outcome_answers import performance
from intelligence import cases, case_context as C, diagnostics, report_facts
from intelligence.input_budget import TextBudget
from intelligence.store import write_private, private_path
from ai import ai_routes as ai


@pytest.fixture
def selected(fixture):
    saved = performance("partial", 3)
    saved["findings"] = [{"text": "PRIVATE_UNSELECTED_INTERPRETATION"}]
    saved["attachments"] = ["PRIVATE_ATTACHMENT_BODY"]
    saved["next_steps"] = []
    diagnostics.save_report("local", saved)
    link = cases._pointer(cases.review_evidence("local", "report", saved["id"]))
    row = fixture.row
    values = {k: row[k] for k in ("title", "symptom", "status", "archived", "steps", "resolution")}
    values.update(evidence=[fixture.link, link], expected_revision=row["revision"])
    fixture.row = cases.save("local", cases.Update(**values).model_dump(), row["id"])["case"]
    fixture.report, fixture.report_link = saved, link
    return fixture


def selected_ref(f):
    return ref(f, evidence_refs=[f.report_link], report_refs=[f.report_link])


@pytest.mark.parametrize("path", PATHS)
def test_selected_report_supplies_only_facts_with_full_receipts_and_no_store_write(path, client, selected):
    before = {kind: private_path("local", kind).read_bytes() for kind in ("cases", "diagnostics")}
    data = result(client.post(path, json={"message": "Which possibilities should I consider?", "case_ref": selected_ref(selected),
                                          "brain": "lmstudio", "use_saved_memory": False, "use_conversation_history": False}))
    assert len(selected.calls) == 1
    prompt = selected.calls[0][0]["content"]
    supplied = json.loads(prompt.split("Selected case reference data:\n")[1])
    assert supplied["selected_report_facts"] == report_facts.build(selected.report)
    assert supplied["selected_report_facts"]["raw_samples_included"] == 0
    assert "PRIVATE_" not in prompt and '"samples": [' not in prompt
    facts = data["evidence_context"]["recorded_report"]
    assert facts == supplied["selected_report_facts"]
    assert data["case_context"]["included_reports"][0]["revision"] == selected.report_link["revision"]
    assert data["case_context"]["linked_bodies_included"] is False
    assert next(s for s in data["evidence_context"]["sources"] if s["handle"] == "R1")["revision"] == selected.report_link["revision"]
    assert {kind: private_path("local", kind).read_bytes() for kind in before} == before


def test_preview_is_explicit_and_fact_only(client, selected):
    response = client.post("/api/intelligence/cases/context-review", json={"case_ref": selected_ref(selected)})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["case_report_context"] == C.REPORT_PROTOCOL and data["actions_performed"] is False
    assert data["evidence_context"]["recorded_report"] == report_facts.build(selected.report)
    assert "PRIVATE_" not in response.text and not selected.calls


@pytest.mark.parametrize("operation", ["changed", "missing", "foreign", "wrong_target"])
def test_report_recheck_rejects_stale_missing_foreign_and_other_computers(client, selected, operation):
    body = selected_ref(selected)
    if operation == "changed":
        rows = diagnostics.history("local"); rows[0]["scope"] += " edited"
        write_private("local", "diagnostics", rows)
    elif operation in ("missing", "foreign"):
        if operation == "foreign": write_private("another-owner", "diagnostics", diagnostics.history("local"))
        write_private("local", "diagnostics", [])
    else:
        rows = cases.read_all("local"); rows["cases"][0]["computer"] = {"id": "another-computer", "name": "Other"}
        write_private("local", "cases", rows)
        body["revision"] = cases.get_case("local", selected.row["id"])["revision"]
    response = client.post("/api/ai/chat", json={"message": "Which possibilities remain?", "case_ref": body})
    assert response.status_code in (409, 422), response.text
    assert not selected.calls


def test_unselected_reports_have_no_facts_and_old_receipts_remain_exact(selected):
    old = ref(selected, evidence_refs=[selected.report_link])
    prepared = C.prepare("local", ai.ChatRequest(message="What next?", case_ref=old))
    assert "included_reports" not in prepared["case_context"]
    assert "recorded_report" not in prepared["evidence_context"]
    assert "selected_report_facts" not in str(prepared)
    assert C.public_receipt(prepared["case_context"]) == prepared["case_context"]


@pytest.mark.parametrize("path", PATHS)
def test_report_summary_in_case_is_deterministic_and_scope_bound(path, client, selected, monkeypatch):
    monkeypatch.setattr(selected.manager, "ensure_running", lambda: pytest.fail("No model for recorded summary"))
    data = result(client.post(path, json={"message": "Summarize this report", "case_ref": selected_ref(selected)}))
    assert data["handled_by"] == "case_outcome" and not selected.calls
    assert "[R1]" in data["reply"] and "[C1]" in data["reply"]
    assert data["evidence_context"]["interpretation"] == "backend"
    assert "partial" in data["reply"].lower() and "not current computer health" in data["reply"].lower()


def test_report_selection_is_whole_under_budget_and_cannot_forge_metadata(selected):
    request = ai.ChatRequest(message="What next?", case_ref=selected_ref(selected))
    with pytest.raises(HTTPException) as error:
        C.prepare("local", request, budget=TextBudget(context_tokens=1024, max_tokens=512))
    assert error.value.status_code == 422
    receipt = C.prepare("local", request)["case_context"]
    broken = copy.deepcopy(receipt); broken["included_reports"][0]["id"] = "other"
    assert C.public_receipt(broken) is None
    with pytest.raises(ValueError): C.CaseRef(**ref(selected, report_refs=[selected.report_link]))
