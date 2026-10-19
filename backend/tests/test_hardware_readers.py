"""Checked hardware services use synthetic probes, never the test host's devices."""
from __future__ import annotations

import copy
import ctypes
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

from routers import system_routes as routes


XML = (
    "<DxDiag><SystemInformation><Processor>Fixture CPU</Processor>"
    "</SystemInformation><DisplayDevices><DisplayDevice>"
    "<CardName>Fixture GPU</CardName><DriverVersion>1.2</DriverVersion>"
    "<DedicatedMemoryInBytes>8589934592</DedicatedMemoryInBytes>"
    "<CurrentMode>Unknown</CurrentMode></DisplayDevice></DisplayDevices></DxDiag>"
)


@pytest.fixture
def hardware(monkeypatch, tmp_path):
    """One-shot denial reveals fallbacks which accidentally retry a failed check."""
    fixture = SimpleNamespace(
        platform="Windows", calls=[], stop=None, error=None, fault=False,
        revoked=False, temporary=[], commands=[], xml=XML,
    )

    def step(stage, value=None):
        fixture.calls.append(stage)
        if stage == fixture.stop:
            fixture.revoked = True
            if fixture.fault:
                raise OSError("Synthetic probe failure with private host details")
        return value

    def check():
        if fixture.revoked:
            fixture.revoked = False
            raise fixture.error

    fixture.step = step
    fixture.check = check
    monkeypatch.setenv("SystemDrive", "C:")
    monkeypatch.setattr(routes, "_system_summary_cache", {"result": None, "ts": 0.0})
    for name, value in {
        "processor": "Fixture fallback CPU", "machine": "fixture-arch",
        "release": "fixture-release", "version": "fixture-version",
    }.items():
        monkeypatch.setattr(routes.platform, name, lambda n=name, v=value: step(n, v))
    monkeypatch.setattr(routes.platform, "system", lambda: step("system", fixture.platform))
    monkeypatch.setattr(routes.S, "now_iso", lambda: "2001-02-03T04:05:06Z")
    probes = SimpleNamespace(
        cpu_count=lambda logical: step("threads" if logical else "cores", 16 if logical else 8),
        virtual_memory=lambda: step("memory", SimpleNamespace(total=32 * 1024**3, available=16 * 1024**3)),
        disk_partitions=lambda all: step("partitions", [
            SimpleNamespace(mountpoint="C:\\", fstype="NTFS"),
            SimpleNamespace(mountpoint="D:\\", fstype="NTFS"),
        ]),
        disk_usage=lambda mount: step("usage:" + mount, SimpleNamespace(
            total=100 * 1024**3, used=40 * 1024**3, free=60 * 1024**3, percent=40)),
    )
    monkeypatch.setattr(routes, "psutil", probes)
    monkeypatch.setattr(ctypes, "windll", SimpleNamespace(user32=SimpleNamespace(
        GetSystemMetrics=lambda index: step("metrics:" + str(index), [1920, 1080][index]),
    )), raising=False)
    monkeypatch.setitem(sys.modules, "pynvml", SimpleNamespace(
        nvmlInit=lambda: step("nvml:init"),
        nvmlDeviceGetHandleByIndex=lambda index: step("nvml:handle", "fixture-handle"),
        nvmlDeviceGetMemoryInfo=lambda handle: step("nvml:memory", SimpleNamespace(total=8 * 1024**3)),
        nvmlShutdown=lambda: step("nvml:shutdown"),
    ))

    original_temp = routes.tempfile.NamedTemporaryFile

    def temporary(**kwargs):
        handle = original_temp(dir=tmp_path, **kwargs)
        fixture.temporary.append(Path(handle.name))
        return handle

    monkeypatch.setattr(routes.tempfile, "NamedTemporaryFile", temporary)
    original_parse = routes.ET.parse

    def parse(path):
        value = original_parse(path)
        return step("xml:parse", value)

    monkeypatch.setattr(routes.ET, "parse", parse)

    def run(command, **kwargs):
        fixture.commands.append((command, kwargs))
        name = command[0]
        result = SimpleNamespace(returncode=0, stderr="", stdout="")
        if name == "dxdiag":
            Path(command[-1]).write_text(fixture.xml, encoding="utf-8")
            stage = "dxdiag"
        elif name == "powershell":
            stage = "powershell"
            result.stdout = json.dumps([{"Model": "Fixture disk", "Size": 100 * 1024**3}])
        elif name == "system_profiler":
            stage = "system_profiler"
            result.stdout = json.dumps({"SPDisplaysDataType": [{
                "sppci_model": "Fixture GPU", "spdisplays_vram": "8 GB",
                "spdisplays_ndrvs": [{"_spdisplays_resolution": "1920 x 1080"}],
            }]})
        elif name == "diskutil" and command[1] == "list":
            stage = "diskutil:list"
            result.stdout = plistlib.dumps({"WholeDisks": ["disk0", "disk1"]})
        elif name == "diskutil" and command[1] == "info":
            stage = "diskutil:" + command[-1]
            result.stdout = plistlib.dumps({"MediaName": "Fixture disk", "TotalSize": 100 * 1024**3})
        elif name == "lspci":
            stage = "lspci"
            result.stdout = '00:02.0 "VGA compatible controller" "Fixture vendor" "Fixture GPU"'
        elif name == "lsblk":
            stage = "lsblk"
            result.stdout = json.dumps({"blockdevices": [{"name": "fixture-disk", "type": "disk", "size": "100G"}]})
        else:
            raise AssertionError("Unexpected process invocation: " + repr(command))
        return step(stage, result)

    monkeypatch.setattr(routes.subprocess, "run", run)
    return fixture


ERRORS = [
    pytest.param(lambda: HTTPException(401, "Session changed"), id="401"),
    pytest.param(lambda: HTTPException(503, "Security state unavailable"), id="503"),
    pytest.param(lambda: FileNotFoundError("one-shot authority failure"), id="missing"),
    pytest.param(lambda: OSError("one-shot authority failure"), id="os-error"),
    pytest.param(lambda: RuntimeError("one-shot authority failure"), id="runtime-error"),
]


@pytest.mark.parametrize("service", [routes.system_probe, routes.system_summary, routes.system_disk])
@pytest.mark.parametrize("error_factory", ERRORS)
def test_denied_service_admission_does_no_observation(hardware, service, error_factory):
    hardware.revoked = True
    hardware.error = error_factory()
    with pytest.raises(type(hardware.error)) as raised:
        service(check=hardware.check)
    assert raised.value is hardware.error
    assert hardware.calls == []
    assert hardware.temporary == []


@pytest.mark.parametrize("stage", ["threads", "cores", "memory", "nvml:init", "nvml:handle", "nvml:memory"])
@pytest.mark.parametrize("error_factory", ERRORS)
def test_probe_one_shot_denial_stops_remaining_work_and_closes_nvml(hardware, stage, error_factory):
    hardware.stop, hardware.error = stage, error_factory()
    with pytest.raises(type(hardware.error)) as raised:
        routes.system_probe(check=hardware.check)
    assert raised.value is hardware.error
    assert hardware.calls[-1] == ("nvml:shutdown" if stage.startswith("nvml:") else stage)
    assert ("nvml:shutdown" in hardware.calls) == stage.startswith("nvml:")
    if stage == "nvml:init":
        assert "nvml:handle" not in hardware.calls
    if stage == "nvml:handle":
        assert "nvml:memory" not in hardware.calls


def test_probe_denial_during_nvml_cleanup_still_denies_output(hardware):
    hardware.stop, hardware.error = "nvml:shutdown", HTTPException(503, "Unavailable")
    with pytest.raises(HTTPException) as raised:
        routes.system_probe(check=hardware.check)
    assert raised.value is hardware.error
    assert hardware.calls.count("nvml:shutdown") == 1


def test_probe_without_optional_nvml_stays_compatible(hardware, monkeypatch):
    monkeypatch.setitem(sys.modules, "pynvml", None)
    result = routes.system_probe(check=hardware.check)
    assert result.cpu_cores == 8
    assert result.ram_total_gb == 32
    assert result.gpu_vram_gb is None


SUMMARY_STAGES = [
    ("Windows", stage) for stage in [
        "processor", "cores", "threads", "memory", "system", "release", "version", "machine",
        "dxdiag", "xml:parse", "metrics:0", "metrics:1", "powershell",
    ]
] + [("Darwin", stage) for stage in ["system_profiler", "diskutil:list", "diskutil:disk0"]] + [
    ("Linux", "lspci"), ("Linux", "lsblk"),
]


@pytest.mark.parametrize("platform_name,stage", SUMMARY_STAGES)
@pytest.mark.parametrize("error_factory", ERRORS)
def test_summary_one_shot_denial_never_degrades_or_continues(hardware, platform_name, stage, error_factory):
    hardware.platform, hardware.stop, hardware.error = platform_name, stage, error_factory()
    original_cache = routes._system_summary_cache
    with pytest.raises(type(hardware.error)) as raised:
        routes.system_summary(check=hardware.check)
    assert raised.value is hardware.error
    assert hardware.calls[-1] == stage
    assert routes._system_summary_cache is original_cache
    assert original_cache["result"] is None
    assert all(not path.exists() for path in hardware.temporary)


@pytest.mark.parametrize("platform_name,stage", [
    ("Windows", "cores"), ("Windows", "memory"), ("Windows", "dxdiag"),
    ("Windows", "xml:parse"), ("Windows", "metrics:0"), ("Windows", "powershell"),
    ("Darwin", "system_profiler"), ("Darwin", "diskutil:list"), ("Darwin", "diskutil:disk0"),
    ("Linux", "lspci"), ("Linux", "lsblk"),
])
def test_summary_probe_error_rechecks_and_preserves_first_authority_failure(hardware, platform_name, stage):
    hardware.platform, hardware.stop, hardware.fault = platform_name, stage, True
    hardware.error = HTTPException(503, "Security state unavailable")
    with pytest.raises(HTTPException) as raised:
        routes.system_summary(check=hardware.check)
    assert raised.value is hardware.error
    assert hardware.calls[-1] == stage
    assert routes._system_summary_cache["result"] is None
    assert all(not path.exists() for path in hardware.temporary)


@pytest.mark.parametrize("stage", ["system", "partitions", "usage:C:\\"])
@pytest.mark.parametrize("error_factory", ERRORS)
def test_disk_one_shot_denial_stops_mount_enumeration(hardware, stage, error_factory):
    hardware.stop, hardware.error = stage, error_factory()
    with pytest.raises(type(hardware.error)) as raised:
        routes.system_disk(check=hardware.check)
    assert raised.value is hardware.error
    assert hardware.calls[-1] == stage
    assert "usage:D:\\" not in hardware.calls


@pytest.mark.parametrize("stage", ["partitions", "usage:C:\\"])
def test_disk_error_rechecks_before_partial_success(hardware, stage):
    hardware.stop, hardware.fault = stage, True
    hardware.error = HTTPException(503, "Security state unavailable")
    with pytest.raises(HTTPException) as raised:
        routes.system_disk(check=hardware.check)
    assert raised.value is hardware.error
    assert "usage:D:\\" not in hardware.calls


@pytest.mark.parametrize("platform_name", ["Windows", "Darwin", "Linux"])
def test_synthetic_summary_preserves_shape_and_process_timeouts(hardware, platform_name):
    hardware.platform = platform_name
    result = routes.system_summary(check=hardware.check)
    assert result["cpu"]["cores"] == 8
    assert result["cpu"]["threads"] == 16
    assert result["memory"]["total_gb"] == 32
    assert result["gpu"]["model"] == "Fixture GPU"
    assert result["storage"]["drives"]
    assert result["board"]["system"] == platform_name
    assert routes._system_summary_cache["checked"] is True
    assert all(not path.exists() for path in hardware.temporary)
    assert all(0 < options["timeout"] <= 18 for _, options in hardware.commands)
    if platform_name == "Windows":
        assert all(options["creationflags"] == (
            getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        ) for _, options in hardware.commands)


def test_disk_keeps_legacy_flat_fields_and_no_check_signature(hardware):
    result = routes.system_disk()
    assert result["ok"] is True
    assert result["system"] == result["drives"][0]
    assert result["total_gb"] == result["system"]["total_gb"] == 100
    assert result["pct"] == 40
    assert len(result["drives"]) == 2


def test_unchecked_summary_cannot_supply_checked_cache(hardware):
    first = routes.system_summary()
    assert routes._system_summary_cache["checked"] is False
    hardware.calls.clear()
    checked = routes.system_summary(check=hardware.check)
    assert checked == first
    assert "dxdiag" in hardware.calls
    assert routes._system_summary_cache["checked"] is True


def test_cache_and_returned_values_are_detached_for_all_callers(hardware):
    first = routes.system_summary(check=hardware.check)
    snapshot = copy.deepcopy(routes._system_summary_cache)
    first["cpu"]["model"] = "Caller mutation"
    first["storage"]["drives"].clear()
    unchecked = routes.system_summary()
    unchecked["cpu"]["model"] = "Internal mutation"
    unchecked["sources"]["storage"].clear()
    hardware.calls.clear()
    checked = routes.system_summary(check=hardware.check)
    assert checked == snapshot["result"]
    assert routes._system_summary_cache == snapshot
    assert checked is not routes._system_summary_cache["result"]
    assert hardware.calls == []
    checked["display"]["width"] = 1
    assert routes._system_summary_cache == snapshot


@pytest.mark.parametrize("cache_hit", [False, True])
def test_authority_ending_during_cache_copy_never_publishes_or_discloses(hardware, monkeypatch, cache_hit):
    if cache_hit:
        routes.system_summary(check=hardware.check)
    original_cache = routes._system_summary_cache
    original_copy = copy.deepcopy
    failure = HTTPException(503, "Unavailable")

    def denied_copy(value):
        result = original_copy(value)
        hardware.error, hardware.revoked = failure, True
        return result

    monkeypatch.setattr(copy, "deepcopy", denied_copy)
    with pytest.raises(HTTPException) as raised:
        routes.system_summary(check=hardware.check)
    assert raised.value is failure
    assert routes._system_summary_cache is original_cache


@pytest.mark.parametrize("another_publisher", [False, True])
def test_late_denial_rolls_back_only_its_own_cache_publication(hardware, another_publisher):
    original_cache = routes._system_summary_cache
    replacement = {"result": {"timestamp": "other observation"}, "ts": 123, "checked": True}
    failure = HTTPException(503, "Unavailable")

    def check():
        if routes._system_summary_cache is not original_cache:
            if another_publisher:
                routes._system_summary_cache = replacement
            raise failure

    with pytest.raises(HTTPException) as raised:
        routes.system_summary(check=check)
    assert raised.value is failure
    assert routes._system_summary_cache is (replacement if another_publisher else original_cache)


def test_cache_hit_keeps_observation_timestamp(hardware, monkeypatch):
    original = routes.system_summary(check=hardware.check)
    cached_at = routes._system_summary_cache["ts"]
    monkeypatch.setattr(routes.time, "time", lambda: cached_at + 10)
    monkeypatch.setattr(routes.S, "now_iso", lambda: "later time must not replace observation")
    hardware.calls.clear()
    assert routes.system_summary(check=hardware.check)["timestamp"] == original["timestamp"]
    assert routes._system_summary_cache["ts"] == cached_at
    assert hardware.calls == []


def test_denied_dxdiag_creation_closes_and_removes_its_temporary_file(hardware, monkeypatch):
    original = routes.tempfile.NamedTemporaryFile

    def temporary(**kwargs):
        handle = original(**kwargs)
        hardware.revoked = True
        return handle

    hardware.error = HTTPException(503, "Unavailable")
    monkeypatch.setattr(routes.tempfile, "NamedTemporaryFile", temporary)
    with pytest.raises(HTTPException) as raised:
        routes._dxdiag_xml_path(check=hardware.check)
    assert raised.value is hardware.error
    assert hardware.commands == []
    assert len(hardware.temporary) == 1
    assert not hardware.temporary[0].exists()


def test_denial_after_dxdiag_helper_returns_still_removes_xml(hardware, monkeypatch):
    original = routes._dxdiag_xml_path

    def delayed_denial(*, check):
        path = original(check=check)
        hardware.revoked = True
        return path

    hardware.error = HTTPException(503, "Unavailable")
    monkeypatch.setattr(routes, "_dxdiag_xml_path", delayed_denial)
    with pytest.raises(HTTPException) as raised:
        routes.system_summary(check=hardware.check)
    assert raised.value is hardware.error
    assert "xml:parse" not in hardware.calls
    assert "powershell" not in hardware.calls
    assert all(not path.exists() for path in hardware.temporary)
