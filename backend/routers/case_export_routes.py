"""Authenticated, read-only troubleshooting previews and deliberate downloads."""
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from intelligence import case_exports as exports
from intelligence import cases
from routers.system_routes import require_session

router = APIRouter(prefix="/api/intelligence/case-exports", tags=["Troubleshooting export"])


def authorize(request, user):
    origin = request.headers.get("origin")
    if request.headers.get("sec-fetch-site") == "cross-site" or origin and origin != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "Open TLI on this host to review an export.")
    if require_session(request.cookies.get("tli_session"), request) != user:
        raise HTTPException(401, "The TLI session changed. Unlock and start a new export review.")


@router.post("/preview")
def preview(body: exports.Preview, request: Request, response: Response, user: str = Depends(require_session)):
    authorize(request, user)
    result = exports.preview(user, body)
    authorize(request, user)
    response.headers["Cache-Control"] = "no-store"
    return {"ok": True, "protocol": exports.PROTOCOL, "checked_at": cases.stamp(), "actions_performed": False, "source_unchanged": True, **result}


@router.post("/download")
def download(body: exports.Download, request: Request, user: str = Depends(require_session)):
    authorize(request, user)
    raw, media = exports.download(user, body)
    authorize(request, user)
    suffix = {"text": "txt", "json": "json", "html": "html"}[body.selection.format]
    return Response(raw, media_type=media, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                    "Content-Disposition": f'attachment; filename="tli-troubleshooting.{suffix}"',
                    "Content-Security-Policy": "default-src 'none'; sandbox", "X-TLI-Export-SHA256": body.preview_sha256})
