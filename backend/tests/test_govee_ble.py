"""Synthetic H6125 candidate-profile tests; these do not establish hardware support."""
import asyncio
import copy
from functools import reduce
from operator import xor
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

import bluetooth_support as B
from drivers import govee_ble as G
from tests.test_bluetooth_support import runtime  # fake-only runtime and worker teardown


DEVICE = {"vendor": "govee_ble", "ip": "ble://AA:BB:CC:DD:EE:FF", "extra": {
    "transport": "bluetooth", "model": "H6125", "address": "AA:BB:CC:DD:EE:FF", "profile": G.PROFILE}}


def reply(on):
    body = bytes((0xAA, 1, on)) + bytes(16)
    return body + bytes((reduce(xor, body),))


@pytest.fixture
def radio(runtime, monkeypatch):
    f = SimpleNamespace(calls=[], fail=None, revoke=None, revoked=False, failure=HTTPException(401, "ended"),
                        packets=[reply(1)], early=None, wrong_sender=False, check_count=0)
    f.control = SimpleNamespace(uuid=G.CONTROL_UUID, properties=["write-without-response"], max_write_without_response_size=20)
    f.notify = SimpleNamespace(uuid=G.NOTIFY_UUID, properties=["notify"])
    f.characteristics = [f.control, f.notify]
    def phase(name):
        f.calls.append(name)
        if f.revoke == name:
            f.revoked = True
        if f.fail == name:
            raise OSError("PRIVATE address/native error")
    def check():
        f.check_count += 1
        if f.revoked:
            f.revoked = False  # prove a one-shot denial remains sticky
            raise f.failure
    class Scanner:
        def __init__(self, detection_callback):
            self.callback = detection_callback
            phase("scanner")
        async def start(self):
            phase("scan_start")
            self.callback(SimpleNamespace(address="AA:BB:CC:DD:EE:FF", name="Govee_H6125"), SimpleNamespace(local_name=None))
        async def stop(self):
            phase("scan_stop")
    class Client:
        def __init__(self, device, **kwargs):
            assert not isinstance(device, str), "Never permit implicit string-address scan"
            assert device.address == "AA:BB:CC:DD:EE:FF"
            self.is_connected = False
            self.callback = None
            phase("client")
        @property
        def services(self):
            phase("services")
            return [SimpleNamespace(characteristics=f.characteristics)]
        async def connect(self):
            phase("connect")
            self.is_connected = True
        async def disconnect(self):
            phase("disconnect")
            self.is_connected = False
        async def start_notify(self, char, callback):
            assert char is f.notify
            self.callback = callback
            phase("notify")
            if f.early is not None:
                callback(f.notify, f.early)
        async def stop_notify(self, char):
            phase("stop_notify")
            self.callback = None
        async def write_gatt_char(self, char, packet, *, response):
            assert char is f.control and response is False
            if packet == G.POWER_QUERY:
                phase("query")
                for data in f.packets:
                    self.callback(object() if f.wrong_sender else f.notify, data)
            else:
                phase("write")
                f.sent = packet
    f.check = check
    f.Client = Client
    f.Scanner = Scanner
    monkeypatch.setattr(B.importlib, "import_module", lambda name: SimpleNamespace(BleakScanner=Scanner, BleakClient=Client))
    # Keep successful waits tiny; timeout-specific tests override checked_await below.
    return f


@pytest.mark.parametrize("on,checksum", [(False, 0x32), (True, 0x33)])
def test_power_packet_exact_layout(on, checksum):
    assert G.power_packet(on) == bytes((0x33, 1, int(on))) + bytes(16) + bytes((checksum,))
    assert len(G.power_packet(on)) == 20


@pytest.mark.parametrize("value", [None, 0, 1, "on", [], {}])
def test_power_encoder_requires_bool(value):
    with pytest.raises(ValueError):
        G.power_packet(value)


def test_query_packet():
    assert G.POWER_QUERY == bytes((0xAA, 1)) + bytes(17) + b"\xab"


@pytest.mark.parametrize("value,expected", [(reply(0), False), (reply(1), True), (bytearray(reply(0)), False)])
def test_valid_power_reply(value, expected):
    assert G.parse_power(value) is expected


@pytest.mark.parametrize("value", [None, "AA0101", b"", b"\xaa\x01\x01", reply(2), reply(255), reply(1)[:-1], reply(1)+b"\x00", G.power_packet(True), bytes(20), reply(1)[:-1]+b"\x00"])
def test_invalid_reply_never_becomes_off(value):
    assert G.parse_power(value) is None


@pytest.mark.parametrize("index", [0, 1, 3, 12, 18])
def test_rejects_wrong_domain_or_reserved_bytes_even_with_valid_checksum(index):
    packet = bytearray(reply(1))
    packet[index] ^= 1
    packet[19] = reduce(xor, packet[:19])
    assert G.parse_power(packet) is None


@pytest.mark.parametrize("action,on", [("switch.on", True), ("switch.off", False)])
def test_write_is_single_sent_unacknowledged_not_verified(radio, action, on):
    result = G.GoveeBLEDriver().execute_checked(DEVICE, action, check=radio.check)
    assert result["ok"] is True and result["acknowledged"] is False
    assert result["outcome"] == "sent" and result["verified"] is False
    assert "on" not in result and radio.sent == G.power_packet(on)
    assert radio.calls.count("write") == 1
    assert "query" not in radio.calls and radio.calls[-1] == "disconnect"


def test_probe_only_connects_validates_and_disconnects(radio):
    result = G.GoveeBLEDriver().probe_checked(DEVICE, check=radio.check)
    assert result["ok"] is True and result["profile"] == G.PROFILE and result["experimental"] is True
    assert radio.calls == ["scanner", "scan_start", "scan_stop", "client", "connect", "services", "disconnect"]


@pytest.mark.parametrize("on", [0, 1])
def test_status_requires_fresh_valid_notification(radio, on):
    radio.packets = [reply(on)]
    result = G.GoveeBLEDriver().get_status_checked(DEVICE, check=radio.check)
    assert result["ok"] is True and result["on"] is bool(on) and result["verified"] is True
    assert radio.calls.count("query") == 1 and "write" not in radio.calls
    assert radio.calls[-2:] == ["stop_notify", "disconnect"]


@pytest.mark.parametrize("variant", ["missing", "early", "wrong_sender", "bad_checksum", "wrong_domain", "short", "nonboolean"])
def test_status_unknown_without_valid_fresh_reply(radio, monkeypatch, variant):
    radio.packets = []
    if variant == "early":
        radio.early = reply(0)
    elif variant == "wrong_sender":
        radio.packets, radio.wrong_sender = [reply(1)], True
    elif variant == "bad_checksum":
        radio.packets = [reply(0)[:-1] + b"\x00"]
    elif variant == "wrong_domain":
        radio.packets = [G.power_packet(True)]
    elif variant == "short":
        radio.packets = [b"\xaa\x01\x01"]
    elif variant == "nonboolean":
        radio.packets = [reply(2)]
    original = B.checked_await
    async def bounded(access, factory, **kwargs):
        if getattr(factory, "__name__", None) == "wait":
            kwargs["timeout"] = 0.01
        return await original(access, factory, **kwargs)
    monkeypatch.setattr(B, "checked_await", bounded)
    result = G.GoveeBLEDriver().get_status_checked(DEVICE, check=radio.check)
    assert result["ok"] is False and result["on"] is None and result["verified"] is False
    assert radio.calls[-2:] == ["stop_notify", "disconnect"]


@pytest.mark.parametrize("field,value", [("vendor", "govee"), ("ip", "192.0.2.1"), ("extra", {}), ("model", "H617C"), ("profile", "invented"), ("transport", "lan"), ("address", "BAD")])
def test_invalid_binding_before_radio(radio, field, value):
    device = copy.deepcopy(DEVICE)
    if field in {"vendor", "ip", "extra"}:
        device[field] = value
    else:
        device["extra"][field] = value
    result = G.GoveeBLEDriver().probe_checked(device, check=radio.check)
    assert result["ok"] is False and result["error"] == "invalid_device"
    assert radio.calls == []


@pytest.mark.parametrize("capability", ["switch.toggle", "light.brightness", "light.color", "script.run", ""])
def test_unsupported_capability_no_radio(radio, capability):
    result = G.GoveeBLEDriver().execute_checked(DEVICE, capability, check=radio.check)
    assert result["ok"] is False and result["error"] == "unsupported_capability"
    assert radio.calls == []


def test_legacy_unchecked_methods_cannot_operate(radio):
    driver = G.GoveeBLEDriver()
    assert driver.execute(DEVICE, "switch.on")["error"] == "authority_required"
    assert driver.get_status(DEVICE)["on"] is None
    with pytest.raises(HTTPException) as caught:
        driver.probe_checked(DEVICE, check=None)
    assert caught.value.status_code == 403 and radio.calls == []


@pytest.mark.parametrize("variant", ["missing_control", "missing_notify", "duplicate_control", "duplicate_notify", "wrong_write", "wrong_notify", "small_mtu"])
def test_profile_is_exact_and_never_writes_when_invalid(radio, variant):
    if variant == "missing_control":
        radio.characteristics = [radio.notify]
    elif variant == "missing_notify":
        radio.characteristics = [radio.control]
    elif variant == "duplicate_control":
        radio.characteristics.append(radio.control)
    elif variant == "duplicate_notify":
        radio.characteristics.append(radio.notify)
    elif variant == "wrong_write":
        radio.control.properties = ["write"]
    elif variant == "wrong_notify":
        radio.notify.properties = ["read"]
    else:
        radio.control.max_write_without_response_size = 19
    result = G.GoveeBLEDriver().execute_checked(DEVICE, "switch.on", check=radio.check)
    assert result["ok"] is False and result["error"] == "profile_mismatch"
    assert "write" not in radio.calls and radio.calls[-1] == "disconnect"


@pytest.mark.parametrize("phase", ["scan_start", "scan_stop", "connect", "services", "write", "disconnect"])
@pytest.mark.parametrize("failure", [HTTPException(401, "gone"), HTTPException(503, "security unavailable"), OSError("one shot")])
def test_control_denial_stops_further_steps_retains_actual_outcome(radio, phase, failure):
    radio.revoke, radio.failure = phase, failure
    with pytest.raises(type(failure)) as caught:
        G.GoveeBLEDriver().execute_checked(DEVICE, "switch.on", check=radio.check)
    assert caught.value is failure
    if phase in {"write", "disconnect"}:
        assert failure.device_result["outcome"] == "sent"
        assert failure.device_result["acknowledged"] is False
        assert radio.calls.count("write") == 1
    else:
        assert "write" not in radio.calls and not hasattr(failure, "device_result")
    if phase in {"scan_start", "scan_stop"}:
        assert "client" not in radio.calls and radio.calls[-1] == "scan_stop"
    else:
        assert radio.calls[-1] == "disconnect"


@pytest.mark.parametrize("phase", ["notify", "query", "stop_notify", "disconnect"])
@pytest.mark.parametrize("failure", [HTTPException(401, "gone"), HTTPException(503, "security unavailable"), FileNotFoundError("one shot")])
def test_status_denial_never_becomes_unknown_success(radio, phase, failure):
    radio.revoke, radio.failure = phase, failure
    with pytest.raises(type(failure)) as caught:
        G.GoveeBLEDriver().get_status_checked(DEVICE, check=radio.check)
    assert caught.value is failure and radio.calls[-2:] == ["stop_notify", "disconnect"]
    if phase == "notify":
        assert "query" not in radio.calls


@pytest.mark.parametrize("phase", ["connect", "services", "write"])
def test_native_control_failures_redacted_no_retry(radio, phase):
    radio.fail = phase
    result = G.GoveeBLEDriver().execute_checked(DEVICE, "switch.on", check=radio.check)
    assert result["ok"] is False and "PRIVATE" not in str(result)
    assert result["outcome"] == ("unknown" if phase == "write" else "not_sent")
    assert radio.calls.count("write") <= 1 and radio.calls[-1] == "disconnect"


def test_write_pending_authority_loss_retains_unknown_and_disconnects(radio, monkeypatch):
    async def write(client, *args, **kwargs):
        radio.calls.append("write")
        radio.revoked = True
        await asyncio.sleep(60)
    monkeypatch.setattr(radio.Client, "write_gatt_char", write)
    with pytest.raises(HTTPException) as caught:
        G.GoveeBLEDriver().execute_checked(DEVICE, "switch.on", check=radio.check)
    assert caught.value is radio.failure
    assert caught.value.device_result["outcome"] == "unknown"
    assert radio.calls[-1] == "disconnect" and radio.calls.count("write") == 1


def test_failed_scan_cleanup_blocks_same_request_connect_and_future_work(radio):
    radio.fail = "scan_stop"
    result = G.GoveeBLEDriver().execute_checked(DEVICE, "switch.on", check=radio.check)
    assert result["ok"] is False and result["outcome"] == "not_sent"
    assert result["error"] == "cleanup_pending"
    assert radio.calls == ["scanner", "scan_start", "scan_stop"]
    assert B._WORKER.devices == {}
    before = list(radio.calls)
    assert G.GoveeBLEDriver().probe_checked(DEVICE, check=radio.check)["error"] == "cleanup_pending"
    assert radio.calls == before


def test_failed_disconnect_retains_sent_but_blocks_future_radio(radio):
    radio.fail = "disconnect"
    result = G.GoveeBLEDriver().execute_checked(DEVICE, "switch.on", check=radio.check)
    assert result["outcome"] == "sent" and result["cleanup_pending"] is True
    before = list(radio.calls)
    assert G.GoveeBLEDriver().execute_checked(DEVICE, "switch.off", check=radio.check)["error"] == "cleanup_pending"
    assert radio.calls == before


def test_write_timeout_is_unknown_without_retry(radio, monkeypatch):
    original = B.checked_await
    async def bounded(access, factory, **kwargs):
        if getattr(factory, "__name__", None) == "write":
            kwargs["timeout"] = 0.005
        return await original(access, factory, **kwargs)
    async def write(client, *args, **kwargs):
        radio.calls.append("write")
        await asyncio.sleep(60)
    monkeypatch.setattr(B, "checked_await", bounded)
    monkeypatch.setattr(radio.Client, "write_gatt_char", write)
    result = G.GoveeBLEDriver().execute_checked(DEVICE, "switch.on", check=radio.check)
    assert result["ok"] is False and result["outcome"] == "unknown"
    assert radio.calls.count("write") == 1 and radio.calls[-1] == "disconnect"


def test_scan_stop_noncancellable_blocks_current_connect(radio, monkeypatch):
    released = None
    finished = None
    async def stop(scanner):
        nonlocal released, finished
        radio.calls.append("scan_stop")
        released, finished = asyncio.Event(), asyncio.Event()
        try:
            try:
                await released.wait()
            except asyncio.CancelledError:
                await released.wait()
        finally:
            finished.set()
    monkeypatch.setattr(radio.Scanner, "stop", stop)
    try:
        result = G.GoveeBLEDriver().execute_checked(DEVICE, "switch.on", check=radio.check)
        assert result["ok"] is False and result["outcome"] == "not_sent"
        assert result["error"] == "cleanup_pending"
        assert radio.calls == ["scanner", "scan_start", "scan_stop"] and B._WORKER.devices == {}
    finally:
        async def settle():
            released.set()
            await asyncio.wait_for(finished.wait(), timeout=1)
            await asyncio.sleep(0)
        asyncio.run_coroutine_threadsafe(settle(), B._WORKER.loop).result(1)


def test_native_cancelled_write_retains_unknown_in_sanitized_failure(radio, monkeypatch):
    async def cancelled(client, *args, **kwargs):
        radio.calls.append("write")
        raise asyncio.CancelledError("PRIVATE NATIVE DETAILS")
    monkeypatch.setattr(radio.Client, "write_gatt_char", cancelled)
    result = G.GoveeBLEDriver().execute_checked(DEVICE, "switch.on", check=radio.check)
    assert result["ok"] is False and result["outcome"] == "unknown"
    assert result["acknowledged"] is False and "PRIVATE" not in str(result)
    assert radio.calls.count("write") == 1 and radio.calls[-1] == "disconnect"
