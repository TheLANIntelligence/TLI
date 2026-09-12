"""Real reviewed guidance/run routes with synthetic encrypted stores only."""
import copy
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from tests.test_case_context import fixture, ref, result, PATHS
from tests.test_case_report_context import selected, selected_ref
from intelligence import cases, case_context, case_next_check as N, devices, diagnostics, diagnostic_workflow as W, memory
from intelligence.store import private_path, write_private


@pytest.fixture
def guidance(selected, monkeypatch):
    host = {"id": "study-id", "name": "Study", "node_id": "study-id"}
    local = {"id": "node-study-id", "name": "Study", "node_id": "study-id", "source_id": "study-id", "kind": "computer", "source": "local_node"}
    registry = {local["id"]: local}
    monkeypatch.setattr(devices, "node", lambda: copy.deepcopy(host))
    def get(ident):
        if ident not in registry:
            raise HTTPException(404, "Selected computer is unavailable")
        return copy.deepcopy(registry[ident])
    monkeypatch.setattr(devices, "get", get)
    raw = cases.read_all("local")
    row = raw["cases"][0]
    row.update(computer={"id": local["id"], "name": local["name"]}, title="Video pauses", symptom="Video stutters intermittently.",
               steps=[{"id": "skipped", "text": "Update driver", "status": "skipped", "outcome": "Not attempted."},
                      {"id": "tried", "text": "Close browser", "status": "tried", "outcome": "Stutter continued."}])
    write_private("local", "cases", raw)
    selected.row = cases.get_case("local", row["id"])
    W._requests.clear()
    selected.registry, selected.host = registry, host
    def no_effect(*args, **kwargs): pytest.fail("Guidance cannot call diagnostics, a peer, a model or unselected notes")
    monkeypatch.setattr(diagnostics, "run", no_effect)
    monkeypatch.setattr(memory, "list_facts", no_effect)
    import peer_trust
    monkeypatch.setattr(peer_trust, "observe", no_effect)
    return selected


def preview(client, f, **changes):
    wanted = {**selected_ref(f), **changes}
    response = client.post("/api/intelligence/cases/next-check", json={"case_ref": wanted})
    assert response.status_code == 200, response.text
    return response.json(), wanted


def run_body(data, ident="one-reviewed-observation"):
    g = data["guidance"]
    option = next(o for o in g["check_options"]["options"] if o["id"] == g["suggestion"]["option_id"])
    return {"kind": option["kind"], "target_id": option["target_id"], "internet": False,
            "expected_host_id": option["execution_host"]["id"], "expected_scope": option["scope_revision"], "request_id": ident,
            "next_check_ref": {"case_ref": g["selection"], "selection_sha256": g["selection_sha256"], "option_id": option["id"]}}


def test_review_is_exact_historical_fact_only_no_effect_or_unselected_note_lookup(client, guidance):
    before = {k: private_path("local", k).read_bytes() for k in ("cases", "diagnostics")}
    data, wanted = preview(client, guidance)
    g = data["guidance"]
    assert data["next_check_protocol"] == N.PROTOCOL and data["actions_performed"] is False
    assert data["evidence_context"]["interpretation"] == "backend"
    assert g["selection"] == case_context.CaseRef(**wanted).model_dump(exclude_none=True)
    assert g["suggestion"]["option_id"] == "system"
    assert "already contains host CPU and RAM" in g["suggestion"]["rationale"]
    assert "Stutter continued." in g["suggestion"]["rationale"]
    assert [(s["status"], s["outcome"]) for s in g["steps"]] == [("skipped", "Not attempted."), ("tried", "Stutter continued.")]
    assert data["evidence_context"]["recorded_report"]["recorded_samples"] == 3
    assert data["evidence_context"]["recorded_report"]["raw_samples_included"] == 0
    assert data["case_context"]["omitted_link_count"] == 1
    assert "PRIVATE_" not in json.dumps(data) and not guidance.calls
    assert {k: private_path("local", k).read_bytes() for k in before} == before


def test_reference_only_has_no_report_body_read_or_hidden_values(client, guidance, monkeypatch):
    def no_reports(*a, **kw): pytest.fail("Unselected report bodies must not be looked up")
    monkeypatch.setattr(diagnostics, "get_report", no_reports)
    data, _ = preview(client, guidance, evidence_refs=[], report_refs=[])
    assert "recorded_report" not in data["evidence_context"]
    assert "included_reports" not in data["case_context"]
    assert "report_facts" in {x["id"] for x in data["guidance"]["missing"]}
    assert "sample_coverage" not in {x["id"] for x in data["guidance"]["known"]}


@pytest.mark.parametrize("mode", ["empty_ram", "zero_ram"])
def test_missing_measurements_stay_unknown_while_real_zero_is_known(client, guidance, mode):
    rows = diagnostics.history("local")
    if mode == "empty_ram":
        for sample in rows[0]["performance"]["samples"]: sample["host_ram_percent"] = None
    else:
        for sample in rows[0]["performance"]["samples"]: sample["host_ram_percent"] = 0
    write_private("local", "diagnostics", rows)
    new_link = cases._pointer(cases.review_evidence("local", "report", rows[0]["id"]))
    raw = cases.read_all("local"); raw["cases"][0]["evidence"] = [{**new_link, "label": "Reviewed report", "linked_at": "2026-09-01T12:00:00Z"}]
    write_private("local", "cases", raw)
    guidance.row = cases.get_case("local", raw["cases"][0]["id"])
    guidance.report_link = new_link
    data, _ = preview(client, guidance)
    assert ("ram" in {x["id"] for x in data["guidance"]["missing"]}) == (mode == "empty_ram")
    measurement = next(m for m in data["evidence_context"]["recorded_report"]["measurements"] if m["key"] == "host_ram_percent")
    assert measurement["mean"] == (None if mode == "empty_ram" else 0)
    if mode == "empty_ram": assert "no usable RAM result" in data["guidance"]["suggestion"]["rationale"]


def test_attempt_without_outcome_requires_review_instead_of_repeating_check(client, guidance):
    raw=cases.read_all("local");raw["cases"][0]["steps"][1]["outcome"]=""
    write_private("local","cases",raw);guidance.row=cases.get_case("local",guidance.row["id"],resolve=False)
    data,_=preview(client,guidance)
    assert data["guidance"]["suggestion"] is None
    assert any(item["id"]=="attempt_outcome" for item in data["guidance"]["missing"])
    assert "Record or review the missing outcome" in " ".join(data["guidance"]["limitations"])


@pytest.mark.parametrize("change", ["case", "deleted_case", "report", "deleted_report", "foreign_report", "wrong_target"])
def test_changed_missing_and_wrong_target_selection_rejects_before_effects(client, guidance, change):
    wanted = selected_ref(guidance)
    if change in ("case", "deleted_case", "wrong_target"):
        raw = cases.read_all("local")
        if change == "deleted_case": raw["cases"] = []
        elif change == "case": raw["cases"][0]["symptom"] += " changed"
        else: raw["cases"][0]["computer"] = {"id": "wrong", "name": "Other computer"}
        write_private("local", "cases", raw)
        if change == "wrong_target": wanted["revision"] = cases.get_case("local", wanted["id"], resolve=False)["revision"]
    else:
        rows = diagnostics.history("local")
        if change == "report": rows[0]["scope"] = "Changed source"
        else:
            if change == "foreign_report": write_private("other-owner", "diagnostics", rows)
            rows = []
        write_private("local", "diagnostics", rows)
    response = client.post("/api/intelligence/cases/next-check", json={"case_ref": wanted})
    assert response.status_code in (404, 409, 422), response.text
    assert not guidance.calls


def test_case_edit_during_capability_read_rejects_guidance_without_store_lock(client, guidance, monkeypatch):
    original = W.options
    def edited(*a, **kw):
        from intelligence.store import LOCK
        assert not LOCK._is_owned()
        data = original(*a, **kw)
        raw = cases.read_all("local"); raw["cases"][0]["symptom"] += " edited"
        write_private("local", "cases", raw)
        return data
    monkeypatch.setattr(W, "options", edited)
    response = client.post("/api/intelligence/cases/next-check", json={"case_ref": selected_ref(guidance)})
    assert response.status_code == 409 and not guidance.calls


@pytest.mark.parametrize("mode", ["no_computer", "ambiguous_symptom", "resolved", "unsupported_peer", "peer"])
def test_only_one_available_matching_observation_no_host_fallback(client, guidance, monkeypatch, mode):
    raw = cases.read_all("local"); row = raw["cases"][0]
    if mode == "no_computer": row["computer"] = None
    if mode == "ambiguous_symptom": row["symptom"] = "Slow internet connection."
    if mode == "resolved": row.update(status="resolved", resolution="The user confirmed improvement.")
    if mode in ("unsupported_peer", "peer"):
        import peer_trust
        row["computer"] = {"id": "node-peer", "name": "Other"}
        guidance.registry["node-peer"] = {"id": "node-peer", "name": "Other", "kind": "computer", "node_id": "peer", "source_id": "peer", "source": "mesh", "address": "192.0.2.20"}
        monkeypatch.setattr(peer_trust, "capability", lambda _: {"available": mode == "peer", "reason": "Unavailable", "peer": {"id": "peer", "name": "Other", "identity_fingerprint": "a" * 64}, "revision": "b" * 64})
    write_private("local", "cases", raw)
    guidance.row = cases.get_case("local", row["id"], resolve=False)
    data, _ = preview(client, guidance, evidence_refs=[], report_refs=[])
    g = data["guidance"]
    if mode == "peer":
        assert g["suggestion"]["option_id"] == "peer_system"
        option = next(o for o in g["check_options"]["options"] if o["id"] == "peer_system")
        assert option["execution_host"]["id"] == "peer" and option["target_id"] == "node-peer"
    else: assert g["status"] == "unavailable" and g["suggestion"] is None


def test_suggested_run_binds_sources_and_duplicate_receipt_without_new_runner(client, guidance, monkeypatch):
    data, _ = preview(client, guidance); body = run_body(data); calls = []
    def fake_run(user, kind, target_id, internet, **kw):
        calls.append(kw)
        report = {"id": "new-observation", "kind": kind, "created_at": "2026-09-10T12:00:00Z", "host": guidance.host, "target": None, "scope": "Synthetic host check only.", "internet_checks":False,"findings":[],"next_steps":[],"verified_fix":None,"checks": [], "_check_request": kw["_request_receipt"]}
        return diagnostics.save_report(user, report)
    monkeypatch.setattr(diagnostics, "run", fake_run)
    first = client.post("/api/intelligence/diagnostics", json=body)
    assert first.status_code == 200, first.text
    assert client.post("/api/intelligence/diagnostics", json=body).status_code == 200
    assert len(calls) == 1 and calls[0]["_request_receipt"]["next_check_selection"] == data["guidance"]["selection_sha256"]
    other, _ = preview(client, guidance, step_ids=["tried"])
    assert client.post("/api/intelligence/diagnostics", json=run_body(other)).status_code == 409
    assert len(calls) == 1


@pytest.mark.parametrize("change", ["case", "report", "hash", "option", "internet", "late_case"])
def test_changed_next_check_rejected_at_actual_run_before_any_probe(client, guidance, monkeypatch, change):
    data, _ = preview(client, guidance); body = run_body(data)
    if change == "case":
        raw = cases.read_all("local"); raw["cases"][0]["symptom"] += " changed"; write_private("local", "cases", raw)
    if change == "report":
        rows = diagnostics.history("local"); rows[0]["scope"] = "changed"; write_private("local", "diagnostics", rows)
    if change == "hash": body["next_check_ref"]["selection_sha256"] = "0" * 64
    if change == "option": body["next_check_ref"]["option_id"] = "network"
    if change == "internet": body["internet"] = True
    if change == "late_case":
        original = N.execution_guard
        def changed(*a, **kw):
            guard = original(*a, **kw)
            raw = cases.read_all("local"); raw["cases"][0]["symptom"] += " late change"; write_private("local", "cases", raw)
            return guard
        monkeypatch.setattr(N, "execution_guard", changed)
    response = client.post("/api/intelligence/diagnostics", json=body)
    assert response.status_code == 409, response.text
    assert not guidance.calls


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("question", ["What did we already try, and did it work?", "What are Study's current CPU and RAM readings?", "Compare the recorded readings with now. What changed?"])
def test_narrow_factual_case_questions_use_actual_routes_without_model(client, guidance, path, question):
    data = result(client.post(path, json={"message": question, "case_ref": selected_ref(guidance)}))
    assert data["handled_by"] == "case_outcome" and not guidance.calls
    assert data["evidence_context"]["interpretation"] == "backend"
    if "try" in question:
        assert "Stutter continued." in data["reply"] and "not recorded as tried" in data["reply"]
    else:
        assert "No current measurements were supplied" in data["reply"]
        assert "[R1]" in data["reply"] and "Recorded host: Study" in data["reply"]


@pytest.mark.parametrize("question", ["Explain three possible causes of the stutter.", "What are another computer's current CPU readings?", "What did we try? Also restart the router.", "Write code to compare CPU readings."])
def test_general_mixed_instruction_and_other_target_questions_are_not_blanket_intercepted(guidance, question):
    from ai.ai_routes import ChatRequest
    prepared = case_context.prepare("local", ChatRequest(message=question, case_ref=selected_ref(guidance)))
    assert "recorded_answer" not in prepared
