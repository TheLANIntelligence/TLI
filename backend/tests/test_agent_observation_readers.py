"""Agent observations read synthetic host/runtime evidence without lifecycle work."""
import builtins
import json
from pathlib import Path
import sys
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

from ai import ai_manager as manager_module
import model_probe
import security_state
import tli_state as S
from routers import system_routes as routes


ERRORS = [
    pytest.param(lambda: HTTPException(401, "Session changed"), id="401"),
    pytest.param(lambda: HTTPException(503, "Security unavailable"), id="503"),
    pytest.param(lambda: FileNotFoundError("Authority unavailable"), id="missing"),
    pytest.param(lambda: OSError("Authority unavailable"), id="os-error"),
    pytest.param(lambda: RuntimeError("Authority unavailable"), id="unexpected"),
]


@pytest.fixture
def observation(tmp_path, monkeypatch):
    f = SimpleNamespace(calls=[], stop=None, error=None, revoked=False, fault=False,
                        model=tmp_path / "chosen.gguf", status=200, data={"data": []})
    f.model.write_bytes(b"Synthetic model; never executed")

    def step(name, result=None):
        f.calls.append(name)
        if f.stop == name:
            f.revoked = True
            if f.fault:
                raise OSError("Synthetic private observation failure")
        return result

    def check():
        if f.revoked:
            f.revoked = False
            raise f.error

    def forbidden(*args, **kwargs):
        pytest.fail("Observation attempted initialization, lifecycle, write, or legacy network")

    f.step, f.check = step, check
    f.node = SimpleNamespace(node_id="saved-node", node_name="Fixture host", role="host", mesh_status="approved")
    monkeypatch.setattr(S, "read_node_config", lambda **kwargs: step("node", f.node))
    for name in ("load_node_config", "save_node_config", "load_devices", "save_devices"):
        monkeypatch.setattr(S, name, forbidden)
    monkeypatch.setattr(security_state, "write_json", forbidden)
    for name, value in {"node": "fixture-host", "platform": "SyntheticOS 1.0", "system": "SyntheticOS"}.items():
        monkeypatch.setattr(routes.platform, name, lambda n=name, v=value: step(n, v))
    monkeypatch.setattr(routes.os, "cpu_count", lambda: step("cpu_count", 16))
    monkeypatch.setattr(routes.S, "now_iso", lambda: "2001-02-03T04:05:06Z")
    monkeypatch.setattr(routes, "psutil", SimpleNamespace(
        cpu_percent=lambda interval: step("cpu_percent", 25),
        virtual_memory=lambda: step("memory", SimpleNamespace(
            total=32 * 1024**3, available=20 * 1024**3, used=12 * 1024**3, percent=37.5)),
        disk_usage=lambda path: step("disk", SimpleNamespace(
            total=100 * 1024**3, free=60 * 1024**3, percent=40)),
        boot_time=lambda: step("boot", routes.time.time() - 100),
    ))

    class Lock:
        def __init__(self, name):
            self.name, self.busy, self.held = name, False, False

        def acquire(self, blocking):
            assert blocking is False
            step(self.name)
            if self.busy:
                return False
            self.held = True
            return True

        def release(self):
            assert self.held
            self.held = False
            step(self.name + ":release")

    # Bypass __init__: it reads settings and registers lifetime hooks.
    f.manager = object.__new__(manager_module.BundledAIManager)
    f.manager.cfg = SimpleNamespace(model_path=f.model, host="127.0.0.1", port=8089, health_path="/v1/models")
    f.manager._active_preset = "standard"
    f.manager._transition = False
    f.manager.operation_lock = Lock("operation_lock")
    f.manager_lock = Lock("manager_lock")
    monkeypatch.setattr(manager_module.BundledAIManager, "_instance", f.manager)
    monkeypatch.setattr(manager_module.BundledAIManager, "_lock", f.manager_lock)
    for name in ("get", "status", "start", "stop", "ensure_running", "is_healthy", "_start_watchdog"):
        monkeypatch.setattr(manager_module.BundledAIManager, name, forbidden)
    for name in ("get_models_dir", "_resolve_model_path", "_load_active_preset_id", "_is_port_open", "_http_get_json"):
        monkeypatch.setattr(manager_module, name, forbidden)
    monkeypatch.setattr(manager_module.subprocess, "Popen", forbidden)
    monkeypatch.setattr(manager_module.socket, "create_connection", forbidden)
    monkeypatch.setattr(manager_module, "urlopen", forbidden)
    real_stat = Path.stat

    def stat(path, *args, **kwargs):
        if path == f.model:
            value = real_stat(path, *args, **kwargs)
            return step("model_stat", value)
        return real_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat)

    def probe(url, *, check):
        assert url == f"http://{f.manager.cfg.host}:{f.manager.cfg.port}{f.manager.cfg.health_path}"
        check()
        result = step("probe", {"status_code": f.status, "data": f.data})
        check()
        return result

    monkeypatch.setattr(model_probe, "probe_json", probe)
    return f


@pytest.mark.parametrize("service", [routes.agent_health, routes.agent_info])
@pytest.mark.parametrize("error_factory", ERRORS)
def test_agent_denied_before_reading_host(observation, service, error_factory):
    f = observation
    f.revoked, f.error = True, error_factory()
    with pytest.raises(type(f.error)) as raised:
        service(check=f.check)
    assert raised.value is f.error
    assert f.calls == []


SERVICE_STAGES = [(routes.agent_health, stage) for stage in
                  ["node", "system", "cpu_percent", "memory", "disk", "boot", "model_stat", "probe"]] + [
    (routes.agent_info, stage) for stage in ["node", "platform", "system", "cpu_count", "memory"]]


@pytest.mark.parametrize("service,stage", SERVICE_STAGES)
@pytest.mark.parametrize("error_factory", ERRORS)
def test_one_shot_denial_is_never_optional_fallback(observation, service, stage, error_factory):
    f = observation
    f.stop, f.error = stage, error_factory()
    with pytest.raises(type(f.error)) as raised:
        service(check=f.check)
    assert raised.value is f.error
    assert f.calls[-1] in {stage, "operation_lock:release"}
    if stage in {"node", "system", "cpu_percent", "memory", "disk", "boot"}:
        assert "probe" not in f.calls
    if stage == "model_stat":
        assert "probe" not in f.calls
    assert not f.manager_lock.held and not f.manager.operation_lock.held


@pytest.mark.parametrize("stage", ["cpu_percent", "memory", "disk", "boot", "model_stat", "probe"])
def test_failed_observation_then_revocation_preserves_original_denial(observation, stage):
    f = observation
    f.stop, f.error, f.fault = stage, HTTPException(503, "Unavailable"), True
    with pytest.raises(HTTPException) as raised:
        routes.agent_health(check=f.check)
    assert raised.value is f.error
    if stage != "probe":
        assert "probe" not in f.calls
    assert not f.manager.operation_lock.held


def test_health_retains_trustworthy_fields_without_lifecycle(observation):
    data = routes.agent_health(check=observation.check)
    assert data["node_id"] == "saved-node"
    assert data["node_name"] == "Fixture host"
    assert data["cpu_percent"] == 25
    assert data["ram_total_gb"] == 32 and data["disk_free_gb"] == 60
    assert data["has_ai"] is True and data["ai_healthy"] is True
    assert data["ai_status"] == "observed"
    assert data["active_preset"] == "standard"
    assert data["active_model"] == manager_module.MODEL_PRESETS["standard"]["name"]
    assert observation.calls.count("model_stat") == 1
    assert observation.calls.count("probe") == 1


def test_info_keeps_existing_shape_and_no_argument_callable(observation):
    data = routes.agent_info()
    assert data["ok"] is True
    assert data["node"] == vars(observation.node)
    assert data["system"]["hostname"] == "fixture-host"
    assert data["system"]["cpu_count"] == 16
    assert data["system"]["memory"]["total_gb"] == 32
    assert "manager_lock" not in observation.calls and "probe" not in observation.calls


def test_no_manager_module_does_not_import_or_initialize_it(observation, monkeypatch):
    original = builtins.__import__

    def no_manager_import(name, *args, **kwargs):
        assert name != "ai.ai_manager"
        return original(name, *args, **kwargs)

    monkeypatch.delitem(sys.modules, "ai.ai_manager")
    monkeypatch.setattr(builtins, "__import__", no_manager_import)
    data = routes.agent_health(check=observation.check)
    assert data["ai_status"] == "unavailable"
    assert data["has_ai"] is data["ai_healthy"] is data["active_preset"] is data["active_model"] is None
    assert "probe" not in observation.calls


@pytest.mark.parametrize("absent", [True, False])
def test_missing_manager_or_transition_is_explicit_unknown(observation, monkeypatch, absent):
    if absent:
        monkeypatch.setattr(manager_module.BundledAIManager, "_instance", None)
    else:
        observation.manager._transition = True
    data = routes.agent_health(check=observation.check)
    assert data["ai_status"] == ("unavailable" if absent else "busy")
    assert data["has_ai"] is None and data["ai_healthy"] is None
    assert "model_stat" not in observation.calls and "probe" not in observation.calls


@pytest.mark.parametrize("lock_name", ["manager_lock", "operation_lock"])
def test_busy_observation_locks_do_not_wait_or_probe(observation, lock_name):
    lock = observation.manager_lock if lock_name == "manager_lock" else observation.manager.operation_lock
    lock.busy = True
    data = manager_module.BundledAIManager.observe_existing(check=observation.check)
    assert data["status"] == "busy"
    assert data["healthy"] is None
    assert "model_stat" not in observation.calls and "probe" not in observation.calls
    assert not observation.manager_lock.held and not observation.manager.operation_lock.held


@pytest.mark.parametrize("stage", ["manager_lock", "manager_lock:release", "operation_lock", "operation_lock:release"])
@pytest.mark.parametrize("error_factory", ERRORS)
def test_manager_lock_boundaries_retain_denial_and_release_locks(observation, stage, error_factory):
    f = observation
    f.stop, f.error = stage, error_factory()
    with pytest.raises(type(f.error)) as raised:
        manager_module.BundledAIManager.observe_existing(check=f.check)
    assert raised.value is f.error
    assert not f.manager_lock.held and not f.manager.operation_lock.held


@pytest.mark.parametrize("status,data,expected", [
    (200, {}, True), (200, {"data": []}, True), (503, None, False), (404, None, False),
    (200, ["not an object"], None),
])
def test_runtime_observation_distinguishes_response_from_unknown(observation, status, data, expected):
    observation.status, observation.data = status, data
    result = manager_module.BundledAIManager.observe_existing(check=observation.check)
    assert result["healthy"] is expected
    assert result["model_exists"] is True
    assert result["status"] == ("unavailable" if expected is None else "observed")


@pytest.mark.parametrize("reason", ["timed_out", "unavailable", "redirected", "too_large", "invalid_response"])
def test_bounded_probe_failure_is_not_confirmed_offline(observation, monkeypatch, reason):
    def unavailable(*args, **kwargs):
        raise model_probe.ModelProbeError(reason)
    monkeypatch.setattr(model_probe, "probe_json", unavailable)
    result = manager_module.BundledAIManager.observe_existing(check=observation.check)
    assert result["status"] == "unavailable" and result["healthy"] is None
    assert result["model_exists"] is True and result["active_preset"] == "standard"


@pytest.mark.parametrize("field,value", [
    ("host", "192.0.2.1"), ("host", "user@localhost"), ("host", "malformed"),
    ("port", 0), ("port", True), ("port", 65536),
    ("health_path", "//external.invalid/"), ("health_path", "/bad?query"),
    ("health_path", "/bad\\path"), ("health_path", "/bad\r\n"),
])
def test_untrusted_runtime_destination_never_probed(observation, field, value):
    setattr(observation.manager.cfg, field, value)
    result = manager_module.BundledAIManager.observe_existing(check=observation.check)
    assert result["status"] == "unavailable" and result["healthy"] is None
    assert "model_stat" not in observation.calls and "probe" not in observation.calls


@pytest.mark.parametrize("change", ["model", "preset", "manager", "transition", "host"])
def test_changed_runtime_snapshot_is_not_reported_as_current(observation, monkeypatch, change):
    f = observation
    def probe(*args, **kwargs):
        if change == "model": f.manager.cfg.model_path = f.model.with_name("other.gguf")
        elif change == "preset": f.manager._active_preset = "lite"
        elif change == "manager": manager_module.BundledAIManager._instance = None
        elif change == "transition": f.manager._transition = True
        else: f.manager.cfg.host = "localhost"
        return {"status_code": 200, "data": {}}
    monkeypatch.setattr(model_probe, "probe_json", probe)
    result = manager_module.BundledAIManager.observe_existing(check=f.check)
    assert result["status"] == "unavailable"
    assert result["healthy"] is result["model_exists"] is result["active_preset"] is None


def test_slow_observations_do_not_hold_model_operation_lock(observation, monkeypatch):
    f = observation
    original_stat = Path.stat

    def stat(path, *args, **kwargs):
        if path == f.model:
            assert not f.manager.operation_lock.held
        return original_stat(path, *args, **kwargs)

    def probe(*args, **kwargs):
        assert not f.manager.operation_lock.held
        # A normal model operation can acquire its existing lock while the
        # observation is in flight; the observer never waits for this work.
        assert f.manager.operation_lock.acquire(blocking=False)
        f.manager.operation_lock.release()
        return {"status_code": 200, "data": {}}

    monkeypatch.setattr(Path, "stat", stat)
    monkeypatch.setattr(model_probe, "probe_json", probe)
    assert manager_module.BundledAIManager.observe_existing(check=f.check)["healthy"] is True


@pytest.mark.parametrize("mode,expected", [
    ("observed", "observed"), ("class-busy", "busy"), ("operation-busy", "busy"),
    ("transition", "busy"), ("invalid-config", "unavailable"), ("missing", "unavailable"),
    ("changed", "unavailable"), ("probe-error", "unavailable"), ("final-busy", "busy"),
])
def test_authority_callbacks_never_hold_snapshot_locks(observation, monkeypatch, mode, expected):
    f = observation
    if mode == "class-busy": f.manager_lock.busy = True
    elif mode == "operation-busy": f.manager.operation_lock.busy = True
    elif mode == "transition": f.manager._transition = True
    elif mode == "invalid-config": f.manager.cfg.host = "invalid"
    elif mode == "missing": monkeypatch.setattr(manager_module.BundledAIManager, "_instance", None)
    if mode in {"changed", "probe-error", "final-busy"}:
        def probe(*args, **kwargs):
            if mode == "changed": f.manager._active_preset = "lite"
            elif mode == "final-busy": f.manager.operation_lock.busy = True
            else: raise model_probe.ModelProbeError("unavailable")
            return {"status_code": 200, "data": {}}
        monkeypatch.setattr(model_probe, "probe_json", probe)
    snapshots = []

    def check():
        snapshots.append((f.manager_lock.held, f.manager.operation_lock.held))
        assert not f.manager_lock.held and not f.manager.operation_lock.held

    result = manager_module.BundledAIManager.observe_existing(check=check)
    assert result["status"] == expected
    assert snapshots and all(locks == (False, False) for locks in snapshots)
    assert not f.manager_lock.held and not f.manager.operation_lock.held


def test_model_operation_started_during_probe_makes_result_unknown(observation, monkeypatch):
    def probe(*args, **kwargs):
        observation.manager.operation_lock.busy = True
        return {"status_code": 200, "data": {}}
    monkeypatch.setattr(model_probe, "probe_json", probe)
    result = manager_module.BundledAIManager.observe_existing(check=observation.check)
    assert result["status"] == "busy"
    assert result["healthy"] is result["model_exists"] is result["active_preset"] is None
    assert not observation.manager.operation_lock.held


def test_authority_ending_after_final_snapshot_unlock_is_not_disclosed(observation, monkeypatch):
    f = observation
    original = f.manager.operation_lock.release
    releases = []
    f.error = HTTPException(503, "Unavailable")

    def release():
        original()
        releases.append(True)
        if len(releases) == 2:
            f.revoked = True

    monkeypatch.setattr(f.manager.operation_lock, "release", release)
    with pytest.raises(HTTPException) as raised:
        manager_module.BundledAIManager.observe_existing(check=f.check)
    assert raised.value is f.error and len(releases) == 2
    assert not f.manager.operation_lock.held


@pytest.mark.parametrize("host,url", [("localhost", "http://localhost:8089/v1/models"),
    ("127.0.0.2", "http://127.0.0.2:8089/v1/models"), ("::1", "http://[::1]:8089/v1/models")])
def test_explicit_loopback_runtime_addresses_are_supported(observation, monkeypatch, host, url):
    observation.manager.cfg.host = host
    calls = []
    def probe(actual_url, *, check):
        check()
        calls.append(actual_url)
        return {"status_code": 200, "data": {}}
    monkeypatch.setattr(model_probe, "probe_json", probe)
    assert manager_module.BundledAIManager.observe_existing(check=observation.check)["healthy"] is True
    assert calls == [url]


def test_selected_model_stat_failure_is_unknown_and_stops_network(observation, monkeypatch):
    original = Path.stat
    def stat(path, *args, **kwargs):
        if path == observation.model:
            raise PermissionError("Private model path is unreadable")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "stat", stat)
    result = manager_module.BundledAIManager.observe_existing(check=observation.check)
    assert result["status"] == "unavailable" and result["model_exists"] is None
    assert "probe" not in observation.calls


def test_ordinary_metric_failure_is_explicit_missing_without_invented_zero(observation, monkeypatch):
    def unavailable(*args, **kwargs):
        raise OSError("Private metric details")
    monkeypatch.setattr(routes.psutil, "disk_usage", unavailable)
    result = routes.agent_health(check=observation.check)
    assert result["disk_total_gb"] is result["disk_free_gb"] is result["disk_percent"] is None
    assert result["cpu_percent"] == 25
    assert result["ai_status"] == "observed"


def test_missing_selected_model_is_known_absence_without_directory_creation(observation):
    observation.model.unlink()
    result = manager_module.BundledAIManager.observe_existing(check=observation.check)
    assert result["model_exists"] is False
    assert result["healthy"] is True  # A running runtime can retain an already-open model.
    assert not observation.model.exists()


@pytest.mark.parametrize("service", [routes.agent_health, routes.agent_info])
@pytest.mark.parametrize("state", ["missing", "valid", "corrupt", "dependent"])
def test_actual_identity_reader_never_initializes_or_repairs(observation, monkeypatch, tmp_path, service, state):
    node = tmp_path / "data" / "mesh" / "node_config.json"
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(S, "NODE_CONFIG_PATH", node)
    # Restore the actual reader without reloading state or the app.
    monkeypatch.setattr(S, "read_node_config", REAL_NODE_READER)
    if state in {"valid", "corrupt"}:
        node.parent.mkdir(parents=True)
        node.write_bytes(json.dumps({"node_id": "saved-node", "node_name": "Fixture host",
            "created_at": "2001-01-01", "updated_at": "2001-01-01", "future": {"keep": True}}
        ).encode() if state == "valid" else b'{"private": damaged')
    if state == "dependent":
        dependency = node.parent / "mesh_directory.json"
        dependency.parent.mkdir(parents=True)
        dependency.write_bytes(b'{"saved-node": {"name": "Preserved member"}}')
    before = {str(p): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    if state in {"corrupt", "dependent"}:
        with pytest.raises(HTTPException) as raised:
            service(check=observation.check)
        assert raised.value.status_code == 503
        assert "probe" not in observation.calls
    else:
        result = service(check=observation.check)
        identity = result if service is routes.agent_health else result["node"]
        assert identity["node_id"] == ("saved-node" if state == "valid" else None)
    assert {str(p): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()} == before


REAL_NODE_READER = S.read_node_config
