"""Freeze allowlisted working-tree source without Git commits or private runtime data.

create_snapshot(repo, output_dir=None) creates a unique directory under the
repository's ignored build_work directory. Its source/ includes the desktop,
mobile, and verification inputs; manifest.json lives outside the hashed tree.
verify_snapshot(source, manifest, source_root=None) checks the frozen files and,
when requested, detects drift in the original working tree. No app is imported.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile


POLICY_VERSION = 1
ROOT_FILES = {
    ".easignore", ".gitignore", "AGENTS.md", "CLAUDE.md", "README.md", "TLI_MANUAL.md", "LICENSE", "SECURITY.md",
    "build_dist.py", "build.ps1", "build_windows.ps1", "build_linux.sh", "build_mac.sh",
    "TLI_Start.bat", "TLI_Start.command", "TLI_Start.sh", "tli_sentinel.ps1",
    "TLI_Setup.ps1", "TLI_Setup.bat", "TLI_Diagnostics.bat",
    "TLI_Bootstrap.ps1", "START_HERE.md",
    "TLI_Update.bat", "TLI_Update.ps1", "TLI_Update.command", "TLI_Update.sh",
    "TLI.exe", "build_launcher.ps1",
    "Uninstall_TLI.bat", "TLI_Uninstall.ps1", "Uninstall_TLI.command", "Uninstall_TLI.sh",
}
BACKEND_DIRS = {"ai", "builder", "cleanup", "drivers", "game_configs", "intelligence", "providers", "routers", "tests"}
BACKEND_FILES = {"requirements.txt", "requirements-test.txt", "pytest.ini", "tli_backend.spec", "run_backend_dev.bat"}
PUBLIC_GUIDES = {"HOST_START.md", "TLI_HOST_START.md", "TLI_SMART_HUB_REFINEMENT.md",
                "TLI_CONNECTED_WORKFLOWS.md", "TLI_SIMPLIFICATION_RELEASE.md",
                "TLI_SIMPLIFICATION_ACCEPTANCE.md", "TLI_SIDEBAR_DIRECT_ACCESS.md",
                "TLI_CAPABILITIES.md", "TLI_ANNIVERSARY_COMPLETION_PROGRAM.md",
                "RELEASE_1.4.0_BETA.md", "RELEASE_1.4.1_BETA.md", "TLI_UPDATES.md", "TLI_UNINSTALL.md"}
MOBILE_FILES = {"package.json", "package-lock.json", "app.config.ts", "tsconfig.json", "expo-env.d.ts", "eas.json", ".easignore", ".gitignore", "README.md"}
MOBILE_DIRS = {"app", "src", "modules", "assets", "tests", "scripts"}
SOURCE_EXTENSIONS = {".py", ".js", ".cjs", ".mjs", ".ts", ".tsx", ".html", ".css", ".svg", ".png", ".ico", ".jpg", ".jpeg", ".webp", ".woff", ".woff2", ".ttf", ".mp3", ".swift", ".kt", ".java", ".gradle", ".podspec", ".xml", ".md", ".yml", ".yaml"}
GENERATED_DIRS = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache", ".venv", "venv", "node_modules", ".expo", ".gradle", "build", "build_work", "build-inspect", "dist", "dist_build", "coverage", ".git", ".codex", ".claude", ".idea", ".vscode"}
PRIVATE_DIRS = {"data", "tli_data", "vault_data", "vault", "memory", "models", "session", "sessions", "keys", "tls", "secrets", ".ssh", ".aws", ".azure", ".gnupg"}
PRIVATE_FILES = {"active_model.json", "devices.json", "tli_model_config.json", "vault_meta.json", "credentials.json", "node_identity.json", "tli_pin.json", "tli_system_profile.json", "conversations.json", "vault_sessions.json", "startup.json", "printers_snmp.json", "secrets.json", "secrets.yaml", "secrets.yml", "credentials.yaml", "credentials.yml", "id_rsa", "id_ed25519"}
PRIVATE_EXTENSIONS = {".pem", ".key", ".crt", ".pfx", ".p12", ".jks", ".keystore", ".mobileprovision", ".gguf", ".ggml", ".bin", ".safetensors", ".onnx", ".pt", ".pth", ".db", ".sqlite", ".sqlite3", ".enc", ".jsonl", ".log", ".bak", ".tmp", ".zip", ".rar", ".7z", ".gz", ".pyc"}
RUNTIME_DEV_PREFIXES = ("llama-bench", "llama-batched", "llama-cli", "llama-completion", "llama-fit-params", "llama-gemma", "llama-gguf", "llama-imatrix", "llama-llava", "llama-minicpmv", "llama-mtmd-cli", "llama-perplexity", "llama-quantize", "llama-qwen", "llama-tokenize", "llama-tts", "rpc-server")
RUNTIME_LICENSE_NAMES = {"LICENSE", "LICENSE-llama.cpp.txt", "LICENSE-jsonhpp.txt",
                         "LICENSE-cpp-httplib.txt", "LICENSE-LLVM-OpenMP.txt", "RUNTIME-NOTICES.txt"}


class SnapshotError(RuntimeError):
    pass


def _linked(path: Path) -> bool:
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def _directory_allowed(rel: Path) -> bool:
    parts = rel.parts
    if any(part.casefold() in GENERATED_DIRS | PRIVATE_DIRS or part.casefold().startswith(".env") for part in parts):
        return False
    if parts[0] == "backend":
        return len(parts) == 1 or parts[1] in BACKEND_DIRS
    if parts[0] == "frontend":
        return len(parts) == 1 or parts[1] in {"js", "css", "assets", "tests", "history"}
    if parts[0] == "mobile":
        return len(parts) == 1 or parts[1] in MOBILE_DIRS
    if parts[0] == "scripts":
        return len(parts) == 1 or parts[1] == "tests" or parts == ("scripts", "fixtures")
    if parts[0] == "docs":
        return len(parts) == 1
    if parts[0] == "desktop":
        return len(parts) == 1
    return False


def _file_allowed(rel: Path) -> bool:
    if len(rel.parts) == 1:
        return rel.name in ROOT_FILES
    if not _directory_allowed(rel.parent):
        return False
    name, suffix = rel.name.casefold(), rel.suffix.casefold()
    if name.startswith(".env") or name in PRIVATE_FILES or suffix in PRIVATE_EXTENSIONS:
        return False
    parts = rel.parts
    if parts[0] == "desktop":
        return rel.as_posix() in {"desktop/TliLauncher.cs", "desktop/tli.ico"}
    if parts[0] == "docs":
        return len(parts) == 2 and rel.name in PUBLIC_GUIDES
    if parts[0] == "backend":
        if parts[1:3] == ("ai", "runtime"):
            return not name.startswith(RUNTIME_DEV_PREFIXES) and (
                name in {"llama-server", "llama_server"} or rel.name in RUNTIME_LICENSE_NAMES
                or suffix in {".exe", ".dll", ".so", ".dylib", ".metal", ".metallib"}
                or re.fullmatch(r"lib[\w.-]+\.so(?:\.\d+)+", name) is not None)
        return suffix == ".py" or (len(parts) == 2 and rel.name in BACKEND_FILES) or (
            parts[1:3] in {("ai", "prompts"), ("builder", "prompts")} and suffix == ".txt") or (
            parts[1] == "tests" and suffix in {".json", ".txt", ".html"})
    if parts[0] == "frontend":
        return suffix in SOURCE_EXTENSIONS or rel.as_posix() in {"frontend/manifest.json", "frontend/history/provenance.json", "frontend/assets/answer-validation.json", "frontend/assets/model-comparison.json", "frontend/assets/model-comparison-anniversary.json", "frontend/assets/fonts/Inter-LICENSE.txt", "frontend/tests/fixtures/free-space-api.json", "frontend/tests/fixtures/next-check.json"}
    if parts[0] == "mobile":
        if rel.as_posix() in {"mobile/tests/fixtures/case-report-preview.json", "mobile/tests/fixtures/peer-guided-report.json", "mobile/tests/fixtures/next-check.json"}:
            return True
        return (len(parts) == 2 and rel.name in MOBILE_FILES) or (len(parts) > 2 and (
            suffix in SOURCE_EXTENSIONS or name in {"package.json", "expo-module.config.json"}))
    if parts[0] == "scripts":
        if parts[1:2] == ("fixtures",):
            return rel.as_posix() in {"scripts/fixtures/tli_answer_quality.json", "scripts/fixtures/tli_answer_extensions.json", "scripts/fixtures/tli_answer_development.json", "scripts/fixtures/tli_dependable_computers_quality.json"}
        return suffix in {".py", ".cjs", ".js", ".json", ".html", ".css", ".ts"} or rel.as_posix() in {
            "scripts/verify_windows_launcher.ps1", "scripts/tests/TliLauncherTests.cs"}
    return False


def _source_files(root: Path) -> list[Path]:
    """Prune private/unlisted directories before os.walk can enumerate them."""
    result = []
    def inaccessible(_error):
        raise SnapshotError("An allowlisted source directory could not be read.")
    for directory, dirs, files in os.walk(root, topdown=True, followlinks=False, onerror=inaccessible):
        base = Path(directory)
        dirs[:] = sorted(name for name in dirs if _directory_allowed((base / name).relative_to(root)) and not _linked(base / name))
        for name in sorted(files):
            path = base / name
            rel = path.relative_to(root)
            if _file_allowed(rel) and not _linked(path):
                if not stat.S_ISREG(path.lstat().st_mode):
                    raise SnapshotError("An allowlisted source input is not a regular file.")
                result.append(rel)
    return sorted(result, key=lambda path: path.as_posix())


def _record(root: Path, rel: Path, destination: Path | None = None) -> dict:
    path = root / rel
    if _linked(path):
        raise SnapshotError("An allowlisted source input became a linked path.")
    before = path.stat()
    digest, size = hashlib.sha256(), 0
    output = None
    try:
        if destination is not None:
            destination.parent.mkdir(parents=True, exist_ok=True)
            output = destination.open("xb")
        with path.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
                if output is not None:
                    output.write(chunk)
    finally:
        if output is not None:
            output.close()
    after = path.stat()
    if _linked(path) or (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise SnapshotError("Source changed while the snapshot was being read; create a new snapshot.")
    if destination is not None:
        shutil.copystat(path, destination, follow_symlinks=False)
    return {"path": rel.as_posix(), "size": size, "sha256": digest.hexdigest()}


def _fingerprint(records: list[dict]) -> str:
    canonical = json.dumps({"policy_version": POLICY_VERSION, "files": records}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _read_manifest(path: Path) -> dict:
    if _linked(path) or path.stat().st_size > 16 * 1024 * 1024:
        raise SnapshotError("Invalid snapshot manifest.")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        def require(condition):
            if not condition:
                raise SnapshotError("Invalid snapshot manifest.")
        require(type(value["schema_version"]) is int and value["schema_version"] == 1)
        require(type(value["policy_version"]) is int and value["policy_version"] == POLICY_VERSION)
        records = value["files"]
        require(isinstance(records, list) and records)
        paths = []
        for record in records:
            name = record["path"]
            rel = PurePosixPath(name)
            require(isinstance(name, str) and rel.as_posix() == name and not rel.is_absolute())
            require(".." not in rel.parts and "\\" not in name and ":" not in name)
            require(_file_allowed(Path(name)))
            require(type(record["size"]) is int and record["size"] >= 0)
            require(re.fullmatch(r"[a-f0-9]{64}", record["sha256"]))
            require(set(record) == {"path", "size", "sha256"})
            paths.append(name)
        require(paths == sorted(set(paths)))
        require(_fingerprint(records) == value["source_fingerprint"])
    except (KeyError, TypeError, ValueError):
        raise SnapshotError("Invalid snapshot manifest.") from None
    return value


def verify_snapshot(snapshot_root: Path, manifest_path: Path, source_root: Path | None = None) -> dict:
    """Verify frozen source, and optionally the still-uncommitted original source."""
    snapshot_root, manifest_path = Path(snapshot_root), Path(manifest_path)
    if _linked(snapshot_root) or not snapshot_root.is_dir():
        raise SnapshotError("Snapshot source is not a regular directory.")
    manifest = _read_manifest(manifest_path)
    expected = manifest["files"]
    actual = [_record(snapshot_root, rel) for rel in _source_files(snapshot_root)]
    if actual != expected:
        raise SnapshotError("Frozen source does not match its manifest; do not publish this snapshot.")
    if source_root is not None:
        source_root = Path(source_root).resolve()
        current = [_record(source_root, rel) for rel in _source_files(source_root)]
        if current != expected:
            raise SnapshotError("Working-tree source drifted after the snapshot; create and verify a new snapshot.")
    return {"ok": True, "fingerprint": manifest["source_fingerprint"], "file_count": len(expected), "source_matches": True if source_root is not None else None}


def create_snapshot(repo: Path, output_dir: Path | None = None) -> dict:
    """Return portable snapshot locations; never overwrite an earlier attempt."""
    repo = Path(repo).resolve()
    allowed = repo / "build_work"
    output_dir = Path(output_dir).absolute() if output_dir is not None else allowed
    if not output_dir.resolve().is_relative_to(allowed):
        raise SnapshotError("Snapshot output must stay inside this repository's build_work directory.")
    for path in (output_dir, *output_dir.parents):
        if path == repo:
            break
        if path.exists() and _linked(path):
            raise SnapshotError("Snapshot output cannot use linked directories.")
    output_dir.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="release-snapshot-", dir=output_dir))
    snapshot = workspace / "source"
    snapshot.mkdir()
    records = [_record(repo, rel, snapshot / rel) for rel in _source_files(repo)]
    if not records:
        raise SnapshotError("No allowlisted source was found.")
    manifest_path = workspace / "manifest.json"
    manifest_path.write_text(json.dumps({"schema_version": 1, "policy_version": POLICY_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(), "source_fingerprint": _fingerprint(records), "files": records}, indent=2) + "\n", encoding="utf-8")
    result = verify_snapshot(snapshot, manifest_path, source_root=repo)
    return {"workspace": str(workspace), "snapshot_root": str(snapshot), "manifest_path": str(manifest_path), "fingerprint": result["fingerprint"], "file_count": result["file_count"]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    create = commands.add_parser("create")
    create.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    create.add_argument("--output-dir", type=Path)
    verify = commands.add_parser("verify")
    verify.add_argument("--snapshot", type=Path, required=True)
    verify.add_argument("--manifest", type=Path, required=True)
    verify.add_argument("--source", type=Path)
    args = parser.parse_args()
    try:
        result = create_snapshot(args.repo, args.output_dir) if args.operation == "create" else verify_snapshot(args.snapshot, args.manifest, args.source)
    except (SnapshotError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error) if isinstance(error, SnapshotError) else "Snapshot source or output could not be accessed."}))
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
