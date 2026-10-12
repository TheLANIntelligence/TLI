"""Optional native AI probes stay bounded and suppress Windows loader dialogs."""
from types import SimpleNamespace

import pytest

import runtime_preflight as runtime


@pytest.mark.parametrize("failure", [False, True])
def test_native_error_mode_is_restored_after_probe_success_or_failure(tmp_path, monkeypatch, failure):
    import ctypes
    calls = []
    monkeypatch.setattr(runtime, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(runtime.sys, "platform", "win32")
    monkeypatch.setattr(ctypes, "windll", SimpleNamespace(kernel32=SimpleNamespace(
        SetErrorMode=lambda flags: calls.append(flags) or 16)), raising=False)
    monkeypatch.setattr(runtime, "hidden_process_kwargs", lambda: {"creationflags": 0x08000000})
    binary = tmp_path / "llama_server.exe"
    binary.write_bytes(b"Synthetic; never executed")

    def run(command, **options):
        assert calls == [0x0001 | 0x0002 | 0x8000]
        assert command == [str(binary), "--version"]
        assert options["timeout"] == 5 and options["creationflags"] == 0x08000000
        if failure:
            raise OSError("Synthetic missing DLL")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(runtime.subprocess, "run", run)
    if failure:
        with pytest.raises(runtime.RuntimeUnavailable, match="Visual C\\+\\+ v14"):
            runtime.check_windows_runtime(binary)
    else:
        runtime.check_windows_runtime(binary)
    assert calls == [0x0001 | 0x0002 | 0x8000, 16]
