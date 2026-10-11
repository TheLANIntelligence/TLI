from __future__ import annotations

import json
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

import tli_state as S

from .safety import is_within_root, relative_path


def snapshot_root(project_root: Path) -> Path:
    return project_root / ".backups" / "tli-builder"


def create_snapshot(project_root: Path, task: str, files: list[Path], patch_diff: str, risk: str) -> dict[str, Any]:
    sid = datetime.utcnow().strftime("%Y-%m-%d-%H%M%S") + "-" + slugify(task or "builder-patch")
    root = snapshot_root(project_root)
    snap_dir = root / sid
    originals_dir = snap_dir / "original_files"
    originals_dir.mkdir(parents=True, exist_ok=False)

    rel_files: list[str] = []
    for path in files:
        resolved = path.resolve()
        if not is_within_root(project_root, resolved):
            raise ValueError("Snapshot file must stay inside the selected project root.")
        rel = relative_path(project_root, resolved)
        dest = originals_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(resolved, dest)
        rel_files.append(rel)

    (snap_dir / "patch.diff").write_text(patch_diff or "", encoding="utf-8")
    manifest = {
        "id": sid,
        "task": task,
        "created_at": S.now_iso(),
        "files_changed": rel_files,
        "risk": risk,
        "rollback_available": True,
        "snapshot_dir": str(snap_dir),
    }
    (snap_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def list_snapshots(project_root: Path, limit: int = 50) -> list[dict[str, Any]]:
    root = snapshot_root(project_root)
    if not root.exists():
        return []
    snapshots: list[dict[str, Any]] = []
    for manifest_path in root.glob("*/manifest.json"):
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            data["snapshot_dir"] = str(manifest_path.parent)
            snapshots.append(data)
        except Exception:
            continue
    snapshots.sort(key=lambda item: item.get("created_at", ""), reverse=True)
    return snapshots[:limit]


def rollback_snapshot(project_root: Path, snapshot_id: str) -> dict[str, Any]:
    root = snapshot_root(project_root).resolve()
    snap_dir = (root / snapshot_id).resolve()
    if not is_within_root(root, snap_dir):
        raise ValueError("Invalid snapshot id.")
    manifest_path = snap_dir / "manifest.json"
    originals_dir = snap_dir / "original_files"
    if not manifest_path.exists() or not originals_dir.exists():
        raise ValueError("Snapshot not found or incomplete.")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    restored: list[str] = []
    for rel in manifest.get("files_changed", []):
        source = (originals_dir / rel).resolve()
        target = (project_root / rel).resolve()
        if not source.exists() or not is_within_root(project_root, target):
            raise ValueError(f"Cannot restore {rel}.")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        restored.append(rel)

    manifest["rolled_back_at"] = S.now_iso()
    manifest["rollback_available"] = True
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return {"snapshot": manifest, "files_restored": restored}


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.lower()).strip("-")
    return (slug[:48] or "builder-patch")

