"""Local first-launch address selection never moves an existing installation."""
from pathlib import Path
import socket

import pytest

import host_control as H
import host_launcher as L
import launch_checks
import startup_config as C

READ_RECORDED_GENERATIONS = L.recorded_backend_generations


@pytest.fixture
def first_launch(tmp_path, monkeypatch):
    for key in ("TLI_HOST", "TLI_PORT", "TLI_ENABLE_TLS", "TLI_LAN_MODE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(L, "pending_backend", lambda root: False)
    monkeypatch.setattr(L, "recorded_backend_generations", lambda root: [])
    monkeypatch.setattr(L, "spawn_fixed", lambda *a, **kw: pytest.fail("Preparation must not spawn a process."))
    monkeypatch.setattr(L.webbrowser, "open", lambda *a, **kw: pytest.fail("Preparation must not open a browser."))
    monkeypatch.setattr(L, "check_packaged_runtime", lambda *a: pytest.fail("Preparation must not probe inference."))
    return tmp_path


def occupy_default(monkeypatch):
    """Keep a genuine unrelated listener alive throughout preparation."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    monkeypatch.setattr(C, "DEFAULTS", {**C.DEFAULTS, "port": listener.getsockname()[1]})
    return listener


def default_busy(monkeypatch):
    checked = []

    def check(host, port):
        checked.append((host, port))
        if port == C.DEFAULTS["port"]:
            raise RuntimeError("Address in use")

    monkeypatch.setattr(launch_checks, "check_port", check)
    return checked


def assert_unchanged(root):
    before = C.resolve(root)
    assert L.prepare_first_launch(root) == before
    assert not C.config_path(root).exists()


def test_unrelated_listener_gets_persisted_loopback_alternative(first_launch, monkeypatch):
    with occupy_default(monkeypatch) as listener:
        occupied_port = listener.getsockname()[1]
        messages = []
        result = L.prepare_first_launch(first_launch, progress=messages.append)

        assert result["configured"] is True
        assert result["environment_overrides"] == []
        assert result["effective_next"] == result["saved"]
        assert result["saved"]["host"] == "127.0.0.1"
        assert result["saved"]["https"] is False
        assert result["saved"]["port"] != occupied_port
        assert C.resolve(first_launch) == result
        launch_checks.check_port("127.0.0.1", result["saved"]["port"])
        # The other application's listener remains alive and bound.
        assert listener.getsockname()[1] == occupied_port
        with pytest.raises(RuntimeError):
            launch_checks.check_port("127.0.0.1", occupied_port)
        assert messages


def test_free_default_does_not_create_saved_settings(first_launch, monkeypatch):
    checked = []
    monkeypatch.setattr(launch_checks, "check_port", lambda host, port: checked.append((host, port)))
    result = L.prepare_first_launch(first_launch)
    assert result == C.resolve(first_launch)
    assert result["configured"] is False
    assert result["effective_next"] == C.DEFAULTS
    assert checked == [(C.DEFAULTS["host"], C.DEFAULTS["port"])]
    assert not C.config_path(first_launch).exists()


def test_exhausted_preferred_ports_use_os_assigned_local_port(first_launch, monkeypatch):
    real_check = launch_checks.check_port
    checked = []

    def busy(host, port):
        checked.append((host, port))
        raise RuntimeError("Address in use")

    monkeypatch.setattr(launch_checks, "check_port", busy)
    result = L.prepare_first_launch(first_launch)
    assert checked == [("127.0.0.1", port) for port in [8000, *range(8002, 8021)]]
    assert result["saved"]["host"] == "127.0.0.1"
    assert result["saved"]["port"] not in {8000, 8001, *range(8002, 8021)}
    real_check("127.0.0.1", result["saved"]["port"])
    assert C.resolve(first_launch) == result


@pytest.mark.parametrize("settings", [
    {"host": "127.0.0.1", "port": 8000, "https": False},
    {"host": "127.0.0.1", "port": 8123, "https": False},
    {"host": "0.0.0.0", "port": 8443, "https": True},
])
def test_saved_address_is_preserved_even_when_occupied(first_launch, monkeypatch, settings):
    C.write(settings, first_launch)
    original = C.config_path(first_launch).read_bytes()
    monkeypatch.setattr(launch_checks, "check_port", lambda *a: pytest.fail("Saved choices must not be reconsidered."))
    result = L.prepare_first_launch(first_launch)
    assert result["effective_next"] == settings
    assert result["configured"] is True
    assert C.config_path(first_launch).read_bytes() == original


@pytest.mark.parametrize("key,value", [
    ("TLI_PORT", "8000"), ("TLI_PORT", "8123"),
    ("TLI_HOST", "127.0.0.1"), ("TLI_ENABLE_TLS", "0"),
    ("TLI_LAN_MODE", "0"),
])
def test_explicit_environment_choice_disables_fallback(first_launch, monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    before = C.resolve(first_launch)
    monkeypatch.setattr(launch_checks, "check_port", lambda *a: pytest.fail("An explicit choice must be preserved."))
    assert L.prepare_first_launch(first_launch) == before
    assert not C.config_path(first_launch).exists()


def test_invalid_environment_stops_preparation(first_launch, monkeypatch):
    monkeypatch.setenv("TLI_PORT", "not-a-port")
    monkeypatch.setattr(launch_checks, "check_port", lambda *a: pytest.fail("Invalid configuration must fail before port checks."))
    with pytest.raises(C.StartupConfigurationError):
        L.prepare_first_launch(first_launch)
    assert not C.config_path(first_launch).exists()


def test_damaged_saved_configuration_is_not_replaced(first_launch, monkeypatch):
    path = C.config_path(first_launch)
    path.parent.mkdir(parents=True)
    original = b'{"version": 1, "port":'
    path.write_bytes(original)
    monkeypatch.setattr(launch_checks, "check_port", lambda *a: pytest.fail("Damage must fail before probing another address."))
    with pytest.raises(C.StartupConfigurationError):
        L.prepare_first_launch(first_launch)
    assert path.read_bytes() == original


def test_pending_owned_backend_does_not_move(first_launch, monkeypatch):
    default_busy(monkeypatch)
    monkeypatch.setattr(L, "pending_backend", lambda root: True)
    assert_unchanged(first_launch)


@pytest.mark.parametrize("state", ["running", "unknown", "exited"])
def test_recorded_backend_generation_disables_first_launch_selection(first_launch, monkeypatch, state):
    default_busy(monkeypatch)
    child = {"pid": 1234, "created_at": 12.0, "script": "main.py"}
    monkeypatch.setattr(L, "recorded_backend_generations", lambda root: [child])
    def generation(root, value):
        return state

    monkeypatch.setattr(L, "process_generation_state", generation)
    assert_unchanged(first_launch)


@pytest.mark.parametrize("relative", ["data/node_identity.json", "data/mesh/node_config.json"])
def test_previous_installation_state_preserves_unsaved_default(first_launch, monkeypatch, relative):
    default_busy(monkeypatch)
    path = first_launch / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"existing private installation state")
    assert_unchanged(first_launch)
    assert path.read_bytes() == b"existing private installation state"


@pytest.mark.parametrize("filename,raw", [
    ("desktop-child.json", b"{}"),
    ("desktop-child.json", b"[]"),
    ("requests.json", b'{"requests": []}'),
    ("requests.json", b'{"requests": [{"phase": "accepted", "child": {}}]}'),
])
def test_retained_receipt_without_recognized_generation_blocks_fallback(first_launch, monkeypatch, filename, raw):
    path = first_launch / "data" / "host_control" / filename
    path.parent.mkdir(parents=True)
    path.write_bytes(raw)
    monkeypatch.setattr(L, "recorded_backend_generations", READ_RECORDED_GENERATIONS)
    # These shapes previously disappeared from the generation projection.
    assert L.recorded_backend_generations(first_launch) == []
    monkeypatch.setattr(launch_checks, "check_port", lambda *a: pytest.fail("Retained receipts must prevent address selection."))
    assert_unchanged(first_launch)
    assert path.read_bytes() == raw


def test_unreadable_marker_metadata_cannot_establish_first_launch(first_launch, monkeypatch):
    original_lstat = Path.lstat
    blocked = first_launch / "data" / "node_identity.json"

    def inaccessible(path, *args, **kwargs):
        if path == blocked:
            raise PermissionError("Marker metadata unavailable")
        return original_lstat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", inaccessible)
    monkeypatch.setattr(launch_checks, "check_port", lambda *a: pytest.fail("Unavailable evidence must prevent port checks."))
    with pytest.raises(PermissionError, match="Marker metadata unavailable"):
        L.prepare_first_launch(first_launch)
    assert not C.config_path(first_launch).exists()


@pytest.mark.parametrize("reader", ["pending_backend", "recorded_backend_generations"])
def test_unavailable_ownership_evidence_does_not_save(first_launch, monkeypatch, reader):
    default_busy(monkeypatch)

    def unavailable(root):
        raise H.HostControlError(503, "Owned-process evidence unavailable")

    monkeypatch.setattr(L, reader, unavailable)
    with pytest.raises(H.HostControlError):
        L.prepare_first_launch(first_launch)
    assert not C.config_path(first_launch).exists()


def test_failed_publication_does_not_return_alternate_address(first_launch, monkeypatch):
    default_busy(monkeypatch)

    def fail(value, root=None):
        raise C.StartupConfigurationError("Settings could not be saved")

    monkeypatch.setattr(C, "create_if_absent", fail)
    with pytest.raises(C.StartupConfigurationError, match="could not be saved"):
        L.prepare_first_launch(first_launch)
    assert not C.config_path(first_launch).exists()


def test_concurrent_saved_choice_wins_over_suggested_address(first_launch, monkeypatch):
    default_busy(monkeypatch)
    create = C.create_if_absent
    concurrent = {"host": "127.0.0.1", "port": 9137, "https": False}

    def another_save_first(value, root=None):
        C.write(concurrent, root)
        return create(value, root)

    monkeypatch.setattr(C, "create_if_absent", another_save_first)
    result = L.prepare_first_launch(first_launch)
    assert result["configured"] is True
    assert result["saved"] == concurrent
    assert result == C.resolve(first_launch)


def test_launch_holds_lock_through_probe_and_publication(first_launch, monkeypatch):
    actual_lock = H.FileLock
    actual_create = C.create_if_absent
    active = []
    events = []

    class ObservedLock:
        def __init__(self, path):
            self.path = path
            self.lock = actual_lock(path)

        def __enter__(self):
            self.lock.__enter__()
            active.append(self.path.name)
            return self

        def __exit__(self, *args):
            active.pop()
            return self.lock.__exit__(*args)

    def check(host, port):
        assert active == ["launch.lock"]
        events.append("probe")
        if port == C.DEFAULTS["port"]:
            raise RuntimeError("Address in use")

    def create(value, root=None):
        assert active == ["launch.lock"]
        events.append("publish")
        return actual_create(value, root)

    monkeypatch.setattr(H, "FileLock", ObservedLock)
    monkeypatch.setattr(launch_checks, "check_port", check)
    monkeypatch.setattr(C, "create_if_absent", create)
    monkeypatch.setattr(L, "inspect_backend", lambda root, settings: ("running", "Verified owned backend"))
    monkeypatch.setattr(L, "verify_release", lambda root, settings: None)
    assert L.launch(first_launch, open_browser=False)["backend_state"] == "running"
    assert "probe" in events and events[-1] == "publish"
    assert active == []


def test_create_if_absent_preserves_existing_file(first_launch):
    original = {"host": "127.0.0.1", "port": 8123, "https": False}
    C.write(original, first_launch)
    path = C.config_path(first_launch)
    raw = path.read_bytes()
    C.create_if_absent({**original, "port": 8124}, first_launch)
    assert path.read_bytes() == raw
    assert C.resolve(first_launch)["saved"] == original


def test_create_if_absent_preserves_unreadable_file(first_launch):
    path = C.config_path(first_launch)
    path.parent.mkdir(parents=True)
    path.write_bytes(b"damaged startup state")
    try:
        C.create_if_absent(dict(C.DEFAULTS), first_launch)
    except C.StartupConfigurationError:
        pass
    assert path.read_bytes() == b"damaged startup state"


def test_launch_uses_saved_alternative_for_child_and_verified_url(first_launch, monkeypatch):
    observations = iter([("stopped", "Not running"), ("running", "Verified owned backend")])
    monkeypatch.setattr(L, "inspect_backend", lambda root, settings: next(observations))
    monkeypatch.setattr(L, "check_packaged_runtime", lambda root: None)
    monkeypatch.setattr(L.time, "sleep", lambda seconds: None)
    launched = []
    verified = []

    def spawn(root, settings):
        launched.append(dict(settings))
        return {"pid": 1234, "created_at": 12.0, "script": "main.py"}

    monkeypatch.setattr(L, "spawn_backend", spawn)
    monkeypatch.setattr(L, "verify_release", lambda root, settings: verified.append(dict(settings)))
    with occupy_default(monkeypatch) as listener:
        result = L.launch(first_launch, open_browser=False)
        saved = C.resolve(first_launch)["saved"]
        assert saved["port"] != listener.getsockname()[1]
        assert launched == verified == [saved]
        assert result["url"] == C.browser_url(saved)
        assert result["backend_state"] == "running"


def test_launch_with_explicit_settings_does_not_choose_alternative(first_launch, monkeypatch):
    explicit = {"host": "127.0.0.1", "port": 8137, "https": False}
    monkeypatch.setattr(L, "prepare_first_launch", lambda *a, **kw: pytest.fail("Explicit startup must not choose another address."))
    monkeypatch.setattr(L, "inspect_backend", lambda root, settings: ("running", "Verified owned backend"))
    monkeypatch.setattr(L, "verify_release", lambda root, settings: None)
    result = L.launch(first_launch, settings=explicit, open_browser=False)
    assert result["url"] == C.browser_url(explicit)
    assert not C.config_path(first_launch).exists()


def test_later_bind_race_stops_launch_without_selecting_another_port(first_launch, monkeypatch):
    checked = default_busy(monkeypatch)
    monkeypatch.setattr(L, "inspect_backend", lambda root, settings: ("unavailable", "Another process took the address"))
    with pytest.raises(H.HostControlError, match="Another process took the address"):
        L.launch(first_launch, open_browser=False)
    saved = C.resolve(first_launch)
    assert saved["configured"] is True
    assert saved["saved"]["port"] == 8002
    assert L.prepare_first_launch(first_launch) == saved
    assert checked == [("127.0.0.1", 8000), ("127.0.0.1", 8002)]
