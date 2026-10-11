"""Private troubleshooting journals shared by browser and Companion."""
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import Field
from typing import Literal
from routers.system_routes import require_session
from intelligence import cases, case_context, case_next_check
from types import SimpleNamespace

router = APIRouter(prefix="/api/intelligence/cases", tags=["Troubleshooting"], dependencies=[Depends(require_session)])


def reply(response, **values):
    response.headers["Cache-Control"] = "no-store"
    return {"ok": True, "protocol": cases.PROTOCOL, "checked_at": cases.stamp(), "actions_performed": False, **values}


@router.get("/capabilities")
def capabilities(response: Response):
    return reply(response, backup_format="saved-work-v2", max_cases=cases.MAX_CASES, case_context="tli-case-context-v1",
                 case_report_context=case_context.REPORT_PROTOCOL, max_case_reports=1,
                 next_check=case_next_check.PROTOCOL)


class ContextReview(cases.Strict):
    case_ref: case_context.CaseRef


@router.post("/context-review")
def context_review(req: ContextReview, response: Response, user: str = Depends(require_session)):
    prepared = case_context.prepare(user, SimpleNamespace(case_ref=req.case_ref, message="Review the selected case context."))
    return reply(response, case_report_context=case_context.REPORT_PROTOCOL,
                 case_context=prepared["case_context"], evidence_context=prepared["evidence_context"])


@router.post("/next-check")
def next_check(req: ContextReview, request: Request, response: Response, user: str = Depends(require_session)):
    from companion_auth import operation_access
    return reply(response, **case_next_check.review(user, req.case_ref, authorize=operation_access(request, user)))


@router.get("/health")
def health(response: Response, user: str = Depends(require_session)):
    return reply(response, store=cases.health(user))


class Review(cases.Strict):
    kind: Literal["note", "report", "chat"]
    id: str = Field(min_length=1, max_length=256)
    message_index: int | None = Field(default=None, ge=0, le=1_000_000)


@router.post("/evidence/review")
def review(req: Review, response: Response, user: str = Depends(require_session)):
    if (req.kind == "chat") != (req.message_index is not None):
        raise HTTPException(422, "Chat evidence requires a message index; notes and reports do not.")
    return reply(response, evidence=cases.review_evidence(user, req.kind, req.id, req.message_index))


@router.get("")
def listing(response: Response, q: str = Query(default="", max_length=120), status: Literal["open", "resolved", "archived"] | None = None,
            limit: int = Query(default=50, ge=1, le=50), user: str = Depends(require_session)):
    return reply(response, **cases.list_cases(user, query=q, status=status, limit=limit))


@router.post("")
def create(req: cases.Create, response: Response, user: str = Depends(require_session)):
    try:
        result = cases.save(user, req.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return reply(response, **result)


@router.get("/{ident}")
def get(ident: str, response: Response, user: str = Depends(require_session)):
    return reply(response, case=cases.get_case(user, ident))


@router.put("/{ident}")
def update(ident: str, req: cases.Update, response: Response, user: str = Depends(require_session)):
    try:
        result = cases.save(user, req.model_dump(), ident)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return reply(response, **result)


@router.delete("/{ident}")
def remove(ident: str, response: Response, expected_revision: str = Query(pattern=r"^[a-f0-9]{64}$"), user: str = Depends(require_session)):
    return reply(response, **cases.remove(user, ident, expected_revision))
