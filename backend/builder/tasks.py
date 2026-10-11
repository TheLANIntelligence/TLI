from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

import tli_state as S

from .attachment_context import format_attachments_for_prompt
from .command_runner import run_approved_command
from .diff_generator import generate_find_replace_diff
from .llm_client import ModelInvalid, ModelOffline, complete_patch_json
from .planner import create_plan, gather_file_excerpts
from .receipts import BUILDER_DIR, add_patch_proposal
from .retrieval import answer_from_project_map, retrieve_relevant_files
from .safety import classify_command, is_protected_path, is_within_root


TASKS_PATH = BUILDER_DIR / "tasks.json"
AGENT_ORDER = ["explorer", "planner", "patch", "test", "reviewer", "receipt"]
INTENT_TARGET_INDEX = {"inspect": 1, "plan": 2, "build": 3}


def load_tasks(limit: int = 100) -> list[dict[str, Any]]:
    BUILDER_DIR.mkdir(parents=True, exist_ok=True)
    tasks = S.load_json_file(TASKS_PATH, []) or []
    return list(reversed(tasks[-limit:]))


def find_task(task_id: str) -> dict[str, Any] | None:
    tasks = _load_all()
    for task in tasks:
        if task.get("id") == task_id:
            return task
    return None


def create_task(
    task_text: str,
    project_root: Path,
    permission_level: str,
    golden_build_guard: bool,
    intent: str = "build",
    file_path: str = "",
    find_text: str = "",
    replace_text: str = "",
    replace_all: bool = False,
    test_command: str = "",
    attachments: list[dict[str, Any]] | None = None,
    parent_id: str | None = None,
    thread_id: str | None = None,
) -> dict[str, Any]:
    normalized_intent = normalize_intent(intent)
    resolved_thread_id, parent = _resolve_thread(parent_id, thread_id)
    # Inherit parent's attachments when the caller didn't supply any.
    if not attachments and parent:
        inherited = (parent.get("inputs", {}) or {}).get("attachments") or parent.get("attachments") or []
        if inherited:
            attachments = list(inherited)
    task = {
        "id": "task_" + uuid.uuid4().hex[:12],
        "created_at": S.now_iso(),
        "updated_at": S.now_iso(),
        "status": "queued",
        "active_agent": "explorer",
        "next_agent_index": 0,
        "task": task_text,
        "intent": normalized_intent,
        "target_agent_index": INTENT_TARGET_INDEX[normalized_intent],
        "project": str(project_root),
        "permission_level": permission_level,
        "golden_build_guard": golden_build_guard,
        "thread_id": resolved_thread_id,
        "parent_id": parent_id or "",
        "inputs": {
            "file_path": file_path,
            "find_text": find_text,
            "replace_text": replace_text,
            "replace_all": replace_all,
            "test_command": test_command,
            "attachments": attachments or [],
        },
        "agents": [],
        "artifacts": {},
        "blocked_reason": "",
    }
    tasks = _load_all()
    tasks.append(task)
    _save_all(tasks)
    return task


def normalize_intent(intent: str | None) -> str:
    value = str(intent or "build").strip().lower()
    if value in INTENT_TARGET_INDEX:
        return value
    return "build"


def mark_task_patch_applied(task_id: str, patch_id: str, snapshot_id: str) -> dict[str, Any]:
    tasks = _load_all()
    for task in tasks:
        if task.get("id") != task_id:
            continue

        artifacts = task.setdefault("artifacts", {})
        applied_at = S.now_iso()
        matched = False

        proposal = artifacts.get("patch_proposal")
        if isinstance(proposal, dict) and proposal.get("id") == patch_id:
            proposal.update({
                "applied": True,
                "applied_at": applied_at,
                "snapshot_id": snapshot_id,
            })
            matched = True

        proposals = artifacts.get("patch_proposals")
        if isinstance(proposals, list):
            for item in proposals:
                if isinstance(item, dict) and item.get("id") == patch_id:
                    item.update({
                        "applied": True,
                        "applied_at": applied_at,
                        "snapshot_id": snapshot_id,
                    })
                    matched = True

        artifacts["last_applied_patch_id"] = patch_id
        artifacts["last_snapshot_id"] = snapshot_id
        if not matched:
            artifacts["applied_patch_missing_from_task"] = patch_id
        task["updated_at"] = applied_at

        next_idx = int(task.get("next_agent_index", 0) or 0)
        if next_idx < INTENT_TARGET_INDEX["build"]:
            task["next_agent_index"] = INTENT_TARGET_INDEX["build"]
            next_idx = task["next_agent_index"]
        if task.get("status") not in {"cancelled", "completed"}:
            task["status"] = "paused"
            task["active_agent"] = AGENT_ORDER[next_idx] if next_idx < len(AGENT_ORDER) else None

        _save_all(tasks)
        return task

    raise ValueError("Builder task not found.")


def _resolve_thread(parent_id: str | None, thread_id: str | None) -> tuple[str, dict[str, Any] | None]:
    """Return (thread_id, parent_record_or_None).

    If parent_id resolves to a known task or chat, inherit its thread_id; otherwise
    mint a fresh thread. Caller passes thread_id only when forcing a specific value.
    """
    parent: dict[str, Any] | None = None
    if parent_id:
        from .chat import find_chat
        parent = find_task(parent_id) or find_chat(parent_id)
    if not thread_id and parent:
        thread_id = parent.get("thread_id") or ""
    if not thread_id:
        thread_id = "thr_" + uuid.uuid4().hex[:12]
    return thread_id, parent


def advance_task(
    task_id: str,
    project_root: Path,
    project_map: dict[str, Any],
    approve_test_command: bool = False,
    allow_network: bool = False,
) -> dict[str, Any]:
    tasks = _load_all()
    task = None
    for item in tasks:
        if item.get("id") == task_id:
            task = item
            break
    if task is None:
        raise ValueError("Builder task not found.")
    if task.get("status") in {"completed", "cancelled"}:
        return task

    task["status"] = "running"
    task["blocked_reason"] = ""
    idx = int(task.get("next_agent_index", 0))
    if idx >= len(AGENT_ORDER):
        task["status"] = "completed"
        task["active_agent"] = None
        task["updated_at"] = S.now_iso()
        _save_all(tasks)
        return task

    agent = AGENT_ORDER[idx]
    task["active_agent"] = agent
    step = run_agent_step(agent, task, project_root, project_map, approve_test_command, allow_network)
    task.setdefault("agents", []).append(step)
    task.setdefault("artifacts", {}).update(step.get("artifacts", {}))

    if step.get("status") == "blocked":
        task["status"] = "blocked"
        task["blocked_reason"] = step.get("message", "")
    else:
        task["next_agent_index"] = idx + 1
        if task["next_agent_index"] >= len(AGENT_ORDER):
            task["status"] = "completed"
            task["active_agent"] = None
        else:
            task["status"] = "paused"
            task["active_agent"] = AGENT_ORDER[task["next_agent_index"]]
    task["updated_at"] = S.now_iso()
    _save_all(tasks)
    return task


def update_task_status(task_id: str, status: str) -> dict[str, Any]:
    tasks = _load_all()
    for task in tasks:
        if task.get("id") == task_id:
            current = task.get("status")
            # Cancellation/discard is always permitted (it's a hide action).
            # Pause is only meaningful on an active task.
            if status != "cancelled" and current in {"completed", "cancelled"}:
                raise ValueError("Completed or cancelled tasks cannot be moved back to an active state.")
            task["status"] = status
            task["updated_at"] = S.now_iso()
            _save_all(tasks)
            return task
    raise ValueError("Builder task not found.")


def run_agent_step(
    agent: str,
    task: dict[str, Any],
    project_root: Path,
    project_map: dict[str, Any],
    approve_test_command: bool,
    allow_network: bool,
) -> dict[str, Any]:
    if agent == "explorer":
        relevant = retrieve_relevant_files(project_root, project_map, task["task"], limit=10)
        answer = answer_from_project_map(project_map, task["task"], relevant)
        attachments = (task.get("inputs", {}) or {}).get("attachments") or []
        return agent_result(agent, "complete", "Explorer identified relevant files.", {
            "relevant_files": relevant,
            "analysis": answer,
            "attachments": attachments,
        })

    if agent == "planner":
        attachments = (task.get("inputs", {}) or {}).get("attachments") or []
        thread_context = ""
        if task.get("parent_id"):
            from .thread_context import build_thread_context
            thread_context = build_thread_context(task["parent_id"])
        plan = create_plan(
            project_root,
            project_map,
            task["task"],
            limit=10,
            attachments=attachments,
            thread_context=thread_context,
        )
        return agent_result(agent, "complete", "Planner created an implementation plan.", {"plan": plan})

    if agent == "patch":
        inputs = task.get("inputs", {})
        if inputs.get("file_path") and inputs.get("find_text"):
            proposal = generate_find_replace_diff(
                project_root,
                inputs["file_path"],
                inputs["find_text"],
                inputs.get("replace_text", ""),
                task=task["task"],
                replace_all=bool(inputs.get("replace_all")),
            )
            add_patch_proposal(proposal)
            return agent_result(agent, "complete", "Patch agent generated a copyable diff preview.", {"patch_proposal": proposal})
        return run_llm_patch_step(task, project_root)

    if agent == "test":
        command = (task.get("inputs", {}) or {}).get("test_command", "").strip()
        if not command:
            return agent_result(agent, "complete", "Test agent found no command input; recorded manual verification need.", {
                "test_result": {
                    "status": "not_run",
                    "suggestion": "Run an approved relevant test/build command before applying broadly.",
                }
            })
        safety = classify_command(command)
        if not approve_test_command:
            return agent_result(agent, "blocked", "Test command requires explicit approval.", {
                "command_safety": safety,
            })
        result = run_approved_command(project_root, command, approved=True, allow_network=allow_network)
        return agent_result(agent, "complete", "Test agent ran the approved command.", {"test_result": result})

    if agent == "reviewer":
        artifacts = task.get("artifacts", {})
        issues = []
        proposal = artifacts.get("patch_proposal")
        if proposal and proposal.get("risk") == "medium":
            issues.append("Patch touches a shared or high-impact file; review carefully before applying.")
        if artifacts.get("test_result", {}).get("exit_code", 0) not in (0, None):
            issues.append("Test command did not pass.")
        return agent_result(agent, "complete", "Reviewer checked task artifacts.", {
            "review": {
                "issues": issues,
                "recommendation": "Ready for manual approval." if not issues else "Review issues before applying.",
            }
        })

    if agent == "receipt":
        artifacts = task.get("artifacts", {})
        receipt = {
            "task": task["task"],
            "project": task.get("project"),
            "files_considered": [f.get("path") for f in artifacts.get("relevant_files", [])],
            "patch_id": artifacts.get("patch_proposal", {}).get("id"),
            "test_status": artifacts.get("test_result", {}).get("status", "not_run"),
            "final_status": "completed",
        }
        return agent_result(agent, "complete", "Receipt agent summarized the Builder task.", {"task_receipt": receipt})

    return agent_result(agent, "blocked", f"Unknown agent: {agent}", {})


def run_llm_patch_step(task: dict[str, Any], project_root: Path) -> dict[str, Any]:
    artifacts_so_far = task.get("artifacts", {}) or {}
    plan = artifacts_so_far.get("plan") or {}
    candidate_paths: list[str] = []
    for path in plan.get("files_involved") or []:
        if isinstance(path, str) and path not in candidate_paths:
            candidate_paths.append(path)
    for item in artifacts_so_far.get("relevant_files") or []:
        if isinstance(item, dict):
            path = item.get("path")
            if isinstance(path, str) and path not in candidate_paths:
                candidate_paths.append(path)

    if not candidate_paths:
        return agent_result("patch", "blocked", "Patch agent has no candidate files. Run explorer and planner first.", {})

    excerpts = gather_file_excerpts(project_root, candidate_paths[:3])
    if not excerpts:
        return agent_result("patch", "blocked", "Patch agent could not read any candidate files (missing or protected).", {})

    allowed_paths = {item["path"] for item in excerpts}
    attachments = (task.get("inputs", {}) or {}).get("attachments") or []
    thread_context = ""
    if task.get("parent_id"):
        from .thread_context import build_thread_context
        thread_context = build_thread_context(task["parent_id"])
    user_prompt = build_patch_user_prompt(
        task.get("task", ""),
        plan,
        excerpts,
        attachments,
        thread_context=thread_context,
    )

    try:
        parsed = complete_patch_json(user_prompt)
    except ModelOffline as exc:
        return agent_result("patch", "blocked", f"Model offline: {exc}", {
            "model_error": {"kind": "offline", "message": str(exc)},
        })
    except ModelInvalid as exc:
        return agent_result("patch", "blocked", f"Model output was invalid: {exc}", {
            "model_error": {"kind": "invalid", "message": str(exc)},
            "model_raw": getattr(exc, "raw_text", ""),
        })

    edits = parsed.get("edits") or []
    if not edits:
        return agent_result("patch", "blocked", parsed.get("summary") or "Model returned no edits.", {
            "model_summary": parsed.get("summary", ""),
        })

    proposals: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for edit in edits:
        rel = edit["file_path"]
        if rel not in allowed_paths:
            skipped.append({"file_path": rel, "reason": "file was not in patch context"})
            continue
        target = (project_root / rel).resolve()
        if not is_within_root(project_root, target) or not target.exists() or not target.is_file():
            skipped.append({"file_path": rel, "reason": "file missing or outside project root"})
            continue
        if is_protected_path(target):
            skipped.append({"file_path": rel, "reason": "file is protected"})
            continue
        try:
            current = target.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            skipped.append({"file_path": rel, "reason": f"read failed: {exc}"})
            continue
        if edit["find"] not in current:
            skipped.append({"file_path": rel, "reason": "find text not present in current file"})
            continue
        try:
            proposal = generate_find_replace_diff(
                project_root,
                rel,
                edit["find"],
                edit["replace"],
                task=task.get("task", ""),
                replace_all=bool(edit.get("replace_all")),
            )
        except ValueError as exc:
            skipped.append({"file_path": rel, "reason": str(exc)})
            continue
        add_patch_proposal(proposal)
        proposals.append(proposal)

    if not proposals:
        return agent_result("patch", "blocked", "Model proposed edits but none could be validated.", {
            "model_summary": parsed.get("summary", ""),
            "skipped_edits": skipped,
        })

    artifacts: dict[str, Any] = {
        "patch_proposal": proposals[0],
        "model_summary": parsed.get("summary", ""),
        "model_backend": parsed.get("backend", ""),
    }
    if len(proposals) > 1:
        artifacts["patch_proposals"] = proposals
    if skipped:
        artifacts["skipped_edits"] = skipped

    backend_label = parsed.get("backend") or "local model"
    message = f"Patch agent generated {len(proposals)} diff preview(s) via {backend_label}."
    if skipped:
        message += f" Skipped {len(skipped)} unsafe or invalid edit(s)."
    return agent_result("patch", "complete", message, artifacts)


def build_patch_user_prompt(
    task_text: str,
    plan: dict[str, Any],
    excerpts: list[dict[str, Any]],
    attachments: list[dict[str, Any]] | None = None,
    thread_context: str = "",
) -> str:
    lines: list[str] = []
    if thread_context:
        lines.append(thread_context)
        lines.append("")
    lines.append("Task:")
    lines.append((task_text or "").strip() or "(no task text provided)")
    lines.append("")
    if plan:
        summary = (plan.get("summary") or "").strip()
        risk = (plan.get("risk") or "").strip()
        strategy = plan.get("change_strategy") or []
        if summary:
            lines.append("Planner summary: " + summary[:500])
        if risk:
            lines.append("Planner risk: " + risk)
        if strategy:
            lines.append("Planner strategy:")
            for step in strategy[:4]:
                lines.append("- " + str(step)[:220])
        lines.append("")
    lines.append("Files you may edit (use exact paths shown):")
    for item in excerpts:
        lines.append(f"- {item['path']}{'  [truncated]' if item.get('truncated') else ''}")
    lines.append("")
    attachment_block, _image_refs = format_attachments_for_prompt(attachments or [])
    if attachment_block:
        lines.append(attachment_block)
        lines.append("")
    lines.append("File contents:")
    for item in excerpts:
        lines.append("")
        lines.append(f"=== FILE: {item['path']} ===")
        lines.append(item["content"])
        lines.append(f"=== END FILE: {item['path']} ===")
    lines.append("")
    lines.append("Return a single JSON object matching the schema in the system prompt. No prose.")
    return "\n".join(lines)


def agent_result(agent: str, status: str, message: str, artifacts: dict[str, Any]) -> dict[str, Any]:
    return {
        "agent": agent,
        "status": status,
        "message": message,
        "created_at": S.now_iso(),
        "artifacts": artifacts,
    }


def _load_all() -> list[dict[str, Any]]:
    BUILDER_DIR.mkdir(parents=True, exist_ok=True)
    return S.load_json_file(TASKS_PATH, []) or []


def _save_all(tasks: list[dict[str, Any]]) -> None:
    BUILDER_DIR.mkdir(parents=True, exist_ok=True)
    S.save_json_file(TASKS_PATH, tasks[-200:])
