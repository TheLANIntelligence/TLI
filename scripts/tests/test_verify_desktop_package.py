"""Host-independent package boundary tests; no live application or native runtime."""
import importlib.util
from pathlib import Path
import stat
import zipfile

import pytest


spec = importlib.util.spec_from_file_location("desktop_package_verifier", Path(__file__).parents[1] / "verify_desktop_package.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
VERSION = "1.4.0-beta"


def fixture_files(target):
    files = {name: b"fixture\n" for name in verifier.COMMON_ROOT | verifier.PLATFORM_ROOT[target] | verifier.REQUIRED_SOURCE}
    files["backend/tli_state.py"] = f'TLI_VERSION = "{VERSION}"\n'.encode()
    files["frontend/app.js"] = f'const TLI_VERSION = "{VERSION}";\n'.encode()
    files["frontend/index.html"] = b'<link href="style.css"><script src="app.js"></script>'
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
    assert inventory["files"] == len(fixture_files(target))
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
    ({"TLI_Bootstrap.ps1": None}, "required"), ({"backend/ai/runtime/LICENSE-llama.cpp.txt": None}, "licensing")])
def test_missing_entrypoint_license_or_stale_version_fails(tmp_path, changes, match):
    with pytest.raises(verifier.PackageError, match=match):
        verifier.inspect_archive(write_zip(tmp_path, changes=changes), "windows", VERSION)


def test_macos_requires_lf_and_executable_launchers_and_runtime(tmp_path):
    with pytest.raises(verifier.PackageError, match="LF"):
        verifier.inspect_archive(write_zip(tmp_path, "macos", {"TLI_Start.sh": b"#!/bin/bash\r\n"}), "macos", VERSION)
    for name in ["TLI_Start.command", "backend/ai/runtime/macos-arm64/llama-server"]:
        with pytest.raises(verifier.PackageError, match="executable"):
            verifier.inspect_archive(write_zip(tmp_path, "macos", modes={name: stat.S_IFREG | 0o644}), "macos", VERSION)


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
