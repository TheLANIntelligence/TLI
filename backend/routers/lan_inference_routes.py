"""Browser model selection plus the shared, separately authenticated peer ingress."""
from fastapi import APIRouter, Depends, Request

import lan_inference as L
from companion_auth import operation_access
from routers.system_routes import require_session
from peer_inference_routes import InferenceRoute, capability, inference, make_peer_router


router = APIRouter(route_class=InferenceRoute)


@router.get("/api/ai/lan/peers")
def peers(owner=Depends(require_session)):
    return L.peers()


@router.post("/api/ai/lan/models")
def models(body: dict, request: Request, owner=Depends(require_session)):
    L._exact(body, {"peer_id"})
    return L.models(body["peer_id"], check=operation_access(request, owner))


router.include_router(make_peer_router())
