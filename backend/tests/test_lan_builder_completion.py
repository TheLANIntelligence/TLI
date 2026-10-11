"""LAN Builder completion consumes only finished bounded text from reviewed peers."""
import copy
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import lan_inference as inference
import tli_state as S
from ai.lan_chat import Selection
from builder import lan_compute, llm_client


PEER = {"id": "gaming-pc", "name": "Gaming PC"}
MODEL = "synthetic-coder"
CHOICE = {"peer_id": PEER["id"], "trust_revision": "a" * 64,
          "resource_id": inference._resource_id("lmstudio", MODEL), "resource_revision": "b" * 64}
META = {"type": "meta", "protocol": inference.PROTOCOL, "peer": PEER, "model": MODEL,
        "provider": "lmstudio", "identity_fingerprint": "c" * 64,
        "resource_id": CHOICE["resource_id"], "resource_revision": CHOICE["resource_revision"]}
MESSAGES = [{"role": "system", "content": "Create a bounded self-contained app."},
            {"role": "user", "content": json.dumps({"brief": "A local counter", "requested_changes_or_failures": ""})}]


@pytest.fixture
def compute(monkeypatch):
    state = SimpleNamespace(selections=[], calls=[], closed=0, checked=0, revoked=False,
                            events=[META, {"type": "delta", "text": ' {"files":'}, {"type": "delta", "text": "{}} "}, {"type": "done"}])
    def check():
        state.checked += 1
        if state.revoked:
            raise HTTPException(401, "Original browser access was revoked.")
    def select(value):
        state.selections.append(copy.deepcopy(value))
        assert value == CHOICE
        return {**value, "peer": copy.deepcopy(PEER)}
    def stream(selected, messages, **options):
        state.calls.append({"selected": copy.deepcopy(selected), "messages": copy.deepcopy(messages), **options})
        try:
            for event in state.events:
                if callable(event):
                    event()
                else:
                    yield copy.deepcopy(event)
        finally:
            state.closed += 1
    monkeypatch.setattr(inference, "selection", select)
    monkeypatch.setattr(inference, "stream", stream)
    monkeypatch.setattr(llm_client, "_chat", lambda *args: pytest.fail("No local completion fallback is permitted"))
    state.check = check
    state.bind = lambda **kw: lan_compute.completion(Selection(**CHOICE), check=check, **kw)
    return state


def test_complete_output_has_bound_identity_and_lan_provenance(compute):
    complete = compute.bind()
    assert compute.calls == []  # binding does not run a model
    result, provenance = complete(MESSAGES, 0.15, 6000)
    assert result == '{"files":{}}'
    assert provenance == "LAN · Gaming PC (gaming-pc) · lmstudio/synthetic-coder"
    assert compute.calls[0]["max_tokens"] == inference.MAX_TOKENS
    assert compute.calls[0]["messages"] == MESSAGES
    assert compute.closed == 1 and compute.checked >= len(compute.events) + 4


def test_selection_is_snapshotted_and_revalidated_each_generation(compute):
    choice = Selection(**CHOICE)
    complete = lan_compute.completion(choice, check=compute.check)
    choice.peer_id = "other-computer"
    complete(MESSAGES, 0.15, 1000)
    complete(MESSAGES, 0.15, 500)
    assert len(compute.selections) == 3
    assert [call["max_tokens"] for call in compute.calls] == [1000, 500]
    assert compute.closed == 2


@pytest.mark.parametrize("events", [
    [META, {"type": "delta", "text": "partial"}],
    [META, {"type": "done"}],
    [META, {"type": "delta", "text": "   "}, {"type": "done"}],
    [{"type": "delta", "text": "before identity"}, META, {"type": "done"}],
    [META, META, {"type": "done"}],
    [META, {"type": "error", "message": "failed"}],
    [META, {"type": "tool_call", "name": "shell", "arguments": "do something"}],
    [META, {"type": "delta", "text": "ok", "tool_calls": [{"name": "shell"}]}],
    [META, {"type": "delta", "text": "ok"}, {"type": "done", "executed": True}],
    [META, {"type": "delta", "text": {"arbitrary": "object"}}],
    [META, {"type": "delta", "text": "\ud800"}],
    [META, {"type": "delta", "text": "x" * (inference.MAX_OUTPUT + 1)}],
    [META, {"type": "delta", "text": "é" * (inference.MAX_OUTPUT // 2 + 1)}],
    [None],
])
def test_partial_empty_malformed_or_unbounded_stream_never_returns_artifact(compute, events):
    compute.events = events
    with pytest.raises(llm_client.ModelOffline):
        compute.bind()(MESSAGES, 0.15, 6000)
    assert compute.closed == 1 and len(compute.calls) == 1


@pytest.mark.parametrize("patch", [
    {"peer": {"id": "wrong", "name": "Other"}}, {"resource_id": "d" * 64},
    {"resource_revision": "d" * 64}, {"model": "unselected-model"}, {"provider": "cloud"},
    {"model": "bad\nmodel"}, {"identity_fingerprint": "not-a-hash"}, {"protocol": "unsupported"},
])
def test_model_identity_is_checked_again_at_builder_boundary(compute, patch):
    compute.events = [{**META, **patch}, {"type": "delta", "text": "untrusted"}, {"type": "done"}]
    with pytest.raises(llm_client.ModelOffline, match="identity"):
        compute.bind()(MESSAGES, 0.15, 6000)
    assert compute.closed == 1


def test_revoked_operation_aborts_before_any_selection_or_model_call(compute):
    compute.revoked = True
    with pytest.raises(HTTPException) as error:
        compute.bind()
    assert error.value.status_code == 401
    assert compute.selections == [] and compute.calls == []


@pytest.mark.parametrize("stage", [0, 1, 2])
def test_authentication_is_rechecked_during_stream_and_at_completion(compute, stage):
    expire = lambda: setattr(compute, "revoked", True)
    compute.events = [META, {"type": "delta", "text": "uncommitted"}, {"type": "done"}]
    compute.events.insert(stage, expire)
    with pytest.raises(HTTPException) as error:
        compute.bind()(MESSAGES, 0.15, 6000)
    assert error.value.status_code == 401
    assert compute.closed == 1 and len(compute.calls) == 1


def test_existing_source_requires_explicit_opt_in_and_never_reads_project_files(compute):
    messages = copy.deepcopy(MESSAGES)
    content = json.loads(messages[-1]["content"])
    content["previous_files"] = {"index.html": "private old source"}
    messages[-1]["content"] = json.dumps(content)
    with pytest.raises(ValueError, match="explicitly allow"):
        compute.bind()(messages, 0.15, 6000)
    assert compute.calls == []
    assert compute.bind(allow_existing_source=True)(messages, 0.15, 6000)[0] == '{"files":{}}'
    assert compute.calls[0]["messages"][-1]["content"] == messages[-1]["content"]


def test_validation_repair_can_include_this_jobs_generated_text_without_source_opt_in(compute):
    messages = copy.deepcopy(MESSAGES) + [{"role": "assistant", "content": '{"files":{}}'},
                                         {"role": "user", "content": "Repair missing required files."}]
    assert compute.bind()(messages, 0.15, 6000)[0] == '{"files":{}}'
    assert compute.calls[0]["messages"] == messages


@pytest.mark.parametrize("messages,tokens,temperature", [
    ([{"role": "tool", "content": "output"}], 100, 0.1),
    ([{"role": "user", "content": [{"type": "image", "url": "x"}]}], 100, 0.1),
    ([{"role": "user", "content": "x", "tools": []}], 100, 0.1),
    ([], 100, 0.1), (MESSAGES, 0, 0.1), (MESSAGES, True, 0.1),
    (MESSAGES, 100, float("nan")), (MESSAGES, 100, 3),
    ([{"role": "user", "content": "x" * 140_000}], 100, 0.1),
])
def test_invalid_input_is_not_shortened_or_sent(compute, messages, tokens, temperature):
    with pytest.raises(ValueError):
        compute.bind()(messages, temperature, tokens)
    assert compute.calls == []


def test_trust_change_between_attempts_does_not_trigger_fallback(compute, monkeypatch):
    complete = compute.bind()
    monkeypatch.setattr(inference, "selection", lambda value: (_ for _ in ()).throw(HTTPException(409, {"message": "Reviewed identity changed."})))
    with pytest.raises(llm_client.ModelOffline, match="identity changed"):
        complete(MESSAGES, 0.15, 6000)
    assert compute.calls == []


def test_transport_exception_closes_stream_and_produces_no_partial_source(compute):
    def fail():
        raise TimeoutError("synthetic")
    compute.events = [META, {"type": "delta", "text": "incomplete"}, fail]
    with pytest.raises(llm_client.ModelOffline, match="No transport retry"):
        compute.bind()(MESSAGES, 0.15, 6000)
    assert compute.closed == 1 and len(compute.calls) == 1


def test_too_many_events_is_bounded_even_when_text_is_empty(compute):
    compute.events = [META] + [{"type": "delta", "text": ""}] * 8192 + [{"type": "done"}]
    with pytest.raises(llm_client.ModelOffline, match="event sequence"):
        compute.bind()(MESSAGES, 0.15, 6000)
    assert compute.closed == 1


def app_bundle():
    return {"name": "Greeting", "summary": "A local greeting", "files": {
        "index.html": '<html><head><link rel="stylesheet" href="style.css"></head><body><main><p id="hello">Hello</p></main><script src="app.js"></script></body></html>',
        "style.css": "body { font-family: system-ui; }", "app.js": "// No external resources."},
        "checks": [{"name": "Greeting appears", "steps": [{"action": "text", "selector": "#hello", "contains": "Hello"}]}],
        "manual_checks": ["Read the greeting on a narrow screen."]}


def test_builder_keeps_completed_lan_revision_and_preserves_it_after_interruption(compute, monkeypatch, tmp_path):
    from builder import receipts, web_apps
    monkeypatch.setattr(receipts, "BUILDER_DIR", tmp_path / "builder")
    bundle = app_bundle()
    compute.events = [META, {"type": "delta", "text": json.dumps(bundle)}, {"type": "done"}]
    project = web_apps.generate_app("Show a greeting", owner="alice", complete=compute.bind())
    assert project["status"] == "ready_for_preview"
    original = copy.deepcopy(project["revisions"])
    assert original[0]["backend"].startswith("LAN · Gaming PC")
    assert original[0]["files"] == bundle["files"]
    compute.events = [META, {"type": "delta", "text": "truncated revision"}]
    failed = web_apps.generate_app(app_id=project["id"], expected_revision=1, feedback="Make the greeting friendlier",
                                   owner="alice", complete=compute.bind(allow_existing_source=True))
    assert failed["status"] == "needs_retry" and failed["revisions"] == original
    assert web_apps.get_app(project["id"], owner="alice")["revisions"] == original
    assert len(compute.calls) == 2 and compute.closed == 2


@pytest.fixture
def lan_route(compute, app, monkeypatch, tmp_path):
    from builder import receipts
    monkeypatch.setattr(receipts, "BUILDER_DIR", tmp_path / "builder")
    monkeypatch.setattr(receipts, "STATE_PATH", tmp_path / "builder-state.json")
    monkeypatch.setattr(receipts, "RECEIPTS_PATH", tmp_path / "builder-receipts.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    receipts.save_state({"permission_level": "ask"})
    compute.token = S.create_session_token("alice")
    compute.client = TestClient(app, base_url="https://tli.invalid")
    compute.client.headers["Cookie"] = "tli_session=" + compute.token
    compute.events = [META, {"type": "delta", "text": json.dumps(app_bundle())}, {"type": "done"}]
    return compute


def test_router_create_and_explicit_lan_revision_keep_owner_source_scope_and_provenance(lan_route):
    from builder import web_apps
    created = lan_route.client.post("/api/builder/web-apps", json={"brief": "Build a greeting", "lan_inference": CHOICE})
    assert created.status_code == 200, created.text
    assert created.headers["cache-control"] == "no-store"
    project = created.json()["project"]
    assert project["status"] == "ready_for_preview"
    assert project["revisions"][0]["backend"] == "LAN · Gaming PC (gaming-pc) · lmstudio/synthetic-coder"
    first_prompt = json.loads(lan_route.calls[0]["messages"][1]["content"])
    assert first_prompt == {"brief": "Build a greeting", "requested_changes_or_failures": ""}
    changed = lan_route.client.post(f"/api/builder/web-apps/{project['id']}/revise", json={
        "feedback": "Make the greeting friendlier", "expected_revision": 1, "lan_inference": CHOICE})
    assert changed.status_code == 200, changed.text
    revised = changed.json()["project"]
    assert len(revised["revisions"]) == 2
    repair_prompt = json.loads(lan_route.calls[1]["messages"][1]["content"])
    assert repair_prompt["previous_files"] == project["revisions"][0]["files"]
    assert repair_prompt["requested_changes_or_failures"] == "Make the greeting friendlier"
    assert web_apps.get_app(project["id"], owner="alice") == revised
    assert web_apps.list_apps(owner="bob") == []
    assert len(lan_route.calls) == 2 and lan_route.closed == 2


def test_router_unrelated_account_cannot_read_or_forward_another_owners_source(lan_route, monkeypatch):
    from builder import web_apps
    created = lan_route.client.post("/api/builder/web-apps", json={"brief": "Alice private app", "lan_inference": CHOICE}).json()["project"]
    real_get = web_apps.get_app
    reads = []
    def owner_read(app_id, *, owner):
        reads.append(owner)
        return real_get(app_id, owner=owner)
    monkeypatch.setattr(web_apps, "get_app", owner_read)
    lan_route.client.headers["Cookie"] = "tli_session=" + S.create_session_token("bob")
    denied_read = lan_route.client.get(f"/api/builder/web-apps/{created['id']}")
    assert denied_read.status_code == 404
    denied_repair = lan_route.client.post(f"/api/builder/web-apps/{created['id']}/revise", json={
        "feedback": "Expose old source", "expected_revision": 1, "lan_inference": CHOICE})
    assert denied_repair.status_code == 400
    assert reads == ["bob", "bob"]
    assert len(lan_route.calls) == 1
    assert real_get(created["id"], owner="alice")["revisions"] == created["revisions"]


@pytest.mark.parametrize("revise", [False, True])
def test_router_original_cookie_revocation_discards_complete_text_before_done(lan_route, revise):
    from builder import web_apps
    original = None
    if revise:
        response = lan_route.client.post("/api/builder/web-apps", json={"brief": "Owner app", "lan_inference": CHOICE})
        original = response.json()["project"]
    # Even an entire valid JSON object is uncommitted until done is received
    # with the original request's authority still intact.
    lan_route.events = [META, {"type": "delta", "text": json.dumps(app_bundle())},
                        lambda: S._active_sessions.pop(lan_route.token, None), {"type": "done"}]
    path = f"/api/builder/web-apps/{original['id']}/revise" if original else "/api/builder/web-apps"
    payload = {"feedback": "A private improvement", "expected_revision": 1} if original else {"brief": "Aborted app"}
    response = lan_route.client.post(path, json={**payload, "lan_inference": CHOICE})
    assert response.status_code == 401, response.text
    project_id = original["id"] if original else web_apps.list_apps(owner="alice")[0]["id"]
    saved = web_apps.get_app(project_id, owner="alice")
    assert saved["status"] == "needs_retry"
    assert saved["revisions"] == (original["revisions"] if original else [])
    assert len(lan_route.calls) == (2 if revise else 1)
    assert lan_route.closed == len(lan_route.calls)


def test_router_missing_or_invalid_session_cannot_admit_lan_generation(lan_route):
    for cookie in (None, "tli_session=revoked"):
        if cookie is None:
            lan_route.client.headers.pop("Cookie", None)
        else:
            lan_route.client.headers["Cookie"] = cookie
        response = lan_route.client.post("/api/builder/web-apps", json={"brief": "No access", "lan_inference": CHOICE})
        assert response.status_code == 401
    assert lan_route.selections == [] and lan_route.calls == []
