from __future__ import annotations

import difflib
import hashlib
import uuid
from pathlib import Path
from typing import Any

from .safety import is_protected_path, is_within_root, relative_path


TEXT_EXTS = {
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".html",
    ".css",
    ".scss",
    ".json",
    ".md",
    ".yml",
    ".yaml",
    ".toml",
    ".ps1",
    ".sh",
    ".bat",
    ".txt",
}


def generate_find_replace_diff(
    root: Path,
    file_path: str,
    find_text: str,
    replace_text: str,
    task: str = "",
    replace_all: bool = False,
) -> dict[str, Any]:
    if not find_text:
        raise ValueError("Find text is required.")

    target = (root / file_path).resolve()
    if not is_within_root(root, target):
        raise ValueError("Diff target must stay inside the selected project root.")
    if not target.exists() or not target.is_file():
        raise ValueError("Diff target file does not exist.")
    if is_protected_path(target):
        raise ValueError("Protected files cannot be used for Phase 2 diff preview.")
    if target.suffix.lower() not in TEXT_EXTS:
        raise ValueError("Phase 2 diff preview only supports text source/config files.")
    if target.stat().st_size > 768_000:
        raise ValueError("File is too large for Phase 2 diff preview.")

    original = target.read_text(encoding="utf-8", errors="replace")
    count = original.count(find_text)
    if count == 0:
        raise ValueError("Find text was not found in the target file.")

    changed = original.replace(find_text, replace_text) if replace_all else original.replace(find_text, replace_text, 1)
    rel = relative_path(root, target)
    diff_lines = list(difflib.unified_diff(
        original.splitlines(),
        changed.splitlines(),
        fromfile=f"a/{rel}",
        tofile=f"b/{rel}",
        lineterm="",
    ))
    diff_text = "\n".join(diff_lines)
    if diff_text:
        diff_text += "\n"

    return {
        "id": "patch_" + uuid.uuid4().hex[:12],
        "task": task,
        "file_path": rel,
        "replace_all": replace_all,
        "find_text": find_text,
        "replace_text": replace_text,
        "original_sha256": sha256_text(original),
        "changed_sha256": sha256_text(changed),
        "matches_found": count,
        "matches_replaced": count if replace_all else 1,
        "diff": diff_text,
        "before_excerpt": excerpt_around(original, find_text),
        "after_excerpt": excerpt_around(changed, replace_text),
        "risk": "medium" if rel in {"backend/main.py", "frontend/app.js", "frontend/index.html"} else "low",
        "applied": False,
        "phase": "phase_2",
    }


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def excerpt_around(text: str, needle: str, radius: int = 420) -> str:
    if not needle:
        return text[:radius]
    idx = text.find(needle)
    if idx < 0:
        return text[:radius]
    start = max(0, idx - radius)
    end = min(len(text), idx + len(needle) + radius)
    prefix = "..." if start else ""
    suffix = "..." if end < len(text) else ""
    return prefix + text[start:end] + suffix
