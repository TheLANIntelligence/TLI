from pathlib import Path

import pytest

from ai import runtime_support


@pytest.mark.parametrize("machine,selected", [("arm64", "macos-arm64"), ("aarch64", "macos-arm64"),
                                                ("x86_64", "macos-x64"), ("AMD64", "macos-x64")])
def test_macos_selects_only_the_process_architecture(tmp_path, monkeypatch, machine, selected):
    monkeypatch.setattr(runtime_support.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(runtime_support.platform, "machine", lambda: machine)
    for name in ("macos-arm64", "macos-x64"):
        (tmp_path / name).mkdir()
        (tmp_path / name / "llama-server").write_bytes(b"synthetic native runtime")
    assert runtime_support.select_runtime(tmp_path) == tmp_path / selected / "llama-server"


def test_macos_legacy_root_does_not_select_other_architecture(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime_support.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(runtime_support.platform, "machine", lambda: "arm64")
    (tmp_path / "macos-x64").mkdir()
    (tmp_path / "macos-x64/llama-server").write_bytes(b"wrong architecture")
    legacy = tmp_path / "llama-server"
    legacy.write_bytes(b"legacy runtime")
    assert runtime_support.select_runtime(tmp_path) == legacy
    (tmp_path / "macos-arm64").mkdir()
    # An incomplete architecture-specific installation stays missing instead of
    # running an unrelated root binary or the other architecture's server.
    assert runtime_support.select_runtime(tmp_path) == tmp_path / "macos-arm64/llama-server"


def test_non_macos_preserves_existing_runtime_layout(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime_support.platform, "system", lambda: "Windows")
    (tmp_path / "macos-arm64").mkdir()
    import os
    assert runtime_support.select_runtime(tmp_path) == tmp_path / ("llama_server.exe" if os.name == "nt" else "llama-server")


def test_manager_uses_runtime_selection_helper(tmp_path, monkeypatch):
    from ai import ai_manager
    selected = tmp_path / "macos-arm64/llama-server"
    recorded = []
    monkeypatch.setattr(ai_manager, "_ai_base_dir", lambda: tmp_path)
    monkeypatch.setattr(ai_manager, "_resolve_model_path", lambda: Path("synthetic-model.gguf"))
    monkeypatch.setattr(runtime_support, "select_runtime", lambda folder: recorded.append(folder) or selected)
    monkeypatch.setattr(ai_manager.BundledAIManager, "_instance", None)
    monkeypatch.setattr(ai_manager.BundledAIManager, "__init__", lambda self, cfg: setattr(self, "cfg", cfg))
    assert ai_manager.BundledAIManager.get().cfg.runtime_path == selected
    assert recorded == [tmp_path / "runtime"]
