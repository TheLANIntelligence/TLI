from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import tli_state as S


BUILDER_DIR = Path(S.DATA_DIR) / "builder"
STATE_PATH = BUILDER_DIR / "builder_state.json"
RECEIPTS_PATH = BUILDER_DIR / "receipts.json"
PROPOSALS_PATH = BUILDER_DIR / "patch_proposals.json"


def ensure_builder_dir() -> None:
    BUILDER_DIR.mkdir(parents=True, exist_ok=True)


def load_state() -> dict[str, Any]:
    ensure_builder_dir()
    return S.load_json_file(STATE_PATH, {
        "selected_project": None,
        "permission_level": "ask",
        "golden_build_guard": True,
        "last_project_map": None,
        "last_analysis": None,
    }) or {}


def save_state(state: dict[str, Any]) -> None:
    ensure_builder_dir()
    S.save_json_file(STATE_PATH, state)


def load_receipts(limit: int = 50) -> list[dict[str, Any]]:
    ensure_builder_dir()
    receipts = S.load_json_file(RECEIPTS_PATH, []) or []
    return list(reversed(receipts[-limit:]))


def load_patch_proposals(limit: int = 50) -> list[dict[str, Any]]:
    ensure_builder_dir()
    proposals = S.load_json_file(PROPOSALS_PATH, []) or []
    return list(reversed(proposals[-limit:]))


def find_patch_proposal(patch_id: str) -> dict[str, Any] | None:
    ensure_builder_dir()
    proposals = S.load_json_file(PROPOSALS_PATH, []) or []
    for proposal in proposals:
        if proposal.get("id") == patch_id:
            return proposal
    return None


def add_patch_proposal(proposal: dict[str, Any]) -> dict[str, Any]:
    ensure_builder_dir()
    proposals = S.load_json_file(PROPOSALS_PATH, []) or []
    proposals.append(proposal)
    S.save_json_file(PROPOSALS_PATH, proposals[-100:])
    return proposal


def update_patch_proposal(patch_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    ensure_builder_dir()
    proposals = S.load_json_file(PROPOSALS_PATH, []) or []
    updated = None
    for proposal in proposals:
        if proposal.get("id") == patch_id:
            proposal.update(updates)
            updated = proposal
            break
    if updated is not None:
        S.save_json_file(PROPOSALS_PATH, proposals[-100:])
    return updated


def add_receipt(action: str, summary: str, **extra: Any) -> dict[str, Any]:
    ensure_builder_dir()
    receipts = S.load_json_file(RECEIPTS_PATH, []) or []
    receipt = {
        "id": "builder_" + uuid.uuid4().hex[:12],
        "created_at": S.now_iso(),
        "action": action,
        "summary": summary,
        "phase": "read_only_analyzer",
        "files_changed": [],
        "commands_run": [],
        "rollback_available": False,
        **extra,
    }
    receipts.append(receipt)
    S.save_json_file(RECEIPTS_PATH, receipts[-200:])
    return receipt
