"""Validated, metadata-free images; optional encrypted retention owned by the user."""
import base64
import io
import time
import uuid
import warnings
from fastapi import HTTPException
from intelligence.store import LOCK, read_private, write_private

MAX_BYTES = 6 * 1024 * 1024
MAX_PIXELS = 16_000_000


def sanitize(encoded, mime=None):
    if not isinstance(encoded, str) or len(encoded) > (MAX_BYTES * 4 // 3 + 4):
        raise HTTPException(413, "Images must be at most 6 MB.")
    try:
        from PIL import Image, ImageOps
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > MAX_BYTES:
            raise HTTPException(413, "Images must be at most 6 MB.")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as check:
                if check.format not in ("PNG", "JPEG") or check.width * check.height > MAX_PIXELS:
                    raise HTTPException(422, "Use a JPEG or PNG image with at most 16 million pixels.")
                check.verify()
            with Image.open(io.BytesIO(raw)) as original:
                original.load()
                clean = ImageOps.exif_transpose(original).convert("RGB")
                pixels = Image.new("RGB", clean.size)
                pixels.paste(clean)
                out = io.BytesIO()
                pixels.save(out, format="JPEG", quality=90)
        if out.tell() > MAX_BYTES:
            raise HTTPException(413, "The decoded image is too large. Resize it and try again.")
        return {"b64": base64.b64encode(out.getvalue()).decode(), "mime": "image/jpeg"}
    except HTTPException:
        raise
    except ImportError:
        raise HTTPException(503, "Image validation is unavailable. Install the updated backend requirements.")
    except Exception:
        raise HTTPException(422, "This image could not be decoded safely. Use a valid JPEG or PNG.")


def images(user, *, authorize=None):
    check = authorize or (lambda: None)
    check()
    with LOCK:
        check()
        saved = read_private(user, "images", [])
        check()
        active = [item for item in saved if item["expires_at"] > time.time()]
        if len(active) != len(saved):
            check()
            write_private(user, "images", active)
        check()
        return active


def retain(user, clean, days, report_id=None, *, authorize=None):
    check = authorize or (lambda: None)
    check()
    if not days:
        return None
    if not user:
        raise HTTPException(401, "Sign in to retain an image.")
    if days not in (1, 7):
        raise HTTPException(422, "Image retention must be off, one day, or seven days.")
    if report_id:
        from intelligence.diagnostics import get_report
        get_report(user, report_id)
    with LOCK:
        # The request may have waited behind another private-store operation.
        # Recheck inside the lock before even pruning older retained images.
        check()
        saved = images(user, authorize=authorize)
        if len(saved) >= 20:
            raise HTTPException(409, "Delete a retained image first (20 image limit).")
        item = {"id": uuid.uuid4().hex, "expires_at": time.time() + days * 86400,
                "report_id": report_id, **clean}
        check()
        write_private(user, "images", [*saved, item])
        check()
        return {k: v for k, v in item.items() if k != "b64"}


def forget(user, ident):
    with LOCK:
        saved = images(user)
        if not any(i["id"] == ident for i in saved):
            raise HTTPException(404, "Image not found.")
        write_private(user, "images", [i for i in saved if i["id"] != ident])
    return {"ok": True}
