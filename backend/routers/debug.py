from fastapi import APIRouter

debug_router = APIRouter(prefix="/debug", tags=["debug"])

@debug_router.get("/health")
async def health():
    """Minimal health probe — no system information exposed."""
    return {"ok": True}
