"""Experimental H6125 power profile, independent of the existing UDP driver.

Wire evidence: Jaano/govee_lights GOVEE_BLE.md and govee_ble.py (2026-10-16).
The H6125-specific allepet protocol note covers color/brightness, not readback.
Family power query support is therefore provisional: accept only a fresh strict
notification, otherwise report unknown. A write without response is never an ACK.
"""
from __future__ import annotations

from functools import reduce
from operator import xor

import bluetooth_support as BLE
from .base import DeviceDriver

CONTROL_UUID = "00010203-0405-0607-0809-0a0b0c0d2b11"
NOTIFY_UUID = "00010203-0405-0607-0809-0a0b0c0d2b10"
PROFILE = "govee_h6125_v1"
MODEL = "H6125"


def power_packet(on: bool) -> bytes:
    if type(on) is not bool:
        raise ValueError("Power must be boolean")
    body = bytes((0x33, 0x01, int(on))) + bytes(16)
    return body + bytes((reduce(xor, body),))


POWER_QUERY = bytes((0xAA, 0x01)) + bytes(17) + bytes((0xAB,))


def parse_power(data) -> bool | None:
    if not isinstance(data, (bytes, bytearray)) or len(data) != 20:
        return None
    if data[:2] != b"\xaa\x01" or data[2] not in (0, 1) or reduce(xor, data) != 0:
        return None
    if any(data[3:19]):
        return None
    return bool(data[2])


def _target(device) -> str:
    if not isinstance(device, dict) or device.get("vendor") != "govee_ble":
        raise BLE.BluetoothError("invalid_device")
    extra = device.get("extra")
    if not isinstance(extra, dict) or extra.get("transport") != "bluetooth" or extra.get("model") != MODEL or extra.get("profile") != PROFILE:
        raise BLE.BluetoothError("invalid_device")
    try:
        address = BLE.canonical_address(extra.get("address"))
    except ValueError:
        raise BLE.BluetoothError("invalid_device") from None
    if device.get("ip") != "ble://" + address:
        raise BLE.BluetoothError("invalid_device")
    return address


def _profile(client, access):
    access()
    services = client.services
    access()
    # Resolve exact objects; duplicate UUIDs are ambiguous and must not be selected.
    controls, notifications = [], []
    for service in services:
        access()
        for characteristic in service.characteristics:
            access()
            if characteristic.uuid.lower() == CONTROL_UUID:
                controls.append(characteristic)
            if characteristic.uuid.lower() == NOTIFY_UUID:
                notifications.append(characteristic)
    if len(controls) != 1 or len(notifications) != 1:
        raise BLE.BluetoothError("profile_mismatch")
    control, notify = controls[0], notifications[0]
    if "write-without-response" not in control.properties or "notify" not in notify.properties:
        raise BLE.BluetoothError("profile_mismatch")
    if control.max_write_without_response_size < 20:
        raise BLE.BluetoothError("profile_mismatch")
    access()
    return control, notify


def _sent():
    return {"ok": True, "acknowledged": False, "outcome": "sent", "verified": False,
            "summary": "Command sent; device state is not yet verified."}


def _unknown():
    return {"ok": False, "acknowledged": False, "outcome": "unknown", "verified": False,
            "summary": "Command outcome is unknown. Check the light before trying again."}


async def _operation(module, access, worker, address, action):
    import asyncio
    device = await BLE.resolve_device(module, access, worker, address)
    access()
    client = module.BleakClient(device, timeout=BLE.CONNECT_SECONDS)
    notify_started = False
    dispatched = False
    result = None
    try:
        await BLE.checked_await(access, client.connect, timeout=BLE.CONNECT_SECONDS)
        access()
        if not client.is_connected:
            raise BLE.BluetoothError("connection_failed")
        control, notify = _profile(client, access)
        if action == "probe":
            result = {"ok": True, "profile": PROFILE, "model": MODEL, "experimental": True,
                      "summary": "Bluetooth profile found; physical control is not yet verified."}
        elif action in {"switch.on", "switch.off"}:
            access()
            def write():
                nonlocal dispatched
                # Factory is called only after checked_await's final pre-dispatch check.
                dispatched = True
                access.outcome(_unknown())
                return client.write_gatt_char(control, power_packet(action == "switch.on"), response=False)
            await BLE.checked_await(access, write, completed=lambda _: access.outcome(_sent()))
            result = _sent()
        else:
            event = asyncio.Event()
            observed = None
            querying = False
            def notification(sender, data):
                nonlocal observed
                try:
                    access()
                except Exception:
                    return
                if not querying or sender is not notify:
                    return
                parsed = parse_power(data)
                if parsed is not None and observed is None:
                    observed = parsed
                    event.set()
            # A new connection and no preliminary query prevent pre-command stale replies.
            notify_started = True
            await BLE.checked_await(access, lambda: client.start_notify(notify, notification))
            def query():
                nonlocal querying
                querying = True
                return client.write_gatt_char(control, POWER_QUERY, response=False)
            await BLE.checked_await(access, query)
            await BLE.checked_await(access, event.wait)
            result = {"ok": True, "on": observed, "verified": True, "experimental": True,
                      "summary": "ON" if observed else "OFF"}
        access()
    except Exception:
        access()
        if dispatched:
            result = _unknown()
        else:
            raise
    finally:
        clean = True
        if notify_started:
            clean = await BLE.cleanup(lambda: client.stop_notify(notify))
        clean = await BLE.cleanup(client.disconnect) and clean
    access()
    if not clean:
        if dispatched:
            result = {**(result or _unknown()), "cleanup_pending": True}
        else:
            raise BLE.BluetoothError("cleanup_pending")
    return result


class GoveeBLEDriver(DeviceDriver):
    vendor = "govee_ble"

    def _call(self, device, action, check):
        access = BLE.Access(check)
        access()
        try:
            address = _target(device)
            if action not in {"probe", "status", "switch.on", "switch.off"}:
                raise BLE.BluetoothError("unsupported_capability")
            return BLE.run(lambda module, guard, worker: _operation(module, guard, worker, address, action), check=access)
        except BLE.BluetoothError as exc:
            access()
            if isinstance(getattr(exc, "device_result", None), dict):
                return dict(exc.device_result)
            result = {"ok": False, "error": exc.code, "verified": False,
                      "summary": "Bluetooth operation unavailable."}
            if action == "status":
                result["on"] = None
            elif action.startswith("switch."):
                result.update(acknowledged=False, outcome="not_sent")
            return result
        except Exception:
            access()
            raise

    def probe_checked(self, device, *, check):
        return self._call(device, "probe", check)

    def get_status_checked(self, device, *, check):
        return self._call(device, "status", check)

    def execute_checked(self, device, capability, *, check):
        return self._call(device, capability, check)

    def execute(self, device, capability):
        return {"ok": False, "error": "authority_required", "outcome": "not_sent",
                "summary": "Bluetooth requires captured authorization."}

    def get_status(self, device):
        return {"ok": False, "on": None, "error": "authority_required", "verified": False,
                "summary": "Bluetooth requires captured authorization."}
