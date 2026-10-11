from __future__ import annotations

import re
import uuid
from pathlib import Path
from typing import Any

from fastapi import UploadFile

import tli_state as S

from .receipts import BUILDER_DIR


ATTACHMENTS_DIR = BUILDER_DIR / "attachments"
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAX_ATTACHMENTS_PER_UPLOAD = 12


def safe_attachment_name(name: str) -> str:
    base = Path(name or "attachment").name.strip()
    if not base:
        base = "attachment"
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", base)
    base = base.strip(" .")
    return base[:160] or "attachment"


async def save_uploads(files: list[UploadFile]) -> list[dict[str, Any]]:
    if not files:
        raise ValueError("Attach at least one file.")
    if len(files) > MAX_ATTACHMENTS_PER_UPLOAD:
        raise ValueError(f"Attach {MAX_ATTACHMENTS_PER_UPLOAD} files or fewer at once.")

    ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)
    saved: list[dict[str, Any]] = []
    batch_id = "att_" + uuid.uuid4().hex[:12]
    batch_dir = ATTACHMENTS_DIR / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)

    for upload in files:
        original_name = safe_attachment_name(upload.filename or "attachment")
        attachment_id = "file_" + uuid.uuid4().hex[:12]
        disk_name = f"{attachment_id}_{original_name}"
        target = batch_dir / disk_name

        total = 0
        with target.open("wb") as out:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_ATTACHMENT_BYTES:
                    try:
                        target.unlink(missing_ok=True)
                    except Exception:
                        pass
                    raise ValueError(f"{original_name} is larger than 25 MB.")
                out.write(chunk)

        saved.append({
            "id": attachment_id,
            "batch_id": batch_id,
            "name": original_name,
            "content_type": upload.content_type or "application/octet-stream",
            "size": total,
            "path": str(target),
            "created_at": S.now_iso(),
        })

    return saved
