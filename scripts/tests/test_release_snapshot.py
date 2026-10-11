"""Snapshot and packaging checks use synthetic roots, never installation data."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
from types import SimpleNamespace
import zipfile

import pytest


REPO = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


snapshot = load("release_snapshot", REPO / "scripts" / "release_snapshot.py")
packager = load("snapshot_packager", REPO / "build_dist.py")


def write(root, relative, text="fixture"):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture
def source(tmp_path):
    intended = {
        "backend/main.py": "# uncommitted application edit",
        "backend/tli_state.py": 'TLI_VERSION = "synthetic"',
        "backend/requirements.txt": "fake-dependency==1",
        "backend/requirements-test.txt": "pytest",
        "backend/pytest.ini": "[pytest]",
        "backend/tli_backend.spec": "# build config",
        "backend/ai/prompts/system_default.txt": "observed capabilities",
        "backend/builder/prompts/patch.txt": "required patch prompt",
        "backend/ai/runtime/llama-server.exe": "fake windows runtime",
        "backend/ai/runtime/ggml.dll": "fake runtime library",
        "backend/ai/runtime/llama-server": "fake unix runtime",
        "backend/ai/runtime/libggml.so.0": "fake versioned unix library",
        "backend/ai/runtime/libggml.dylib": "fake mac runtime library",
        "backend/tests/conftest.py": "# fake harness isolation",
        "backend/tests/test_feature.py": "# fake harness case",
        "frontend/index.html": "<main>new uncommitted UI</main>",
        "frontend/js/new-panel.js": "// untracked source is intended",
        "frontend/css/performance-workspace.css": ".perf { color: inherit; }",
        "frontend/assets/intro.mp3": "fake bundled audio",
        "frontend/manifest.json": "{}",
        "frontend/history/early-dashboard.html": "<section>Inert synthetic source exhibit</section>",
        "frontend/history/provenance.json": "{}",
        "frontend/assets/answer-validation.json": "{\"synthetic\":true}",
        "frontend/assets/model-comparison.json": "{\"synthetic\":true,\"models\":[]}",
        "frontend/assets/model-comparison-anniversary.json": "{\"synthetic\":true,\"models\":[]}",
        "scripts/fixtures/tli_answer_extensions.json": "{\"version\":1,\"cases\":[]}",
        "scripts/fixtures/tli_answer_development.json": "{\"version\":1,\"cases\":[]}",
        "scripts/fixtures/tli_dependable_computers_quality.json": "{\"synthetic\":true}",
        "mobile/tests/fixtures/case-report-preview.json": "{\"synthetic\":true}",
        "mobile/tests/fixtures/peer-guided-report.json": "{\"synthetic\":true}",
        "mobile/tests/fixtures/next-check.json": "{\"synthetic\":true}",
        "frontend/tests/new-panel.test.cjs": "// source test",
        "frontend/tests/fixtures/free-space-api.json": '{"synthetic":true,"fixtures":{}}',
        "frontend/tests/fixtures/next-check.json": '{"synthetic":true}',
        "mobile/package.json": "{}",
        "mobile/package-lock.json": "{}",
        "mobile/eas.json": "{}",
        "mobile/app.config.ts": "// app configuration",
        "mobile/.easignore": "node_modules/",
        "mobile/tsconfig.json": "{}",
        "mobile/src/client.ts": "// changed client",
        "mobile/app/index.tsx": "// screen",
        "mobile/assets/icon.png": "fake image",
        "mobile/tests/client.test.ts": "// test",
        "mobile/scripts/verify-anniversary-preview.cjs": "// isolated preview verification",
        "mobile/modules/tli-transport/expo-module.config.json": "{}",
        "mobile/modules/tli-transport/package.json": "{}",
        "mobile/modules/tli-transport/android/build.gradle": "// native build config",
        "mobile/modules/tli-transport/android/src/main/AndroidManifest.xml": "<manifest />",
        "mobile/modules/tli-transport/android/src/main/java/Transport.kt": "// native source",
        "mobile/modules/tli-transport/ios/Transport.swift": "// native source",
        "mobile/modules/tli-transport/ios/Transport.podspec": "# native package",
        "scripts/verify_release.py": "# external verifier",
        "scripts/release_snapshot.py": "# snapshot tool",
        "scripts/tests/test_fixture.py": "# developer tool tests",
        "scripts/fixtures/tli_answer_quality.json": '{"cases": ["synthetic evaluation input"]}',
        ".easignore": "/*\n!/mobile",
        ".gitignore": "build_work/",
        "build_dist.py": "# packaging config",
        "TLI_Start.bat": "@echo off",
        "TLI_Start.sh": "#!/bin/sh",
        "build_mac.sh": "#!/bin/sh",
    }
    excluded = [
        "data/private.json", "backend/ai/memory/user/facts.json", "backend/ai/memory/user/source.py",
        "backend/memory/user.json", "backend/data/private.py", "backend/tli_data/private.py", "backend/vault_data/private.py",
        "backend/ai/models/installed.json", "backend/ai/runtime/model.gguf", "backend/ai/runtime/model.ggml",
        "backend/ai/runtime/llama-bench.exe", "backend/ai/runtime/private.key", "backend/ai/runtime/keys/fake.dll",
        "backend/tli_model_config.json", "backend/vault_meta.json", "backend/credentials.json", "backend/routers/printers_snmp.json",
        "mobile/src/secrets.yaml", "mobile/modules/tli-transport/credentials.yml", "backend/id_ed25519",
        "backend/pin.key", "backend/random-private.json", "mobile/credentials.json", "mobile/private.keystore",
        "mobile/.env.local", "mobile/node_modules/library/index.js", "mobile/.expo/cache.ts", "mobile/android/generated.kt",
        "mobile/ios/generated.swift", "mobile/build-inspect/private.json", "frontend/index.html.bak", "frontend/assets/private-unreviewed.json",
        "backend/dist_build/main.py", "backend/.venv/lib/source.py", "frontend/coverage/result.js",
        "scripts/__pycache__/tool.pyc", "scripts/fixtures/unreviewed.json", "scripts/fixtures/private/nested.json", "notes/private.md", ".env", ".env.local", "unreviewed.json",
    ]
    for name, text in intended.items():
        write(tmp_path, name, text)
    for name in excluded:
        write(tmp_path, name, "PRIVATE_CANARY_DO_NOT_COPY")
    return tmp_path, intended, excluded


def test_snapshot_contains_current_uncommitted_source_and_complete_mobile_inputs(source):
    root, intended, excluded = source
    result = snapshot.create_snapshot(root)
    copied = Path(result["snapshot_root"])
    manifest = json.loads(Path(result["manifest_path"]).read_text())
    assert {entry["path"] for entry in manifest["files"]} == set(intended)
    assert result["file_count"] == len(intended)
    assert Path(result["workspace"]).parent == root / "build_work"
    assert Path(result["manifest_path"]).parent == Path(result["workspace"])
    for name, text in intended.items():
        assert (copied / name).read_text() == text == (root / name).read_text()
    for name in excluded:
        assert not (copied / name).exists()
        assert (root / name).read_text() == "PRIVATE_CANARY_DO_NOT_COPY"
    assert snapshot.verify_snapshot(copied, Path(result["manifest_path"]), root)["source_matches"] is True


def test_host_launchers_and_named_public_guides_ship_without_unlisted_documents(tmp_path):
    assert snapshot.PUBLIC_GUIDES == packager.PUBLIC_GUIDES
    included = ["TLI_Setup.bat", "TLI_Setup.ps1", "TLI_Diagnostics.bat",
                "TLI.exe", "build_launcher.ps1", "desktop/TliLauncher.cs", "desktop/tli.ico",
                "docs/TLI_HOST_START.md", "docs/HOST_START.md", "docs/TLI_SMART_HUB_REFINEMENT.md",
                "docs/RELEASE_1.4.0_BETA.md"]
    for name in included:
        write(tmp_path, name, "public source")
    for name in ["docs/private.md", "docs/credentials.json", "docs/archive/TLI_HOST_START.md",
                 "desktop/unreviewed.exe", "desktop/other.cs", "desktop/TLI.lnk", "TLI.lnk"]:
        write(tmp_path, name, "PRIVATE_CANARY_DO_NOT_COPY")
    result = snapshot.create_snapshot(tmp_path)
    copied = Path(result["snapshot_root"])
    assert {entry["path"] for entry in json.loads(Path(result["manifest_path"]).read_text())["files"]} == set(included)
    assert not (copied / "docs/private.md").exists()


def test_fingerprint_is_canonical_and_attempts_never_overwrite(source):
    root, _, _ = source
    first, second = snapshot.create_snapshot(root), snapshot.create_snapshot(root)
    assert first["workspace"] != second["workspace"]
    assert first["fingerprint"] == second["fingerprint"]
    assert len(first["fingerprint"]) == 64
    manifest = json.loads(Path(first["manifest_path"]).read_text())
    assert manifest["files"] == sorted(manifest["files"], key=lambda item: item["path"])


def test_private_and_unlisted_trees_are_never_enumerated(source, monkeypatch):
    root, _, _ = source
    original = os.scandir
    def scan(path):
        rel = Path(path).relative_to(root).as_posix()
        assert not rel.startswith(("data", "backend/ai/memory", "backend/memory", "backend/ai/models", "backend/vault_data", "backend/tli_data", "mobile/node_modules", "notes"))
        return original(path)
    monkeypatch.setattr(os, "scandir", scan)
    snapshot.create_snapshot(root)


@pytest.mark.parametrize("change", ["content", "add", "delete"])
def test_working_source_drift_is_rejected(source, change):
    root, _, _ = source
    result = snapshot.create_snapshot(root)
    if change == "content":
        write(root, "backend/main.py", "# modified again after freeze")
    elif change == "add":
        write(root, "mobile/src/new-code.ts", "// new source")
    else:
        (root / "frontend/js/new-panel.js").unlink()
    with pytest.raises(snapshot.SnapshotError, match="Working-tree source drifted"):
        snapshot.verify_snapshot(Path(result["snapshot_root"]), Path(result["manifest_path"]), root)


@pytest.mark.parametrize("change", ["content", "add", "delete"])
def test_frozen_source_mutation_is_rejected(source, change):
    root, _, _ = source
    result = snapshot.create_snapshot(root)
    copied = Path(result["snapshot_root"])
    if change == "content":
        write(copied, "mobile/src/client.ts", "// edited frozen source")
    elif change == "add":
        write(copied, "frontend/js/added.js", "// changed source set")
    else:
        (copied / "backend/main.py").unlink()
    with pytest.raises(snapshot.SnapshotError, match="Frozen source does not match"):
        snapshot.verify_snapshot(copied, Path(result["manifest_path"]))


def test_dependency_and_export_caches_do_not_mask_or_create_source_drift(source):
    root, _, _ = source
    result = snapshot.create_snapshot(root)
    copied = Path(result["snapshot_root"])
    for tree in (root, copied):
        write(tree, "mobile/node_modules/dependency/source.ts")
        write(tree, "mobile/.expo/generated/types.ts")
        write(tree, "mobile/dist/bundle.js")
        write(tree, "backend/__pycache__/main.pyc")
    assert snapshot.verify_snapshot(copied, Path(result["manifest_path"]), root)["ok"]
    write(copied, "mobile/src/client.ts", "// cache checks cannot hide this edit")
    with pytest.raises(snapshot.SnapshotError):
        snapshot.verify_snapshot(copied, Path(result["manifest_path"]))


def test_source_edit_during_copy_rejects_attempt(source, monkeypatch):
    root, _, _ = source
    original = snapshot._record
    def record(source_root, rel, destination=None):
        value = original(source_root, rel, destination)
        if destination is not None and rel.as_posix() == "backend/main.py":
            write(root, rel, "# changed concurrently after this file was copied")
        return value
    monkeypatch.setattr(snapshot, "_record", record)
    with pytest.raises(snapshot.SnapshotError, match="Working-tree source drifted"):
        snapshot.create_snapshot(root)


def test_linked_source_files_and_windows_junctions_are_never_followed(source, monkeypatch):
    root, intended, _ = source
    linked = write(root, "frontend/js/linked/private.js")
    original_stat, original_scan = Path.lstat, os.scandir
    def lstat(path):
        if path in {root / "backend/main.py", linked.parent}:
            return SimpleNamespace(st_mode=stat.S_IFDIR if path == linked.parent else stat.S_IFREG, st_file_attributes=0x400)
        return original_stat(path)
    def scan(path):
        assert Path(path) != linked.parent
        return original_scan(path)
    monkeypatch.setattr(Path, "lstat", lstat)
    monkeypatch.setattr(os, "scandir", scan)
    result = snapshot.create_snapshot(root)
    copied = Path(result["snapshot_root"])
    assert not (copied / "backend/main.py").exists()
    assert not (copied / "frontend/js/linked").exists()
    assert result["file_count"] == len(intended) - 1


def test_link_replacing_frozen_source_is_detected(source, monkeypatch):
    root, _, _ = source
    result = snapshot.create_snapshot(root)
    copied = Path(result["snapshot_root"])
    original = snapshot._linked
    monkeypatch.setattr(snapshot, "_linked", lambda path: path == copied / "backend/main.py" or original(path))
    with pytest.raises(snapshot.SnapshotError, match="Frozen source"):
        snapshot.verify_snapshot(copied, Path(result["manifest_path"]))


def test_output_is_restricted_to_unique_ignored_directories(source, tmp_path):
    root, _, _ = source
    with pytest.raises(snapshot.SnapshotError, match="build_work"):
        snapshot.create_snapshot(root, root / "release-output")
    assert not (root / "release-output").exists()
    result = snapshot.create_snapshot(root, root / "build_work" / "verification")
    assert Path(result["workspace"]).parent == root / "build_work" / "verification"


@pytest.mark.parametrize("bad", ["path", "hash", "duplicate", "size"])
def test_manifest_tampering_is_rejected(source, bad):
    root, _, _ = source
    result = snapshot.create_snapshot(root)
    path = Path(result["manifest_path"])
    value = json.loads(path.read_text())
    if bad == "path":
        value["files"][0]["path"] = "../private.py"
    elif bad == "hash":
        value["source_fingerprint"] = "0" * 64
    elif bad == "duplicate":
        value["files"].append(value["files"][0])
    else:
        value["files"][0]["size"] = True
    path.write_text(json.dumps(value))
    with pytest.raises(snapshot.SnapshotError, match="Invalid snapshot manifest"):
        snapshot.verify_snapshot(Path(result["snapshot_root"]), path)


def test_desktop_package_uses_frozen_source_and_leaves_harness_and_mobile_out(source, monkeypatch):
    root, _, _ = source
    result = snapshot.create_snapshot(root)
    copied = Path(result["snapshot_root"])
    monkeypatch.setattr(packager, "ROOT", copied)
    archive_path = Path(result["workspace"]) / "desktop.zip"
    packager.build(archive_path)
    with zipfile.ZipFile(archive_path) as archive:
        names = set(archive.namelist())
        assert "backend/main.py" in names and "frontend/js/new-panel.js" in names
        assert "backend/ai/runtime/llama-server.exe" in names
        assert "backend/ai/runtime/libggml.so.0" in names
        assert not any(name.startswith(("mobile/", "scripts/", "backend/tests/", "frontend/tests/")) for name in names)
        assert archive.read("backend/main.py") == b"# uncommitted application edit"


def test_cli_create_and_verify_use_only_the_explicit_synthetic_root(source):
    root, _, _ = source
    tool = str(REPO / "scripts/release_snapshot.py")
    result = subprocess.run([sys.executable, tool, "create", "--repo", str(root)], capture_output=True, text=True, check=True)
    value = json.loads(result.stdout)
    verified = subprocess.run([sys.executable, tool, "verify", "--snapshot", value["snapshot_root"], "--manifest", value["manifest_path"], "--source", str(root)], capture_output=True, text=True, check=True)
    assert json.loads(verified.stdout)["fingerprint"] == value["fingerprint"]
