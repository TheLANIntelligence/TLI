"""Format user attachments for embedding in model prompts.

Builder lets the user drop files into the hero composer. The patch and chat
prompts both need to see those file contents (not just metadata) for the
model's answer to be useful. Image/binary attachments emit a one-line
descriptor instead — a hook for a future vision model is left at the seam.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any


# Extensions whose contents are safe to embed verbatim into a prompt.
TEXT_EXTS = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".md", ".rst", ".txt", ".log", ".csv", ".tsv",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".env.sample",
    ".html", ".htm", ".css", ".scss", ".sass",
    ".sh", ".ps1", ".bat", ".cmd",
    ".go", ".rs", ".rb", ".java", ".kt", ".swift",
    ".c", ".h", ".cpp", ".hpp",
    ".sql", ".graphql", ".xml",
}

# Image extensions get a descriptor line; bytes are not embedded today.
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}


def format_attachments_for_prompt(
    attachments: list[dict[str, Any]] | None,
    max_bytes: int = 16384,
    max_files: int = 8,
) -> tuple[str, list[dict[str, Any]]]:
    """Return ``(text_block, image_refs)`` for prompt injection.

    ``text_block`` is ready to drop into a user prompt (empty string when no
    embeddable content). ``image_refs`` is a list of {"path","name","mime"}
    entries the caller can pass to a multimodal pipeline once one exists —
    today it's reserved for the future Qwen 2.5 VL wiring.
    """
    items = list(attachments or [])[:max_files]
    if not items:
        return "", []

    lines: list[str] = ["User attachments (use these as reference; do not edit their paths):"]
    image_refs: list[dict[str, Any]] = []

    for item in items:
        name = str(item.get("name") or item.get("path") or "attachment")
        size = int(item.get("size") or 0)
        content_type = str(item.get("content_type") or "application/octet-stream")
        path_value = item.get("path") or ""
        suffix = Path(name).suffix.lower()

        if suffix in IMAGE_EXTS or content_type.startswith("image/"):
            descriptor = f"[image: {name} · {content_type} · {_human_size(size)}]"
            lines.append(descriptor)
            image_refs.append({"name": name, "path": path_value, "mime": content_type})
            continue

        if suffix in TEXT_EXTS or content_type.startswith("text/"):
            body, truncated = _read_text_file(path_value, max_bytes)
            if body is None:
                lines.append(f"[unreadable file: {name} · {content_type} · {_human_size(size)}]")
                continue
            lines.append("")
            lines.append(f"=== ATTACHMENT: {name} ({content_type}, {_human_size(size)}) ===")
            lines.append(body)
            if truncated:
                lines.append(f"[... {size - len(body)} more bytes truncated]")
            lines.append(f"=== END ATTACHMENT: {name} ===")
            continue

        # Unknown binary — describe only.
        lines.append(f"[binary attachment: {name} · {content_type} · {_human_size(size)}]")

    return "\n".join(lines), image_refs


def _read_text_file(path_value: str, max_bytes: int) -> tuple[str | None, bool]:
    if not path_value:
        return None, False
    p = Path(path_value)
    if not p.exists() or not p.is_file():
        return None, False
    try:
        raw = p.read_bytes()
    except OSError:
        return None, False
    truncated = len(raw) > max_bytes
    body = raw[:max_bytes].decode("utf-8", errors="replace")
    return body, truncated


def _human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"
