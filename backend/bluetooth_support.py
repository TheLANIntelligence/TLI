"""Explicit, bounded Windows BLE operations; importing this module does no radio work.

Bleak objects live on one lazy daemon-thread event loop. Admission is nonblocking:
there is no background scanner, operation queue, retry or adapter reset. Availability
only describes the supported software runtime, not a working physical radio.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import importlib
import importlib.metadata
import re
import sys
import threading
import time
import unicodedata
from typing import Callable

from fastapi import HTTPException
import bluetooth_profiles

SCAN_SECONDS = 5.0
CONNECT_SECONDS = 8.0
IO_SECONDS = 3.0
CLEANUP_SECONDS = 2.0
OPERATION_SECONDS = 25.0
MAX_DEVICES = 64
DEVICE_TTL_SECONDS = 60.0
_ADDRESS = re.compile(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\Z")


class BluetoothError(Exception):
    """A public, nonprivate error code; never expose native exception strings."""
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def canonical_address(value: str) -> str:
    if not isinstance(value, str) or not _ADDRESS.fullmatch(value):
        raise ValueError("Invalid Bluetooth address")
    return value.upper()


class Access:
    """Retain the first authority failure, including non-HTTP failures, across threads."""
    def __init__(self, check: Callable | None):
        if not callable(check):
            raise HTTPException(403, "Captured authorization required for Bluetooth.",
                                headers={"Cache-Control": "no-store"})
        self._check = check
        self._lock = threading.RLock()
        self.failure: Exception | None = None
        self.result: dict | None = None
        self.deadline = time.monotonic() + OPERATION_SECONDS

    def __call__(self):
        with self._lock:
            if self.failure is not None:
                raise self.failure
            try:
                self._check()
                if time.monotonic() >= self.deadline:
                    raise BluetoothError("operation_timeout")
            except Exception as exc:
                self.failure = exc
                if self.result is not None:
                    exc.device_result = dict(self.result)
                raise

    def outcome(self, result: dict):
        with self._lock:
            self.result = dict(result)
            if self.failure is not None:
                self.failure.device_result = dict(result)


def _runtime_status() -> dict:
    base = {"available": False, "platform": sys.platform}
    if sys.platform != "win32":
        return {**base, "reason": "windows_required"}
    if sys.getwindowsversion().build < 22000:
        return {**base, "reason": "windows_11_required"}
    if sys.version_info < (3, 10):
        return {**base, "reason": "python_version_unsupported"}
    try:
        version = importlib.metadata.version("bleak")
    except importlib.metadata.PackageNotFoundError:
        return {**base, "reason": "dependency_missing"}
    except Exception:
        return {**base, "reason": "dependency_unavailable"}
    if version != "3.0.2":
        return {**base, "reason": "dependency_version_unsupported"}
    if _WORKER is not None and _WORKER.poisoned:
        return {**base, "reason": "cleanup_pending"}
    return {**base, "available": True, "reason": "runtime_ready"}


def support_status(*, check: Callable) -> dict:
    access = Access(check)
    access()
    try:
        result = _runtime_status()
    except Exception:
        access()
        result = {"available": False, "platform": sys.platform, "reason": "runtime_unavailable"}
    access()
    return result


def _poison():
    if _WORKER is not None:
        _WORKER.poisoned = True


async def _cancel(task):
    task.cancel()
    done, _ = await asyncio.wait({task}, timeout=CLEANUP_SECONDS)
    if not done:
        _poison()
        task.add_done_callback(_consume)
    else:
        _consume(task)


def _consume(task):
    if not task.cancelled():
        task.exception()


async def checked_await(access: Access, factory, *, timeout=IO_SECONDS, completed=None):
    """Check while waiting, then record an actual completion before final denial."""
    access()
    if _WORKER is not None and _WORKER.poisoned:
        raise BluetoothError("cleanup_pending")
    remaining = min(timeout, access.deadline - time.monotonic())
    if remaining <= 0:
        raise BluetoothError("operation_timeout")
    task = asyncio.ensure_future(factory())
    deadline = time.monotonic() + remaining
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=min(0.05, max(0, deadline - time.monotonic())))
            if done:
                try:
                    result = task.result()
                except Exception:
                    access()
                    raise
                if completed is not None:
                    completed(result)
                access()
                return result
            access()
            if time.monotonic() >= deadline:
                raise BluetoothError("operation_timeout")
    finally:
        if not task.done():
            await _cancel(task)


async def cleanup(factory) -> bool:
    """Release this request's resources even after authority ends; never retry."""
    try:
        task = asyncio.ensure_future(factory())
        done, _ = await asyncio.wait({task}, timeout=CLEANUP_SECONDS)
        if not done:
            await _cancel(task)
            _poison()
            return False
        task.result()
        return True
    except (Exception, asyncio.CancelledError):
        _poison()
        return False


class _Worker:
    def __init__(self):
        self.admission = threading.Lock()
        self.ready = threading.Event()
        self.loop = None
        self.poisoned = False
        self.devices: dict[str, tuple[float, object]] = {}
        self.thread = threading.Thread(target=self._serve, name="tli-bluetooth", daemon=True)

    def _serve(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.ready.set()
        self.loop.run_forever()

    async def _perform(self, factory, access):
        access()
        try:
            module = importlib.import_module("bleak")
        except Exception:
            access()
            raise BluetoothError("dependency_unavailable") from None
        access()
        try:
            result = await factory(module, access, self)
            access()
            return result
        except Exception:
            access()
            raise

    def run(self, factory, access):
        access()
        if self.poisoned:
            raise BluetoothError("cleanup_pending")
        if not self.admission.acquire(blocking=False):
            access()
            raise BluetoothError("bluetooth_busy")
        future = None
        try:
            access()
            if not self.thread.is_alive():
                self.thread.start()
            if not self.ready.wait(timeout=1.0):
                self.poisoned = True
                access()
                raise BluetoothError("worker_unavailable")
            access()
            future = asyncio.run_coroutine_threadsafe(self._perform(factory, access), self.loop)
            limit = time.monotonic() + OPERATION_SECONDS + 3 * CLEANUP_SECONDS + 1
            while True:
                try:
                    result = future.result(timeout=0.05)
                except concurrent.futures.TimeoutError:
                    # A completed coroutine may itself raise built-in TimeoutError.
                    # It is not a polling timeout and must not be spun on/retried.
                    if future.done():
                        access()
                        raise
                    # Preserve the failure while allowing worker-side finally cleanup.
                    try:
                        access()
                    except Exception:
                        pass
                    if time.monotonic() < limit:
                        continue
                    self.poisoned = True
                    future.cancel()
                    access()
                    raise BluetoothError("operation_timeout") from None
                except Exception:
                    access()
                    raise
                access()
                return result
        finally:
            self.admission.release()


_WORKER: _Worker | None = None
_WORKER_LOCK = threading.Lock()


def run(factory, *, check):
    """Run one explicit radio operation; native failures have only generic codes."""
    global _WORKER
    access = Access(check)
    access()
    try:
        status = _runtime_status()
        access()
        if not status["available"]:
            raise BluetoothError(status["reason"])
        with _WORKER_LOCK:
            if _WORKER is None:
                _WORKER = _Worker()
            worker = _WORKER
        access()
        return worker.run(factory, access)
    except BluetoothError as exc:
        if access.result is not None:
            exc.device_result = dict(access.result)
        access()
        raise
    except Exception:
        access()
        error = BluetoothError("bluetooth_unavailable")
        if access.result is not None:
            error.device_result = dict(access.result)
        raise error from None


def _name(value) -> str:
    if not isinstance(value, str):
        return "Bluetooth device"
    text = "".join(ch for ch in value[:128] if unicodedata.category(ch) not in {"Cc", "Cs"}).strip()
    return text or "Bluetooth device"


async def _scan(module, access, worker, *, address=None):
    access()
    bluetooth_profiles.list_profiles()  # Validate source catalog before any scanner is created.
    access()
    rows = {}
    devices = {}
    def detected(device, advertisement):
        try:
            access()
            key = canonical_address(device.address)
        except Exception:
            return
        if address is not None and key != address:
            return
        if key not in rows and len(rows) >= MAX_DEVICES:
            return
        name = _name(getattr(advertisement, "local_name", None) or getattr(device, "name", None))
        hints = bluetooth_profiles.discovery_hints(name)
        profile = bluetooth_profiles.get_profile(hints[0]) if len(hints) == 1 else None
        # model/supported retain the legacy response shape, but are only name
        # hints. Enrollment still needs an explicit selected profile and GATT check.
        rows[key] = {"address": key, "name": name,
                     "model": profile["model"] if profile is not None else None,
                     "supported": profile is not None, "profile_hints": hints}
        devices[key] = device
    access()
    scanner = module.BleakScanner(detection_callback=detected)
    try:
        await checked_await(access, scanner.start)
        await checked_await(access, lambda: asyncio.sleep(SCAN_SECONDS), timeout=SCAN_SECONDS + 1)
    finally:
        stopped = await cleanup(scanner.stop)
    access()
    if not stopped:
        raise BluetoothError("cleanup_pending")
    now = time.monotonic()
    worker.devices = {key: (now, device) for key, device in devices.items()}
    return list(rows.values())


def discover(*, check) -> list[dict]:
    return run(lambda module, access, worker: _scan(module, access, worker), check=check)


async def resolve_device(module, access, worker, address):
    access()
    entry = worker.devices.get(address)
    if entry is None or time.monotonic() - entry[0] > DEVICE_TTL_SECONDS:
        await _scan(module, access, worker, address=address)
        entry = worker.devices.get(address)
    access()
    if entry is None:
        raise BluetoothError("device_not_found")
    return entry[1]
