#!/usr/bin/env python3
"""
build_dist.py — TLI distribution packager
==========================================
Run from the TLI root directory:

    python build_dist.py                   # produces TLI_dist_<version>.zip
    python build_dist.py --out my_name.zip # custom output name
    python build_dist.py --dry-run         # print file list without writing

Reads TLI_VERSION from backend/tli_state.py automatically.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import pathlib
import re
import sys
import zipfile

ROOT = pathlib.Path(__file__).parent.resolve()


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
    ".venv", "__pycache__", ".mypy_cache", ".pytest_cache",
    # Version control / IDE
    ".git", ".claude", ".vscode",
    # User runtime data (never distribute)
    "data",
    # AI session memory (your sessions, not defaults)
    "session",
    # AI session memory (your sessions, not defaults) — runtime is now included
    # Build artefacts (PyInstaller)
    "build", "build_work", "dist",
    # TLI-specific content not for end users
    "TLI_Beta", "TLI_Confidential", "TLI_Installer",
    "tli-vault-extension", "tools", "docs", "landing", "modules",
    # Node / misc
    "node_modules",
}

# File extensions that are never useful to a user running from source
SKIP_EXTENSIONS: set[str] = {
    # Compiled / binary
    ".pyc", ".pyd", ".pyo", ".so", ".dll", ".exe",
    # Model weights
    ".gguf", ".bin", ".safetensors",
    # Archives (don't bundle zips inside the zip)
    ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2",
    # Media (large, not needed)
    ".mp4", ".avi", ".mkv", ".mov",
    # Runtime databases / logs
    ".db", ".sqlite", ".sqlite3", ".bak", ".log",
    # IDE workspace files
    ".code-workspace",
}

# Exact filenames (anywhere in the tree) that must be excluded
SKIP_FILENAMES: set[str] = {
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
    # Your personal AI memory
    "Ryzen-main.json",
    # The packager itself — not useful inside the dist
    "build_dist.py",
}

# Relative-path substrings — any path containing one of these is excluded.
# Use forward slashes; comparison is done on the posix path string.
SKIP_PATH_CONTAINS: list[str] = [
    "backend/memory/",          # all machine-specific AI memory files
    "backend/tests/",           # test suite
    "backend/build_work/",      # PyInstaller intermediates (belt + suspenders)
]

# Root-level files to skip (exact filename match only at depth 1)
SKIP_ROOT_FILES: set[str] = {
    "relay_server.py",          # stale duplicate — real one is backend/relay_server.py
}


def _should_skip(rel: pathlib.Path) -> tuple[bool, str]:
    """Return (True, reason) if this path should be excluded from the dist."""
    parts = rel.parts
    posix = rel.as_posix()

    # 0a. Root-level specific file exclusions
    if len(parts) == 1 and rel.name in SKIP_ROOT_FILES:
        return True, f"skip-root-file:{rel.name}"

    # 0b. Skip previously-extracted dist folders at the root level
    #    e.g. TLI_v1.0.2/ or TLI_dist_1.0.1/ sitting next to this script
    if len(parts) > 1:
        top = parts[0]
        if re.match(r"^TLI[_\s](v|dist[_\s])[\d]", top, re.IGNORECASE):
            return True, f"skip-dist-extract:{top}"

    # 1. Directory component check
    for part in parts[:-1]:   # exclude the filename itself
        if part in SKIP_DIR_NAMES:
            return True, f"skip-dir:{part}"

    # 1b. AI runtime override — include runtime binaries despite .exe/.dll extension rule.
    #     SKIP_FILENAMES still applies (dev-only bench tools are excluded there).
    if "backend/ai/runtime/" in posix:
        if rel.name in SKIP_FILENAMES:
            return True, f"skip-file:{rel.name}"
        return False, ""

    # 2. Extension check
    if rel.suffix.lower() in SKIP_EXTENSIONS:
        return True, f"skip-ext:{rel.suffix}"

    # 3. Filename check
    if rel.name in SKIP_FILENAMES:
        return True, f"skip-file:{rel.name}"

    # 4. Path-contains check
    for substr in SKIP_PATH_CONTAINS:
        if substr in posix:
            return True, f"skip-path:{substr}"

    return False, ""


# ── Main ─────────────────────────────────────────────────────────────
def build(out_path: pathlib.Path, dry_run: bool = False) -> None:
    version = _read_version()
    print(f"TLI version : {version}")
    print(f"Output      : {out_path}")
    print(f"Root        : {ROOT}")
    if dry_run:
        print("(DRY RUN — no file will be written)\n")

    included: list[pathlib.Path] = []
    skipped:  list[tuple[pathlib.Path, str]] = []

    for abs_path in sorted(ROOT.rglob("*")):
        if abs_path.is_dir():
            continue
        rel = abs_path.relative_to(ROOT)

        # Never include the output zip itself
        if abs_path == out_path:
            continue

        skip, reason = _should_skip(rel)
        if skip:
            skipped.append((rel, reason))
        else:
            included.append(rel)

    print(f"Included    : {len(included)} files")
    print(f"Excluded    : {len(skipped)} files")
    print()

    if dry_run:
        print("=== INCLUDED ===")
        for p in included:
            print(f"  + {p.as_posix()}")
        print()
        print("=== EXCLUDED ===")
        for p, r in skipped:
            print(f"  - {p.as_posix()}  ({r})")
        return

    # Unix execute permission bits — applied to shell scripts so they are
    # immediately runnable on macOS/Linux after unzip without chmod.
    _EXEC_PERMS = 0o755 << 16   # stored in ZipInfo.external_attr upper 16 bits
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
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for rel in included:
            abs_path = ROOT / rel
            data = abs_path.read_bytes()
            info = zipfile.ZipInfo.from_file(abs_path, rel)
            if _needs_exec(rel):
                info.external_attr = _EXEC_PERMS
            zf.writestr(info, data)

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
    print("Paste this into your latest.json when you publish the release:")
    print(f'  "version":      "{version}",')
    print(f'  "sha256":       "{digest}",')
    print(f'  "frontend_only": true')


def main():
    parser = argparse.ArgumentParser(description="Build TLI distribution zip")
    parser.add_argument("--out",     metavar="FILE",  help="Output zip path (default: TLI_dist_<version>.zip)")
    parser.add_argument("--dry-run", action="store_true", help="Print file list without writing zip")
    args = parser.parse_args()

    version  = _read_version()
    out_name = args.out or f"TLI_dist_{version}.zip"
    out_path = ROOT / out_name

    if out_path.exists() and not args.dry_run:
        print(f"Warning: {out_path.name} already exists and will be overwritten.")

    build(out_path, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
