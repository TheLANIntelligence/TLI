"""Source baseline checks use synthetic trees and never import the application."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
from types import SimpleNamespace

import pytest


REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("scripts.source_baseline", REPO / "scripts/source_baseline.py")
baseline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(baseline)


def write(root, relative, content=b"synthetic source\r\n"):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


@pytest.fixture
def source(tmp_path):
    included = {
        "README.md", "AGENTS.md", "build_dist.py", "backend/main.py",
        "backend/requirements.txt", "backend/tests/test_feature.py",
        "backend/tests/fixtures/synthetic.json", "backend/ai/prompts/system_default.txt",
        "frontend/index.html", "frontend/js/panel.js", "frontend/manifest.json",
        "frontend/assets/icon.png", "frontend/tests/panel.test.cjs",
        "frontend/history/provenance.json", "desktop/TliLauncher.cs",
        "mobile/package.json", "mobile/package-lock.json", "mobile/app.config.ts",
        "mobile/app/index.tsx", "mobile/src/client.ts", "mobile/tests/client.test.ts",
        "mobile/modules/transport/android/src/main/java/Transport.kt",
        "mobile/modules/transport/ios/Transport.swift",
        "scripts/source_baseline.py", "scripts/tests/test_source_baseline.py",
        "scripts/fixtures/tli_answer_quality.json", "docs/SSE_SCHEMA.md",
        "docs/TLI_ANALYSIS_2026-10-17.md", "docs/TLI_ROUTE_AUTHORITY_INVENTORY.md",
        *baseline.EXTRA_FILES,
    }
    excluded = {
        "TLI.exe", "backend/ai/runtime/llama-server", "backend/ai/runtime/llama-server.exe",
        "backend/ai/runtime/ggml.dll", "backend/ai/runtime/libggml.so.1",
        "backend/ai/runtime/LICENSE", "backend/ai/runtime/private.key",
        "data/private.json", "backend/ai/memory/private.py", "backend/devices.json",
        "backend/routers/printers_snmp.json", "backend/tli_confidential/private.py",
        "backend/ai/tli_confidential/private.py", "backend/.venv/lib/private.py",
        "mobile/node_modules/library/source.ts", "mobile/src/.dev.vars", "mobile/credentials.json",
        "frontend/assets/private.pem", "frontend/assets/private.db", "frontend/assets/private.json",
        "docs/private/diary.md", "docs/report.json", "docs/report.pdf", "notes/private.md",
        "node/private.txt", "node/extra.py", ".github/workflows/unreviewed.yml", ".env",
    }
    for name in included:
        write(tmp_path, name)
    for name in excluded:
        write(tmp_path, name, b"PRIVATE_CANARY_DO_NOT_COPY")
    return tmp_path, included, excluded


def test_source_only_baseline_preserves_allowlist_and_extra_inputs(source):
    root, included, excluded = source
    result = baseline.create_snapshot(root)
    copied, manifest_path = Path(result["snapshot_root"]), Path(result["manifest_path"])
    manifest = json.loads(manifest_path.read_text())
    assert manifest["format"] == baseline.FORMAT
    assert {row["path"] for row in manifest["files"]} == included
    assert result["file_count"] == len(included)
    assert result["fingerprint"] == baseline.release._fingerprint(manifest["files"])
    assert Path(result["workspace"]).parent == root / "build_work"
    for name in included:
        assert (copied / name).read_bytes() == (root / name).read_bytes() == b"synthetic source\r\n"
    for name in excluded:
        assert not (copied / name).exists()
        assert (root / name).read_bytes() == b"PRIVATE_CANARY_DO_NOT_COPY"
    assert baseline.verify_snapshot(copied, manifest_path, root)["source_matches"] is True
    assert baseline.verify_snapshot(copied, manifest_path)["source_matches"] is None


def test_private_and_downloaded_trees_are_not_read_or_enumerated(source, monkeypatch):
    root, _, excluded = source
    original_scan, original_open = os.scandir, Path.open
    blocked_trees = [root / name for name in (
        "data", "backend/ai/runtime", "backend/ai/memory", "backend/.venv",
        "backend/ai/tli_confidential", "mobile/node_modules", "docs/private", "notes")]
    def scan(path):
        assert not any(Path(path).is_relative_to(tree) for tree in blocked_trees)
        return original_scan(path)
    def open_file(path, *args, **kwargs):
        assert path not in {root / name for name in excluded}
        return original_open(path, *args, **kwargs)
    monkeypatch.setattr(os, "scandir", scan)
    monkeypatch.setattr(Path, "open", open_file)
    baseline.create_snapshot(root)


def test_each_attempt_is_exclusive_and_fingerprint_is_stable(source):
    root, _, _ = source
    first = baseline.create_snapshot(root)
    before = Path(first["manifest_path"]).read_bytes()
    second = baseline.create_snapshot(root, root / "build_work" / "review")
    assert first["workspace"] != second["workspace"]
    assert first["fingerprint"] == second["fingerprint"]
    assert Path(first["manifest_path"]).read_bytes() == before
    assert Path(second["workspace"]).parent == root / "build_work" / "review"


@pytest.mark.parametrize("change", ["edit", "add", "add-doc", "delete"])
def test_original_source_drift_is_detected_including_additions(source, change):
    root, _, _ = source
    result = baseline.create_snapshot(root)
    if change == "edit":
        write(root, "backend/main.py", b"modified")
    elif change == "add":
        write(root, "mobile/src/new.ts")
    elif change == "add-doc":
        write(root, "docs/new.md")
    else:
        (root / "node/requirements.txt").unlink()
    assert baseline.verify_snapshot(result["snapshot_root"], result["manifest_path"])["ok"]
    with pytest.raises(baseline.SnapshotError, match="source drifted"):
        baseline.verify_snapshot(result["snapshot_root"], result["manifest_path"], root)


def test_new_private_state_and_dependencies_do_not_become_source_drift(source):
    root, _, _ = source
    result = baseline.create_snapshot(root)
    write(root, "data/new-private.json")
    write(root, "mobile/node_modules/new/source.ts")
    write(root, "backend/ai/runtime/new.dll")
    assert baseline.verify_snapshot(result["snapshot_root"], result["manifest_path"], root)["ok"]


@pytest.mark.parametrize("change", ["edit", "add", "delete", "add-private", "add-binary"])
def test_frozen_tamper_is_rejected_even_for_excluded_inputs(source, change):
    root, _, _ = source
    result = baseline.create_snapshot(root)
    frozen = Path(result["snapshot_root"])
    if change == "delete":
        (frozen / "backend/main.py").unlink()
    else:
        relative = {"edit": "backend/main.py", "add": "frontend/js/new.js",
                    "add-private": "data/private.json", "add-binary": "TLI.exe"}[change]
        write(frozen, relative, b"tampered")
    with pytest.raises(baseline.SnapshotError, match="Frozen source"):
        baseline.verify_snapshot(frozen, result["manifest_path"])


@pytest.mark.parametrize("change", ["traversal", "absolute", "binary", "duplicate", "size", "hash", "format"])
def test_manifest_tamper_is_rejected_before_source_reads(source, monkeypatch, change):
    root, _, _ = source
    result = baseline.create_snapshot(root)
    path = Path(result["manifest_path"])
    manifest = json.loads(path.read_text())
    row = manifest["files"][0]
    if change in {"traversal", "absolute", "binary"}:
        row["path"] = {"traversal": "../private.py", "absolute": "/backend/main.py", "binary": "TLI.exe"}[change]
    elif change == "duplicate":
        manifest["files"].append(dict(row))
    elif change == "size":
        row["size"] = True
    elif change == "format":
        manifest["format"] = "release"
    manifest["source_fingerprint"] = ("0" * 64 if change == "hash"
                                      else baseline.release._fingerprint(manifest["files"]))
    path.write_text(json.dumps(manifest))
    monkeypatch.setattr(baseline.release, "_record", lambda *a, **kw: pytest.fail("Invalid manifest authorized source read"))
    with pytest.raises(baseline.SnapshotError, match="Invalid source baseline manifest"):
        baseline.verify_snapshot(result["snapshot_root"], path)


@pytest.mark.parametrize("entry", [".", "backend/main.py", "frontend/js", "docs/TLI_ANALYSIS_2026-10-17.md", ".github/workflows"])
@pytest.mark.parametrize("kind", ["symlink", "reparse"])
def test_selected_links_and_reparse_entries_are_refused_before_copy(source, monkeypatch, entry, kind):
    root, _, _ = source
    linked = root / entry
    original = Path.lstat
    def lstat(path):
        if path == linked:
            return SimpleNamespace(st_mode=stat.S_IFLNK if kind == "symlink" else stat.S_IFDIR,
                                   st_file_attributes=0x400 if kind == "reparse" else 0)
        return original(path)
    monkeypatch.setattr(Path, "lstat", lstat)
    monkeypatch.setattr(baseline.release, "_record", lambda *a, **kw: pytest.fail("Linked source was read"))
    with pytest.raises(baseline.SnapshotError, match="linked or reparse"):
        baseline.create_snapshot(root)
    assert not (root / "build_work").exists()


@pytest.mark.parametrize("entry", ["source", "source/backend", "source/backend/main.py", "manifest.json"])
def test_frozen_and_manifest_links_are_refused(source, monkeypatch, entry):
    root, _, _ = source
    result = baseline.create_snapshot(root)
    linked = Path(result["workspace"]) / entry
    original = baseline.release._linked
    monkeypatch.setattr(baseline.release, "_linked", lambda path: path == linked or original(path))
    with pytest.raises(baseline.SnapshotError, match="linked or reparse"):
        baseline.verify_snapshot(result["snapshot_root"], result["manifest_path"])


@pytest.mark.parametrize("location", ["source", "frozen", "manifest"])
def test_native_hardlinks_cannot_smuggle_excluded_bytes(source, monkeypatch, location):
    root, _, _ = source
    private = root / "data/private.json"
    before = private.read_bytes()
    result = baseline.create_snapshot(root) if location != "source" else None
    target = (root / "backend/main.py" if location == "source" else
              Path(result["snapshot_root"]) / "backend/main.py" if location == "frozen" else
              Path(result["manifest_path"]))
    target.unlink()
    os.link(private, target)
    assert private.stat().st_nlink == target.stat().st_nlink == 2
    original_open = Path.open
    def open_file(path, *args, **kwargs):
        assert path not in {private, target}, "Hardlinked private bytes must not be read"
        return original_open(path, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(Path, "open", open_file)
        with pytest.raises(baseline.SnapshotError, match="multiply linked regular files"):
            if location == "source":
                baseline.create_snapshot(root)
            else:
                baseline.verify_snapshot(result["snapshot_root"], result["manifest_path"])
    assert private.read_bytes() == target.read_bytes() == before
    if location == "source":
        assert not (root / "build_work").exists()


@pytest.mark.parametrize("output", ["release-output", "build_work/../escape"])
def test_output_escape_is_rejected_before_source_reads(source, monkeypatch, output):
    root, _, _ = source
    monkeypatch.setattr(baseline.release, "_record", lambda *a, **kw: pytest.fail("Output escape read source"))
    with pytest.raises(baseline.SnapshotError, match="build_work|traversal"):
        baseline.create_snapshot(root, root / output)
    assert not (root / "build_work").exists()
    assert not (root / "release-output").exists()


def test_output_reparse_ancestor_is_refused(source, monkeypatch):
    root, _, _ = source
    output = root / "build_work"
    output.mkdir()
    original = baseline.release._linked
    monkeypatch.setattr(baseline.release, "_linked", lambda path: path == output or original(path))
    with pytest.raises(baseline.SnapshotError, match="linked or reparse"):
        baseline.create_snapshot(root, output / "review")
    assert list(output.iterdir()) == []


def test_concurrent_source_addition_rejects_the_attempt(source, monkeypatch):
    root, _, _ = source
    original = baseline.release._record
    def record(source_root, rel, destination=None):
        result = original(source_root, rel, destination)
        if destination is not None and rel.as_posix() == "backend/main.py":
            write(root, "backend/new.py")
        return result
    monkeypatch.setattr(baseline.release, "_record", record)
    with pytest.raises(baseline.SnapshotError, match="source drifted"):
        baseline.create_snapshot(root)


def test_cli_create_verify_and_drift_failure_use_only_synthetic_source(source):
    root, _, _ = source
    command = [sys.executable, str(REPO / "scripts/source_baseline.py")]
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    created = subprocess.run(command + ["create", "--repo", str(root)], capture_output=True,
                             text=True, check=True, **options)
    result = json.loads(created.stdout)
    verify = command + ["verify", "--snapshot", result["snapshot_root"], "--manifest", result["manifest_path"], "--source", str(root)]
    verified = subprocess.run(verify, capture_output=True, text=True, check=True, **options)
    assert json.loads(verified.stdout)["fingerprint"] == result["fingerprint"]
    write(root, "docs/new.md")
    denied = subprocess.run(verify, capture_output=True, text=True, **options)
    assert denied.returncode == 1 and json.loads(denied.stdout)["ok"] is False
