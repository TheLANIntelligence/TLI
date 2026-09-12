import base64
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from PIL import Image, PngImagePlugin
import tli_state as S
from intelligence import chat, context, devices, diagnostics, memory, models, vision
from intelligence.store import private_path, root
from ai import ai_routes
from routers import chat_routes, home_power


@pytest.fixture(autouse=True)
def isolated_intelligence(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="host-1", node_name="Office host", role="standalone"))
    monkeypatch.setattr(S, "load_shelly_registry", lambda: [])
    monkeypatch.setattr(S, "load_mesh_directory", lambda: {})
    monkeypatch.setattr(home_power, "get_runtime", lambda: SimpleNamespace(load_devices=lambda: []))
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})


def image_data():
    out = io.BytesIO()
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("location", "secret-address")
    Image.new("RGB", (32, 32), "blue").save(out, "PNG", pnginfo=metadata)
    return base64.b64encode(out.getvalue()).decode()


def test_shared_aliases_resolve_without_registry_mutation(monkeypatch):
    registry = [{"id": "lamp-1", "name": "Lamp", "ip": "192.168.2.4", "relay": 1}]
    monkeypatch.setattr(S, "load_shelly_registry", lambda: registry)
    before = json.dumps(registry)
    item = devices.inventory()["devices"][1]
    devices.update(item["id"], {"name": "Desk light", "aliases": ["Reading lamp"], "room": "Office"})
    assert devices.match("Reading lamp").device["id"] == item["id"]
    from ai.intent_engine import detect_intent
    result = detect_intent("turn off reading lamp", registry)
    assert result.status == "matched"
    assert result.intent["device"]["relay"] == 1
    assert json.dumps(registry) == before


def test_shared_alias_collision_does_not_execute(monkeypatch):
    registry = [{"id": str(i), "name": "Lamp " + str(i), "ip": "192.168.2.4", "relay": i} for i in (0, 1)]
    monkeypatch.setattr(S, "load_shelly_registry", lambda: registry)
    for item in devices.inventory()["devices"][1:]:
        devices.update(item["id"], {"aliases": ["desk"]})
    assert devices.match("desk").status == "ambiguous"
    assert devices.match("192.168.2.4").status == "ambiguous"
    from ai.intent_engine import detect_intent
    assert detect_intent("turn off desk", registry).status == "failed"


def test_printer_refresh_retains_cache_on_failure(monkeypatch):
    from routers import printers
    monkeypatch.setattr(printers, "get_printers", lambda: [{"name": "USB Printer", "system_name": "usb"}])
    devices.refresh_printers()
    monkeypatch.setattr(printers, "get_printers", lambda: {"error": "offline"})
    with pytest.raises(HTTPException):
        devices.refresh_printers()
    assert devices.inventory()["devices"][-1]["name"] == "USB Printer"


def test_network_checks_default_to_local_and_compare(monkeypatch):
    import event_bus
    events = []
    monkeypatch.setattr(event_bus, "emit_event", lambda *args, **kw: events.append(args))
    monkeypatch.setattr(diagnostics, "gateway", lambda: "192.168.1.1")
    monkeypatch.setattr(diagnostics, "ping", lambda ip: ("pass", "Gateway answered"))
    monkeypatch.setattr(diagnostics, "tcp", lambda *a: pytest.fail("Unexpected internet request"))
    monkeypatch.setattr(diagnostics, "resolve_hostname", lambda *a: pytest.fail("Unexpected DNS request"))
    first = diagnostics.run("alice", "network", None)
    assert first["host"]["name"] == "Office host"
    assert "phone" in first["scope"]
    assert not first["internet_checks"]
    monkeypatch.setattr(diagnostics, "ping", lambda ip: ("fail", "No reply; may be filtered"))
    second = diagnostics.run("alice", "network", None)
    assert second["comparison"]["changes"] == [{"check": "gateway_ping", "before": "pass", "after": "fail",
        "label": "Gateway response", "before_detail": "Gateway answered", "after_detail": "No reply; may be filtered"}]
    assert len(diagnostics.history("alice")) == 2
    assert diagnostics.history("bob") == []
    assert "Gateway answered" not in private_path("alice", "diagnostics").read_text()
    assert events[-1][1] == "warn" and "failed" in events[-1][3]
    assert "192.168.1.1" not in str(events) and "Gateway answered" not in str(events)


def test_external_evidence_labels_dns_hypothesis(monkeypatch):
    monkeypatch.setattr(diagnostics, "gateway", lambda: "192.168.1.1")
    monkeypatch.setattr(diagnostics, "ping", lambda _: ("pass", "reply"))
    monkeypatch.setattr(diagnostics, "tcp", lambda *a: ("pass", "external connection succeeded"))
    monkeypatch.setattr(diagnostics, "resolve_hostname", lambda _: (_ for _ in ()).throw(RuntimeError("DNS failed")))
    report = diagnostics.run("alice", "network", None, True)
    assert any(f["certainty"] == "likely" and "resolution" in f["text"] for f in report["findings"])


@pytest.mark.parametrize("platform,output,expected", [
    ("Windows", "192.168.1.1\n", "powershell"),
    ("Darwin", "route to: default\n gateway: 192.168.1.1\n", "route"),
    ("Linux", '[{"gateway":"192.168.1.1","metric":100}]', "ip"),
])
def test_platform_gateway_commands_are_bounded(monkeypatch, platform, output, expected):
    calls = []
    monkeypatch.setattr(diagnostics.platform, "system", lambda: platform)
    monkeypatch.setattr(diagnostics, "command", lambda args: calls.append(args) or output)
    assert diagnostics.gateway() == "192.168.1.1"
    assert calls[0][0] == expected


def test_dns_does_not_launch_application_executable(monkeypatch):
    seen = []
    monkeypatch.setattr(diagnostics, "command", lambda args: seen.append(args) or "Server: router\nAddress: 192.168.1.1\nName: example.com\nAddress: 93.184.216.34")
    assert diagnostics.resolve_hostname("example.com") == "93.184.216.34"
    assert seen == [["nslookup", "-type=A", "example.com"]]


def test_diagnostic_slots_reject_without_probe(monkeypatch):
    monkeypatch.setattr(diagnostics, "_slots", SimpleNamespace(acquire=lambda **k: False))
    monkeypatch.setattr(devices, "node", lambda: pytest.fail("Should not probe"))
    with pytest.raises(HTTPException) as exc:
        diagnostics.run("alice", "network", None)
    assert exc.value.status_code == 429


def test_confirmed_fixes_roundtrip_and_are_owned(monkeypatch):
    monkeypatch.setattr(diagnostics.psutil, "cpu_percent", lambda **k: 20)
    monkeypatch.setattr(diagnostics.psutil, "virtual_memory", lambda: SimpleNamespace(percent=40))
    monkeypatch.setattr(diagnostics.psutil, "disk_partitions", lambda **k: [])
    report = diagnostics.run("alice", "system", None)
    diagnostics.confirm_fix("alice", report["id"], "Closed the stalled editor; CPU returned to normal.")
    diagnostics.confirm_fix("alice", report["id"], "Closed the stalled editor; checked CPU again.")
    facts = memory.list_facts("alice")
    assert len(facts) == 1
    assert facts[0]["report_id"] == report["id"]
    assert facts[0]["source"] == "user_confirmation"
    with pytest.raises(HTTPException):
        diagnostics.confirm_fix("bob", report["id"], "mine")
    assert len(memory.list_facts("bob")) == 0


def test_memory_edit_forget_and_context_are_owner_scoped():
    alice = memory.save_fact("alice", "Office printer needs A4 paper", device_id="printer")
    memory.save_fact("bob", "Bob private printer password")
    assert not memory.relevant("alice", "printer", "other")
    assert memory.relevant("alice", "printer", "printer")[0]["id"] == alice["id"]
    memory.change("alice", alice["id"], "Office printer uses letter paper")
    assert "letter" in memory.list_facts("alice")[0]["text"]
    with pytest.raises(HTTPException):
        memory.change("bob", alice["id"], "stolen")
    memory.change("alice", alice["id"], None)
    assert not memory.list_facts("alice")
    assert "Office printer" not in Path(S.memory_path_for_user("alice")).read_text()


def test_legacy_device_memory_does_not_acquire_unproven_owner(monkeypatch):
    path = memory.legacy_path("browser-owner-test")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('["My printer is upstairs"]')
    assert memory.list_facts("local", "browser-owner-test")
    assert not memory.list_facts("alice", "browser-owner-test")
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    assert not memory.list_facts("local", "browser-owner-test")
    with pytest.raises(HTTPException):
        memory.legacy_path("../somebody")


def test_context_is_bounded_and_shared_with_legacy_chat():
    for _ in range(20):
        memory.save_fact("alice", "printer " + "x" * 1900)
    assembled = context.build("alice", "printer")
    assert len(assembled["text"]) < 5000
    req = chat_routes.ChatRequest(user_id="alice", message="printer")
    prepared = chat_routes._prepare_messages(req)
    messages = chat_routes.build_messages(req, S.load_memory("alice"))
    # The primary prompt may include a newly sampled health snapshot each call;
    # the owner-scoped reference selection must agree between both adapters.
    assert messages[1:] == prepared["messages"][1:]
    assert sum(len(m["content"]) for m in messages) <= 12000
    reference = next(line for m in messages if m["role"] == "system"
                     for line in m["content"].splitlines() if line.startswith("memory: "))
    supplied = json.loads(reference.removeprefix("memory: "))
    assert all(note["text"] == "printer " + "x" * 1900 for note in supplied)
    assert [n["id"] for n in supplied] == [n["id"] for n in prepared["memory_context"]["notes"]]
    assert "Bob private" not in json.dumps(messages)


def test_image_sanitization_strips_metadata_and_rejects_invalid():
    clean = vision.sanitize(image_data(), "image/png")
    decoded = base64.b64decode(clean["b64"])
    assert clean["mime"] == "image/jpeg"
    assert "secret-address" not in decoded.decode(errors="ignore")
    assert Image.open(io.BytesIO(decoded)).size == (32, 32)
    for invalid in ("notbase64", base64.b64encode(b"<svg/>").decode()):
        with pytest.raises(HTTPException):
            vision.sanitize(invalid)


def test_image_limits_checked_before_provider(monkeypatch):
    monkeypatch.setattr(vision, "MAX_PIXELS", 10)
    monkeypatch.setattr(models, "image_provider", lambda: pytest.fail("Must not discover provider"))
    with pytest.raises(HTTPException) as exc:
        chat.image_reply("alice", "check", image_data())
    assert exc.value.status_code == 422


def test_retention_is_opt_in_encrypted_owned_and_expires(monkeypatch):
    clean = vision.sanitize(image_data())
    assert vision.retain("alice", clean, 0) is None
    assert not private_path("alice", "images").exists()
    monkeypatch.setattr(vision.time, "time", lambda: 1000)
    item = vision.retain("alice", clean, 1)
    assert len(vision.images("alice")) == 1 and not vision.images("bob")
    assert clean["b64"] not in private_path("alice", "images").read_text()
    with pytest.raises(HTTPException):
        vision.forget("bob", item["id"])
    monkeypatch.setattr(vision.time, "time", lambda: 1000 + 86400)
    assert not vision.images("alice")


def test_image_capability_failure_never_falls_through_to_text(client, monkeypatch):
    monkeypatch.setattr(models, "image_provider", lambda: (_ for _ in ()).throw(HTTPException(409, "No vision provider")))
    monkeypatch.setattr(ai_routes, "_route_action_intent", lambda *a: pytest.fail("Image must not execute text action"))
    monkeypatch.setattr(ai_routes, "_find_mesh_ai_peer", lambda: pytest.fail("Image must not silently route to mesh"))
    response = client.post('/api/ai/chat/stream', json={"message": "turn off lamp", "image_b64": image_data()})
    assert '"type": "error"' in response.text
    assert '"type": "done"' not in response.text
    assert client.post('/api/ai/chat', json={"message": "image", "image_b64": image_data()}).status_code == 409


def test_successful_image_call_has_evidence_but_no_persisted_image(client, monkeypatch):
    captured = []
    monkeypatch.setattr(models, "image_provider", lambda: {"provider": "lmstudio", "model": "chosen", "url": "http://127.0.0.1/vision"})
    monkeypatch.setattr(chat.requests, "post", lambda url, **kw: captured.append(kw["json"]) or SimpleNamespace(
        raise_for_status=lambda: None, json=lambda: {"choices": [{"message": {"content": "The panel displays a warning."}}]}))
    result = client.post('/api/ai/chat/stream', json={"message": "What does this show?", "image_b64": image_data()})
    assert '"handled_by": "vision"' in result.text
    assert '"type": "done"' in result.text
    assert captured[0]["model"] == "chosen"
    assert captured[0]["messages"][-1]["content"][1]["image_url"]["url"].startswith('data:image/jpeg;base64,')
    assert image_data() not in json.dumps(S.load_conversations())
    assert not vision.images("local")


def test_diagnostic_chat_runs_without_model(client, monkeypatch):
    monkeypatch.setattr(diagnostics, "gateway", lambda: "192.168.1.1")
    monkeypatch.setattr(diagnostics, "ping", lambda _: ("pass", "reply"))
    monkeypatch.setattr(ai_routes, "_find_mesh_ai_peer", lambda: pytest.fail("Diagnostics do not need a model"))
    res = client.post('/api/ai/chat', json={"message": "check my network"})
    assert res.json()["handled_by"] == "diagnostics"
    assert "Office host" in res.json()["reply"]


def test_new_routes_and_old_memory_routes_enforce_ownership(authed_client):
    client = authed_client
    own = client.post('/api/intelligence/memory', json={"text": "My printer is upstairs"}).json()
    assert own["id"] in [f["id"] for f in client.get('/api/intelligence/memory').json()["facts"]]
    alien = memory.save_fact("another-user", "Private fact")
    assert client.delete('/api/intelligence/memory/' + alien["id"]).status_code == 404
    assert client.get('/memory/another-user').status_code == 404
    assert client.get('/api/intelligence/images/missing').status_code == 404


def test_bundled_history_cannot_read_or_delete_other_owners(authed_client):
    ident = ai_routes._get_or_create_conv(None, user_id="another-user")
    ai_routes._save_turn(ident, "user", "Private conversation")
    assert authed_client.get('/api/ai/conversations/' + ident).status_code == 404
    assert not any(c["id"] == ident for c in authed_client.get('/api/ai/conversations').json()["conversations"])
    authed_client.delete('/api/ai/conversations')
    assert ident in S.load_conversations()
    with pytest.raises(HTTPException):
        ai_routes._get_or_create_conv(ident, user_id="test-user")


def test_unknown_lm_model_never_becomes_vision_by_name(monkeypatch):
    monkeypatch.setattr(models.requests, "get", lambda *a, **kw: SimpleNamespace(raise_for_status=lambda: None,
        json=lambda: {"data": [{"id": "amazing-vision-model"}]}))
    entry = [m for m in models.catalogue()["models"] if m["provider"] == "lmstudio"][0]
    assert not entry["vision"]
    with pytest.raises(HTTPException):
        models.image_provider()
    models.configure("amazing-vision-model", True)
    assert models.image_provider()["model"] == "amazing-vision-model"


def test_context_budget_preserves_primary_instructions_and_never_silently_cuts_question():
    primary = "Primary rules must remain intact. " * 100
    question = "Complete this request. " * 150
    result = context.bound_messages([{ "role": "system", "content": primary },
        {"role": "system", "content": "Reference " * 2000},
        {"role": "assistant", "content": "Old answer " * 2000}, {"role": "user", "content": question}])
    assert result[0]["content"] == primary
    assert result[-1]["content"] == question
    assert sum(len(m["content"]) for m in result) <= 12000
    with pytest.raises(HTTPException):
        context.bound_messages([{"role": "system", "content": primary}, {"role": "user", "content": "x" * 12000}])


def test_new_private_routes_require_authentication(client, monkeypatch):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    for path in ("/api/intelligence/devices", "/api/intelligence/diagnostics", "/api/intelligence/memory", "/api/intelligence/images", "/api/ai/conversations"):
        assert client.get(path).status_code == 401
    with pytest.raises(HTTPException) as error:
        context.build(None, "check", report_id="somebody-elses-report")
    assert error.value.status_code == 401


def test_phone_entrypoint_retains_companion_and_exposes_full_tools(client):
    mobile = client.get('/', headers={"User-Agent": "Mozilla iPhone Mobile"})
    assert "TLI Companion" in mobile.text
    assert "Open diagnostics, memory &amp; image tools" in mobile.text
    assert "Device context &amp; diagnostics" not in mobile.text
    assert '/js/intelligence.js' in client.get('/?desktop=1', headers={"User-Agent": "iPhone"}).text


def test_empty_model_stream_reports_failure(client, monkeypatch):
    monkeypatch.setattr(ai_routes.BundledAIManager, "ensure_running", lambda self: True)
    monkeypatch.setattr(ai_routes, "_should_prefer_mesh", lambda: False)
    monkeypatch.setattr(ai_routes, "_route_action_intent", lambda *a: None)
    monkeypatch.setattr(ai_routes, "_tool_answer", lambda *a: None)
    monkeypatch.setattr(ai_routes, "_llama_stream_raw", lambda *a, **kw: iter(()))
    response = client.post('/api/ai/chat/stream', json={"message": "hello"})
    assert '"type": "error"' in response.text
    assert '"type": "done"' not in response.text


def test_report_context_is_not_silently_dropped_on_legacy_mesh(client, monkeypatch):
    target = devices.inventory()["devices"][0]["id"]
    monkeypatch.setattr(ai_routes, "_find_mesh_ai_peer", lambda: {"ip": "192.0.2.10", "port": 8000, "node_name": "Demo", "preset": "standard"})
    monkeypatch.setattr(ai_routes, "_route_action_intent", lambda *a: None)
    monkeypatch.setattr(ai_routes, "_tool_answer", lambda *a: None)
    monkeypatch.setattr(ai_routes, "_stream_via_mesh_peer", lambda *a: pytest.fail("Would discard selected context"))
    res = client.post('/api/ai/chat/stream', json={"message": "Tell me about this host", "target_id": target})
    assert "cannot receive the selected local diagnostic context" in res.text


def test_failed_legacy_memory_edit_preserves_original(monkeypatch):
    path = memory.legacy_path("failed-memory-edit")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('["Printer is in the study"]')
    fact = memory.legacy_facts("local", "failed-memory-edit")[0]
    monkeypatch.setattr(memory, "save_fact", lambda *a: (_ for _ in ()).throw(OSError("Disk full")))
    with pytest.raises(OSError):
        memory.change("local", fact["id"], "Printer moved", "failed-memory-edit")
    assert json.loads(path.read_text()) == ["Printer is in the study"]
