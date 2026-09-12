"""Additive retained-conversation search; existing chat routes are unchanged."""
from fastapi import APIRouter, Depends, Query, Response
from routers.system_routes import require_session
from intelligence import conversation_search

router = APIRouter(prefix="/api/intelligence/conversation-search", tags=["conversation-search"])


@router.get("/capabilities")
def capabilities(response: Response, user: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return {"ok": True, "protocol": conversation_search.PROTOCOL}


@router.get("")
def search_conversations(response: Response, q: str = Query("", max_length=120), limit: int = Query(20, ge=1, le=50),
                         cursor: str | None = Query(None, max_length=128), user: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return conversation_search.search(user, q, limit, cursor)
