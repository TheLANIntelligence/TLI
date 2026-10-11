"""Hardware reads retain useful fields without inventing monitor specifications."""
from __future__ import annotations

import ctypes
import os
from pathlib import Path
import subprocess
from types import SimpleNamespace
from xml.sax.saxutils import escape

import pytest

from routers import system_routes as routes


def dxdiag_file(tmp_path, mode="3840 x 2160 (32 bit) (60Hz)", processor="AMD Ryzen Fixture CPU"):
    path = tmp_path / "hardware.xml"
    path.write_text(
        "<DxDiag><SystemInformation><Processor>" + escape(processor) +
        "</Processor></SystemInformation><DisplayDevices><DisplayDevice>"
        "<CardName>Fixture GPU</CardName><DriverVersion>1.2.3</DriverVersion>"
        "<DedicatedMemoryInBytes>12884901888</DedicatedMemoryInBytes>"
        "<CurrentMode>" + escape(mode) + "</CurrentMode>"
        "</DisplayDevice></DisplayDevices></DxDiag>", encoding="utf-8")
    return path


@pytest.mark.parametrize("mode,expected", [
    ("3840 x 2160 (32 bit) (60Hz)", 60),
    ("2560 x 1440 (32 bit) (144Hz)", 144),
    ("3840 x 2160 (32 bit) (59.95 Hz)", 59.95),
    ("1920 x 1080 (32 bit) (60.0hz)", 60),
])
def test_dxdiag_refresh_is_the_number_next_to_hz(tmp_path, mode, expected):
    result = routes._parse_dxdiag(dxdiag_file(tmp_path, mode))
    assert result["display"]["hz"] == expected
    assert result["gpu"] == {"model": "Fixture GPU", "driver": "1.2.3", "vram_gb": 12.0}
    assert result["cpu"]["model"] == "AMD Ryzen Fixture CPU"


@pytest.mark.parametrize("refresh", ["Unknown", "NaNHz", "-60Hz", "0Hz", "1001Hz", "59..95Hz", "2e3Hz", "384021603260Hz"])
def test_dxdiag_invalid_refresh_does_not_hide_other_hardware(tmp_path, refresh):
    result = routes._parse_dxdiag(dxdiag_file(tmp_path, "3840 x 2160 (32 bit) (" + refresh + ")"))
    assert result["display"] == {"width": 3840, "height": 2160}
    assert result["gpu"]["model"] == "Fixture GPU"
    assert result["gpu"]["vram_gb"] == 12.0


@pytest.mark.parametrize("mode", ["Unknown (60Hz)", "0 x 2160 (60Hz)", "99999 x 2160 (60Hz)"])
def test_dxdiag_keeps_valid_refresh_when_dimensions_are_unknown(tmp_path, mode):
    assert routes._parse_dxdiag(dxdiag_file(tmp_path, mode))["display"] == {"hz": 60}


def test_dxdiag_cpu_survives_missing_display_devices(tmp_path):
    path = tmp_path / "cpu-only.xml"
    path.write_text("<DxDiag><SystemInformation><Processor>  Fixture CPU  </Processor></SystemInformation></DxDiag>")
    result = routes._parse_dxdiag(path)
    assert result["cpu"] == {"model": "Fixture CPU"}
    assert result["gpu"] == {}
    assert result["display"] == {}


@pytest.fixture
def summary_probes(monkeypatch):
    monkeypatch.setattr(routes, "_system_summary_cache", {"result": None, "ts": 0.0})
    monkeypatch.setattr(routes.platform, "system", lambda: "Windows")
    monkeypatch.setattr(routes.platform, "processor", lambda: "Generic fallback CPU")
    probes = SimpleNamespace(
        cpu_count=lambda logical: 16 if logical else 8,
        virtual_memory=lambda: SimpleNamespace(total=64 * 1024 ** 3),
    )
    monkeypatch.setattr(routes, "psutil", probes)
    monkeypatch.setattr(routes, "_run_pwsh_json", lambda _: [])
    monkeypatch.setattr(ctypes, "windll", SimpleNamespace(
        user32=SimpleNamespace(GetSystemMetrics=lambda index: [1920, 1080][index])), raising=False)
    return probes


def test_summary_uses_named_cpu_and_removes_successful_probe_xml(tmp_path, monkeypatch, summary_probes):
    xml = dxdiag_file(tmp_path)
    monkeypatch.setattr(routes, "_dxdiag_xml_path", lambda: str(xml))
    result = routes.system_summary()
    assert result["cpu"] == {"model": "AMD Ryzen Fixture CPU", "cores": 8, "threads": 16}
    assert result["memory"] == {"total_gb": 64.0}
    assert result["gpu"]["vram_gb"] == 12.0
    assert result["display"] == {"width": 3840, "height": 2160, "hz": 60}
    assert not xml.exists()


def test_summary_retains_cpu_fallback_if_dxdiag_has_no_processor(tmp_path, monkeypatch, summary_probes):
    xml = dxdiag_file(tmp_path, processor="")
    monkeypatch.setattr(routes, "_dxdiag_xml_path", lambda: str(xml))
    assert routes.system_summary()["cpu"]["model"] == "Generic fallback CPU"


def test_summary_keeps_ram_and_cpu_after_dxdiag_failure_and_removes_xml(tmp_path, monkeypatch, summary_probes):
    xml = tmp_path / "broken.xml"
    xml.write_text("<unfinished")
    monkeypatch.setattr(routes, "_dxdiag_xml_path", lambda: str(xml))
    def failed_storage(_):
        raise RuntimeError("Synthetic unavailable storage probe")
    monkeypatch.setattr(routes, "_run_pwsh_json", failed_storage)
    result = routes.system_summary()
    assert result["memory"] == {"total_gb": 64.0}
    assert result["cpu"]["model"] == "Generic fallback CPU"
    assert result["gpu"]["model"] is None
    assert result["storage"]["drives"] == []
    assert result["display"] == {"width": 1920, "height": 1080}
    assert not xml.exists()


def test_summary_fills_dimensions_without_losing_valid_refresh(tmp_path, monkeypatch, summary_probes):
    xml = dxdiag_file(tmp_path, mode="Unknown (59.95Hz)")
    monkeypatch.setattr(routes, "_dxdiag_xml_path", lambda: str(xml))
    assert routes.system_summary()["display"] == {"width": 1920, "height": 1080, "hz": 59.95}


def test_cpu_count_failure_does_not_hide_ram_or_named_cpu(tmp_path, monkeypatch, summary_probes):
    xml = dxdiag_file(tmp_path)
    monkeypatch.setattr(routes, "_dxdiag_xml_path", lambda: str(xml))
    def cpu_count(logical):
        if not logical:
            raise OSError("Physical core count unavailable")
        return 16
    summary_probes.cpu_count = cpu_count
    result = routes.system_summary()
    assert result["memory"]["total_gb"] == 64.0
    assert result["cpu"] == {"model": "AMD Ryzen Fixture CPU", "cores": None, "threads": 16}


@pytest.mark.parametrize("failure", ["timeout", "nonzero"])
def test_dxdiag_subprocess_failure_removes_temp_xml(tmp_path, monkeypatch, failure):
    original_temp = routes.tempfile.NamedTemporaryFile
    monkeypatch.setattr(routes.tempfile, "NamedTemporaryFile", lambda **kwargs: original_temp(dir=tmp_path, **kwargs))
    paths = []
    def run(command, **kwargs):
        paths.append(Path(command[-1]))
        assert paths[-1].exists()
        assert kwargs["creationflags"] == (getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0)
        if failure == "timeout":
            raise subprocess.TimeoutExpired(command, kwargs["timeout"])
        return SimpleNamespace(returncode=1)
    monkeypatch.setattr(routes.subprocess, "run", run)
    with pytest.raises((subprocess.TimeoutExpired, RuntimeError)):
        routes._dxdiag_xml_path()
    assert len(paths) == 1
    assert not paths[0].exists()


def test_powershell_probe_is_hidden_and_preserves_json(monkeypatch):
    def run(command, **kwargs):
        assert command[0] == "powershell"
        assert kwargs["creationflags"] == (getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0)
        return SimpleNamespace(returncode=0, stdout='{"Model":"Fixture disk"}', stderr="")
    monkeypatch.setattr(routes.subprocess, "run", run)
    assert routes._run_pwsh_json("Synthetic read-only probe") == {"Model": "Fixture disk"}
