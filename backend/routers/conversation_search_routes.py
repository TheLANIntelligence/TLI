"""Additive retained-conversation search; existing chat routes are unchanged."""
from fastapi import APIRouter, Query, Request, Response
from intelligence import conversation_search
from private_client_authority import private_client_access, checked_call, checked_json

router = APIRouter(prefix="/api/intelligence/conversation-search", tags=["conversation-search"])


@router.get("/capabilities")
def capabilities(request: Request, response: Response):
    _user, check = private_client_access(request, response)
    return checked_json(check, {"ok": True, "protocol": conversation_search.PROTOCOL})


@router.get("")
def search_conversations(request: Request, response: Response, q: str = Query("", max_length=120), limit: int = Query(20, ge=1, le=50),
                         cursor: str | None = Query(None, max_length=128)):
    user, check = private_client_access(request, response)
    value = checked_call(check, lambda: conversation_search.search(user, q, limit, cursor, check=check))
    return checked_json(check, value)
