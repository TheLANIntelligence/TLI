"""Real JSON/SSE route contracts over encrypted synthetic report stores."""
import json
from types import SimpleNamespace

import pytest

import tli_state as S
from ai import ai_routes as bundled
from routers import chat_routes as legacy
from intelligence import context, diagnostics, memory, observed_answers, chat_continuity
from intelligence.store import write_private

PATHS = ["/api/ai/chat", "/api/ai/chat/stream", "/chat"]


def saved_report():
    return {"id": "owned-report", "created_at": "2026-09-01T12:00:00Z", "kind": "device",
            "host": {"id": "fixture-host", "name": "Study"}, "target": {"id": "printer-7", "name": "Office printer"},
            "checks": [{"id": "tcp_9100", "label": "Service reachability", "status": "pass", "detail": "Port reachable"}],
            "verified_fix": None, "scope": "TCP reachability from Study to Office printer, not physical printing."}


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="fixture-host", node_name="Study", role="standalone", host_address=None))
    monkeypatch.setattr(context.devices, "node", lambda: {"id": "fixture-host", "name": "Study"})
    monkeypatch.setattr(context.devices, "get", lambda ident: {"id": ident, "name": "Fixture target"})
    def forbidden(*a, **kw):
        pytest.fail("A recorded-outcome answer cannot run checks, actions, inference or implicit retrieval")
    for obj, names in [
        (bundled, ("_route_action_intent", "_tool_answer", "_llama_post", "_llama_stream_raw", "diagnostic_answer", "_find_mesh_ai_peer")),
        (legacy, ("diagnostic_answer", "choose_model", "proxy_chat_to_host")),
        (diagnostics, ("run",)), (memory, ("relevant",)), (chat_continuity, ("history",)),
        (observed_answers, ("answer",)), (S.lm_provider, ("complete", "health_check"))]:
        for name in names:
            monkeypatch.setattr(obj, name, forbidden)
    monkeypatch.setattr(bundled.BundledAIManager, "get", lambda: SimpleNamespace(ensure_running=forbidden))
    write_private("local", "diagnostics", [saved_report()])


def result(response):
    assert response.status_code == 200, response.text
    if "text/event-stream" not in response.headers.get("content-type", ""):
        return response.json()
    frames = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
    assert frames[-1]["type"] == "done", frames
    data = {}
    for frame in frames:
        if frame["type"] == "meta":
            data.update(frame)
    data["reply"] = "".join(frame["text"] for frame in frames if frame["type"] == "delta")
    return data


@pytest.mark.parametrize("path", PATHS)
def test_selected_report_answer_is_factual_and_persisted_without_model_or_action(path, client, isolated):
    response = client.post(path, json={"message": "Did the test print?", "diagnostic_id": "owned-report", "brain": "lmstudio", "use_saved_memory": False})
    data = result(response)
    assert data["handled_by"] == "recorded_outcome"
    assert "does not establish that a print job was submitted, physically printed" in data["reply"]
    assert "1 passed" in data["reply"]
    assert data["evidence_context"]["interpretation"] == "backend"
    source = data["evidence_context"]["sources"][0]
    assert source["kind"] == "report" and source["id"] == "owned-report"
    assert source["observed_at"] == "2026-09-01T12:00:00Z" and source["target_id"] == "printer-7"
    assert data.get("observation_context") is None
    stored = next(iter(S.load_conversations().values()))["messages"][-1]
    assert stored["evidence_context"] == data["evidence_context"]
    assert stored["memory_context"]["status"] == "disabled"
    assert stored["content"] == data["reply"] and stored["provider"] == "tli-records"
    assert "observation_context" not in stored


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("enabled", [True, False])
def test_previous_assistant_claim_and_omitted_memory_do_not_supply_a_fix(path, enabled, client, isolated):
    S.save_conversations({"history": {"id": "history", "user_id": "local", "messages": [
        {"role": "user", "content": "Printer disconnects"},
        {"role": "assistant", "content": "I replaced your USB cable and it worked.", "memory_context": {
            "use_saved_memory": True, "status": "included", "notes": [{"id": "deleted-note", "title": "Cable", "source": "chat_ai", "category": "general", "revision": "a" * 64}], "omitted_for_budget": 0}}]}})
    data = result(client.post(path, json={"message": "What fixed it last time?", "conversation_id": "history",
                                        "use_saved_memory": enabled, "use_conversation_history": enabled, "brain": "lmstudio"}))
    assert data["handled_by"] == "recorded_outcome"
    assert "No recorded completion or confirmed repair outcome was supplied" in data["reply"]
    assert "USB cable" not in data["reply"]
    assert data["evidence_context"]["sources"] == []
    assert data["memory_context"]["status"] == ("none" if enabled else "disabled")
    assert data["conversation_context"]["status"] == ("none" if enabled else "disabled")
    assert S.load_conversations()["history"]["messages"][1]["content"] == "I replaced your USB cable and it worked."


@pytest.mark.parametrize("path", PATHS)
def test_other_account_report_cannot_be_selected_even_with_forged_body_user(path, client, isolated):
    hidden = saved_report()
    hidden["id"] = "other-report"
    hidden["verified_fix"] = {"source": "user_confirmation", "confirmed_at": "2026-09-02T12:00:00Z", "text": "Private other-owner repair marker"}
    write_private("other-owner", "diagnostics", [hidden])
    response = client.post(path, json={"message": "What fixed it last time?", "diagnostic_id": "other-report", "user_id": "other-owner"})
    assert response.status_code == 404, response.text
    assert "Private other-owner" not in response.text
    assert all(m.get("role") != "assistant" for row in S.load_conversations().values() for m in row.get("messages", []))


@pytest.mark.parametrize("path", PATHS)
def test_explicit_wrong_target_is_rejected_without_actions_or_answer(path, client, isolated):
    response = client.post(path, json={"message": "Did the test print?", "diagnostic_id": "owned-report", "target_id": "printer-other"})
    assert response.status_code == 422, response.text
    assert "different computer or device" in response.text


@pytest.mark.parametrize("path", PATHS)
def test_user_confirmed_fix_stays_attributed_to_user(path, client, isolated):
    saved = saved_report()
    saved["verified_fix"] = {"source": "user_confirmation", "confirmed_at": "2026-09-02T12:00:00Z", "text": "Switched to the rear USB port."}
    write_private("local", "diagnostics", [saved])
    data = result(client.post(path, json={"message": "What fixed it last time?", "diagnostic_id": "owned-report"}))
    assert "The user recorded this confirmation at 2026-09-02T12:00:00Z" in data["reply"]
    assert "Switched to the rear USB port." in data["reply"]
    assert "not an independent test" in data["reply"]
    assert "rear USB" not in json.dumps(data["evidence_context"])


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("reference", ["documents", "notes"])
def test_explicit_reference_route_precedes_factual_shortcut(path, reference, client, isolated, monkeypatch):
    body = {"message": "What fixed it last time?"}
    if reference == "documents":
        body["documents"] = [{"name": "fix.txt", "text": "The user reports replacing the USB cable."}]
    else:
        fact = memory.save_fact("local", "The user reports replacing the USB cable.", title="Selected fix")
        body["note_refs"] = [{"id": fact["id"], "revision": fact["revision"]}]
    monkeypatch.setattr(chat_continuity, "recorded_outcome", lambda *a, **kw: pytest.fail("Explicit standalone references keep precedence"))
    calls = []
    monkeypatch.setattr(bundled.BundledAIManager, "get", lambda: SimpleNamespace(ensure_running=lambda: True, active_preset_id="standard", base_url="http://127.0.0.1:19999"))
    monkeypatch.setattr(bundled, "_llama_post", lambda *a, **kw: calls.append("bundled") or {"choices": [{"message": {"content": "Selected reference answer"}}]})
    def stream(*a, **kw):
        calls.append("bundled")
        yield json.dumps({"choices": [{"delta": {"content": "Selected reference answer"}}]})
    monkeypatch.setattr(bundled, "_llama_stream_raw", stream)
    monkeypatch.setattr(legacy, "choose_model", lambda *a, **kw: {"id": "fixture-lm"})
    monkeypatch.setattr(S.lm_provider, "health_check", lambda: True)
    monkeypatch.setattr(S.lm_provider, "complete", lambda **kw: calls.append("lmstudio") or {"text": "Selected reference answer", "model": "fixture-lm"})
    data = result(client.post(path, json=body))
    assert data["handled_by"] != "recorded_outcome"
    assert data.get("document_context" if reference == "documents" else "note_context")
    assert len(calls) == 1


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("status,count", [("partial", 7), ("completed", 30)])
def test_actual_report_backed_performance_completion_through_all_routes(path, status, count, client, isolated):
    from intelligence.outcome_answers import PERFORMANCE_METRICS
    saved = saved_report()
    saved.update(kind="performance", target=None, scope="Study host and selected Render process only.")
    saved["performance"] = {"schema_version": 1, "observation_id": "observation-1", "status": status,
        "process": {"pid": 42, "create_time": 1788250000.25, "name": "Render", "exe": "C:\\Render.exe"},
        "started_at": "2026-09-01T12:00:00Z", "finished_at": "2026-09-01T12:00:30Z",
        "sample_count": count, "expected_samples": 30, "samples": [{key: 20 for key in PERFORMANCE_METRICS} for _ in range(count)],
        "summary": {key: {"min": 20, "max": 20, "mean": 20, "samples": count} for key in PERFORMANCE_METRICS}}
    write_private("local", "diagnostics", [saved])
    data = result(client.post(path, json={"message": "Did you finish measuring Render, and is it fixed?", "diagnostic_id": "owned-report"}))
    assert data["handled_by"] == "recorded_outcome"
    assert f"{count} of 30 planned samples" in data["reply"]
    assert ("completed its planned sampling" if status == "completed" else "**partial**") in data["reply"]
    assert "does not record whether the application's own task finished" in data["reply"]
    assert "no admissible user-confirmed repair outcome" in data["reply"]
    assert "PID 42, process start 1788250000.25" in data["reply"]


def test_legacy_get_stream_can_answer_missing_outcome_without_an_inference_start(client, isolated):
    data = result(client.get("/api/ai/chat/stream", params={"message": "What fixed it last time?", "use_saved_memory": "false"}))
    assert data["handled_by"] == "recorded_outcome"
    assert data["evidence_context"]["sources"] == []


@pytest.mark.parametrize("path", PATHS)
def test_missing_memory_key_for_existing_report_is_an_error_not_no_outcome(path, client, isolated, monkeypatch):
    # Read the synthetic report through the actual reader, with its protected
    # key unavailable; a privacy-store failure must not become an empty answer.
    original = S._store_key
    def key(name, **kwargs):
        if name == "memory_key.bin":
            raise ValueError("fixture key unavailable")
        return original(name, **kwargs)
    monkeypatch.setattr(S, "_store_key", key)
    response = client.post(path, json={"message": "Did the test print?", "diagnostic_id": "owned-report"})
    assert response.status_code == 503, response.text
    assert "No recorded completion" not in response.text
