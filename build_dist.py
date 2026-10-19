#!/usr/bin/env python3
"""
build_dist.py — TLI distribution packager
==========================================
Run from the TLI root directory:

    python build_dist.py                   # produces TLI_dist_<version>.zip
    python build_dist.py --out my_name.zip # custom output name
    python build_dist.py --dry-run         # print file list without writing
    python build_dist.py --platform windows # prepared Windows launcher/runtime
    python build_dist.py --platform macos   # Apple Silicon + Intel runtimes

Reads TLI_VERSION from backend/tli_state.py automatically.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import sys
import zipfile

ROOT = pathlib.Path(__file__).parent.resolve()

# Load the standalone updater policy without importing application state or
# depending on the caller's working directory / Python import path.
_policy_spec = importlib.util.spec_from_file_location("tli_package_update_policy", ROOT / "backend/update_install.py")
_policy = importlib.util.module_from_spec(_policy_spec)
_policy_spec.loader.exec_module(_policy)


# ── Version detection ────────────────────────────────────────────────
def _read_version() -> str:
    state_file = ROOT / "backend" / "tli_state.py"
    try:
        text = state_file.read_text(encoding="utf-8")
        m = re.search(r'TLI_VERSION\s*=\s*["\']([^"\']+)["\']', text)
        if m:
            return m.group(1)
    except Exception:
        pass
    return "unknown"


# ── Exclusion rules ──────────────────────────────────────────────────
#
# Rule priority (checked in order):
#   1. Whole-directory skips  — any path component matches the set
#   2. File extension skips   — suffix matches the set
#   3. Exact filename skips   — filename matches the set
#   4. Glob-pattern skips     — matched against the full relative path string
#
# Design goal: ship ONLY what a new user needs to run TLI.
# Never ship: your data, your sessions, your device lists, your keys,
#             build artefacts, test suites, or dev-only launchers.

# Any directory (anywhere in the tree) whose NAME is in this set is
# excluded entirely — including all its contents.
SKIP_DIR_NAMES: set[str] = {
    # Python / virtualenv
    ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".cache",
    # Version control / IDE
    ".git", ".claude", ".vscode",
    ".codex", ".idea",
    # User runtime data (never distribute)
    "data", "tli_data", "vault_data", "vault", "keys", "tls", "secrets", ".ssh", ".aws", ".azure", ".gnupg",
    # AI session memory (your sessions, not defaults)
    "session", "sessions", "models",
    # AI session memory (your sessions, not defaults) — runtime is now included
    # Build artefacts (PyInstaller)
    "build", "build_work", "dist", "dist_build", "build-inspect", "coverage",
    # TLI-specific content not for end users
    "TLI_Beta", "TLI_Confidential", "TLI_Installer",
    "tli-vault-extension", "tools", "docs", "landing", "modules",
    # Node / misc
    "node_modules", "mobile", ".expo", ".gradle", ".wrangler",  # native apps have their own EAS distribution
}

# File extensions that are never useful to a user running from source
SKIP_EXTENSIONS: set[str] = {
    # Compiled / binary
    ".pyc", ".pyd", ".pyo", ".so", ".dll", ".exe", ".lnk",
    # Model weights
    ".gguf", ".ggml", ".bin", ".safetensors", ".onnx", ".pt", ".pth",
    # Archives (don't bundle zips inside the zip)
    ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2",
    # Media (large, not needed)
    ".mp4", ".avi", ".mkv", ".mov",
    # Runtime databases / logs
    ".db", ".sqlite", ".sqlite3", ".bak", ".log", ".jsonl", ".enc", ".tmp",
    ".pem", ".key", ".crt", ".pfx", ".p12", ".jks", ".keystore", ".mobileprovision", ".env",
    # IDE workspace files
    ".code-workspace",
}

# Exact filenames (anywhere in the tree) that must be excluded
SKIP_FILENAMES: set[str] = {
    # Generated per-package inventory and local staged-update destination.
    "TLI_RELEASE.json", "update-target.json",
    # OS junk
    "desktop.ini", "Thumbs.db", ".DS_Store",
    # AI runtime: dev/bench tools not needed by end users
    "llama_log.txt",
    "llama-batched-bench.exe", "llama-bench.exe", "llama-cli.exe",
    "llama-completion.exe", "llama-fit-params.exe", "llama-gemma3-cli.exe",
    "llama-gguf-split.exe", "llama-imatrix.exe", "llama-llava-cli.exe",
    "llama-minicpmv-cli.exe", "llama-mtmd-cli.exe", "llama-perplexity.exe",
    "llama-quantize.exe", "llama-qwen2vl-cli.exe", "llama-tokenize.exe",
    "llama-tts.exe", "llama-batched-bench", "llama-bench", "llama-cli",
    "rpc-server.exe", "rpc-server",
    # Stale root-level duplicate — real one lives at backend/relay_server.py
    # Excluded via path rule below, not by filename, so backend/ copy is kept

    # Windows dev shortcuts
    "Legato Backend CMD.lnk",
    # Dev-only launchers (users run via start_tli.sh or the packaged EXE)
    "run_backend_dev.bat", "run_backend_dev.py",
    "kill_port_8000.bat",
    # PyInstaller spec (only needed when building the EXE)
    "tli_backend.spec",
    # Test infrastructure (not needed at runtime)
    "pytest.ini", "requirements-test.txt",
    # Your machine's runtime state files — never ship these
    "active_model.json",       # backend/ai/active_model.json
    "devices.json",            # backend/devices.json
    "tli_model_config.json",   # backend/tli_model_config.json
    "vault_meta.json",         # backend/vault_meta.json
    "credentials.json", "node_identity.json", "tli_pin.json", "tli_system_profile.json",
    "conversations.json", "vault_sessions.json", "startup.json",
    "printers_snmp.json", "secrets.json", "secrets.yaml", "secrets.yml",
    "credentials.yaml", "credentials.yml", "id_rsa", "id_ed25519",
    # Your personal AI memory
    "Ryzen-main.json",
    # The packager itself — not useful inside the dist
    "build_dist.py",
}

# Relative-path substrings — any path containing one of these is excluded.
# Use forward slashes; comparison is done on the posix path string.
SKIP_PATH_CONTAINS: list[str] = [
    "backend/ai/memory/",       # entire private legacy AI memory tree; never traverse
    "backend/memory/",          # all machine-specific AI memory files
    "backend/tests/",           # test suite
    "frontend/tests/",          # browser/component tests
    "scripts/verify_release.py", # isolated developer release check
    "scripts/release_rehearsal.py",
    "scripts/",                # developer harnesses never ship to end users
    "backend/build_work/",      # PyInstaller intermediates (belt + suspenders)
]

# Root-level files to skip (exact filename match only at depth 1)
SKIP_ROOT_FILES: set[str] = {
    "relay_server.py",          # stale duplicate — real one is backend/relay_server.py
    "wrangler.toml",           # website hosting only
}

# Only reviewed, public guides ship. Other documentation stays developer-only.
PUBLIC_GUIDES = {"TLI_SHARED_WORKSPACE.md", "TLI_COMPUTER_CONNECTION_REQUESTS.md", "TLI_SEAMLESS_CONNECTIONS.md", "SSE_SCHEMA.md",
                "TLI_TASK_AGENT.md", "TLI_SONOS.md", "TLI_HOST_VOICE.md", "TLI_BLUETOOTH.md",
                "HOST_START.md", "TLI_HOST_START.md", "TLI_SMART_HUB_REFINEMENT.md",
                "TLI_CONNECTED_WORKFLOWS.md", "TLI_SIMPLIFICATION_RELEASE.md",
                "TLI_SIMPLIFICATION_ACCEPTANCE.md", "TLI_SIDEBAR_DIRECT_ACCESS.md",
                "TLI_CAPABILITIES.md", "TLI_ANNIVERSARY_COMPLETION_PROGRAM.md",
                "RELEASE_1.4.0_BETA.md", "RELEASE_1.4.1_BETA.md", "TLI_UPDATES.md", "TLI_UNINSTALL.md"}

PLATFORM_ROOT_FILES = {
    "windows": {"TLI.exe", "TLI_Start.bat", "TLI_Diagnostics.bat", "TLI_Bootstrap.ps1",
                "TLI_Setup.bat", "TLI_Setup.ps1", "TLI_Network_Setup.ps1", "tli_sentinel.ps1",
                "TLI_Update.bat", "TLI_Update.ps1", "Uninstall_TLI.bat", "TLI_Uninstall.ps1"},
    "macos": {"TLI_Start.command", "TLI_Start.sh", "TLI_Update.command", "TLI_Update.sh",
              "Uninstall_TLI.command", "Uninstall_TLI.sh"},
}
COMMON_ROOT_FILES = {"README.md", "START_HERE.md", "LICENSE", "SECURITY.md", "TLI_MANUAL.md"}


def _platform_includes(rel: pathlib.Path, platform: str) -> bool:
    if platform == "all":
        return True
    if len(rel.parts) == 1:
        return rel.name in COMMON_ROOT_FILES | PLATFORM_ROOT_FILES[platform]
    if rel.parts[0] not in {"backend", "frontend", "docs"}:
        return False
    if rel.parts[:3] == ("backend", "ai", "runtime"):
        if platform == "macos":
            return len(rel.parts) > 4 and rel.parts[3] in {"macos-arm64", "macos-x64"}
        return len(rel.parts) == 4 and rel.suffix.lower() != ".dylib"
    return True


def _should_skip(rel: pathlib.Path) -> tuple[bool, str]:
    """Return (True, reason) if this path should be excluded from the dist."""
    parts = rel.parts
    posix = rel.as_posix().casefold()
    name = rel.name.casefold()

    if name == ".env" or name.startswith(".env.") or name == ".dev.vars" or name.startswith(".dev.vars."):
        return True, "skip-environment"
    if len(parts) > 1 and parts[0].casefold() in {"website", "functions"}:
        return True, "website-service"
    if len(parts) == 2 and parts[0] == "docs" and parts[1] in PUBLIC_GUIDES:
        return False, ""

    # 0a. Root-level specific file exclusions
    if len(parts) == 1 and name in {value.casefold() for value in SKIP_ROOT_FILES}:
        return True, f"skip-root-file:{rel.name}"

    # 0b. Skip previously-extracted dist folders at the root level
    #    e.g. TLI_v1.0.2/ or TLI_dist_1.0.1/ sitting next to this script
    if len(parts) > 1:
        top = parts[0]
        if re.match(r"^TLI[_\s](v|dist[_\s])[\d]", top, re.IGNORECASE):
            return True, f"skip-dist-extract:{top}"

    # 1. Directory component check
    for part in parts[:-1]:   # exclude the filename itself
        if part.casefold() in {value.casefold() for value in SKIP_DIR_NAMES}:
            return True, f"skip-dir:{part}"

    # Exact paths apply before any runtime extension override.
    for substr in SKIP_PATH_CONTAINS:
        if substr in posix:
            return True, f"skip-path:{substr}"

    # The reviewed desktop launcher is the only non-runtime executable shipped.
    if rel.as_posix() == "TLI.exe":
        return False, ""

    # 1b. AI runtime override — include runtime binaries despite .exe/.dll extension rule.
    #     SKIP_FILENAMES still applies (dev-only bench tools are excluded there).
    if posix.startswith("backend/ai/runtime/"):
        if name in {value.casefold() for value in SKIP_FILENAMES}:
            return True, f"skip-file:{rel.name}"
        if rel.suffix.lower() in {".exe", ".dll", ".so"}:
            return False, ""

    # 2. Extension check
    if rel.suffix.lower() in SKIP_EXTENSIONS:
        return True, f"skip-ext:{rel.suffix}"

    # 3. Filename check
    if name in {value.casefold() for value in SKIP_FILENAMES}:
        return True, f"skip-file:{rel.name}"

    return False, ""


def _is_linked_path(path: pathlib.Path) -> bool:
    """Reject symlinks and Windows junction/reparse points on Python 3.10+."""
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    ) or path.is_symlink()


# ── Main ─────────────────────────────────────────────────────────────
def build(out_path: pathlib.Path, dry_run: bool = False, frontend_only: bool = False, platform: str = "all") -> None:
    if platform not in {"all", "windows", "macos"}:
        raise ValueError("Unknown distribution platform")
    if frontend_only and platform != "all":
        raise ValueError("A platform installation cannot be a frontend-only update")
    version = _read_version()
    print(f"TLI version : {version}")
    print(f"Output      : {out_path}")
    print(f"Root        : {ROOT}")
    if dry_run:
        print("(DRY RUN — no file will be written)\n")

    included: list[pathlib.Path] = []
    skipped:  list[tuple[pathlib.Path, str]] = []

    for directory, dirs, files in os.walk(ROOT, followlinks=False):
        base = pathlib.Path(directory)
        kept_dirs = []
        for name in sorted(dirs):
            path = base / name
            rel = path.relative_to(ROOT)
            # Traverse the public guide directory, but admit only named files.
            skip, reason = (False, "") if rel.as_posix() == "docs" else _should_skip(rel / "__directory__")
            if _is_linked_path(path):
                skipped.append((rel, "skip-linked-directory"))
            elif skip:
                skipped.append((rel, reason))
            else:
                kept_dirs.append(name)
        dirs[:] = kept_dirs
        for name in sorted(files):
            abs_path = base / name
            rel = abs_path.relative_to(ROOT)
            if abs_path.resolve() == out_path.resolve():
                continue
            skip, reason = _should_skip(rel)
            if not _policy.is_application_path(rel.as_posix()):
                skip, reason = True, "not-reviewed-application-file"
            if _is_linked_path(abs_path):
                skip, reason = True, "skip-linked-file"
            if frontend_only and rel.parts[0] != "frontend":
                skip, reason = True, "frontend-only"
            if not _platform_includes(rel, platform):
                skip, reason = True, "other-platform-or-developer-file"
            if skip:
                skipped.append((rel, reason))
            else:
                included.append(rel)
    included.sort()

    if platform != "all":
        required = {"backend/main.py", "backend/requirements.txt", "backend/update_install.py", "frontend/index.html",
                    "START_HERE.md", "LICENSE", "docs/TLI_UNINSTALL.md"} | PLATFORM_ROOT_FILES[platform]
        required |= ({"backend/ai/runtime/llama_server.exe"} if platform == "windows" else {
            "backend/ai/runtime/macos-arm64/llama-server", "backend/ai/runtime/macos-x64/llama-server"})
        missing = required - {rel.as_posix() for rel in included}
        if missing:
            raise RuntimeError("Prepare the platform package first; missing: " + ", ".join(sorted(missing)))

    print(f"Included    : {len(included)} files")
    print(f"Excluded    : {len(skipped)} files")
    print()

    if dry_run:
        print("=== INCLUDED ===")
        for p in included:
            print(f"  + {p.as_posix()}")
        print("  + TLI_RELEASE.json (generated verified-file inventory)")
        print()
        print("=== EXCLUDED ===")
        for p, r in skipped:
            print(f"  - {p.as_posix()}  ({r})")
        return

    # Unix execute permission bits — applied to shell scripts so they are
    # immediately runnable on macOS/Linux after unzip without chmod.
    _EXEC_EXTS  = {".sh", ".command"}

    def _needs_exec(rel: pathlib.Path) -> bool:
        if rel.suffix.lower() in _EXEC_EXTS:
            return True
        # Executables inside .app bundles have no extension
        if "/Contents/MacOS/" in rel.as_posix():
            return True
        # Mac/Linux AI runtime binary (no extension, sits in backend/ai/runtime/)
        if rel.name == "llama-server" and "backend/ai/runtime" in rel.as_posix():
            return True
        return False

    # Write zip
    out_path.parent.mkdir(parents=True, exist_ok=True)
    inventory = []
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for rel in included:
            abs_path = ROOT / rel
            data = abs_path.read_bytes()
            # A Windows checkout may contain CRLF. Finder/bash need portable
            # Unix line endings even when the Mac ZIP is built on Windows.
            if rel.suffix.lower() in {".sh", ".command"}:
                data = data.replace(b"\r\n", b"\n")
            info = zipfile.ZipInfo.from_file(abs_path, rel)
            info.compress_type = zipfile.ZIP_DEFLATED
            mode = 0o755 if _needs_exec(rel) else 0o644
            info.create_system = 3  # Unix permissions must survive a Windows-built zip.
            info.external_attr = (stat.S_IFREG | mode) << 16
            zf.writestr(info, data)
            inventory.append({"path": rel.as_posix(), "size": len(data),
                              "sha256": hashlib.sha256(data).hexdigest(), "mode": mode})
        manifest = {"schema_version": 1, "version": version, "platform": platform, "files": inventory}
        info = zipfile.ZipInfo("TLI_RELEASE.json")
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        zf.writestr(info, json.dumps(manifest, indent=2).encode("utf-8") + b"\n")

    # The published archive must satisfy the same path, size and hash contract
    # that an existing installation will enforce before preparing its update.
    _policy.validate_archive(out_path, expected_version=version, expected_platform=platform)

    # SHA-256 of the zip file itself — matches what auto_update.py verifies
    sha = hashlib.sha256()
    with open(out_path, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            sha.update(chunk)

    size_mb = out_path.stat().st_size / 1024 / 1024
    digest  = sha.hexdigest()

    print(f"Done  {out_path.name}")
    print(f"Size  {size_mb:.1f} MB")
    print(f"SHA256 (zip file hash — matches auto_update.py verification):")
    print(f"  {digest}")
    print()
    if platform != "all":
        print("Publish the verified checksum in landing/downloads.json after release verification.")
        print("Existing users: extract separately, stop TLI, then run the included TLI_Update launcher.")
        print("The legacy application updater must not copy this package over running application files.")
        return
    print("Frontend-only legacy channel metadata:" if frontend_only else "Verified source-package metadata:")
    print(f'  "version":      "{version}",')
    print(f'  "sha256":       "{digest}",')
    print(f'  "frontend_only": {str(frontend_only).lower()}')
    if not frontend_only:
        print("Existing users: extract separately, stop TLI, then run the included TLI_Update launcher.")
        print("Validate matching platform packages and publish their checksums with updater: guided-v1.")
        print("Do not publish a full package to the legacy direct-copy update channel.")


def main():
    parser = argparse.ArgumentParser(description="Build TLI distribution zip")
    parser.add_argument("--out",     metavar="FILE",  help="Output zip path (default: TLI_dist_<version>.zip)")
    parser.add_argument("--dry-run", action="store_true", help="Print file list without writing zip")
    parser.add_argument("--frontend-only", action="store_true", help="Package only frontend files; use only for changes with no backend/dependency requirements")
    parser.add_argument("--platform", choices=("all", "windows", "macos"), default="all",
                        help="Package a prepared platform installation; requires its launcher and runtime")
    args = parser.parse_args()

    version  = _read_version()
    out_name = args.out or f"TLI_dist_{version}.zip"
    out_path = ROOT / out_name

    if out_path.exists() and not args.dry_run:
        print(f"Warning: {out_path.name} already exists and will be overwritten.")

    build(out_path, dry_run=args.dry_run, frontend_only=args.frontend_only, platform=args.platform)


if __name__ == "__main__":
    main()
