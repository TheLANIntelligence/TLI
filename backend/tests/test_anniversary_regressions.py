import json
from pathlib import Path

from fastapi.testclient import TestClient
from routers import dashboard_presence as dp
from ai import ai_routes, ai_manager
import event_bus
import tli_state as S


def test_installation_and_legacy_stores_are_isolated():
    import os
    import vault_security
    repo = Path(__file__).resolve().parents[2]
    assert not Path(S.DATA_DIR).resolve().is_relative_to(repo)
    assert not Path(vault_security.VAULT_META_PATH).resolve().is_relative_to(repo)
    assert not ai_manager.get_models_dir().resolve().is_relative_to(repo)
    assert Path(os.environ["TLI_ROOT"]).resolve() == Path.cwd()


def test_repeated_startup_shutdown_owns_one_poller_and_one_hook(app, monkeypatch):
    monkeypatch.setattr(dp, "_probe_metrics", lambda: {"cpu_pct": 10, "ram_pct": 20, "disk_pct_by_drive": {"/": 30}})
    monkeypatch.setattr(dp, "_score_disk_actions", lambda _: None)
    monkeypatch.setattr(event_bus, "_post_emit_hooks", [])
    for _ in range(2):
        with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 40000)) as client:
            assert client.get("/dashboard/state").status_code == 200
            assert dp._poller_thread.is_alive()
            original = dp._poller_thread
            dp.start_polling()
            assert dp._poller_thread is original
            assert event_bus._post_emit_hooks.count(dp.on_event) == 1
        assert not dp._poller_thread.is_alive()
        assert dp.on_event not in event_bus._post_emit_hooks
        assert event_bus._loop is None


def test_chat_stream_contract_and_history(client, monkeypatch):
    monkeypatch.setattr(ai_manager.BundledAIManager, "ensure_running", lambda self: True)
    monkeypatch.setattr(ai_routes, "_should_prefer_mesh", lambda: False)
    monkeypatch.setattr(ai_routes, "_route_action_intent", lambda *a: None)
    monkeypatch.setattr(ai_routes, "_tool_answer", lambda *a: None)
    monkeypatch.setattr(ai_routes, "_build_system_prompt", lambda **kw: "You are TLI.")
    def stream(*args, **kwargs):
        assert kwargs.get("allow_redirects") is False
        for text in ("Hello", " from TLI"):
            yield json.dumps({"choices": [{"delta": {"content": text}}]})
    monkeypatch.setattr(ai_routes, "_llama_stream_raw", stream)
    res = client.post("/api/ai/chat/stream", json={"message": "hello"})
    assert res.status_code == 200
    events = [json.loads(line[6:]) for line in res.text.splitlines() if line.startswith("data: ")]
    assert [e["type"] for e in events] == ["meta", "delta", "delta", "meta", "done"]
    assert "".join(e.get("text", "") for e in events) == "Hello from TLI"
    ident = events[0]["session_id"]
    conv = S.load_conversations()[ident]
    assert conv["messages"][-1]["content"] == "Hello from TLI"
    # Only completed, saved replies receive claims about final provider input.
    assert "memory_context" not in events[0] and "source_ref" not in events[0]
    completed = events[-2]
    from intelligence import context, chat_memory
    assert context.public_memory_receipt(completed["memory_context"]) == completed["memory_context"]
    assert context.public_conversation_receipt(completed["conversation_context"]) == completed["conversation_context"]
    assert completed["memory_context"] == conv["messages"][-1]["memory_context"]
    assert completed["conversation_context"] == conv["messages"][-1]["conversation_context"]
    assert completed["source_ref"] == chat_memory.source_ref(ident, 1, conv["messages"][1])
    assert completed["user_source_ref"] == chat_memory.source_ref(ident, 0, conv["messages"][0])


def test_no_model_degrades_without_disabling_dashboard(browser_client, monkeypatch):
    monkeypatch.setattr(ai_routes, "_find_mesh_ai_peer", lambda: None)
    res = browser_client.post("/api/ai/chat/stream", json={"message": "hello"})
    assert '"type": "error"' in res.text
    assert browser_client.get("/dashboard/state").status_code == 200


def test_memory_encryption_and_existing_json_formats_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    S.add_fact("anniversary-user", "Office printer is upstairs", device_id="printer")
    path = Path(S.memory_path_for_user("anniversary-user"))
    assert "Office printer" not in path.read_text()
    assert S.load_memory("anniversary-user")["facts"][0]["text"] == "Office printer is upstairs"
    registry = [{"name": "Lamp", "ip": "192.168.1.10", "relay": 1}]
    from device_resolution import resolve
    path = tmp_path / "shelly.json"
    path.write_text(json.dumps(registry))
    before = path.read_bytes()
    assert resolve("Lamp", json.loads(path.read_text())).device["relay"] == 1
    assert path.read_bytes() == before


def test_previous_actions_reader_can_read_current_files(tmp_path, monkeypatch):
    """Exercise the pinned previous file reader, independently of current HEAD."""
    import hashlib
    import types
    from routers import actions_engine as actions
    fixture = Path(__file__).with_name("fixtures") / "actions_reader_a5f2104.py"
    source = fixture.read_text(encoding="utf-8")
    assert hashlib.sha256(source.encode("utf-8")).hexdigest() == "41ee5ae91da35966367922a0d24584aa0ef47d1e8b69391e0d6eaaf9ae78acdf"
    legacy = types.ModuleType("anniversary_legacy_actions")
    exec(compile(source, str(fixture), "exec"), legacy.__dict__)
    legacy.init_actions_engine(data_dir=tmp_path, shelly_registry_path=tmp_path / "shelly.json",
                               shelly_driver=None, log_debug=None)
    monkeypatch.setattr(actions, "_CTX", {**actions._CTX, "data_dir": tmp_path})
    path, receipts_path = actions._paths()
    original = {"actions": [{"id": "saved", "name": "Existing action", "steps": [],
                             "enabled": False, "custom": {"note": "Keep compatible metadata"}}],
                "triggers": [{"id": "saved-trigger", "action_id": "saved", "enabled": False}],
                "custom": {"source": "existing installation"}}
    actions._save_json(path, original)
    before = path.read_bytes()
    receipts = [
        {"ts": S.now_iso(), "kind": "action_run", "ok": False,
         "summary": "Failed action", "results": [{"ok": False}], "custom": {"retained": True}},
        {"ts": S.now_iso(), "kind": "action_run", "ok": True,
         "summary": "Later saved receipt", "results": [{"ok": True}]},
    ]
    for receipt in receipts:
        actions._append_receipt(receipt)
    receipt_bytes = receipts_path.read_bytes()
    assert legacy.actions_list() == original
    assert legacy.actions_receipts()["items"] == receipts
    assert legacy.actions_receipts(limit=1)["items"] == receipts[-1:]
    assert path.read_bytes() == before
    assert receipts_path.read_bytes() == receipt_bytes
