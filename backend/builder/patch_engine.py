from __future__ import annotations

from pathlib import Path
from typing import Any

import tli_state as S

from .diff_generator import sha256_text
from .safety import is_protected_path, is_within_root
from .snapshots import create_snapshot


def apply_find_replace_proposal(project_root: Path, proposal: dict[str, Any]) -> dict[str, Any]:
    rel = proposal.get("file_path") or ""
    find_text = proposal.get("find_text")
    replace_text = proposal.get("replace_text", "")
    if not rel or find_text is None:
        raise ValueError("Patch proposal is missing apply metadata. Regenerate the diff before applying.")
    if proposal.get("applied"):
        raise ValueError("Patch proposal has already been applied.")

    target = (project_root / rel).resolve()
    if not is_within_root(project_root, target):
        raise ValueError("Patch target must stay inside the selected project root.")
    if not target.exists() or not target.is_file():
        raise ValueError("Patch target file does not exist.")
    if is_protected_path(target):
        raise ValueError("Protected files cannot be patched by Builder.")

    original = target.read_text(encoding="utf-8", errors="replace")
    expected_hash = proposal.get("original_sha256")
    if expected_hash and sha256_text(original) != expected_hash:
        raise ValueError("Target file changed since this diff was generated. Regenerate the diff before applying.")

    matches = original.count(find_text)
    if matches == 0:
        raise ValueError("Find text no longer exists in target file. Regenerate the diff before applying.")

    replace_all = bool(proposal.get("replace_all"))
    changed = original.replace(find_text, replace_text) if replace_all else original.replace(find_text, replace_text, 1)
    changed_hash = proposal.get("changed_sha256")
    if changed_hash and sha256_text(changed) != changed_hash:
        raise ValueError("Patch result hash did not match the approved preview.")

    snapshot = create_snapshot(
        project_root=project_root,
        task=proposal.get("task") or proposal.get("id") or "Builder patch",
        files=[target],
        patch_diff=proposal.get("diff") or "",
        risk=proposal.get("risk") or "unknown",
    )
    target.write_text(changed, encoding="utf-8")

    receipt_md = [
        "TLI Builder Receipt",
        "",
        f"Task: {proposal.get('task') or proposal.get('id')}",
        f"Files changed: {rel}",
        f"Snapshot: {snapshot.get('snapshot_dir')}",
        f"Applied at: {S.now_iso()}",
        "",
        "Rollback: Available",
    ]
    receipt_path = Path(snapshot["snapshot_dir"]) / "receipt.md"
    receipt_path.write_text("\n".join(receipt_md) + "\n", encoding="utf-8")

    return {
        "patch_id": proposal.get("id"),
        "file_path": rel,
        "matches_replaced": matches if replace_all else 1,
        "snapshot": snapshot,
        "changed_sha256": sha256_text(changed),
    }

