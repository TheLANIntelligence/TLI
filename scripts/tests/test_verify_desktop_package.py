"""Host-independent package boundary tests; no live application or native runtime."""
import importlib.util
import hashlib
import json
from pathlib import Path
import stat
import zipfile

import pytest


spec = importlib.util.spec_from_file_location("desktop_package_verifier", Path(__file__).parents[1] / "verify_desktop_package.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
VERSION = "1.4.1-beta"


def test_failed_child_reports_bounded_output_tail():
    from subprocess import CompletedProcess
    result = CompletedProcess(["synthetic-child"], 1, stdout="prefix" * 4000, stderr="specific child failure")
    with pytest.raises(verifier.PackageError) as caught:
        verifier.require_process(result, "Application check failed")
    message = str(caught.value)
    assert message.startswith("Application check failed")
    assert message.endswith("specific child failure")
    assert len(message) < 12200


def test_successful_child_needs_no_failure_output():
    from subprocess import CompletedProcess
    verifier.require_process(CompletedProcess(["synthetic-child"], 0), "not a failure")


def test_macos_stdlib_metadata_is_warmed_before_application_guard(monkeypatch):
    import platform
    import subprocess
    import sys
    from types import SimpleNamespace
    # Load a fresh stdlib module so this exercises CPython's real lazy uname
    # processor lookup and platform cache without disturbing the test host.
    spec = importlib.util.spec_from_file_location("isolated_platform", platform.__file__)
    fresh = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fresh)
    fresh.sys = SimpleNamespace(platform="darwin", executable=sys.executable)
    uname = fresh.uname_result("Darwin", "synthetic", "24.0", "synthetic version", "arm64")
    monkeypatch.setattr(fresh, "uname", lambda: uname)
    monkeypatch.setattr(fresh, "mac_ver", lambda: ("15.0", ("", "", ""), "arm64"))
    monkeypatch.setattr(verifier, "host_platform", fresh)
    def blocked(*args, **kwargs):
        raise RuntimeError("Application process guard")
    monkeypatch.setattr(subprocess, "check_output", blocked)
    with pytest.raises(RuntimeError, match="Application process guard"):
        fresh.platform()
    probes = []
    def metadata_command(command, **kwargs):
        probes.append(command)
        if command == ["uname", "-p"]:
            return "arm\n"
        assert command[:2] == ["file", "-b"]
        return b"Mach-O 64-bit executable arm64\n"
    monkeypatch.setattr(subprocess, "check_output", metadata_command)
    warmed = verifier.host_metadata()
    assert warmed["platform"].startswith("macOS-15.0")
    assert probes and probes[0] == ["uname", "-p"]
    monkeypatch.setattr(subprocess, "check_output", blocked)
    assert fresh.platform() == warmed["platform"]
    assert fresh.processor() == "arm"


def fixture_files(target):
    files = {name: b"fixture\n" for name in verifier.COMMON_ROOT | verifier.PLATFORM_ROOT[target] | verifier.REQUIRED_SOURCE}
    files["backend/tli_state.py"] = f'TLI_VERSION = "{VERSION}"\n'.encode()
    files["frontend/app.js"] = f'const TLI_VERSION = "{VERSION}";\n'.encode()
    files["frontend/index.html"] = b'<link href="style.css"><script src="app.js"></script>'
    files["frontend/assets/fonts/InterVariable.woff2"] = b"synthetic bundled font"
    files["frontend/assets/fonts/Inter-LICENSE.txt"] = b"synthetic bundled font license"
    directories = ["backend/ai/runtime"] if target == "windows" else ["backend/ai/runtime/macos-arm64", "backend/ai/runtime/macos-x64"]
    for directory in directories:
        runtime = "llama_server.exe" if target == "windows" else "llama-server"
        files[directory + "/" + runtime] = b"synthetic runtime, never executed"
        for name in verifier.LICENSE_NAMES | ({"LICENSE-LLVM-OpenMP.txt"} if target == "windows" else set()):
            files[directory + "/" + name] = b"fixture license\n"
    return files


def write_zip(tmp_path, target="windows", changes=None, extra=(), modes=None):
    files = fixture_files(target)
    for name, data in (changes or {}).items():
        if data is None:
            files.pop(name)
        else:
            files[name] = data
    manifest = {"schema_version": 1, "version": VERSION, "platform": target, "files": [
        {"path": name, "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
         "mode": 0o755 if name in verifier.PLATFORM_ROOT["macos"] or name.endswith("/llama-server") else 0o644}
        for name, raw in sorted(files.items())]}
    files[verifier.MANIFEST_NAME] = json.dumps(manifest).encode()
    archive = tmp_path / "fixture.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        for name, raw in list(files.items()) + list(extra):
            entry = zipfile.ZipInfo(name)
            entry.filename = name  # Preserve adversarial separators on Windows.
            entry.create_system = 3
            executable = name in verifier.PLATFORM_ROOT["macos"] or name.endswith("/llama-server")
            entry.external_attr = (modes or {}).get(name, stat.S_IFREG | (0o755 if executable else 0o644)) << 16
            bundle.writestr(entry, raw)
    return archive


@pytest.mark.parametrize("target", ["windows", "macos"])
def test_complete_inventory_and_fresh_extraction(tmp_path, target):
    archive = write_zip(tmp_path, target)
    inventory = verifier.inspect_archive(archive, target, VERSION)
    assert inventory["files"] == len(fixture_files(target)) + 1
    assert inventory["release_inventory_verified"] is True
    assert inventory["release_inventory_files"] == len(fixture_files(target))
    destination = tmp_path / "installation"
    verifier.extract_fresh(archive, destination)
    assert verifier.asset_paths(destination / "frontend") == ["app.js", "index.html", "style.css"]
    with pytest.raises(verifier.PackageError, match="must be new"):
        verifier.extract_fresh(archive, destination)


@pytest.mark.parametrize("name", ["../escape.py", "/absolute.py", "backend/../escape.py", "backend\\escape.py",
                                 "backend/C:drive.py", "backend/NUL.py", "backend/ambiguous. ", "backend//double.py"])
def test_rejects_unsafe_paths_before_extraction(tmp_path, name):
    archive = write_zip(tmp_path, extra=[(name, b"never extract")])
    with pytest.raises(verifier.PackageError):
        verifier.inspect_archive(archive, "windows", VERSION)
    assert not (tmp_path / "escape.py").exists()


@pytest.mark.parametrize("name", ["backend/data/conversations.json", "backend/.env", "backend/models/model.gguf",
                                 "backend/tests/test_private.py", "scripts/developer.py", "frontend/private.key",
                                 "docs/PRIVATE_ACCEPTANCE.md", "TLI_Start.sh", "backend/ai/runtime/libggml.dylib"])
def test_rejects_private_developer_and_opposite_platform_files(tmp_path, name):
    with pytest.raises(verifier.PackageError, match="private, developer-only or wrong-platform"):
        verifier.inspect_archive(write_zip(tmp_path, extra=[(name, b"fixture")]), "windows", VERSION)


def test_duplicate_case_collision_and_link_rejected(tmp_path):
    with pytest.raises(verifier.PackageError, match="duplicate or case-colliding"):
        verifier.inspect_archive(write_zip(tmp_path, extra=[("frontend/APP.js", b"collision")]), "windows", VERSION)
    with pytest.raises(verifier.PackageError, match="link or special"):
        verifier.inspect_archive(write_zip(tmp_path, modes={"frontend/app.js": stat.S_IFLNK | 0o777}), "windows", VERSION)


def test_private_empty_directory_and_file_directory_collision_rejected(tmp_path):
    with pytest.raises(verifier.PackageError, match="private or developer-only directory"):
        verifier.inspect_archive(write_zip(tmp_path, extra=[("backend/data/", b"")]), "windows", VERSION)
    with pytest.raises(verifier.PackageError, match="conflicting"):
        verifier.inspect_archive(write_zip(tmp_path, extra=[("backend/main.py/child.py", b"collision")]), "windows", VERSION)


@pytest.mark.parametrize("changes,match", [({"frontend/app.js": b'const TLI_VERSION = "old";'}, "version"),
    ({"TLI_Bootstrap.ps1": None}, "required"), ({"backend/ai/runtime/LICENSE-llama.cpp.txt": None}, "licensing"),
    ({"frontend/assets/fonts/Inter-LICENSE.txt": None}, "font licensing")])
def test_missing_entrypoint_license_or_stale_version_fails(tmp_path, changes, match):
    with pytest.raises(verifier.PackageError, match=match):
        verifier.inspect_archive(write_zip(tmp_path, changes=changes), "windows", VERSION)


def test_macos_requires_lf_and_executable_launchers_and_runtime(tmp_path):
    with pytest.raises(verifier.PackageError, match="LF"):
        verifier.inspect_archive(write_zip(tmp_path, "macos", {"TLI_Start.sh": b"#!/bin/bash\r\n"}), "macos", VERSION)
    for name in sorted(verifier.PLATFORM_ROOT["macos"]) + ["backend/ai/runtime/macos-arm64/llama-server"]:
        with pytest.raises(verifier.PackageError, match="executable"):
            verifier.inspect_archive(write_zip(tmp_path, "macos", modes={name: stat.S_IFREG | 0o644}), "macos", VERSION)


@pytest.mark.parametrize("target", ["windows", "macos"])
def test_update_and_uninstall_launchers_and_guides_are_required(tmp_path, target):
    required = (verifier.PLATFORM_ROOT[target] | {"backend/update_install.py", "docs/TLI_UPDATES.md", "docs/TLI_UNINSTALL.md"})
    for name in sorted(required):
        with pytest.raises(verifier.PackageError, match="required file"):
            verifier.inspect_archive(write_zip(tmp_path, target, {name: None}), target, VERSION)


@pytest.mark.parametrize("mutation", ["missing", "invalid-json", "duplicate-key", "version", "platform", "all-platforms",
                                      "hash", "size", "duplicate-path", "unlisted", "missing-entry", "permissions"])
def test_generated_release_inventory_is_validated_before_extraction(tmp_path, mutation):
    archive = write_zip(tmp_path)
    with zipfile.ZipFile(archive) as bundle:
        entries = {info.filename: (info, bundle.read(info)) for info in bundle.infolist()}
    info, raw = entries[verifier.MANIFEST_NAME]
    manifest = json.loads(raw)
    if mutation == "missing":
        del entries[verifier.MANIFEST_NAME]
    elif mutation == "invalid-json":
        entries[verifier.MANIFEST_NAME] = (info, b"not JSON")
    elif mutation == "duplicate-key":
        entries[verifier.MANIFEST_NAME] = (info, raw[:-1] + b',"schema_version":1}')
    elif mutation == "permissions":
        entry, contents = entries["frontend/app.js"]
        entry.external_attr = (stat.S_IFREG | 0o755) << 16
    else:
        if mutation == "version":
            manifest["version"] = "older"
        elif mutation == "platform":
            manifest["platform"] = "macos"
        elif mutation == "all-platforms":
            manifest["platform"] = "all"
        elif mutation == "hash":
            manifest["files"][0]["sha256"] = "0" * 64
        elif mutation == "size":
            manifest["files"][0]["size"] += 1
        elif mutation == "duplicate-path":
            manifest["files"].append(manifest["files"][0])
        elif mutation == "unlisted":
            manifest["files"].pop()
        elif mutation == "missing-entry":
            manifest["files"].append({"path": "frontend/js/missing.js", "size": 0, "sha256": hashlib.sha256(b"").hexdigest(), "mode": 0o644})
        entries[verifier.MANIFEST_NAME] = (info, json.dumps(manifest).encode())
    with zipfile.ZipFile(archive, "w") as bundle:
        for entry, contents in entries.values():
            bundle.writestr(entry, contents)
    with pytest.raises(verifier.PackageError, match="inventory|required file"):
        verifier.inspect_archive(archive, "windows", VERSION)


@pytest.mark.parametrize("target", ["windows", "macos"])
def test_current_platform_package_survives_safe_source_snapshot(tmp_path, monkeypatch, target):
    repo = Path(__file__).resolve().parents[2]
    def load(name, path):
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    snapshot = load("desktop_snapshot_integration", repo / "scripts/release_snapshot.py")
    packager = load("desktop_packager_integration", repo / "build_dist.py")
    assert verifier.PLATFORM_ROOT == packager.PLATFORM_ROOT_FILES
    assert verifier.PUBLIC_GUIDES == packager.PUBLIC_GUIDES == snapshot.PUBLIC_GUIDES
    original = tmp_path / "original"
    original.mkdir()
    for name, raw in fixture_files(target).items():
        path = original / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    for name in ("data/private.json", "backend/ai/memory/private.py", "backend/ai/runtime/private-notes.txt", "TLI_RELEASE.json"):
        path = original / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("PRIVATE_CANARY_DO_NOT_SHIP")
    frozen = snapshot.create_snapshot(original)
    monkeypatch.setattr(packager, "ROOT", Path(frozen["snapshot_root"]))
    archive = Path(frozen["workspace"]) / "desktop.zip"
    packager.build(archive, platform=target)
    result = verifier.inspect_archive(archive, target, VERSION)
    assert result["release_inventory_verified"]
    with zipfile.ZipFile(archive) as bundle:
        assert not any(b"PRIVATE_CANARY_DO_NOT_SHIP" in bundle.read(name) for name in bundle.namelist())


def test_asset_references_resolve_queries_and_css_but_reject_missing_or_escape(tmp_path):
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "index.html").write_text('<link href="/style.css?v=1"><img src="https://example.invalid/remote.png">')
    (frontend / "style.css").write_text('body { background: url("image.svg"); }')
    with pytest.raises(verifier.PackageError, match="missing/outside"):
        verifier.asset_paths(frontend)
    (frontend / "image.svg").write_text("<svg/>")
    assert verifier.asset_paths(frontend) == ["image.svg", "index.html", "style.css"]
    (tmp_path / "outside.svg").write_text("<svg/>")
    (frontend / "style.css").write_text("body { background: url('../outside.svg'); }")
    with pytest.raises(verifier.PackageError, match="missing/outside"):
        verifier.asset_paths(frontend)


def test_output_stays_under_checkout_build_work_and_environment_retains_system(monkeypatch, tmp_path):
    monkeypatch.setattr(verifier, "ROOT", tmp_path)
    assert verifier.output_parent(Path("build_work/checks")) == tmp_path / "build_work/checks"
    with pytest.raises(verifier.PackageError, match="must remain"):
        verifier.output_parent(tmp_path.parent)
    monkeypatch.setenv("TLI_ROOT", "unrelated live install")
    monkeypatch.setenv("SystemRoot", "test system root")
    monkeypatch.setenv("PYTHONPATH", "unrelated imports")
    environment = verifier.clean_environment(tmp_path)
    assert {key.upper(): value for key, value in environment.items()}["SYSTEMROOT"] == "test system root"
    assert environment["TLI_ROOT"] == str(tmp_path)
    assert "PYTHONPATH" not in environment
