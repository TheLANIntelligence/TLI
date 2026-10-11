"""Build a sanitized 'Previous turns' block for follow-up tasks/chats.

Only fires when the caller explicitly threads the request (parent_id set).
Strictly cold otherwise — see TLI_BUILDER_SPEC.md for the rationale.

Sanitization: user prompts go in verbatim, but model output is replaced by
the cleaned `model_summary` for builds and the plain `response` text for
chats. Raw model output, error messages, and stack traces are never
included; they leak across turns and confuse small local models.
"""
from __future__ import annotations

from typing import Any

import tli_state as S

from .chat import find_chat, load_chat_messages
from .receipts import BUILDER_DIR


TASKS_PATH = BUILDER_DIR / "tasks.json"


def build_thread_context(
    parent_id: str,
    *,
    max_entries: int = 4,
    max_chars_per_entry: int = 600,
) -> str:
    """Return a 'Previous turns:' block ready to prepend to a model prompt.

    Empty string when the parent can't be located or the thread has no
    siblings.
    """
    if not parent_id:
        return ""
    from .tasks import find_task

    parent = find_task(parent_id) or find_chat(parent_id)
    if not parent:
        return ""
    thread_id = parent.get("thread_id")
    if not thread_id:
        # Pre-thread record: just use the parent itself as the only context.
        siblings = [parent]
    else:
        siblings = _collect_thread(thread_id)

    if not siblings:
        return ""

    siblings.sort(key=lambda r: r.get("updated_at") or r.get("created_at") or "")
    tail = siblings[-max_entries:]

    lines: list[str] = ["Previous turns in this thread:"]
    for record in tail:
        prompt, reply = _summarize_record(record, max_chars_per_entry)
        if not prompt and not reply:
            continue
        lines.append("")
        lines.append("User: " + prompt)
        if reply:
            lines.append("Builder: " + reply)
    if len(lines) == 1:
        return ""
    return "\n".join(lines)


def _collect_thread(thread_id: str) -> list[dict[str, Any]]:
    """Pull all tasks + chat messages sharing the same thread_id."""
    tasks = S.load_json_file(TASKS_PATH, []) or []
    chats = load_chat_messages(limit=200)
    siblings: list[dict[str, Any]] = []
    for record in tasks:
        if record.get("thread_id") == thread_id:
            siblings.append(record)
    for record in chats:
        if record.get("thread_id") == thread_id:
            siblings.append(record)
    return siblings


def _summarize_record(record: dict[str, Any], max_chars: int) -> tuple[str, str]:
    """Return (user_prompt, builder_reply) for a single thread entry.

    Each side capped to ``max_chars``. Builder reply uses sanitized fields
    only — never `model_raw`, never an exception message.
    """
    prompt = (record.get("task") or "").strip()
    prompt = _clip(prompt, max_chars)
    kind = record.get("kind") or ""
    if kind == "chat":
        reply = (record.get("response") or "").strip()
        return prompt, _clip(reply, max_chars)

    # Build task: prefer the patch agent's clean summary; fall back to the
    # planner summary; never expose raw model output.
    artifacts = record.get("artifacts") or {}
    reply = (artifacts.get("model_summary") or "").strip()
    if not reply:
        plan = artifacts.get("plan") or {}
        reply = (plan.get("summary") or "").strip()
    return prompt, _clip(reply, max_chars)


def _clip(text: str, max_chars: int) -> str:
    if not text:
        return ""
    text = " ".join(text.split())
    return text if len(text) <= max_chars else text[: max_chars - 1] + "…"
