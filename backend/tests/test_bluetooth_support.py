"""All Bluetooth objects are synthetic; no OS Bluetooth API is imported or used."""
import asyncio
import concurrent.futures
import threading
import time
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

import bluetooth_support as B


@pytest.fixture
def runtime(monkeypatch):
    monkeypatch.setattr(B, "_WORKER", None)
    monkeypatch.setattr(B.sys, "platform", "win32")
    monkeypatch.setattr(B.sys, "getwindowsversion", lambda: SimpleNamespace(build=22000), raising=False)
    monkeypatch.setattr(B.importlib.metadata, "version", lambda name: "3.0.2")
    monkeypatch.setattr(B, "SCAN_SECONDS", 0.005)
    monkeypatch.setattr(B, "CLEANUP_SECONDS", 0.025)
    original = B.importlib.import_module
    def forbid(name, *args, **kwargs):
        if name == "bleak":
            raise AssertionError("A test attempted to import the real BLE runtime")
        return original(name, *args, **kwargs)
    monkeypatch.setattr(B.importlib, "import_module", forbid)
    yield
    worker = B._WORKER
    if worker is not None and worker.loop is not None:
        worker.loop.call_soon_threadsafe(worker.loop.stop)
        worker.thread.join(timeout=1)
        assert not worker.thread.is_alive()
        worker.loop.close()


@pytest.mark.parametrize("value", [None, "", "AA", "AA-BB-CC-DD-EE-FF", "aa:bb:cc:dd:ee:ff ", "aa:bb:cc:dd:ee:ff\n", "GG:BB:CC:DD:EE:FF", "AA:BB:CC:DD:EE:FF:00", 12])
def test_bad_addresses(value):
    with pytest.raises(ValueError):
        B.canonical_address(value)


def test_canonical_address():
    assert B.canonical_address("aa:Bb:cc:DD:ee:ff") == "AA:BB:CC:DD:EE:FF"


def test_support_does_not_import_or_start_worker(runtime):
    assert B.support_status(check=lambda: None) == {"available": True, "platform": "win32", "reason": "runtime_ready"}
    assert B._WORKER is None


@pytest.mark.parametrize("platform,build,version,reason", [
    ("linux", 22000, "3.0.2", "windows_required"),
    ("darwin", 22000, "3.0.2", "windows_required"),
    ("win32", 19045, "3.0.2", "windows_11_required"),
    ("win32", 22000, "0.22.3", "dependency_version_unsupported"),
    ("win32", 22000, "3.0.1", "dependency_version_unsupported"),
    ("win32", 22000, "3.1.0", "dependency_version_unsupported"),
])
def test_runtime_gates_without_radio(runtime, monkeypatch, platform, build, version, reason):
    monkeypatch.setattr(B.sys, "platform", platform)
    monkeypatch.setattr(B.sys, "getwindowsversion", lambda: SimpleNamespace(build=build))
    monkeypatch.setattr(B.importlib.metadata, "version", lambda name: version)
    result = B.support_status(check=lambda: None)
    assert result["available"] is False and result["reason"] == reason
    assert B._WORKER is None


@pytest.mark.parametrize("failure,reason", [(B.importlib.metadata.PackageNotFoundError("bleak"), "dependency_missing"), (OSError("private"), "dependency_unavailable")])
def test_metadata_failures_are_generic(runtime, monkeypatch, failure, reason):
    def fail(name):
        raise failure
    monkeypatch.setattr(B.importlib.metadata, "version", fail)
    assert B.support_status(check=lambda: None)["reason"] == reason
    assert B._WORKER is None


@pytest.mark.parametrize("failure", [HTTPException(401, "gone"), HTTPException(503, "unavailable"), FileNotFoundError("one-shot"), OSError("one-shot")])
def test_first_authority_error_is_sticky(failure):
    calls = []
    def check():
        calls.append(1)
        if len(calls) == 1:
            raise failure
    access = B.Access(check)
    for _ in range(2):
        with pytest.raises(type(failure)) as caught:
            access()
        assert caught.value is failure
    assert calls == [1]


@pytest.mark.parametrize("operation", [B.support_status, B.discover])
def test_no_authority_refused_before_runtime(runtime, operation):
    with pytest.raises(HTTPException) as caught:
        operation(check=None)
    assert caught.value.status_code == 403 and B._WORKER is None


def test_final_metadata_denial_preserved(runtime, monkeypatch):
    error = HTTPException(401, "gone")
    revoked = False
    def version(name):
        nonlocal revoked
        revoked = True
        return "3.0.2"
    def check():
        if revoked:
            raise error
    monkeypatch.setattr(B.importlib.metadata, "version", version)
    with pytest.raises(HTTPException) as caught:
        B.support_status(check=check)
    assert caught.value is error and B._WORKER is None


def test_persistent_loop_and_lazy_import_only_after_operation(runtime, monkeypatch):
    loops, imports = [], []
    def imported(name):
        imports.append((name, threading.get_ident()))
        return SimpleNamespace()
    monkeypatch.setattr(B.importlib, "import_module", imported)
    async def operation(module, access, worker):
        loops.append(asyncio.get_running_loop())
        return threading.get_ident()
    first = B.run(operation, check=lambda: None)
    second = B.run(operation, check=lambda: None)
    assert first == second != threading.get_ident()
    assert loops[0] is loops[1] is B._WORKER.loop
    assert all(name == "bleak" and ident == first for name, ident in imports)


def test_busy_admission_has_no_queue(runtime, monkeypatch):
    monkeypatch.setattr(B.importlib, "import_module", lambda name: SimpleNamespace())
    entered, release = threading.Event(), threading.Event()
    async def operation(module, access, worker):
        entered.set()
        while not release.is_set():
            await B.checked_await(access, lambda: asyncio.sleep(0.005))
        return "finished"
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(B.run, operation, check=lambda: None)
        assert entered.wait(1)
        try:
            with pytest.raises(B.BluetoothError, match="bluetooth_busy"):
                B.run(operation, check=lambda: None)
        finally:
            release.set()
        assert first.result(1) == "finished"


@pytest.mark.parametrize("stage", ["start", "wait", "stop"])
@pytest.mark.parametrize("failure", [HTTPException(401, "gone"), HTTPException(503, "unavailable"), OSError("one-shot")])
def test_scan_revocation_cleans_and_does_not_cache(runtime, monkeypatch, stage, failure):
    calls, revoked = [], False
    def check():
        nonlocal revoked
        if revoked:
            revoked = False  # first denial must survive a later successful callback
            raise failure
    class Scanner:
        def __init__(self, detection_callback):
            self.callback = detection_callback
        async def start(self):
            nonlocal revoked
            calls.append("start")
            self.callback(SimpleNamespace(address="AA:BB:CC:DD:EE:FF", name="H6125"), SimpleNamespace(local_name=None))
            if stage == "start":
                revoked = True
            if stage == "wait":
                asyncio.get_running_loop().call_soon(lambda: lose())
        async def stop(self):
            nonlocal revoked
            calls.append("stop")
            if stage == "stop":
                revoked = True
    def lose():
        nonlocal revoked
        revoked = True
    monkeypatch.setattr(B.importlib, "import_module", lambda name: SimpleNamespace(BleakScanner=Scanner))
    with pytest.raises(type(failure)) as caught:
        B.discover(check=check)
    assert caught.value is failure
    assert calls == ["start", "stop"] and B._WORKER.devices == {}


def test_discovery_bounded_rows_sanitizes_metadata(runtime, monkeypatch):
    class Scanner:
        def __init__(self, detection_callback):
            self.callback = detection_callback
        async def start(self):
            for i in range(80):
                self.callback(SimpleNamespace(address=f"AA:BB:CC:DD:EE:{i:02X}", name="ignored"), SimpleNamespace(local_name="Govee_H6125_1234\n" if i == 0 else "Other"))
            self.callback(SimpleNamespace(address="PRIVATE INVALID", name="bad"), SimpleNamespace(local_name=None))
        async def stop(self):
            pass
    monkeypatch.setattr(B.importlib, "import_module", lambda name: SimpleNamespace(BleakScanner=Scanner))
    rows = B.discover(check=lambda: None)
    assert len(rows) == B.MAX_DEVICES
    assert rows[0] == {"address": "AA:BB:CC:DD:EE:00", "name": "Govee_H6125_1234", "model": "H6125", "supported": True,
                       "profile_hints": ["govee_h6125_v1"]}
    assert rows[1]["model"] is None and rows[1]["supported"] is False
    assert rows[1]["profile_hints"] == []
    assert all(set(row) == {"address", "name", "model", "supported", "profile_hints"} for row in rows)


@pytest.mark.parametrize("stage", ["start", "stop"])
def test_scan_native_failure_is_generic_and_stopped(runtime, monkeypatch, stage):
    calls = []
    class Scanner:
        def __init__(self, **kwargs):
            pass
        async def start(self):
            calls.append("start")
            if stage == "start":
                raise OSError("PRIVATE MAC")
        async def stop(self):
            calls.append("stop")
            if stage == "stop":
                raise OSError("PRIVATE MAC")
    monkeypatch.setattr(B.importlib, "import_module", lambda name: SimpleNamespace(BleakScanner=Scanner))
    with pytest.raises(B.BluetoothError) as caught:
        B.discover(check=lambda: None)
    assert "PRIVATE" not in str(caught.value)
    assert calls == ["start", "stop"] and B._WORKER.devices == {}
    if stage == "stop":
        assert B.support_status(check=lambda: None)["reason"] == "cleanup_pending"


def test_expired_operation_cannot_dispatch():
    access = B.Access(lambda: None)
    access.deadline = 0
    calls = []
    async def run():
        await B.checked_await(access, lambda: calls.append("effect"))
    with pytest.raises(B.BluetoothError, match="operation_timeout"):
        asyncio.run(run())
    assert calls == []


def test_cleanup_timeout_latches_worker_without_retry(runtime):
    B._WORKER = B._Worker()  # no thread started
    calls = []
    async def slow():
        calls.append("cleanup")
        await asyncio.sleep(60)
    assert asyncio.run(B.cleanup(slow)) is False
    assert B._WORKER.poisoned and calls == ["cleanup"]
    with pytest.raises(B.BluetoothError, match="cleanup_pending"):
        B.run(lambda *args: None, check=lambda: None)


def test_poisoned_transport_blocks_followup_factory(runtime):
    B._WORKER = B._Worker()
    B._WORKER.poisoned = True
    calls = []
    async def run():
        await B.checked_await(B.Access(lambda: None), lambda: calls.append("effect"))
    with pytest.raises(B.BluetoothError, match="cleanup_pending"):
        asyncio.run(run())
    assert calls == []


def test_native_timeout_is_not_mistaken_for_pending_future(runtime, monkeypatch):
    monkeypatch.setattr(B.importlib, "import_module", lambda name: SimpleNamespace())
    calls = []
    async def failed(module, access, worker):
        calls.append("native")
        raise TimeoutError("PRIVATE")
    started = time.monotonic()
    with pytest.raises(B.BluetoothError, match="bluetooth_unavailable"):
        B.run(failed, check=lambda: None)
    assert time.monotonic() - started < 1
    assert calls == ["native"]


def test_noncancellable_native_wait_poison_blocks_same_operation(runtime, monkeypatch):
    B._WORKER = B._Worker()
    calls = []
    async def scenario():
        release = asyncio.Event()
        finished = asyncio.Event()
        async def stubborn():
            calls.append("native")
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()
            finally:
                finished.set()
        try:
            with pytest.raises(B.BluetoothError, match="operation_timeout"):
                await B.checked_await(B.Access(lambda: None), stubborn, timeout=0.005)
            assert B._WORKER.poisoned
            with pytest.raises(B.BluetoothError, match="cleanup_pending"):
                await B.checked_await(B.Access(lambda: None), lambda: calls.append("second effect"))
        finally:
            release.set()
            await asyncio.wait_for(finished.wait(), timeout=1)
            await asyncio.sleep(0)
    asyncio.run(scenario())
    assert calls == ["native"]


def test_outer_deadline_quarantines_stuck_worker_and_stops_late_effect(runtime, monkeypatch):
    monkeypatch.setattr(B.importlib, "import_module", lambda name: SimpleNamespace())
    monkeypatch.setattr(B, "OPERATION_SECONDS", 0.01)
    monkeypatch.setattr(B, "CLEANUP_SECONDS", 0.005)
    release, finished = threading.Event(), threading.Event()
    calls = []
    async def blocked(module, access, worker):
        try:
            calls.append("native-block")
            release.wait(3)  # synthetic noncooperative native call; no real I/O
            access()
            calls.append("late-effect")
        finally:
            finished.set()
    try:
        started = time.monotonic()
        with pytest.raises(B.BluetoothError, match="operation_timeout"):
            B.run(blocked, check=lambda: None)
        assert time.monotonic() - started < 2
        assert B._WORKER.poisoned
        with pytest.raises(B.BluetoothError, match="cleanup_pending"):
            B.run(blocked, check=lambda: None)
    finally:
        release.set()
        assert finished.wait(1)
        # Let run_coroutine_threadsafe deliver its terminal completion to its future.
        asyncio.run_coroutine_threadsafe(asyncio.sleep(0), B._WORKER.loop).result(1)
    assert calls == ["native-block"]


def test_discovery_uses_catalog_for_synthetic_second_brand_without_protocol_dispatch(runtime, monkeypatch):
    import bluetooth_profiles as P
    synthetic = P.Profile(id="fixture_light_v1", vendor="fixture_ble", brand="Test fixture brand",
                          model="T9001", id_prefix="fixture-ble-", capabilities=("switch.on", "switch.off"))
    monkeypatch.setattr(P, "_PROFILES", (*P._PROFILES, synthetic))
    calls = []
    class Scanner:
        def __init__(self, detection_callback):
            self.callback = detection_callback
        async def start(self):
            calls.append("scan")
            for suffix, name in ((0, "Fixture_T9001_1234"), (1, "Govee_H6125_1234"), (2, "Unknown Light")):
                self.callback(SimpleNamespace(address=f"AA:BB:CC:DD:EE:{suffix:02X}", name=name), SimpleNamespace(local_name=None))
        async def stop(self):
            calls.append("stop")
    monkeypatch.setattr(B.importlib, "import_module", lambda name: SimpleNamespace(BleakScanner=Scanner))
    rows = B.discover(check=lambda: None)
    assert rows[0]["profile_hints"] == ["fixture_light_v1"] and rows[0]["model"] == "T9001"
    assert rows[1]["profile_hints"] == ["govee_h6125_v1"] and rows[1]["model"] == "H6125"
    assert rows[2]["profile_hints"] == [] and rows[2]["model"] is None and rows[2]["supported"] is False
    assert calls == ["scan", "stop"]


def test_discovery_ambiguous_model_has_hints_but_no_legacy_supported_guess(runtime, monkeypatch):
    import bluetooth_profiles as P
    synthetic = P.Profile(id="fixture_other_v1", vendor="fixture_ble", brand="Test fixture brand",
                          model="H6125", id_prefix="fixture-ble-", capabilities=("switch.on", "switch.off"))
    monkeypatch.setattr(P, "_PROFILES", (*P._PROFILES, synthetic))
    class Scanner:
        def __init__(self, detection_callback):
            self.callback = detection_callback
        async def start(self):
            self.callback(SimpleNamespace(address="AA:BB:CC:DD:EE:FF", name="H6125"), SimpleNamespace(local_name=None))
        async def stop(self):
            pass
    monkeypatch.setattr(B.importlib, "import_module", lambda name: SimpleNamespace(BleakScanner=Scanner))
    row = B.discover(check=lambda: None)[0]
    assert row["profile_hints"] == ["govee_h6125_v1", "fixture_other_v1"]
    assert row["model"] is None and row["supported"] is False


def test_invalid_source_catalog_fails_before_scanner_creation(runtime, monkeypatch):
    import bluetooth_profiles as P
    monkeypatch.setattr(P, "_PROFILES", (*P._PROFILES, P._PROFILES[0]))
    calls = []
    monkeypatch.setattr(B.importlib, "import_module", lambda name: SimpleNamespace(
        BleakScanner=lambda **kwargs: calls.append("scanner")))
    with pytest.raises(B.BluetoothError, match="bluetooth_unavailable"):
        B.discover(check=lambda: None)
    assert calls == [] and B._WORKER.devices == {}
