from __future__ import annotations

import threading
from typing import Any, Dict, Optional

try:
    from typing import Literal
except ImportError:
    from typing_extensions import Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

import tli_state as S
from routers.system_routes import require_session
from builder.attachments import save_uploads
from builder.chat import add_chat_message, load_chat_messages
from builder.command_runner import run_approved_command
from builder.diff_generator import generate_find_replace_diff
from builder.llm_client import ModelOffline, complete_chat
from builder.patch_engine import apply_find_replace_proposal
from builder.planner import create_plan
from builder.project_creator import create_project
from builder.project_indexer import public_project_map, scan_project
from builder.receipts import (
    add_patch_proposal,
    add_receipt,
    find_patch_proposal,
    load_patch_proposals,
    load_receipts,
    load_state,
    save_state,
    update_patch_proposal,
)
from builder.retrieval import answer_from_project_map, retrieve_relevant_files
from builder.safety import classify_command, resolve_project_root
from builder.snapshots import list_snapshots, rollback_snapshot
from builder.tasks import (
    advance_task,
    create_task,
    find_task,
    load_tasks,
    mark_task_patch_applied,
    update_task_status,
)


router = APIRouter(prefix="/api/builder", tags=["builder"], dependencies=[Depends(require_session)])


class SelectProjectRequest(BaseModel):
    path: str = Field(..., min_length=1)
    permission_level: Literal["locked", "ask", "trusted"] = "ask"
    golden_build_guard: bool = True


class CreateProjectRequest(BaseModel):
    parent_path: str = Field(..., min_length=1, max_length=1000)
    name: str = Field(..., min_length=1, max_length=120)
    template: Literal["blank", "python", "web"] = "blank"
    create_parent: bool = False
    open_after: bool = True
    permission_level: Literal["locked", "ask", "trusted"] = "ask"
    golden_build_guard: bool = True


class AnalyzeRequest(BaseModel):
    task: str = Field(..., min_length=1, max_length=2000)
    refresh_project_map: bool = False
    limit: int = Field(default=12, ge=1, le=30)


class CommandClassifyRequest(BaseModel):
    command: str = Field(..., min_length=1, max_length=1000)


class PlanRequest(BaseModel):
    task: str = Field(..., min_length=1, max_length=2000)
    refresh_project_map: bool = False
    limit: int = Field(default=8, ge=1, le=20)


class GenerateDiffRequest(BaseModel):
    task: str = Field(default="", max_length=2000)
    file_path: str = Field(..., min_length=1, max_length=1000)
    find_text: str = Field(..., min_length=1, max_length=20000)
    replace_text: str = Field(default="", max_length=20000)
    replace_all: bool = False


class ApplyPatchRequest(BaseModel):
    patch_id: Optional[str] = Field(default=None, max_length=128)
    task_id: Optional[str] = Field(default=None, max_length=128)
    approved: bool = False


class RollbackRequest(BaseModel):
    snapshot_id: str = Field(..., min_length=1, max_length=160)
    approved: bool = False


class RunCommandRequest(BaseModel):
    command: str = Field(..., min_length=1, max_length=1000)
    cwd: str = Field(default="", max_length=1000)
    approved: bool = False
    allow_network: bool = False
    timeout_seconds: int = Field(default=120, ge=1, le=600)


class CreateTaskRequest(BaseModel):
    task: str = Field(..., min_length=1, max_length=2000)
    intent: Literal["build", "plan", "inspect"] = "build"
    file_path: str = Field(default="", max_length=1000)
    find_text: str = Field(default="", max_length=20000)
    replace_text: str = Field(default="", max_length=20000)
    replace_all: bool = False
    test_command: str = Field(default="", max_length=1000)
    attachments: list[Dict[str, Any]] = Field(default_factory=list)
    parent_id: Optional[str] = Field(default=None, max_length=128)


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    attachments: list[Dict[str, Any]] = Field(default_factory=list)
    parent_id: Optional[str] = Field(default=None, max_length=128)


class AdvanceTaskRequest(BaseModel):
    approve_test_command: bool = False
    allow_network: bool = False


class TaskStatusRequest(BaseModel):
    status: Literal["paused", "cancelled"] = "paused"


@router.get("/status")
def builder_status():
    state = load_state()
    return {
        "enabled": True,
        "mode": "agent_tasks",
        "selected_project": state.get("selected_project"),
        "permission_level": state.get("permission_level", "ask"),
        "golden_build_guard": bool(state.get("golden_build_guard", True)),
        "last_patch_status": state.get("last_patch_status"),
        "rollback_available": bool(state.get("last_snapshot_id")),
        "capabilities": {
            "scan_project": True,
            "create_project": True,
            "upload_attachments": True,
            "analyze": True,
            "plan": True,
            "generate_diff": True,
            "apply_patch": True,
            "rollback": True,
            "run_command": True,
            "agent_tasks": True,
        },
    }


@router.get("/backend-status")
def backend_status():
    """Report which local AI backend will answer the next patch agent call.

    Tries the bundled llama.cpp runtime first (matches llm_client's order),
    falls back to LM Studio. Returns a single normalized payload for the UI pill.
    """
    bundled_label, bundled_model, bundled_error = _probe_bundled_backend()
    if bundled_label:
        return {
            "backend": "bundled",
            "healthy": True,
            "label": bundled_label,
            "model": bundled_model,
            "error": "",
        }

    lms_label, lms_model, lms_error = _probe_lmstudio_backend()
    if lms_label:
        return {
            "backend": "lmstudio",
            "healthy": True,
            "label": lms_label,
            "model": lms_model,
            "error": "",
        }

    parts: list[str] = []
    if bundled_error:
        parts.append(f"bundled: {bundled_error}")
    if lms_error:
        parts.append(f"lmstudio: {lms_error}")
    return {
        "backend": "offline",
        "healthy": False,
        "label": "AI offline",
        "model": "",
        "error": " | ".join(parts) or "No local AI backend reachable.",
    }


@router.post("/warm-backend")
def warm_backend():
    """Eagerly start the bundled llama.cpp runtime in a background thread.

    Returns immediately. The runtime may take several seconds to come up; the
    UI should keep polling /api/builder/backend-status to detect when it goes
    healthy. Safe to call repeatedly — ensure_running() is a no-op if already up.
    """
    def _warm():
        try:
            from ai.ai_manager import BundledAIManager
            BundledAIManager.get().ensure_running()
        except Exception as exc:
            S.log_debug("builder", "WARN", "warm-backend failed", error=str(exc))

    try:
        threading.Thread(target=_warm, daemon=True).start()
    except Exception as exc:
        return {"warming": False, "error": str(exc)}
    return {"warming": True}


def _probe_bundled_backend() -> tuple[str, str, str]:
    try:
        from ai.ai_manager import BundledAIManager, MODEL_PRESETS
    except Exception as exc:
        return "", "", f"runtime missing ({exc})"
    try:
        mgr = BundledAIManager.get()
        if not mgr.is_healthy():
            return "", "", "runtime not healthy"
        preset = MODEL_PRESETS.get(mgr.active_preset_id, {}) or {}
        model_name = preset.get("name") or preset.get("filename") or "Local model"
        return model_name, str(preset.get("filename", "")), ""
    except Exception as exc:
        return "", "", str(exc)


def _probe_lmstudio_backend() -> tuple[str, str, str]:
    provider = getattr(S, "lm_provider", None)
    if provider is None:
        return "", "", "provider not configured"
    try:
        if not provider.health_check():
            return "", "", "not reachable"
        cfg = getattr(S, "MODEL_CONFIG", {}) or {}
        key = getattr(S, "DEFAULT_MODEL_KEY", "") or ""
        entry = cfg.get(key) if isinstance(cfg, dict) else None
        if isinstance(entry, dict):
            label = entry.get("label") or entry.get("id") or "LM Studio"
            model_id = entry.get("id") or ""
            return f"LM Studio · {label}", str(model_id), ""
        return "LM Studio", "", ""
    except Exception as exc:
        return "", "", str(exc)


@router.post("/select-project")
def select_project(req: SelectProjectRequest):
    try:
        root = resolve_project_root(req.path)
        project_map = scan_project(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        S.log_debug("builder", "ERROR", "project scan failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Project scan failed: {exc}")

    state = load_state()
    state.update({
        "selected_project": str(root),
        "permission_level": req.permission_level,
        "golden_build_guard": req.golden_build_guard,
        "last_project_map": project_map,
        "last_analysis": None,
        "last_plan": None,
        "last_patch_status": None,
        "last_patch_proposal": None,
        "last_snapshot_id": None,
        "last_command_result": None,
    })
    save_state(state)

    receipt = add_receipt(
        "select_project",
        f"Selected and scanned {root.name}.",
        project=str(root),
        permission_level=req.permission_level,
        golden_build_guard=req.golden_build_guard,
        files_read=project_map.get("file_count", 0),
        risk_files=project_map.get("risk_files", []),
    )
    return {"project_map": public_project_map(project_map), "receipt": receipt}


@router.post("/create-project")
def create_builder_project(req: CreateProjectRequest):
    try:
        created = create_project(req.parent_path, req.name, req.template, create_parent=req.create_parent)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        S.log_debug("builder", "ERROR", "project create failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Project create failed: {exc}")

    receipt = add_receipt(
        "create_project",
        f"Created new {created['template']} project {created['project_name']}.",
        phase="agent_tasks",
        project=created["root"],
        files_changed=created["files_created"],
        rollback_available=False,
    )

    if not req.open_after:
        return {"created": created, "project_map": None, "receipt": receipt}

    try:
        root = resolve_project_root(created["root"])
        project_map = scan_project(root)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Project created but scan failed: {exc}")

    state = load_state()
    state.update({
        "selected_project": str(root),
        "permission_level": req.permission_level,
        "golden_build_guard": req.golden_build_guard,
        "last_project_map": project_map,
        "last_analysis": None,
        "last_plan": None,
        "last_patch_status": None,
        "last_patch_proposal": None,
        "last_snapshot_id": None,
        "last_command_result": None,
    })
    save_state(state)
    return {"created": created, "project_map": public_project_map(project_map), "receipt": receipt}


@router.post("/attachments")
async def upload_builder_attachments(files: list[UploadFile] = File(...)):
    try:
        attachments = await save_uploads(files)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        S.log_debug("builder", "ERROR", "attachment upload failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Attachment upload failed: {exc}")

    receipt = add_receipt(
        "upload_attachments",
        f"Uploaded {len(attachments)} Builder attachment(s).",
        phase="workspace",
        files=[item.get("name") for item in attachments],
        total_bytes=sum(int(item.get("size") or 0) for item in attachments),
    )
    return {"attachments": attachments, "receipt": receipt}


@router.get("/project-map")
def get_project_map(refresh: bool = False):
    state = load_state()
    selected = state.get("selected_project")
    if not selected:
        raise HTTPException(status_code=404, detail="No Builder project selected.")

    project_map = state.get("last_project_map")
    if refresh or not project_map:
        try:
            root = resolve_project_root(selected)
            project_map = scan_project(root)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Project scan failed: {exc}")
        state["last_project_map"] = project_map
        save_state(state)

    return {"project_map": public_project_map(project_map)}


@router.post("/analyze")
def analyze_project(req: AnalyzeRequest):
    state = load_state()
    selected = state.get("selected_project")
    if not selected:
        raise HTTPException(status_code=400, detail="Select a Builder project before analyzing.")

    try:
        root = resolve_project_root(selected)
        project_map = scan_project(root) if req.refresh_project_map or not state.get("last_project_map") else state["last_project_map"]
        relevant = retrieve_relevant_files(root, project_map, req.task, limit=req.limit)
        answer = answer_from_project_map(public_project_map(project_map), req.task, relevant)
    except Exception as exc:
        S.log_debug("builder", "ERROR", "analysis failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Builder analysis failed: {exc}")

    analysis = {
        "task": req.task,
        "answer": answer,
        "relevant_files": relevant,
        "risk": "read_only",
        "phase": "phase_1",
    }
    state["last_project_map"] = project_map
    state["last_analysis"] = analysis
    save_state(state)

    receipt = add_receipt(
        "analyze",
        "Read-only Builder analysis completed.",
        project=str(root),
        request=req.task,
        files_read=[item["path"] for item in relevant],
        risk="read_only",
    )
    return {"analysis": analysis, "receipt": receipt}


@router.get("/receipts")
def receipts(limit: int = 50):
    return {"receipts": load_receipts(limit=limit)}


@router.get("/patch-proposals")
def patch_proposals(limit: int = 50):
    return {"proposals": load_patch_proposals(limit=limit)}


@router.get("/snapshots")
def snapshots(limit: int = 50):
    state = load_state()
    selected = state.get("selected_project")
    if not selected:
        raise HTTPException(status_code=400, detail="Select a Builder project before listing snapshots.")
    try:
        root = resolve_project_root(selected)
        return {"snapshots": list_snapshots(root, limit=limit)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Builder snapshot listing failed: {exc}")


@router.get("/tasks")
def builder_tasks(limit: int = 50):
    items = load_tasks(limit=limit) + load_chat_messages(limit=limit)
    items.sort(key=lambda item: item.get("updated_at") or item.get("created_at") or "", reverse=True)
    return {"tasks": items[:limit]}


@router.post("/chat")
def chat_with_builder(req: ChatRequest):
    state = load_state()
    selected = state.get("selected_project") or ""
    project_context = ""
    if selected:
        project_map = state.get("last_project_map") or {}
        public_map = public_project_map(project_map) if project_map else {}
        if public_map:
            project_context = "\n".join([
                "Project context:",
                f"Name: {public_map.get('project_name', '')}",
                f"Stack: {', '.join(public_map.get('frameworks') or []) or 'unknown'}",
                f"Languages: {', '.join((public_map.get('languages') or {}).keys()) or 'unknown'}",
            ])
    # Resolve parent and (optionally) inherit attachments before formatting.
    parent_record = None
    if req.parent_id:
        from builder.tasks import find_task as _find_task
        from builder.chat import find_chat as _find_chat
        parent_record = _find_task(req.parent_id) or _find_chat(req.parent_id)
    effective_attachments = list(req.attachments or [])
    if not effective_attachments and parent_record:
        inherited = (parent_record.get("inputs", {}) or {}).get("attachments") \
            or parent_record.get("attachments") or []
        if inherited:
            effective_attachments = list(inherited)

    if effective_attachments:
        from builder.attachment_context import format_attachments_for_prompt
        attachment_block, _image_refs = format_attachments_for_prompt(effective_attachments)
        if attachment_block:
            project_context = (project_context + "\n\n" if project_context else "") + attachment_block

    # If this chat is a follow-up, give the model the prior thread context.
    if req.parent_id:
        from builder.thread_context import build_thread_context
        thread_block = build_thread_context(req.parent_id)
        if thread_block:
            project_context = thread_block + ("\n\n" + project_context if project_context else "")

    try:
        result = complete_chat(req.message, project_context=project_context)
        response = result["text"]
        backend = result.get("backend", "")
    except ModelOffline as exc:
        response = f"The local model is not reachable yet: {exc}"
        backend = "offline"
    except Exception as exc:
        S.log_debug("builder", "ERROR", "chat failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Builder chat failed: {exc}")

    thread_id = parent_record.get("thread_id") if parent_record else None
    item = add_chat_message(
        prompt=req.message,
        response=response,
        backend=backend,
        project=selected,
        attachments=effective_attachments,
        thread_id=thread_id,
        parent_id=req.parent_id,
    )
    add_receipt(
        "chat",
        "Builder chat completed.",
        phase="chat",
        project=selected,
        request=req.message,
        backend=backend,
    )
    return {"message": item}


@router.post("/tasks")
def create_builder_task(req: CreateTaskRequest):
    state = load_state()
    selected = state.get("selected_project")
    if not selected:
        raise HTTPException(status_code=400, detail="Select a Builder project before creating tasks.")
    try:
        root = resolve_project_root(selected)
        task = create_task(
            task_text=req.task,
            project_root=root,
            permission_level=state.get("permission_level", "ask"),
            golden_build_guard=bool(state.get("golden_build_guard", True)),
            intent=req.intent,
            file_path=req.file_path,
            find_text=req.find_text,
            replace_text=req.replace_text,
            replace_all=req.replace_all,
            test_command=req.test_command,
            attachments=req.attachments,
            parent_id=req.parent_id,
        )
    except Exception as exc:
        S.log_debug("builder", "ERROR", "task create failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Builder task create failed: {exc}")

    receipt = add_receipt(
        "create_task",
        f"Created Builder agent task {task['id']}.",
        phase="agent_tasks",
        project=selected,
        request=req.task,
        rollback_available=bool(state.get("last_snapshot_id")),
    )
    return {"task": task, "receipt": receipt}


@router.post("/tasks/{task_id}/advance")
def advance_builder_task(task_id: str, req: AdvanceTaskRequest):
    state = load_state()
    selected = state.get("selected_project")
    if not selected:
        raise HTTPException(status_code=400, detail="Select a Builder project before advancing tasks.")
    try:
        root = resolve_project_root(selected)
        project_map = state.get("last_project_map") or scan_project(root)
        task = advance_task(
            task_id=task_id,
            project_root=root,
            project_map=project_map,
            approve_test_command=req.approve_test_command,
            allow_network=req.allow_network,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        S.log_debug("builder", "ERROR", "task advance failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Builder task advance failed: {exc}")

    state["last_agent_task_id"] = task_id
    state["last_agent_task_status"] = task.get("status")
    save_state(state)
    receipt = add_receipt(
        "advance_task",
        f"Advanced Builder task {task_id} to {task.get('status')}.",
        phase="agent_tasks",
        project=selected,
        request=task.get("task"),
        rollback_available=bool(state.get("last_snapshot_id")),
    )
    return {"task": task, "receipt": receipt}


@router.post("/tasks/{task_id}/status")
def update_builder_task_status(task_id: str, req: TaskStatusRequest):
    try:
        task = update_task_status(task_id, req.status)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    receipt = add_receipt(
        "update_task",
        f"Set Builder task {task_id} to {req.status}.",
        phase="agent_tasks",
        request=task.get("task"),
    )
    return {"task": task, "receipt": receipt}


@router.post("/classify-command")
def classify_builder_command(req: CommandClassifyRequest):
    return classify_command(req.command)


@router.post("/plan")
def plan_change(req: PlanRequest):
    state = load_state()
    selected = state.get("selected_project")
    if not selected:
        raise HTTPException(status_code=400, detail="Select a Builder project before planning.")

    try:
        root = resolve_project_root(selected)
        project_map = scan_project(root) if req.refresh_project_map or not state.get("last_project_map") else state["last_project_map"]
        plan = create_plan(root, project_map, req.task, limit=req.limit)
    except Exception as exc:
        S.log_debug("builder", "ERROR", "plan failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Builder plan failed: {exc}")

    state["last_project_map"] = project_map
    state["last_plan"] = plan
    save_state(state)

    receipt = add_receipt(
        "plan",
        "Phase 2 change plan generated.",
        phase="plan_and_diff_preview",
        project=str(root),
        request=req.task,
        files_read=plan.get("files_involved", []),
        risk=plan.get("risk"),
    )
    return {"plan": plan, "receipt": receipt}


@router.post("/generate-diff")
def generate_diff(req: GenerateDiffRequest):
    state = load_state()
    selected = state.get("selected_project")
    if not selected:
        raise HTTPException(status_code=400, detail="Select a Builder project before generating a diff.")

    try:
        root = resolve_project_root(selected)
        proposal = generate_find_replace_diff(
            root=root,
            file_path=req.file_path,
            find_text=req.find_text,
            replace_text=req.replace_text,
            task=req.task,
            replace_all=req.replace_all,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        S.log_debug("builder", "ERROR", "diff preview failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Builder diff preview failed: {exc}")

    add_patch_proposal(proposal)
    state["last_patch_status"] = "preview_generated"
    state["last_patch_proposal"] = proposal
    save_state(state)

    receipt = add_receipt(
        "generate_diff",
        f"Phase 2 diff preview generated for {proposal['file_path']}.",
        phase="plan_and_diff_preview",
        project=str(root),
        request=req.task,
        files_read=[proposal["file_path"]],
        files_changed=[],
        risk=proposal.get("risk"),
        patch_id=proposal["id"],
    )
    return {"proposal": proposal, "receipt": receipt}


@router.post("/apply-patch")
def apply_patch(req: ApplyPatchRequest):
    if not req.approved:
        raise HTTPException(status_code=400, detail="Patch application requires explicit approval.")
    state = load_state()
    selected = state.get("selected_project")
    if not selected:
        raise HTTPException(status_code=400, detail="Select a Builder project before applying a patch.")
    if state.get("permission_level") == "locked":
        raise HTTPException(status_code=403, detail="Builder is in Locked Mode. Patch application is disabled.")

    patch_id = req.patch_id or (state.get("last_patch_proposal") or {}).get("id")
    if not patch_id:
        raise HTTPException(status_code=400, detail="No patch proposal selected.")
    proposal = find_patch_proposal(patch_id)
    if not proposal:
        raise HTTPException(status_code=404, detail="Patch proposal not found.")
    task_before_apply = find_task(req.task_id) if req.task_id else None
    if req.task_id and not task_before_apply:
        raise HTTPException(status_code=404, detail="Builder task not found.")

    try:
        root = resolve_project_root(selected)
        if task_before_apply:
            task_root = resolve_project_root(task_before_apply.get("project") or "")
            if task_root != root:
                raise ValueError("Builder task must belong to the selected project.")
        result = apply_find_replace_proposal(root, proposal)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        S.log_debug("builder", "ERROR", "patch apply failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Builder patch apply failed: {exc}")

    update_patch_proposal(patch_id, {
        "applied": True,
        "applied_at": S.now_iso(),
        "snapshot_id": result["snapshot"]["id"],
    })
    state["last_patch_status"] = "applied"
    state["last_snapshot_id"] = result["snapshot"]["id"]
    save_state(state)

    task = None
    if req.task_id:
        try:
            task = mark_task_patch_applied(req.task_id, patch_id, result["snapshot"]["id"])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    receipt = add_receipt(
        "apply_patch",
        f"Applied approved Builder patch to {result['file_path']}.",
        phase="apply_rollback_test",
        project=str(root),
        request=proposal.get("task"),
        files_changed=[result["file_path"]],
        commands_run=[],
        risk=proposal.get("risk"),
        patch_id=patch_id,
        backup_location=result["snapshot"].get("snapshot_dir"),
        rollback_available=True,
    )
    return {"result": result, "receipt": receipt, "task": task}


@router.post("/rollback")
def rollback(req: RollbackRequest):
    if not req.approved:
        raise HTTPException(status_code=400, detail="Rollback requires explicit approval.")
    state = load_state()
    selected = state.get("selected_project")
    if not selected:
        raise HTTPException(status_code=400, detail="Select a Builder project before rollback.")
    if state.get("permission_level") == "locked":
        raise HTTPException(status_code=403, detail="Builder is in Locked Mode. Rollback is disabled.")

    try:
        root = resolve_project_root(selected)
        result = rollback_snapshot(root, req.snapshot_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        S.log_debug("builder", "ERROR", "rollback failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Builder rollback failed: {exc}")

    state["last_patch_status"] = "rolled_back"
    save_state(state)
    receipt = add_receipt(
        "rollback",
        f"Rolled back Builder snapshot {req.snapshot_id}.",
        phase="apply_rollback_test",
        project=str(root),
        files_changed=result.get("files_restored", []),
        rollback_available=True,
        snapshot_id=req.snapshot_id,
    )
    return {"result": result, "receipt": receipt}


@router.post("/run-command")
def run_command(req: RunCommandRequest):
    state = load_state()
    selected = state.get("selected_project")
    if not selected:
        raise HTTPException(status_code=400, detail="Select a Builder project before running commands.")
    if state.get("permission_level") == "locked":
        raise HTTPException(status_code=403, detail="Builder is in Locked Mode. Command execution is disabled.")

    try:
        root = resolve_project_root(selected)
        result = run_approved_command(
            project_root=root,
            command=req.command,
            cwd=req.cwd,
            approved=req.approved,
            allow_network=req.allow_network,
            timeout_seconds=req.timeout_seconds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        S.log_debug("builder", "ERROR", "command failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Builder command failed: {exc}")

    state["last_command_result"] = result
    save_state(state)
    receipt = add_receipt(
        "run_command",
        f"Ran approved command with exit code {result['exit_code']}.",
        phase="apply_rollback_test",
        project=str(root),
        commands_run=[result],
        risk="command",
    )
    return {"result": result, "receipt": receipt}
