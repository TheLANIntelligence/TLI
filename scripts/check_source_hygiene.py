"""Check Git's tracked source paths without reading file contents or history.

Run from a source checkout with ``python scripts/check_source_hygiene.py``.
This is a path-based publication guard, not a scanner for secrets in source text.
It inspects the current index, so staged additions and removals are included.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


BLOCKED_DIRECTORIES = {
    "node_modules": "vendored dependencies",
    "data": "runtime data",
    "tli_data": "runtime data",
    "vault_data": "runtime data",
    "tli_confidential": "private installation files",
    **dict.fromkeys({".ssh", ".aws", ".azure", ".gnupg"}, "private account configuration"),
    **dict.fromkeys({
        ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
        ".ruff_cache", ".cache", ".wrangler", ".expo", ".gradle",
        ".codex", ".claude", ".idea", ".vscode", "htmlcov", "coverage",
        "build", "build_work", "dist", "dist_build", "build-inspect",
    }, "local tooling or build output"),
}
BLOCKED_PREFIXES = {
    "backend/ai/memory/": "legacy private AI memory",
    "backend/memory/": "legacy private AI memory",
    "tli_installer/bundle/": "generated installer bundle",
    "artifacts/": "generated local artifacts",
}
LEGACY_STATE_PATHS = {
    "backend/ai/active_model.json", "backend/devices.json",
    "backend/routers/printers_snmp.json", "backend/tli_model_config.json",
    "backend/vault_meta.json",
}
STATE_NAMES = {
    "active_model.json", "devices.json", "tli_model_config.json",
    "vault_meta.json", "node_identity.json", "tli_pin.json",
    "tli_system_profile.json", "conversations.json", "vault_sessions.json",
    "startup.json", "printers_snmp.json", "credentials.json",
    "credentials.yaml", "credentials.yml", "secrets.json", "secrets.yaml",
    "secrets.yml",
}
CERTIFICATE_SUFFIXES = {
    ".pem", ".key", ".crt", ".cer", ".der", ".p8", ".p12", ".pfx", ".jks",
    ".keystore", ".mobileprovision",
}
BINARY_SUFFIXES = {
    ".exe", ".dll", ".so", ".dylib", ".pyd", ".pyc", ".pyo",
    ".o", ".obj", ".a", ".lib", ".class", ".jar",
    ".gguf", ".ggml", ".bin", ".safetensors", ".onnx", ".pt", ".pth",
    ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".zst",
    ".tgz", ".tbz2", ".txz", ".apk", ".aab", ".ipa", ".msi",
    ".dmg", ".msix", ".msixbundle", ".appx", ".appxbundle", ".deb", ".rpm",
}
PRIVATE_KEY_NAMES = {"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk"}


def forbidden_reason(path: str) -> str | None:
    """Return the publication boundary violated by a repository-relative path."""
    normalized = path.replace("\\", "/").casefold()
    parts = PurePosixPath(normalized).parts
    if not parts:
        return "invalid tracked path"
    name = parts[-1]
    for directory in parts[:-1]:
        if directory in BLOCKED_DIRECTORIES:
            return BLOCKED_DIRECTORIES[directory]
        if directory.endswith(".egg-info"):
            return "generated Python package metadata"
    for prefix, reason in BLOCKED_PREFIXES.items():
        if normalized.startswith(prefix):
            return reason
    if normalized.startswith("backend/ai/runtime/") and normalized != "backend/ai/runtime/readme.md":
        return "downloaded inference runtime"
    if normalized in LEGACY_STATE_PATHS or (
        name in STATE_NAMES and parts[:-1] in {(), ("backend",), ("mobile",)}
    ):
        return "private configuration or legacy runtime state"
    if name == ".env" or (name.startswith(".env.") and name not in {".env.example", ".env.sample", ".env.template"}):
        return "local environment settings"
    suffix = PurePosixPath(name).suffix
    if name in PRIVATE_KEY_NAMES or suffix in CERTIFICATE_SUFFIXES:
        return "certificate or private signing material"
    if suffix in BINARY_SUFFIXES or re.search(r"\.so(?:\.\d+)+$", name):
        return "built binary, model or archive"
    if suffix in {".log", ".db", ".sqlite", ".sqlite3", ".enc", ".lnk", ".bak"} or name.startswith(".coverage"):
        return "runtime, local shortcut or verification output"
    return None


def tracked_paths(repository: Path) -> list[str]:
    """Read index names using NUL separation; never print Git stderr or file data."""
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--full-name"],
        cwd=repository, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        check=True, **options,
    )
    return sorted({os.fsdecode(path) for path in result.stdout.split(b"\0") if path})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1],
                        help="Repository root to inspect (defaults to this checkout).")
    args = parser.parse_args(argv)
    try:
        paths = tracked_paths(args.repo)
    except (OSError, subprocess.CalledProcessError):
        print("Source hygiene check failed: unable to read Git's tracked paths.", file=sys.stderr)
        return 2
    violations = [(path, reason) for path in paths if (reason := forbidden_reason(path))]
    for path, reason in violations:
        # Escape unusual names so a tracked filename cannot inject terminal lines.
        print(f"{json.dumps(path, ensure_ascii=True)}: {reason}")
    if violations:
        print(f"Source hygiene failed: {len(violations)} forbidden tracked paths.")
        return 1
    print(f"Source hygiene passed: {len(paths)} tracked paths checked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
