"""Offline updates must preserve private state and remain recoverable."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import zipfile

import pytest

import update_install as U


def _files():
    return {
        "backend/main.py": b"# new application\n",
        "backend/tli_state.py": b'TLI_VERSION = "2.0.0"\n',
        "backend/requirements.txt": b"psutil>=5.9.0\n",
        "backend/update_install.py": b"# offline updater\n",
        "frontend/index.html": b"<html>new</html>\n",
        "frontend/js/added.js": b"// new feature\n",
    }


def _manifest(files=None, platform="all"):
    files = files or _files()
    return {
        "schema_version": 1, "version": "2.0.0", "platform": platform,
        "files": [{"path": path, "size": len(content), "sha256": hashlib.sha256(content).hexdigest(), "mode": 0o644}
                  for path, content in files.items()],
    }


def _archive(tmp_path, files=None, manifest=None, extras=None):
    files = files or _files()
    path = tmp_path / "release.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(U.MANIFEST_NAME, json.dumps(manifest or _manifest(files)))
        for name, content in files.items():
            zf.writestr(name, content)
        for name, content in (extras or {}).items():
            zf.writestr(name, content)
    return path


def _write(root, relative, data):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _source(tmp_path):
    root = tmp_path / "source"
    for name, content in _files().items():
        _write(root, name, content)
    _write(root, U.MANIFEST_NAME, json.dumps(_manifest()).encode())
    return root


def _target(tmp_path):
    root = tmp_path / "installed"
    _write(root, "backend/tli_state.py", b'TLI_VERSION = "1.0.0"\n')
    _write(root, "backend/main.py", b"# old application\n")
    _write(root, "frontend/index.html", b"<html>old</html>\n")
    return root


@pytest.fixture
def stopped(monkeypatch):
    calls = []
    monkeypatch.setattr(U, "ensure_stopped", lambda target: calls.append(target))
    return calls


def test_archive_roundtrip_and_expected_release(tmp_path):
    archive = _archive(tmp_path)
    assert U.validate_archive(archive, "2.0.0", "windows")["version"] == "2.0.0"
    source = tmp_path / "staged"
    U.extract_archive(archive, source, "2.0.0", "macos")
    assert (source / "backend/main.py").read_bytes() == _files()["backend/main.py"]
    with pytest.raises(U.UpdateError, match="version"):
        U.validate_archive(archive, "9.0.0")
    with pytest.raises(U.UpdateError, match="already exist"):
        U.extract_archive(archive, source)


def test_update_installs_removal_entries_and_rollback_preserves_saved_data(tmp_path, stopped):
    additions = {
        "Uninstall_TLI.bat": b"@echo off\n",
        "TLI_Uninstall.ps1": b"# reviewed native removal window\n",
        "Uninstall_TLI.command": b"#!/bin/bash\n# manual guide\n",
        "Uninstall_TLI.sh": b"#!/bin/bash\n# manual guide\n",
        "docs/TLI_UNINSTALL.md": b"Review this installation before removal.\n",
    }
    files = {**_files(), **additions}
    source, target = tmp_path / "source", _target(tmp_path)
    archive = _archive(tmp_path, files=files)
    U.extract_archive(archive, source)
    saved = _write(target, "data/vault/keep.bin", b"private synthetic saved data")
    U.install(source, target)
    for name, content in additions.items():
        assert (target / name).read_bytes() == content
    U.rollback(target)
    assert saved.read_bytes() == b"private synthetic saved data"
    assert not any((target / name).exists() for name in additions)


@pytest.mark.parametrize("path", [
    "../escape.py", "/escape.py", "backend\\main.py", "backend/main.py:stream", "backend/NUL.py",
    "frontend/js/trailing. /x.js", "backend/ai/models/new.gguf", "data/users.json", "backend/devices.json",
    "backend/ai/memory/remember.py", "backend/.venv/pwn.py", "backend/.env", "unknown/file.py",
])
def test_archive_rejects_unsafe_or_private_files(tmp_path, path):
    archive = _archive(tmp_path, extras={path: b"not allowed"})
    with pytest.raises(U.UpdateError):
        U.extract_archive(archive, tmp_path / "staged")
    assert not (tmp_path / "staged").exists()


@pytest.mark.parametrize("mutation", ["hash", "size", "duplicate", "private", "platform", "mode", "version", "count"])
def test_manifest_rejects_corruption(tmp_path, mutation):
    manifest = _manifest()
    if mutation == "hash":
        manifest["files"][0]["sha256"] = "0" * 64
    elif mutation == "size":
        manifest["files"][0]["size"] += 1
    elif mutation == "duplicate":
        manifest["files"].append(dict(manifest["files"][0]))
    elif mutation == "private":
        manifest["files"][0]["path"] = "backend/devices.json"
    elif mutation == "platform":
        manifest["platform"] = []
    elif mutation == "mode":
        manifest["files"][0]["mode"] = 0o4777
    elif mutation == "version":
        manifest["version"] = "bad\nversion"
    elif mutation == "count":
        manifest["files"] = []
    with pytest.raises(U.UpdateError):
        U.validate_archive(_archive(tmp_path, manifest=manifest))


def test_archive_rejects_case_duplicate_and_symlink(tmp_path):
    archive = _archive(tmp_path, extras={"frontend/INDEX.html": b"other"})
    with pytest.raises(U.UpdateError, match="Duplicate"):
        U.validate_archive(archive)
    archive = _archive(tmp_path)
    with zipfile.ZipFile(archive, "a") as zf:
        info = zipfile.ZipInfo("frontend/js/link.js")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        zf.writestr(info, "../../data/private")
    with pytest.raises(U.UpdateError, match="Linked"):
        U.validate_archive(archive)


def test_archive_limits_and_mismatched_platform(tmp_path, monkeypatch):
    archive = _archive(tmp_path, manifest=_manifest(platform="macos"))
    with pytest.raises(U.UpdateError, match="operating system"):
        U.validate_archive(archive, expected_platform="windows")
    monkeypatch.setattr(U, "MAX_BYTES", 5)
    with pytest.raises(U.UpdateError, match="size limit"):
        U.validate_archive(archive)


def test_install_preserves_private_legacy_models_env_unknown_and_backup(tmp_path, stopped):
    source, target = _source(tmp_path), _target(tmp_path)
    private = ["data/accounts.json", "data/vault/blob.enc", "backend/devices.json", "backend/ai/memory/custom.json",
               "backend/ai/models/model.gguf", "backend/.venv/keep.py", ".env", "frontend/custom.js", "personal.txt"]
    for path in private:
        _write(target, path, b"private unchanged")
    _write(target, U.MANIFEST_NAME, b"old manifest")
    _write(source, "update-target.json", json.dumps({"target": str(target)}).encode())
    receipt = U.install(source, target)
    assert receipt["status"] == "installed" and receipt["version"] == "2.0.0"
    assert (target / "backend/main.py").read_bytes() == _files()["backend/main.py"]
    assert all((target / path).read_bytes() == b"private unchanged" for path in private)
    assert not (target / "update-target.json").exists()
    backup = Path(receipt["backup"])
    assert (backup / "files" / U.MANIFEST_NAME).read_bytes() == b"old manifest"
    assert json.loads((backup / "journal.json").read_text())["status"] == "complete"
    assert len(stopped) == 2
    U.rollback(target)
    assert (target / "backend/main.py").read_bytes() == b"# old application\n"
    assert (target / U.MANIFEST_NAME).read_bytes() == b"old manifest"
    assert not (target / "frontend/js/added.js").exists()
    assert all((target / path).read_bytes() == b"private unchanged" for path in private)


def test_injected_copy_failure_rolls_back_and_retains_journal(tmp_path, stopped, monkeypatch):
    source, target = _source(tmp_path), _target(tmp_path)
    original = U._copy_atomic
    def fail(source_path, destination, mode, expected=None):
        if destination == target / "frontend/index.html":
            raise OSError("injected copy failure")
        return original(source_path, destination, mode, expected)
    monkeypatch.setattr(U, "_copy_atomic", fail)
    with pytest.raises(U.UpdateError, match="previous application files were restored"):
        U.install(source, target)
    assert (target / "backend/main.py").read_bytes() == b"# old application\n"
    assert not (target / "backend/requirements.txt").exists()
    assert not (target / U.MANIFEST_NAME).exists()
    journal = next((target / "data/updates/backups").glob("*/journal.json"))
    assert json.loads(journal.read_text())["status"] == "rolled_back"


def test_interruption_has_durable_journal_and_can_be_recovered(tmp_path, stopped, monkeypatch):
    source, target = _source(tmp_path), _target(tmp_path)
    original = U._copy_atomic
    def interrupt(source_path, destination, mode, expected=None):
        if destination == target / "backend/tli_state.py":
            journal_path = next((target / "data/updates/backups").glob("*/journal.json"))
            assert json.loads(journal_path.read_text())["status"] == "applying"
            raise KeyboardInterrupt("simulated interruption")
        return original(source_path, destination, mode, expected)
    monkeypatch.setattr(U, "_copy_atomic", interrupt)
    with pytest.raises(KeyboardInterrupt):
        U.install(source, target)
    assert (target / "backend/main.py").read_bytes() == _files()["backend/main.py"]
    monkeypatch.setattr(U, "_copy_atomic", original)
    with pytest.raises(U.UpdateError, match="interrupted"):
        U.install(source, target)
    assert U.rollback(target)["status"] == "rolled_back"
    assert (target / "backend/main.py").read_bytes() == b"# old application\n"
    assert U.install(source, target)["status"] == "installed"


def test_recovery_refuses_tampered_backup_and_changed_user_code(tmp_path, stopped):
    source, target = _source(tmp_path), _target(tmp_path)
    receipt = U.install(source, target)
    saved = Path(receipt["backup"]) / "files/backend/main.py"
    saved.write_bytes(b"tampered")
    with pytest.raises(U.UpdateError, match="damaged"):
        U.rollback(target)
    assert (target / "backend/main.py").read_bytes() == _files()["backend/main.py"]
    saved.write_bytes(b"# old application\n")
    (target / "frontend/index.html").write_bytes(b"my later edits")
    with pytest.raises(U.UpdateError, match="changed after the update"):
        U.rollback(target)
    assert (target / "frontend/index.html").read_bytes() == b"my later edits"


def test_source_corruption_no_files_changed(tmp_path, stopped):
    source, target = _source(tmp_path), _target(tmp_path)
    (source / "backend/main.py").write_bytes(b"corrupt source")
    with pytest.raises(U.UpdateError, match="hash mismatch"):
        U.install(source, target)
    assert (target / "backend/main.py").read_bytes() == b"# old application\n"
    assert not (target / "data/updates/backups").exists()


def test_prepared_source_environment_and_private_state_are_ignored(tmp_path, stopped):
    source, target = _source(tmp_path), _target(tmp_path)
    private = ["backend/.venv/Lib/installed.py", "data/users.json", "backend/__pycache__/main.pyc",
               "backend/ai/models/model.gguf", "backend/ai/memory/state.json", "backend/active_model.json", ".env"]
    for name in private:
        _write(source, name, b"source private state")
    U.install(source, target)
    assert all(not (target / name).exists() for name in private)
    _write(source, "backend/unlisted.py", b"unlisted application code")
    with pytest.raises(U.UpdateError, match="unlisted"):
        U.install(source, target)


def test_startup_guard_does_not_create_state(tmp_path):
    target = _target(tmp_path)
    U.require_completed_update(target)
    assert not (target / "data").exists()


@pytest.mark.parametrize("state", ["prepared", "applying", "rolling_back", "corrupt"])
def test_startup_guard_blocks_incomplete_or_corrupt_journal(tmp_path, stopped, state):
    source, target = _source(tmp_path), _target(tmp_path)
    receipt = U.install(source, target)
    U.require_completed_update(target)
    journal_path = Path(receipt["backup"]) / "journal.json"
    journal = json.loads(journal_path.read_text())
    journal["status"] = state
    journal_path.write_text("{broken" if state == "corrupt" else json.dumps(journal), encoding="utf-8")
    with pytest.raises(U.UpdateError, match="--rollback"):
        U.require_completed_update(target)
    if state != "corrupt":
        U.rollback(target)
        U.require_completed_update(target)


def test_staged_source_within_target_updates_is_allowed(tmp_path, stopped):
    source, target = _source(tmp_path), _target(tmp_path)
    staged = target / "data/updates/2.0.0/package"
    staged.parent.mkdir(parents=True)
    source.rename(staged)
    assert U.install(staged, target)["status"] == "installed"


def test_same_source_target_and_nested_target_rejected(tmp_path, stopped):
    source = _source(tmp_path)
    with pytest.raises(U.UpdateError, match="separate"):
        U.install(source, source)
    target = source / "old"
    _write(target, "backend/tli_state.py", b"old")
    _write(target, "frontend/index.html", b"old")
    with pytest.raises(U.UpdateError, match="separate"):
        U.install(source, target)


def test_linked_destination_is_rejected(tmp_path, stopped):
    source, target = _source(tmp_path), _target(tmp_path)
    external = _write(tmp_path, "outside.txt", b"private")
    (target / "backend/main.py").unlink()
    try:
        (target / "backend/main.py").symlink_to(external)
    except OSError:
        pytest.skip("Creating symlinks is unavailable on this Windows host")
    with pytest.raises(U.UpdateError, match="Linked"):
        U.install(source, target)
    assert external.read_bytes() == b"private"


def test_process_guard_stopped_running_helper_and_unrelated(tmp_path, monkeypatch):
    import psutil
    target = _target(tmp_path).resolve()
    def processes(records):
        monkeypatch.setattr(psutil, "process_iter", lambda *args, **kwargs: [SimpleNamespace(info=item) for item in records])
    base = {"pid": 12345, "name": "python.exe", "exe": str(tmp_path / "python.exe"), "cwd": str(target / "backend")}
    processes([{**base, "cmdline": ["python", str(target / "backend/main.py")]}])
    with pytest.raises(U.UpdateError, match="Close TLI"):
        U.ensure_stopped(target)
    processes([{**base, "cmdline": ["python", "host_control_server.py"]}])
    with pytest.raises(U.UpdateError, match="helper"):
        U.ensure_stopped(target)
    processes([{**base, "cmdline": ["python", "-m", "uvicorn", "main:app"]}])
    with pytest.raises(U.UpdateError, match="server"):
        U.ensure_stopped(target)
    processes([{**base, "cwd": str(tmp_path), "cmdline": ["python", "main.py"]}])
    U.ensure_stopped(target)
    processes([{**base, "pid": os.getpid(), "cmdline": ["python", str(target / "backend/update_install.py")]}])
    U.ensure_stopped(target)
    processes([{**base, "cmdline": None}])
    with pytest.raises(U.UpdateError, match="Cannot inspect Python"):
        U.ensure_stopped(target)


def test_process_guard_runtime_and_frozen_launcher(tmp_path, monkeypatch):
    import psutil
    target = _target(tmp_path).resolve()
    for relative in ("TLI.exe", "backend/tli_backend.exe", "backend/ai/runtime/llama_server.exe"):
        info = {"pid": 12345, "name": Path(relative).name, "exe": str(target / relative), "cmdline": [str(target / relative)], "cwd": str(target)}
        monkeypatch.setattr(psutil, "process_iter", lambda *args, **kwargs: [SimpleNamespace(info=info)])
        with pytest.raises(U.UpdateError, match="Close TLI"):
            U.ensure_stopped(target)


def test_running_installation_has_no_backup_or_code_writes(tmp_path, monkeypatch):
    source, target = _source(tmp_path), _target(tmp_path)
    def running(target):
        raise U.UpdateError("Close TLI before updating")
    monkeypatch.setattr(U, "ensure_stopped", running)
    with pytest.raises(U.UpdateError, match="Close TLI"):
        U.install(source, target)
    assert (target / "backend/main.py").read_bytes() == b"# old application\n"
    assert not (target / "data/updates/backups").exists()


def test_installation_lock_prevents_parallel_updates(tmp_path, stopped):
    source, target = _source(tmp_path), _target(tmp_path)
    with U._installation_lock(target):
        with pytest.raises(U.UpdateError, match="already running"):
            U.install(source, target)
    assert U.install(source, target)["status"] == "installed"


def test_cli_requires_local_confirmation(tmp_path, monkeypatch, stopped):
    source, target = _source(tmp_path), _target(tmp_path)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda prompt: "no")
    assert U.main(["--source", str(source), "--target", str(target)]) == 1
    assert (target / "backend/main.py").read_bytes() == b"# old application\n"
    monkeypatch.setattr("builtins.input", lambda prompt: "UPDATE")
    assert U.main(["--source", str(source), "--target", str(target)]) == 0


def test_frontend_only_package_cannot_install(tmp_path, stopped):
    source, target = _source(tmp_path), _target(tmp_path)
    files = {"frontend/index.html": b"new"}
    for directory in (source / "backend", source / "frontend/js"):
        import shutil
        shutil.rmtree(directory)
    (source / "frontend/index.html").write_bytes(b"new")
    (source / U.MANIFEST_NAME).write_text(json.dumps(_manifest(files)), encoding="utf-8")
    with pytest.raises(U.UpdateError, match="complete release"):
        U.install(source, target)


@pytest.mark.parametrize("platform,names", [
    ("windows", ["TLI_Update.bat", "TLI_Update.ps1"]),
    ("macos", ["TLI_Update.command", "TLI_Update.sh"]),
    ("linux", ["TLI_Update.sh"]),
])
def test_guided_release_requires_complete_source_and_platform_wrappers(platform, names):
    manifest = _manifest()
    U.require_full_release(manifest)
    with pytest.raises(U.UpdateError, match="complete release"):
        U.require_full_release(manifest, platform)
    files = _files()
    files.update({name: b"# update launcher" for name in names})
    U.require_full_release(_manifest(files), platform)
    del files["backend/update_install.py"]
    with pytest.raises(U.UpdateError, match="backend/update_install.py"):
        U.require_full_release(_manifest(files), platform)


def test_recovery_and_startup_guard_are_installed_first_manifest_last(tmp_path, stopped, monkeypatch):
    source, target = _source(tmp_path), _target(tmp_path)
    original, copied = U._copy_atomic, []
    def record(source_path, destination, mode, expected=None):
        if destination.parent != target / "data" and "backups" not in destination.parts:
            copied.append(destination.relative_to(target).as_posix())
        return original(source_path, destination, mode, expected)
    monkeypatch.setattr(U, "_copy_atomic", record)
    U.install(source, target)
    assert copied[:2] == ["backend/update_install.py", "backend/main.py"]
    assert copied[-1] == U.MANIFEST_NAME
