from __future__ import annotations

from pathlib import Path
from typing import Any

from .attachment_context import format_attachments_for_prompt
from .retrieval import retrieve_relevant_files
from .safety import is_protected_path, is_within_root


def create_plan(
    root: Path,
    project_map: dict[str, Any],
    task: str,
    limit: int = 8,
    attachments: list[dict[str, Any]] | None = None,
    thread_context: str = "",
) -> dict[str, Any]:
    relevant = retrieve_relevant_files(root, project_map, task, limit=limit)
    files = [item["path"] for item in relevant]
    risk = classify_plan_risk(files, task)
    summary = summarize_strategy(task, files)
    # Attachments are part of the planner's awareness — let it pull file hints
    # from what the user dropped, but keep the planner deterministic.
    if attachments:
        block, _ = format_attachments_for_prompt(attachments, max_bytes=2048, max_files=4)
        if block:
            summary = summary + "\nUser also attached: " + ", ".join(
                str(a.get("name") or "attachment") for a in attachments[:4]
            )
    # When this is a follow-up task, surface the prior thread in the planner
    # output. The planner today is deterministic (no model call) so we just
    # echo a short note — the real injection happens in the patch prompt.
    if thread_context:
        summary = summary + "\n(Follow-up: prior turns in this thread are passed to the patch agent.)"
    return {
        "task": task,
        "summary": summary,
        "files_involved": files,
        "relevant_files": relevant,
        "change_strategy": build_change_strategy(task, files),
        "risk": risk,
        "test_plan": build_test_plan(files),
        "rollback_impact": "No rollback needed in Phase 2 because Builder only creates a copyable diff preview.",
        "permission_note": "Phase 2 does not write to disk. Use Apply + Rollback in Phase 3 for approved patch application.",
        "phase": "phase_2",
    }


def classify_plan_risk(files: list[str], task: str) -> str:
    text = " ".join([task.lower()] + [f.lower() for f in files])
    if any(token in text for token in [".env", "secret", "credential", "auth", "stripe", "migration"]):
        return "high"
    if any(path in text for path in ["backend/main.py", "frontend/app.js", "frontend/index.html", "tli_state.py"]):
        return "medium"
    if any(token in text for token in ["router", "route", "driver", "vault", "mesh", "ai_routes"]):
        return "medium"
    return "low"


def summarize_strategy(task: str, files: list[str]) -> str:
    if files:
        return f"Plan a targeted change for: {task}. Start with `{files[0]}` and keep edits limited to the ranked files."
    return f"Plan a targeted change for: {task}. No strong file match was found, so inspect the project map before drafting a diff."


def build_change_strategy(task: str, files: list[str]) -> list[str]:
    steps = [
        "Confirm the current behavior in the relevant source file.",
        "Make the smallest text-level change that satisfies the task.",
        "Generate a unified diff preview for review.",
        "Do not apply the diff in Phase 2.",
    ]
    lower = task.lower()
    if "status" in lower or "checking" in lower:
        steps.insert(1, "Check that frontend fetch paths match backend route declarations.")
    if "visualizer" in lower:
        steps.insert(1, "Check the Visualizer frontend module and backend route before touching shared app shell code.")
    if files:
        steps.append("Suggested first file: " + files[0])
    return steps


def gather_file_excerpts(
    project_root: Path,
    file_paths: list[str],
    max_files: int = 2,
    max_chars_per_file: int = 2400,
    total_char_budget: int = 3600,
) -> list[dict[str, Any]]:
    """
    Read bounded excerpts of the most relevant files for the patch agent's prompt.

    Returns a list of {"path", "content", "truncated", "size"} entries. Protected
    files and files outside the project root are skipped silently.
    """
    excerpts: list[dict[str, Any]] = []
    remaining = max(800, total_char_budget)
    for rel in file_paths[:max_files]:
        if remaining <= 0:
            break
        if not isinstance(rel, str) or not rel.strip():
            continue
        candidate = (project_root / rel).resolve()
        if not is_within_root(project_root, candidate):
            continue
        if not candidate.exists() or not candidate.is_file():
            continue
        if is_protected_path(candidate):
            continue
        try:
            text = candidate.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        char_budget = min(max_chars_per_file, remaining)
        excerpt = select_relevant_excerpt(text, char_budget)
        truncated = len(text) > len(excerpt)
        excerpts.append({
            "path": rel.replace("\\", "/"),
            "content": excerpt,
            "truncated": truncated,
            "size": len(text),
        })
        remaining -= len(excerpt)
    return excerpts


def select_relevant_excerpt(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    head_budget = min(700, max_chars // 3)
    tail_budget = max_chars - head_budget
    head = text[:head_budget].rstrip()
    tail = text[-tail_budget:].lstrip()
    return head + "\n\n...[middle omitted for local context budget]...\n\n" + tail


def build_test_plan(files: list[str]) -> list[str]:
    tests = ["Review the generated diff before copying it into any patch tool."]
    if any(path.endswith(".py") or path.startswith("backend/") for path in files):
        tests.append("After a future approved apply step, run the relevant backend pytest target.")
    if any(path.startswith("frontend/") for path in files):
        tests.append("After a future approved apply step, reload TLI and verify the affected panel manually.")
    tests.append("Confirm no protected files appear in the diff.")
    return tests
