"""Distribution rules run against synthetic files, never the installation's data."""
import importlib.util
import os
from pathlib import Path
import stat
from types import SimpleNamespace
import zipfile

import pytest

spec = importlib.util.spec_from_file_location("release_packager", Path(__file__).resolve().parents[2] / "build_dist.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


@pytest.fixture
def package_root(tmp_path, monkeypatch):
    files = {
        "backend/tli_state.py": 'TLI_VERSION = "test"',
        "backend/main.py": "print('application')",
        "backend/requirements.txt": "Pillow>=12.1.1",
        "frontend/index.html": "<html>TLI</html>",
        "frontend/js/intelligence.js": "/* shipped feature */",
        "frontend/tests/example.test.cjs": "/* test only */",
        "mobile/package.json": "{}",
        "mobile/modules/tli-transport/index.ts": "/* native app only */",
        "backend/tests/example.py": "# test only",
        "data/intelligence/private.json": "private data",
        "backend/ai/memory/user/facts.json": "legacy private notes",
        "backend/ai/memory/user/session.py": "private memory even with source extension",
        "backend/memory/user.json": "private memory",
        "backend/tli_data/pin.json": "legacy runtime state",
        "backend/vault_data/secret.txt": "legacy encrypted material",
        "backend/ai/models/catalog.json": "runtime model installation",
        "backend/build_work/intermediate.py": "build artifact",
        "backend/dist_build/source.py": "build artifact",
        "frontend/.expo/cache.js": "build artifact",
        "backend/credentials.json": "credentials",
        "backend/routers/printers_snmp.json": "private printer communities",
        "backend/secrets.yaml": "secrets",
        "backend/id_ed25519": "SSH key",
        "backend/tli_pin.json": "PIN verifier",
        "backend/ai/runtime/keys/secret.dll": "key directory must beat binary override",
        "backend/ai/runtime/model.ggml": "legacy model",
        "backend/ai/runtime/credential.pfx": "private key",
        "backend/ai/runtime/access.jsonl": "private event log",
        "scripts/release_snapshot.py": "developer harness",
        "scripts/verify_companion_browser.cjs": "developer harness",
        "scripts/tests/test_snapshot.py": "developer test",
        ".env": "secret settings",
        ".dev.vars": "synthetic local worker secrets",
        ".dev.vars.preview": "synthetic preview worker secrets",
        "website/download-verification.mjs": "website service",
        "website/vendor/example.json": "website data",
        "functions/api/download/request.js": "website endpoint",
        "wrangler.toml": "website hosting configuration",
        "backend/.env.local": "local secrets",
        "backend/key.pem": "private key",
        "backend/ai/runtime/llama_server.exe": "runtime",
        "backend/ai/runtime/ggml.dll": "runtime library",
        "backend/ai/runtime/llama-server": "unix runtime",
        "backend/ai/runtime/private.gguf": "model weights",
        "backend/ai/runtime/private.key": "private key",
        "backend/ai/runtime/trace.log": "private log",
        "backend/ai/runtime/llama-bench.exe": "benchmark only",
        "TLI_Start.sh": "#!/bin/sh\nexit 0\n",
    }
    for name, data in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data, encoding="utf-8")
    monkeypatch.setattr(packager, "ROOT", tmp_path)
    return tmp_path


def test_full_release_keeps_dependencies_runtime_and_excludes_private_files(package_root, capsys):
    output = package_root / "build.zip"
    packager.build(output)
    with zipfile.ZipFile(output) as archive:
        names = set(archive.namelist())
        assert names == {
            "backend/tli_state.py", "backend/main.py", "backend/requirements.txt",
            "frontend/index.html", "frontend/js/intelligence.js",
            "backend/ai/runtime/llama_server.exe", "backend/ai/runtime/ggml.dll",
            "backend/ai/runtime/llama-server", "TLI_Start.sh",
        }
        for name in ("TLI_Start.sh", "backend/ai/runtime/llama-server"):
            info = archive.getinfo(name)
            assert info.create_system == 3 and (info.external_attr >> 16) & 0o111 == 0o111
        assert archive.getinfo("backend/main.py").compress_type == zipfile.ZIP_DEFLATED
    assert '"frontend_only": false' in capsys.readouterr().out
    assert (package_root / "data/intelligence/private.json").read_text() == "private data"


def test_frontend_only_is_explicit_and_contains_no_backend(package_root, capsys):
    output = package_root / "ui.zip"
    packager.build(output, frontend_only=True)
    with zipfile.ZipFile(output) as archive:
        assert set(archive.namelist()) == {"frontend/index.html", "frontend/js/intelligence.js"}
    assert '"frontend_only": true' in capsys.readouterr().out


@pytest.mark.parametrize("platform", ["windows", "macos"])
def test_platform_packages_keep_matching_runtime_and_launchers_only(package_root, platform):
    for name in (packager.COMMON_ROOT_FILES | set().union(*packager.PLATFORM_ROOT_FILES.values())):
        (package_root / name).write_text("synthetic release file", encoding="utf-8")
    for arch in ("macos-arm64", "macos-x64"):
        base = package_root / "backend/ai/runtime" / arch
        base.mkdir(parents=True)
        for name in ("llama-server", "libllama.0.dylib", "LICENSE"):
            (base / name).write_text("synthetic runtime", encoding="utf-8")
    (package_root / ".github/workflows").mkdir(parents=True)
    (package_root / ".github/workflows/build.yml").write_text("developer only")
    (package_root / "build_mac.sh").write_text("legacy developer script")
    output = package_root / f"{platform}.zip"
    packager.build(output, platform=platform)
    with zipfile.ZipFile(output) as archive:
        names = set(archive.namelist())
    assert packager.PLATFORM_ROOT_FILES[platform] <= names
    assert not (packager.PLATFORM_ROOT_FILES['macos' if platform == 'windows' else 'windows'] & names)
    assert not any(name.startswith((".github/", "scripts/", "desktop/")) for name in names)
    assert "build_mac.sh" not in names
    assert "START_HERE.md" in names and "LICENSE" in names
    if platform == "macos":
        assert "backend/ai/runtime/macos-arm64/llama-server" in names
        assert "backend/ai/runtime/macos-x64/libllama.0.dylib" in names
        assert not any(name.endswith((".exe", ".dll", ".bat", ".ps1")) for name in names)
    else:
        assert "backend/ai/runtime/llama_server.exe" in names
        assert not any("macos-" in name or name.endswith(".dylib") for name in names)


def test_platform_package_fails_when_not_prepared(package_root):
    with pytest.raises(RuntimeError, match="Prepare the platform package"):
        packager.build(package_root / "not-ready.zip", platform="windows")
    assert not (package_root / "not-ready.zip").exists()


def test_windows_built_shell_scripts_have_unix_line_endings(package_root):
    (package_root / "TLI_Start.command").write_bytes(b"#!/bin/bash\r\necho TLI\r\n")
    output = package_root / "portable.zip"
    packager.build(output)
    with zipfile.ZipFile(output) as archive:
        assert archive.read("TLI_Start.command") == b"#!/bin/bash\necho TLI\n"
        assert archive.getinfo("TLI_Start.command").external_attr >> 16 & 0o111 == 0o111


def test_only_named_public_guides_are_packaged(package_root):
    for name in ["docs/HOST_START.md", "docs/TLI_HOST_START.md", "docs/TLI_SMART_HUB_REFINEMENT.md",
                 "docs/private.md", "docs/nested/HOST_START.md", "docs/credentials.json"]:
        path = package_root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("synthetic guide or private canary", encoding="utf-8")
    output = package_root / "public-guides.zip"
    packager.build(output)
    with zipfile.ZipFile(output) as archive:
        assert {name for name in archive.namelist() if name.startswith("docs/")} == {
            "docs/HOST_START.md", "docs/TLI_HOST_START.md", "docs/TLI_SMART_HUB_REFINEMENT.md"}


def test_linked_files_cannot_pull_private_data_into_a_package(package_root, monkeypatch):
    # Fake link detection also exercises this rule on Windows without symlink privileges.
    original = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda path: path.name == "intelligence.js" or original(path))
    output = package_root / "linked.zip"
    packager.build(output)
    with zipfile.ZipFile(output) as archive:
        assert "frontend/js/intelligence.js" not in archive.namelist()


@pytest.mark.parametrize("dry_run", [False, True])
def test_private_memory_is_pruned_without_enumerating_or_reading_it(package_root, monkeypatch, dry_run):
    original = os.scandir
    def scan(path):
        relative = Path(path).relative_to(package_root).as_posix()
        assert not relative.startswith(("backend/ai/memory", "backend/memory", "data/", "backend/tli_data", "backend/vault_data"))
        return original(path)
    monkeypatch.setattr(os, "scandir", scan)
    packager.build(package_root / "safe.zip", dry_run=dry_run)


def test_windows_junction_and_symlink_directories_are_pruned_on_older_python(package_root, monkeypatch):
    linked = package_root / "frontend" / "linked"
    linked.mkdir()
    (linked / "private.js").write_text("do not package")
    original_stat, original_scan = Path.lstat, os.scandir
    monkeypatch.setattr(Path, "lstat", lambda path: SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400) if path == linked else original_stat(path))
    def scan(path):
        assert Path(path) != linked
        return original_scan(path)
    monkeypatch.setattr(os, "scandir", scan)
    output = package_root / "junction.zip"
    packager.build(output)
    with zipfile.ZipFile(output) as archive:
        assert "frontend/linked/private.js" not in archive.namelist()


@pytest.mark.parametrize("path", ["BACKEND/AI/MEMORY/user/facts.json", "backend/Data/facts.json", "backend/.ENV.local", "backend/CREDENTIALS.JSON", "backend/private.P12"])
def test_sensitive_exclusions_are_case_insensitive(path):
    assert packager._should_skip(Path(path))[0]


def test_desktop_launcher_ships_but_machine_shortcuts_and_other_executables_do_not(package_root):
    public = ["TLI.exe", "build_launcher.ps1", "desktop/TliLauncher.cs", "desktop/tli.ico"]
    private = ["TLI.lnk", "desktop/TLI.LNK", "desktop/unreviewed.exe", "other/TLI.exe", "backend/TLI.exe"]
    for name in public + private:
        path = package_root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"synthetic artifact")
    output = package_root / "launcher.zip"
    packager.build(output)
    with zipfile.ZipFile(output) as archive:
        assert set(public) <= set(archive.namelist())
        assert not set(private) & set(archive.namelist())
