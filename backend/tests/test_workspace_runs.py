"""Exercise detached execution, admission identity and owned continuation."""
import json
import threading
import time

import pytest
from fastapi import HTTPException, Request

import host_runs as runs
import tli_state as S
import workspace_events
import workspace_settings
from ai import ai_routes


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "_CONV_KEY", b"c" * 32)
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    monkeypatch.setattr(ai_routes.case_context, "prepare", lambda *a, **k: None)
    monkeypatch.setattr(ai_routes.documents, "prepare", lambda *a, **k: None)
    monkeypatch.setattr(ai_routes.notebook, "prepare", lambda *a, **k: None)
    yield tmp_path
    with runs._lock:
        threads = [run.thread for run in runs._runs.values() if run.thread]
        for run in runs._runs.values():
            run.stop.set()
    for thread in threads:
        thread.join(3)


def request():
    return Request({"type": "http", "scheme": "https", "server": ("192.168.1.10", 8000), "path": "/api/runs", "method": "POST", "headers": []})


def submit(key="a" * 32, **payload):
    return runs.submit("local", request(), request_id=key, kind="chat", payload={"message": "Hello", **payload})[0]


def wait(ident):
    for _ in range(300):
        value = runs.get(ident, "local")
        if value["status"] in runs.TERMINAL:
            return value
        time.sleep(.01)
    pytest.fail("run did not finish")


def stream(monkeypatch, gate=None, count=None):
    def generate(request, message, conv_id, *_args, **_kwargs):
        if count is not None:
            count.append(message)
        yield 'data: ' + json.dumps({"type": "meta", "conversation_id": conv_id, "session_id": conv_id, "provider": "fixture"}) + '\n\n'
        yield 'data: {"type":"delta","text":"Hello "}\n\n'
        if gate:
            assert gate.wait(3)
        from run_context import checkpoint
        checkpoint()
        ai_routes._save_turn(conv_id, "user", message)
        ai_routes._save_turn(conv_id, "assistant", "Hello world", provider="fixture")
        yield 'data: {"type":"delta","text":"world"}\n\n'
        yield 'data: {"type":"done"}\n\n'
    monkeypatch.setattr(ai_routes, "_stream_response", generate)


def test_detached_run_completes_once_and_replays_saved_result(store, monkeypatch):
    count = []
    stream(monkeypatch, count=count)
    first = submit()
    done = wait(first["id"])
    assert done["status"] == "completed" and done["text"] == "Hello world"
    assert submit()["id"] == first["id"] and count == ["Hello"]
    assert runs.get("a" * 32, "local")["id"] == first["id"]
    assert runs.get(first["id"], "local", done["cursor"])["events"] == []
    assert "text" not in runs.listing("local")["runs"][0]
    with runs._lock:
        runs._runs.clear()
    restored = runs.get(first["id"], "local")
    assert restored["result"]["reply"] == "Hello world"
    assert restored["metadata"]["source_ref"]["message_index"] == 1
    assert restored["metadata"]["user_source_ref"]["message_index"] == 0
    # Later exchanges must not replace the original completed run's receipts.
    later = submit("later" * 6, conversation_id=first["conversation_id"])
    wait(later["id"])
    assert runs.get(first["id"], "local")["metadata"]["source_ref"] == restored["metadata"]["source_ref"]
    with pytest.raises(HTTPException) as error:
        runs.get(first["id"], "another-owner")
    assert error.value.status_code == 404


def test_duplicate_payload_conflict_never_executes(store, monkeypatch):
    count = []
    stream(monkeypatch, count=count)
    first = submit()
    wait(first["id"])
    with pytest.raises(HTTPException) as error:
        submit(message="Different request")
    assert error.value.status_code == 409 and count == ["Hello"]


def test_foreign_conversation_is_not_found_while_busy_or_idle(store, monkeypatch):
    monkeypatch.setattr(runs, "operation_access", lambda *_args: lambda: None)
    gate = threading.Event()
    stream(monkeypatch, gate)
    first = submit(conversation_id="conv-private")
    for active in (True, False):
        if not active:
            gate.set()
            assert wait(first["id"])["status"] == "completed"
        with pytest.raises(HTTPException) as error:
            runs.submit("other-owner", request(), request_id="foreign" * 5, kind="chat",
                        payload={"message": "Hello", "conversation_id": "conv-private"})
        assert error.value.status_code == 404
    assert len(runs.listing("local")["runs"]) == 1
    assert not runs.listing("other-owner")["runs"]


@pytest.mark.parametrize("change", ["delete", "owner"])
@pytest.mark.parametrize("cached", [True, False])
def test_terminal_replay_withholds_content_when_conversation_access_is_lost(store, monkeypatch, change, cached):
    count = []
    stream(monkeypatch, count=count)
    first = submit()
    done = wait(first["id"])
    assert done["status"] == "completed" and done["text"] == "Hello world"
    conversations = S.load_conversations()
    if change == "delete":
        conversations.pop(first["conversation_id"])
    else:
        conversations[first["conversation_id"]]["user_id"] = "other-owner"
    S.save_conversations(conversations)
    if not cached:
        with runs._lock:
            runs._runs.clear()
    for value in (runs.get(first["id"], "local"), submit()):
        assert value["status"] == "completed" and value["result_unavailable"]
        assert value["result"] is None and value["text"] == ""
        assert value["metadata"] == {} and value["events"] == []
    assert count == ["Hello"]  # The durable identity still prevents resubmission.
    with pytest.raises(HTTPException) as error:
        runs.get(first["id"], "other-owner")
    assert error.value.status_code == 404


def test_one_active_turn_and_explicit_cancellation(store, monkeypatch):
    gate = threading.Event()
    stream(monkeypatch, gate)
    first = submit(conversation_id="conv-shared")
    with pytest.raises(HTTPException) as error:
        submit("b" * 32, conversation_id="conv-shared")
    assert error.value.status_code == 409
    with pytest.raises(HTTPException):
        workspace_settings.update("conv-shared", "local", None, 0)
    runs.cancel(first["id"], "local")
    gate.set()
    assert wait(first["id"])["status"] == "cancelled"
    assert S.load_conversations()["conv-shared"]["messages"] == []


def test_revocation_stops_remaining_work(store, monkeypatch):
    gate = threading.Event()
    stream(monkeypatch, gate)
    first = submit()
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    gate.set()
    assert wait(first["id"])["status"] == "failed"
    assert not S.load_conversations()[first["conversation_id"]]["messages"]


def test_restart_marks_accepted_work_interrupted_without_dispatch(store):
    path = store / "workspace" / "runs.json"
    path.parent.mkdir()
    path.write_text(json.dumps({"version": 1, "runs": {"run_old": {"id": "run_old", "owner": "local", "request_id": "x" * 32, "digest": "d", "kind": "chat", "status": "running", "created_at": "2026"}}}))
    assert runs.get("run_old", "local")["status"] == "interrupted"
    assert not runs._runs


def test_unreadable_journal_fails_closed(store, monkeypatch):
    path = store / "workspace" / "runs.json"
    path.parent.mkdir()
    path.write_text("broken")
    with pytest.raises(HTTPException) as error:
        submit()
    assert error.value.status_code == 503 and path.read_text() == "broken"


def test_nonfinite_payload_never_creates_a_journal_or_dispatches(store):
    with pytest.raises(HTTPException) as error:
        submit(temperature=float('nan'))
    assert error.value.status_code == 422 and not (store / 'workspace' / 'runs.json').exists()


def test_settings_revision_and_owner_boundaries(store):
    workspace_settings.prepare("conv-one", "local", {"message": "Hi"})
    assert workspace_settings.get("conv-one", "local")["compute_selection"] is None
    assert workspace_settings.update("conv-one", "local", None, 0)["settings_revision"] == 1
    with pytest.raises(HTTPException) as error:
        workspace_settings.update("conv-one", "local", None, 0)
    assert error.value.status_code == 409
    with pytest.raises(HTTPException):
        workspace_settings.get("conv-one", "another-owner")


def test_stale_compute_choice_never_dispatches(store, monkeypatch):
    saved = {"peer_id": "trusted", "trust_revision": "a" * 64, "resource_id": "b" * 64, "resource_revision": "c" * 64}
    import lan_inference
    monkeypatch.setattr(lan_inference, "selection", lambda value: value)
    workspace_settings.prepare("conv-one", "local", {"message": "Hi", "lan_inference": saved})
    with pytest.raises(HTTPException) as error:
        submit(conversation_id="conv-one", lan_inference=None)
    assert error.value.status_code == 409


def test_invalidations_never_include_other_owners_or_content(store):
    before = workspace_events.snapshot("local")
    workspace_events.publish("other", "notes", "secret-note")
    workspace_events.publish("local", "conversation", "conv-one")
    events = workspace_events.snapshot("local", before["cursor"], before["epoch"])
    assert events["events"] == [{"id": events["cursor"], "kind": "conversation", "resource_id": "conv-one"}]
    assert not events["reset"]


def test_phone_browser_uses_full_workspace_and_preserves_legacy(client):
    response = client.get("/", headers={"User-Agent": "Android Mobile"})
    assert 'id="chat-lan-inference"' in response.text
    legacy = client.get("/companion/legacy")
    assert "/js/companion.js" in legacy.text
    assert client.get("/manifest.json").json()["start_url"] == "/"


def test_builder_run_continues_and_cancelled_creation_keeps_recovery_project(store, monkeypatch):
    from builder import receipts, llm_client, web_apps
    from tests.test_builder_web_apps import bundle
    monkeypatch.setattr(receipts, "BUILDER_DIR", store / "builder")
    monkeypatch.setattr(receipts, "STATE_PATH", store / "state.json")
    monkeypatch.setattr(receipts, "RECEIPTS_PATH", store / "receipts.json")
    count, gate = [], threading.Event()
    def complete(*args):
        count.append(1)
        assert gate.wait(3)
        return json.dumps(bundle()), "fixture"
    monkeypatch.setattr(llm_client, "_chat", complete)
    first, _ = runs.submit("local", request(), request_id="build" * 8, kind="builder_create", payload={"brief": "Build a counter"})
    gate.set()
    done = wait(first["id"])
    assert done["status"] == "completed"
    again, created = runs.submit("local", request(), request_id="build" * 8, kind="builder_create", payload={"brief": "Build a counter"})
    assert not created and again["id"] == done["id"] and count == [1]
    gate.clear()
    second, _ = runs.submit("local", request(), request_id="cancel" * 6, kind="builder_create", payload={"brief": "Build another counter"})
    for _ in range(100):
        if runs.get(second["id"], "local").get("app_id"):
            break
        time.sleep(.01)
    runs.cancel(second["id"], "local"); gate.set()
    stopped = wait(second["id"])
    assert stopped["status"] == "cancelled" and stopped["app_id"]
    recovery = web_apps.get_app(stopped["app_id"], owner="local")
    assert recovery["status"] == "needs_retry" and not recovery["revisions"]
