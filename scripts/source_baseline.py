"""Freeze reviewable source under build_work without Git or application access.

This source-only baseline extends the existing release source allowlist with
developer documentation and named Node/CI inputs. Publication hygiene removes
downloaded runtimes and binaries. It is not an installable release package.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path, PurePosixPath
import os
import re
import stat
import tempfile

if __package__:
    from . import release_snapshot as release
    from .check_source_hygiene import forbidden_reason
else:
    import release_snapshot as release
    from check_source_hygiene import forbidden_reason


SnapshotError = release.SnapshotError
FORMAT = "tli-source-baseline-v1"
EXTRA_FILES = frozenset({
    ".gitattributes", "CONTRIBUTING.md", "build_node.py", "TLI_Node.bat",
    "node/README.md", "node/requirements.txt",
    ".github/workflows/source-checks.yml", ".github/workflows/desktop-packages.yml",
})
EXTRA_DIRS = {Path(name).parent for name in EXTRA_FILES}
EXTRA_DIRS |= {parent for path in tuple(EXTRA_DIRS) for parent in path.parents if parent != Path(".")}
EXTRA_DIRS.discard(Path("."))


def _file_allowed(rel: Path) -> bool:
    return forbidden_reason(rel.as_posix()) is None and (
        release._file_allowed(rel) or rel.as_posix() in EXTRA_FILES
        or len(rel.parts) == 2 and rel.parts[0] == "docs" and rel.suffix == ".md")


def _directory_allowed(rel: Path) -> bool:
    return forbidden_reason((rel / "__source__").as_posix()) is None and (
        release._directory_allowed(rel) or rel in EXTRA_DIRS)


def _safe_path(path: Path) -> Path:
    """Check every existing component before following a path or creating it."""
    path = Path(path).absolute()
    if ".." in path.parts:
        raise SnapshotError("Parent traversal is not allowed in baseline paths.")
    for component in reversed((path, *path.parents)):
        try:
            linked = release._linked(component)
            info = component.lstat()
        except FileNotFoundError:
            continue
        if linked:
            raise SnapshotError("Source baselines cannot use linked or reparse paths.")
        if stat.S_ISREG(info.st_mode) and getattr(info, "st_nlink", 1) > 1:
            raise SnapshotError("Source baselines cannot use multiply linked regular files.")
    return path


def _source_files(root: Path, *, frozen: bool = False) -> list[Path]:
    """Reuse release policy while pruning private trees before enumeration.

    Selected links are errors, rather than silently omitted inputs. A frozen
    tree is stricter: even a new excluded file/directory invalidates the copy.
    """
    root = _safe_path(root)
    if not root.is_dir():
        raise SnapshotError("Baseline source is not a regular directory.")
    result = []
    def inaccessible(_error):
        raise SnapshotError("An allowlisted source directory could not be read.")
    for directory, dirs, files in os.walk(root, topdown=True, followlinks=False, onerror=inaccessible):
        base = _safe_path(Path(directory))
        selected = []
        for name in sorted(dirs):
            path = base / name
            allowed = _directory_allowed(path.relative_to(root))
            if frozen and not allowed:
                raise SnapshotError("Frozen source contains an unexpected directory.")
            if allowed:
                _safe_path(path)
                selected.append(name)
        dirs[:] = selected
        for name in sorted(files):
            path = base / name
            rel = path.relative_to(root)
            allowed = _file_allowed(rel)
            if frozen and not allowed:
                raise SnapshotError("Frozen source contains an unexpected file.")
            if allowed:
                _safe_path(path)
                if not stat.S_ISREG(path.lstat().st_mode):
                    raise SnapshotError("An allowlisted source input is not a regular file.")
                result.append(rel)
    return sorted(result, key=lambda path: path.as_posix())


def _records(root: Path, *, destination: Path | None = None, frozen: bool = False) -> list[dict]:
    records = []
    for rel in _source_files(root, frozen=frozen):
        _safe_path(root / rel)
        target = _safe_path(destination / rel) if destination is not None else None
        records.append(release._record(root, rel, target))
    return records


def _read_manifest(path: Path) -> dict:
    path = _safe_path(path)
    if not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
        raise SnapshotError("Invalid source baseline manifest.")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        def require(condition):
            if not condition:
                raise SnapshotError("Invalid source baseline manifest.")
        require(set(value) == {"format", "source_policy_version", "created_at", "source_fingerprint", "files"})
        require(value["format"] == FORMAT)
        require(type(value["source_policy_version"]) is int and value["source_policy_version"] == release.POLICY_VERSION)
        require(isinstance(value["created_at"], str) and 0 < len(value["created_at"]) <= 80)
        records = value["files"]
        require(isinstance(records, list) and records)
        names = []
        for record in records:
            require(set(record) == {"path", "size", "sha256"})
            name = record["path"]
            require(isinstance(name, str) and bool(name))
            rel = PurePosixPath(name)
            require(rel.as_posix() == name and not rel.is_absolute() and ".." not in rel.parts)
            require("\\" not in name and ":" not in name and _file_allowed(Path(name)))
            require(type(record["size"]) is int and record["size"] >= 0)
            require(isinstance(record["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", record["sha256"]))
            names.append(name)
        require(names == sorted(set(names)))
        require(release._fingerprint(records) == value["source_fingerprint"])
    except (KeyError, TypeError, ValueError):
        raise SnapshotError("Invalid source baseline manifest.") from None
    return value


def verify_snapshot(snapshot_root: Path, manifest_path: Path, source_root: Path | None = None) -> dict:
    """Verify every frozen file, optionally detecting original-source drift."""
    snapshot_root = _safe_path(snapshot_root)
    manifest = _read_manifest(manifest_path)
    expected = manifest["files"]
    if _records(snapshot_root, frozen=True) != expected:
        raise SnapshotError("Frozen source does not match its manifest.")
    if source_root is not None and _records(_safe_path(source_root)) != expected:
        raise SnapshotError("Working-tree source drifted; create a new baseline.")
    return {"ok": True, "fingerprint": manifest["source_fingerprint"], "file_count": len(expected),
            "source_matches": True if source_root is not None else None}


def create_snapshot(repo: Path, output_dir: Path | None = None) -> dict:
    """Create a unique source/ and manifest.json; preserve every earlier attempt."""
    repo = _safe_path(repo)
    if not repo.is_dir():
        raise SnapshotError("Source repository is not a regular directory.")
    allowed = repo / "build_work"
    output_dir = _safe_path(output_dir if output_dir is not None else allowed)
    if not output_dir.is_relative_to(allowed):
        raise SnapshotError("Baseline output must stay inside this repository's build_work directory.")
    # Enumerate and reject selected links before creating output or reading data.
    files = _source_files(repo)
    if not files:
        raise SnapshotError("No allowlisted source was found.")
    output_dir.mkdir(parents=True, exist_ok=True)
    _safe_path(output_dir)
    workspace = _safe_path(Path(tempfile.mkdtemp(prefix="source-baseline-", dir=output_dir)))
    snapshot = workspace / "source"
    snapshot.mkdir()
    records = []
    for rel in files:
        _safe_path(repo / rel)
        records.append(release._record(repo, rel, _safe_path(snapshot / rel)))
    manifest_path = workspace / "manifest.json"
    with manifest_path.open("x", encoding="utf-8") as stream:
        json.dump({"format": FORMAT, "source_policy_version": release.POLICY_VERSION,
                   "created_at": datetime.now(timezone.utc).isoformat(),
                   "source_fingerprint": release._fingerprint(records), "files": records}, stream, indent=2)
        stream.write("\n")
    verified = verify_snapshot(snapshot, manifest_path, source_root=repo)
    return {"workspace": str(workspace), "snapshot_root": str(snapshot), "manifest_path": str(manifest_path),
            "fingerprint": verified["fingerprint"], "file_count": verified["file_count"]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    create = commands.add_parser("create")
    create.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    create.add_argument("--output-dir", type=Path)
    verify = commands.add_parser("verify")
    verify.add_argument("--snapshot", type=Path, required=True)
    verify.add_argument("--manifest", type=Path, required=True)
    verify.add_argument("--source", type=Path)
    args = parser.parse_args(argv)
    try:
        result = (create_snapshot(args.repo, args.output_dir) if args.operation == "create"
                  else verify_snapshot(args.snapshot, args.manifest, args.source))
    except (SnapshotError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error) if isinstance(error, SnapshotError)
                          else "Source baseline files could not be accessed."}))
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
