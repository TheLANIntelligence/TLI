import io
import json
import struct
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from ai import ai_manager as am, model_library as lib, model_downloads as dl
from ai import ai_routes as routes
from ai import runtime_support as rs
import hashlib


def gguf(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<4sIQQ", b"GGUF", 3, 1, 1) + bytes(1024 * 1024))
    return path


@pytest.fixture
def manager(tmp_path, monkeypatch):
    models = tmp_path / "models"
    models.mkdir()
    runtime = tmp_path / "runtime"
    runtime.write_bytes(b"fake; never executed")
    monkeypatch.setattr(am, "get_models_dir", lambda: models)
    monkeypatch.setattr(routes, "get_models_dir", lambda: models)
    monkeypatch.setattr(am, "ACTIVE_MODEL_PATH", tmp_path / "active_model.json")
    mgr = am.BundledAIManager(am.BundledAIConfig(tmp_path, runtime, gguf(models / am.MODEL_PRESETS["standard"]["filename"])))
    mgr._active_preset = "standard"
    monkeypatch.setattr(am.BundledAIManager, "get", classmethod(lambda cls: mgr))
    monkeypatch.setattr(mgr, "is_healthy", lambda: False)
    monkeypatch.setattr(mgr, "start", lambda: True)
    monkeypatch.setattr(mgr, "stop", lambda: None)
    monkeypatch.setattr(mgr, "inference_check", lambda: True)
    monkeypatch.setattr(mgr, "_start_watchdog", lambda: None)
    monkeypatch.setattr(lib, "resource_snapshot", lambda directory: resources())
    monkeypatch.setattr(routes, "resource_snapshot", lambda directory: resources())
    monkeypatch.setattr(dl, "resource_snapshot", lambda directory: resources())
    job = dl.ModelDownloads()
    monkeypatch.setattr(routes, "downloads", job)
    am._save_active_preset_id("standard")
    return mgr


def resources(total=32, available=24, free=100):
    return {"total_ram_bytes": total * lib.GIB if total is not None else None,
            "available_ram_bytes": available * lib.GIB if available is not None else None,
            "free_disk_bytes": free * lib.GIB if free is not None else None, "checked_at": 123}


@pytest.mark.parametrize("total,available,expected", [(7, 6, "insufficient_resources"), (8, 6, "compatible"),
    (32, 1, "insufficient_resources"), (None, 10, "unknown"), (32, None, "unknown")])
def test_resource_boundaries(manager, total, available, expected):
    c = lib.assess(am.MODEL_PRESETS["lite"], am.get_models_dir(), manager.cfg.runtime_path, "CPU", resources(total, available))
    assert c["state"] == expected
    assert c["execution_mode"] == "CPU"


def test_disk_and_incomplete_vision(manager):
    preset = am.MODEL_PRESETS["vision"]
    gguf(am.get_models_dir() / preset["filename"])
    c = lib.assess(preset, am.get_models_dir(), manager.cfg.runtime_path, "CPU", resources(free=0))
    assert not c["selectable"] and not c["download_allowed"]
    assert not c["installation"]["complete"]
    manager.cfg.runtime_path.unlink()
    assert manager.compatibility("vision")["state"] == "unsupported"


def test_list_does_not_claim_selected_is_running(manager, authed_client):
    data = authed_client.get("/api/ai/models/presets").json()
    selected = next(p for p in data["presets"] if p["id"] == "standard")
    assert selected["is_selected"] and selected["downloaded"]
    assert not selected["running"] and not selected["is_active"]


@pytest.mark.parametrize("name", ["../bad.gguf", "C:\\bad.gguf", "bad/evil.gguf", "bad.txt", "foo:bar.gguf", "NUL.gguf"])
def test_import_rejects_unsafe_names(manager, authed_client, name):
    response = authed_client.post("/api/ai/model/upload", files={"file": (name, b"bad")})
    assert response.status_code == 400


def test_import_validates_and_does_not_activate(manager, authed_client, tmp_path):
    before = am.ACTIVE_MODEL_PATH.read_bytes()
    assert authed_client.post("/api/ai/model/upload", files={"file": ("bad.gguf", b"GGUFbad")}).status_code == 400
    model = gguf(tmp_path / "custom.gguf")
    response = authed_client.post("/api/ai/model/upload", files={"file": ("custom.gguf", model.read_bytes())})
    assert response.json()["installed"]
    assert am.ACTIVE_MODEL_PATH.read_bytes() == before
    assert manager.active_preset_id == "standard"
    assert any(p["id"] == "custom:custom.gguf" for p in routes.list_model_presets()["presets"])


@pytest.mark.parametrize("start_ok,inference_ok,recovery_ok", [(False, True, True), (True, False, True), (False, False, False)])
def test_failed_switch_restores_selection(manager, monkeypatch, start_ok, inference_ok, recovery_ok):
    import event_bus
    events = []
    monkeypatch.setattr(event_bus, "emit_event", lambda *args, **kw: events.append(args))
    gguf(am.get_models_dir() / am.MODEL_PRESETS["lite"]["filename"])
    before = am.ACTIVE_MODEL_PATH.read_bytes()
    monkeypatch.setattr(manager, "is_healthy", lambda: True)
    starts = []
    def start():
        starts.append(manager.active_preset_id)
        return start_ok if len(starts) == 1 else recovery_ok
    monkeypatch.setattr(manager, "start", start)
    monkeypatch.setattr(manager, "inference_check", lambda: inference_ok if manager.active_preset_id == "lite" else recovery_ok)
    result = manager.switch_model("lite")
    assert not result["ok"] and result["recovery"]["restored"] == recovery_ok
    assert starts == ["lite", "standard"]
    assert manager.active_preset_id == "standard" and am.ACTIVE_MODEL_PATH.read_bytes() == before
    assert manager._manual_failure == (not recovery_ok)
    assert "AI model switch completed" not in [e[2] for e in events]
    assert events[-2][2] == "AI model switch failed"
    assert events[-1][2] == ("Previous AI model restored" if recovery_ok else "Local AI is unavailable")
    assert str(am.get_models_dir()) not in str(events)


def test_success_is_persisted_only_after_inference(manager, monkeypatch):
    import event_bus
    events = []
    monkeypatch.setattr(event_bus, "emit_event", lambda *args, **kw: events.append(args))
    gguf(am.get_models_dir() / am.MODEL_PRESETS["lite"]["filename"])
    def check():
        assert json.loads(am.ACTIVE_MODEL_PATH.read_text())["preset_id"] == "standard"
        assert "AI model switch completed" not in [e[2] for e in events]
        return True
    monkeypatch.setattr(manager, "inference_check", check)
    assert manager.switch_model("lite")["ok"]
    assert json.loads(am.ACTIVE_MODEL_PATH.read_text())["preset_id"] == "lite"
    assert events[-1][2] == "AI model switch completed"


def test_unknown_requires_explicit_check(manager, monkeypatch):
    gguf(am.get_models_dir() / "custom.gguf")
    assert not manager.switch_model("custom:custom.gguf")["ok"]
    assert manager.switch_model("custom:custom.gguf", check_unknown=True)["ok"]
    assert am._load_active_preset_id() == "custom"
    assert am._resolve_model_path().name == "custom.gguf"


def test_generation_and_concurrent_switch_busy(manager, monkeypatch):
    gguf(am.get_models_dir() / am.MODEL_PRESETS["lite"]["filename"])
    with manager.generation():
        assert manager.switch_model("lite")["busy"]
    entered, release = threading.Event(), threading.Event()
    monkeypatch.setattr(manager, "start", lambda: entered.set() or release.wait(3))
    worker = threading.Thread(target=manager.switch_model, args=("lite",))
    worker.start()
    assert entered.wait(2)
    try:
        assert manager.switch_model("lite")["busy"]
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive()


class Response:
    def __init__(self, content, during=None):
        self.content = content
        self.headers = {"content-length": str(len(content))}
        self.during = during
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def raise_for_status(self): pass
    def iter_content(self, **kwargs):
        if self.during: self.during()
        yield self.content


def test_two_component_download_never_selects(manager, monkeypatch, tmp_path):
    import event_bus
    events = []
    monkeypatch.setattr(event_bus, "emit_event", lambda *args, **kw: events.append(args))
    job = routes.downloads
    content = gguf(tmp_path / "payload.gguf").read_bytes()
    monkeypatch.setattr(dl.requests, "get", lambda *a, **kw: Response(content))
    parts = [("https://example.invalid/a", am.get_models_dir() / name, len(content)) for name in ("vision.gguf", "mmproj.gguf")]
    before = am.ACTIVE_MODEL_PATH.read_bytes()
    job.reserve("vision", parts)
    job.run(parts, manager)
    assert job.status()["status"] == "done"
    assert all(lib.validate_gguf(p) for _, p, _ in parts)
    assert before == am.ACTIVE_MODEL_PATH.read_bytes()
    assert events[-1][2] == "Model installation finished"
    assert "All required files validated" in events[-1][3]


@pytest.mark.parametrize("cancel", [False, True])
def test_failed_or_cancelled_download_preserves_existing_files(manager, monkeypatch, tmp_path, cancel):
    import event_bus
    events = []
    monkeypatch.setattr(event_bus, "emit_event", lambda *args, **kw: events.append(args))
    job = routes.downloads
    existing = gguf(am.get_models_dir() / "other.gguf")
    before = existing.read_bytes()
    parts = [("https://example.invalid/a", existing, len(before)), ("https://example.invalid/b", am.get_models_dir() / "mmproj.gguf", 1)]
    def response(url, **kwargs):
        if url.endswith("/a"):
            return Response(before, job.cancel if cancel else None)
        return Response(b"not a gguf")
    monkeypatch.setattr(dl.requests, "get", response)
    job.reserve("vision", parts)
    job.run(parts, manager)
    assert job.status()["status"] == ("cancelled" if cancel else "error")
    assert existing.read_bytes() == before
    assert not list(am.get_models_dir().glob("*.downloading-*"))
    assert [e[2] for e in events] == ["Model installation started", "Model installation cancelled" if cancel else "Model installation failed"]
    assert "example.invalid" not in str(events) and str(existing) not in str(events)


def test_cancel_keeps_reservation_until_worker_exits(manager):
    job = routes.downloads
    parts = [("url", Path("model.gguf"), 100)]
    job.reserve("lite", parts)
    assert job.cancel()["in_progress"]
    with pytest.raises(ValueError): job.reserve("power", parts)
    assert routes.model_progress()["status"] == "cancelling"


def test_selection_resource_gate_cannot_be_bypassed(manager, monkeypatch, authed_client):
    gguf(am.get_models_dir() / am.MODEL_PRESETS["lite"]["filename"])
    monkeypatch.setattr(lib, "resource_snapshot", lambda directory: resources(available=0))
    monkeypatch.setattr(manager, "start", lambda: pytest.fail("Must not start runtime"))
    for endpoint in ("select", "check"):
        result = authed_client.post("/api/ai/models/" + endpoint, json={"preset_id": "lite"}).json()
        assert not result["ok"] and result["compatibility"]["state"] == "insufficient_resources"


def test_capability_context_does_not_invent_health(manager, monkeypatch):
    from intelligence import models, devices
    monkeypatch.setattr(devices, "inventory", lambda: {"node": {"name": "Test host"}, "devices": []})
    facts = models.bundled_capabilities()
    assert not facts["running"] and not facts["vision"]
    context = routes._get_tli_context()
    assert "Test host" in context and "Registration does not prove" in context
    assert "192.168.4.189" not in context


def test_model_mutations_require_session(manager, client, monkeypatch):
    from routers import system_routes
    # Match the project's existing authentication contract with PIN enabled.
    monkeypatch.setattr(system_routes, "_pin_is_set", lambda: True, raising=False)
    from main import app
    from fastapi import HTTPException
    def denied(): raise HTTPException(401, "Authentication required")
    app.dependency_overrides[routes.require_session] = denied
    try:
        for path in ("models/select", "models/check", "model/download", "model/cancel", "storage/location", "model/reveal"):
            assert client.post("/api/ai/" + path, json={"preset_id": "lite"}).status_code == 401
        assert client.post("/api/ai/model/upload", files={"file": ("x.gguf", b"bad")}).status_code == 401
    finally:
        app.dependency_overrides.pop(routes.require_session, None)


def test_stream_holds_generation_lease_until_closed(manager, monkeypatch):
    class Stream(Response):
        ok = True
        def iter_lines(self, **kwargs):
            yield 'data: {"choices":[{"delta":{"content":"hello"}}]}'
            yield 'data: [DONE]'
    monkeypatch.setattr(routes.requests, "post", lambda *a, **kw: Stream(b""))
    stream = routes._llama_stream_raw(manager.base_url + "/v1/chat/completions", {})
    assert "hello" in next(stream)
    assert manager._generations == 1
    assert manager.switch_model("lite")["busy"]
    stream.close()
    assert manager._generations == 0


def test_saved_missing_model_does_not_auto_select_another_download(manager):
    manager.cfg.model_path.unlink()
    gguf(am.get_models_dir() / am.MODEL_PRESETS["power"]["filename"])
    assert am._resolve_model_path().name == am.MODEL_PRESETS["standard"]["filename"]


def test_vision_capability_requires_projector_and_health(manager, monkeypatch):
    from intelligence import models
    manager._active_preset = "vision"
    preset = am.MODEL_PRESETS["vision"]
    manager.cfg.model_path = gguf(am.get_models_dir() / preset["filename"])
    monkeypatch.setattr(manager, "is_healthy", lambda: True)
    assert not models.bundled_capabilities()["vision"]
    gguf(am.get_models_dir() / preset["mmproj_filename"])
    assert models.bundled_capabilities()["vision"]


def test_low_disk_rejects_download_before_starting_worker(manager, monkeypatch, authed_client):
    monkeypatch.setattr(routes, "resource_snapshot", lambda directory: resources(free=0))
    monkeypatch.setattr(routes.downloads, "reserve", lambda *a: pytest.fail("Must not reserve download"))
    assert authed_client.post("/api/ai/model/download", json={"preset_id": "lite"}).status_code == 400


def test_failed_two_file_publish_restores_both_old_files(manager, monkeypatch):
    job = routes.downloads
    one, two = gguf(am.get_models_dir() / "one.gguf"), gguf(am.get_models_dir() / "two.gguf")
    before = (one.read_bytes(), two.read_bytes())
    monkeypatch.setattr(dl.requests, "get", lambda *a, **kw: Response(before[0]))
    replace = Path.replace
    def fail_second(path, target):
        if ".downloading-" in path.name and target == two:
            raise OSError("Simulated commit failure")
        return replace(path, target)
    monkeypatch.setattr(Path, "replace", fail_second)
    parts = [("url", one, len(before[0])), ("url", two, len(before[1]))]
    job.reserve("vision", parts)
    job.run(parts, manager)
    assert job.status()["status"] == "error"
    assert (one.read_bytes(), two.read_bytes()) == before


def test_runtime_exiting_early_never_counts_as_started(manager, monkeypatch):
    monkeypatch.setattr(am, "_is_port_open", lambda *a: False)
    monkeypatch.setattr(am, "_assign_to_win32_job", lambda *a: None)
    monkeypatch.setattr(am.subprocess, "Popen", lambda *a, **kw: SimpleNamespace(pid=123, poll=lambda: 1))
    assert manager._start_runtime() is False


def test_unowned_runtime_port_is_not_reused_for_candidate(manager, monkeypatch):
    monkeypatch.setattr(am, "_is_port_open", lambda *a: True)
    monkeypatch.setattr(am.subprocess, "Popen", lambda *a, **kw: pytest.fail("Must not launch into occupied port"))
    assert manager._start_runtime() is False


def test_optional_catalogue_preserves_defaults_and_pins_publisher_files():
    from ai.model_catalog import QWEN3_PRESETS
    assert am.DEFAULT_PRESET == "standard"
    assert am.MODEL_PRESETS["standard"]["filename"] == "Qwen2.5-3B-Instruct-Q4_K_M.gguf"
    assert len(QWEN3_PRESETS) == 3
    for preset in QWEN3_PRESETS.values():
        assert preset["url"].startswith("https://huggingface.co/Qwen/")
        assert f"/resolve/{preset['revision']}/" in preset["url"]
        assert len(preset["sha256"]) == 64
        assert preset["non_thinking"] and not preset["is_vision"]
        assert preset["ctx_size"] == 4096


@pytest.mark.parametrize("build,flags,state", [(5091, list(rs.FLAGS), "unsupported"),
    (5092, list(rs.FLAGS), "supported"), (7896, ["--jinja"], "unsupported"),
    (None, None, "unknown")])
def test_runtime_build_and_controls_gate_new_models(manager, monkeypatch, build, flags, state):
    monkeypatch.setattr(rs, "runtime_info", lambda path: {"build": build, "flags": flags, "reason": "Unknown runtime"})
    check = manager.compatibility("qwen3_4b")
    assert check["runtime"]["state"] == state
    assert check["download_allowed"] == (state == "supported")
    if state != "supported":
        monkeypatch.setattr(manager, "stop", lambda: pytest.fail("Must preserve current model"))
        assert not manager.switch_model("qwen3_4b", check_unknown=True)["ok"]


def test_runtime_probe_is_bounded_and_cached(tmp_path, monkeypatch):
    rs._inspect.cache_clear()
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        assert kwargs["timeout"] == 3
        return SimpleNamespace(returncode=0, stdout="version: 7896 (abc123)" if args[-1] == "--version" else "\n".join(f + " option" for f in rs.FLAGS), stderr="")
    monkeypatch.setattr(rs.subprocess, "run", run)
    one = rs._inspect(str(tmp_path / "runtime"), 1, 10, 123)
    assert one["build"] == 7896 and set(one["flags"]) == set(rs.FLAGS)
    assert rs._inspect(str(tmp_path / "runtime"), 1, 10, 123) == one
    assert len(calls) == 2
    rs._inspect(str(tmp_path / "runtime"), 2, 10, 123)
    assert len(calls) == 4  # replacement invalidates the result


def test_probe_timeout_is_unknown_not_supported(tmp_path, monkeypatch):
    rs._inspect.cache_clear()
    def fail(*args, **kwargs): raise rs.subprocess.TimeoutExpired("runtime", 3)
    monkeypatch.setattr(rs.subprocess, "run", fail)
    result = rs._inspect(str(tmp_path / "runtime"), 1, 1, 1)
    assert result["build"] is None and result["flags"] is None


@pytest.mark.parametrize("pid", ["standard", "qwen3_4b"])
def test_only_qwen3_startup_gets_non_thinking_controls(manager, monkeypatch, pid):
    monkeypatch.setattr(rs, "runtime_info", lambda path: {"build": 7896, "flags": list(rs.FLAGS), "reason": ""})
    manager._active_preset = pid
    manager.cfg.model_path = gguf(am.get_models_dir() / am.MODEL_PRESETS[pid]["filename"])
    manager._transition = True
    monkeypatch.setattr(am, "_is_port_open", lambda *a: False)
    monkeypatch.setattr(am, "_gpu_layers_for_platform", lambda: 0)
    monkeypatch.setattr(am, "_assign_to_win32_job", lambda *a: None)
    monkeypatch.setattr(manager, "is_healthy", lambda: True)
    commands = []
    def popen(args, **kwargs):
        commands.append(args)
        return SimpleNamespace(pid=123, poll=lambda: None)
    monkeypatch.setattr(am.subprocess, "Popen", popen)
    assert manager._start_runtime()
    command = commands[0]
    if pid == "qwen3_4b":
        assert json.loads(command[command.index("--chat-template-kwargs") + 1]) == {"enable_thinking": False}
        assert command[command.index("--reasoning-budget") + 1] == "0"
        assert command[command.index("--reasoning-format") + 1] == "deepseek"
    else:
        assert "--chat-template-kwargs" not in command


@pytest.mark.parametrize("correct", [True, False])
def test_publisher_checksum_before_download_commit(manager, monkeypatch, tmp_path, correct):
    payload = gguf(tmp_path / "publisher.gguf").read_bytes()
    target = am.get_models_dir() / "qwen-test.gguf"
    previous = gguf(target).read_bytes()
    # Change payload without corrupting its GGUF header.
    payload = payload[:-1] + b"x"
    digest = hashlib.sha256(payload).hexdigest() if correct else "0" * 64
    monkeypatch.setattr(dl.requests, "get", lambda *a, **kw: Response(payload))
    parts = [("https://example.invalid/pinned", target, len(payload))]
    routes.downloads.reserve("test", parts)
    routes.downloads.run(parts, manager, {target.name: digest})
    assert routes.downloads.status()["status"] == ("done" if correct else "error")
    assert target.read_bytes() == (payload if correct else previous)
    assert am._load_active_preset_id() == "standard"


def test_manually_placed_wrong_publisher_file_never_stops_current_model(manager, monkeypatch):
    preset = dict(am.MODEL_PRESETS["qwen3_4b"])
    target = gguf(am.get_models_dir() / preset["filename"])
    preset["size_bytes"] = target.stat().st_size
    monkeypatch.setitem(am.MODEL_PRESETS, "qwen3_4b", preset)
    monkeypatch.setattr(rs, "runtime_info", lambda path: {"build": 7896, "flags": list(rs.FLAGS), "reason": ""})
    monkeypatch.setattr(manager, "stop", lambda: pytest.fail("Checksum failure must preserve current runtime"))
    result = manager.switch_model("qwen3_4b")
    assert not result["ok"] and "checksum" in result["error"]
    assert am._load_active_preset_id() == "standard"


def test_checksum_deadline_and_valid_file(tmp_path, monkeypatch):
    target = gguf(tmp_path / "file.gguf")
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    assert lib.verify_checksum(target, digest)
    assert not lib.verify_checksum(target, digest, timeout=0)


def test_download_api_passes_publisher_hash_to_worker(manager, monkeypatch, authed_client):
    monkeypatch.setattr(rs, "runtime_info", lambda path: {"build": 7896, "flags": list(rs.FLAGS), "reason": ""})
    workers = []
    class Worker:
        def __init__(self, **kwargs): workers.append(kwargs)
        def start(self): pass
    monkeypatch.setattr(routes.threading, "Thread", Worker)
    result = routes.model_download({"preset_id": "qwen3_1_7b"}, user="test-user")
    assert result["ok"]
    preset = am.MODEL_PRESETS["qwen3_1_7b"]
    assert workers[0]["args"][2] == {preset["filename"]: preset["sha256"]}


def test_optional_model_quantization_in_api_is_truthful(manager, authed_client):
    presets = authed_client.get("/api/ai/models/presets").json()["presets"]
    assert next(p for p in presets if p["id"] == "qwen3_1_7b")["quantization"] == "Q8_0"
