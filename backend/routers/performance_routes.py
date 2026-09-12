"""Authenticated explicit Performance & apps observations."""
from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, ConfigDict, Field
from routers.system_routes import require_session
from intelligence import performance as P

router = APIRouter(prefix="/api/intelligence/performance", tags=["Performance & apps"], dependencies=[Depends(require_session)])


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Start(Strict):
    request_id: str = Field(min_length=1, max_length=128)
    pid: int = Field(ge=1, le=2**31 - 1)
    create_time: float = Field(gt=0, allow_inf_nan=False)


class Save(Strict):
    request_id: str = Field(min_length=1, max_length=128)


def reply(response, **values):
    response.headers["Cache-Control"] = "no-store"
    return {"ok": True, "protocol": P.PROTOCOL, "checked_at": P.stamp(), "actions_performed": False, **values}


@router.get("/capabilities")
def capabilities(response: Response):
    return reply(response, duration_seconds=P.DURATION, interval_seconds=P.INTERVAL, max_results=P.MAX_RESULTS, retention_seconds=P.TTL,
                 metrics=list(P.METRICS), scope="This TLI host only. No FPS, GPU, temperature, tuning or automatic diagnostics.")


@router.get("/processes")
def processes(response: Response, q: str = Query(default="", max_length=120), limit: int = Query(default=100, ge=1, le=100)):
    return reply(response, **P.process_list(q.strip(), limit))


@router.get("/observations")
def observations(response: Response, user: str = Depends(require_session)):
    return reply(response, observations=P.manager.listing(user))


@router.get("/observations/by-request/{request_id}")
def by_request(request_id: str, response: Response, user: str = Depends(require_session)):
    return reply(response, observation=P.manager.by_request(user, request_id))


@router.post("/observations")
def start(req: Start, response: Response, user: str = Depends(require_session)):
    result, duplicate = P.manager.start(user, req.request_id, req.pid, req.create_time)
    return reply(response, observation=result, already_started=duplicate)


@router.get("/observations/{ident}")
def observation(ident: str, response: Response, user: str = Depends(require_session)):
    return reply(response, observation=P.manager.get(user, ident))


@router.post("/observations/{ident}/stop")
def stop(ident: str, response: Response, user: str = Depends(require_session)):
    return reply(response, observation=P.manager.stop(user, ident), stop_requested=True)


@router.post("/observations/{ident}/save")
def save(ident: str, req: Save, response: Response, user: str = Depends(require_session)):
    return reply(response, report=P.manager.save(user, ident, req.request_id))
