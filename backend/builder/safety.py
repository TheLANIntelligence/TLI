from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable


IGNORED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "dist",
    "build",
    "build_work",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".next",
    ".nuxt",
    "coverage",
    "data",
    "TLI_Installer",
    "TLI_Confidential",
}

PROTECTED_NAMES = {
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "secrets.json",
    "secrets.yaml",
    "secrets.yml",
    "credentials.json",
    "credentials.yaml",
    "credentials.yml",
}

PROTECTED_EXTS = {
    ".key",
    ".pem",
    ".p12",
    ".pfx",
    ".crt",
    ".cer",
}

PROTECTED_NAME_PREFIXES = (
    ".env.",
)

PROTECTED_NAME_SUFFIXES = (
    "_secret",
    "_secrets",
    "_credentials",
    "_private_key",
    ".secret",
    ".secrets",
    ".credentials",
)

DANGEROUS_COMMANDS = [
    "rm -rf",
    "del /s",
    "format",
    "diskpart",
    "git reset --hard",
    "git clean -fd",
    "curl | bash",
    "Invoke-WebRequest",
    "iex",
    "powershell -ExecutionPolicy Bypass",
    "npm publish",
    "pip uninstall",
    "docker system prune",
]

NETWORK_COMMANDS = [
    "npm install",
    "pip install",
    "curl",
    "wget",
    "git clone",
    "docker pull",
]


def resolve_project_root(path: str) -> Path:
    root = Path(path).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise ValueError("Project path must be an existing folder.")
    return root


def is_within_root(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def should_ignore_dir(name: str) -> bool:
    return name in IGNORED_DIRS


def is_protected_path(path: Path) -> bool:
    name = path.name.lower()
    if name in PROTECTED_NAMES:
        return True
    if path.suffix.lower() in PROTECTED_EXTS:
        return True
    if name.startswith(PROTECTED_NAME_PREFIXES):
        return True
    if name.endswith(PROTECTED_NAME_SUFFIXES):
        return True
    return False


def relative_path(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def filter_existing_safe_paths(root: Path, paths: Iterable[str]) -> list[Path]:
    safe: list[Path] = []
    for raw in paths:
        candidate = (root / raw).resolve()
        if candidate.exists() and candidate.is_file() and is_within_root(root, candidate):
            safe.append(candidate)
    return safe


def classify_command(command: str) -> dict:
    text = " ".join(command.strip().split())
    lower = text.lower()
    dangerous = [cmd for cmd in DANGEROUS_COMMANDS if cmd.lower() in lower]
    network = [cmd for cmd in NETWORK_COMMANDS if cmd.lower() in lower]
    return {
        "command": text,
        "blocked": bool(dangerous),
        "requires_network_warning": bool(network),
        "dangerous_matches": dangerous,
        "network_matches": network,
    }
