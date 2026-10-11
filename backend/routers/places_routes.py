"""Authenticated favorites; check/open remain separate from saving."""
from fastapi import APIRouter, Depends, Query, Response
from routers.system_routes import require_session
from intelligence import places

router = APIRouter(prefix="/api/intelligence/places", tags=["saved places"], dependencies=[Depends(require_session)])


@router.get("")
def listing(response: Response, user=Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return places.listing(user)


@router.post("")
def create(req: places.PlaceInput, user=Depends(require_session)):
    return places.create(user, req)


@router.patch("/{ident}")
def rename(ident: str, req: places.RenameInput, user=Depends(require_session)):
    return places.change(user, ident, req.expected_revision, req.name)


@router.delete("/{ident}")
def remove(ident: str, expected_revision: str = Query(pattern=r"^[a-f0-9]{64}$"), user=Depends(require_session)):
    return places.change(user, ident, expected_revision)


@router.post("/{ident}/check")
def check(ident: str, response: Response, user=Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return places.check(user, ident)
