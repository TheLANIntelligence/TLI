"""Final route payloads use the same bounded, current-note preparation."""
import json
from types import SimpleNamespace

import pytest
import tli_state as S
from intelligence import memory
from routers import chat_routes as legacy
from tests.test_input_budget_routes import isolated_provider, frames


@pytest.mark.parametrize("path", ["/api/ai/chat", "/api/ai/chat/stream", "/chat"])
def test_prepared_follow_up_reaches_transport_with_current_receipt(path, client, isolated_provider, monkeypatch):
    def post(url, *, json, **kwargs):
        isolated_provider.calls.append(("bundled", json))
        return SimpleNamespace(status_code=200, json=lambda: {"choices": [{"message": {"content": "Synthetic answer"}}]})
    monkeypatch.setattr(legacy.requests, "post", post)
    note = memory.save_fact("local", "Printer fix was changing the USB port.", title="Printer disconnects")
    changed = memory.change("local", note["id"], "Replacing the printer USB cable stopped disconnects.", expected_revision=note["revision"])
    memory.save_fact("local", "Router reset was the solution.", title="Router fix")
    S.save_conversations({"fixture-follow-up": {"id": "fixture-follow-up", "user_id": "local", "messages": [
        {"role": "user", "content": "Why does the printer disconnect?"},
        {"role": "assistant", "content": "The earlier saved note suggested changing the USB port."}]}})
    # A referential follow-up still uses current notes and historical topic.
    # Narrow recorded-completion questions now have a separate deterministic
    # route, covered by test_outcome_chat_routes, and need no model invocation.
    question = "And what about that?"
    response = client.post(path, json={"message": question, "conversation_id": "fixture-follow-up", "max_tokens": 256})
    assert response.status_code == 200, response.text
    result = frames(response)[-1] if path.endswith("/stream") else response.json()
    assert len(isolated_provider.calls) == 1
    payload = isolated_provider.calls[0][1]
    assert payload["messages"][-1] == {"role": "user", "content": question}
    refs = "\n".join(m["content"] for m in payload["messages"][1:] if m["role"] == "system")
    assert changed["text"] in refs and "Router reset" not in refs
    receipt = result.get("memory_context")
    if path.endswith("/stream"):
        receipt = next(f["memory_context"] for f in frames(response) if f.get("memory_context"))
    assert [n["id"] for n in receipt["notes"]] == [note["id"]]
    assert receipt["notes"][0]["revision"] == changed["revision"]
    saved = S.load_conversations()["fixture-follow-up"]["messages"][-1]
    assert saved["memory_context"] == receipt
    assert saved["conversation_context"]["recall_scope"] == {"target_id": None, "standalone_reference": False}
    assert "recall_messages" not in json.dumps(saved)
