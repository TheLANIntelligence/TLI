"""Local owner controls and separately signed peer transfer ingress."""
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import StreamingResponse, JSONResponse

import peer_trust as P
import peer_transfers as T
from routers.system_routes import require_session

class TransferRoute(P.BoundedPeerRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def private(request):
            try:
                response = await handler(request)
            except HTTPException as error:
                response = JSONResponse({"detail": error.detail}, status_code=error.status_code, headers=error.headers)
            except RequestValidationError:
                response = JSONResponse({"detail": {"code": "invalid_transfer_request", "message": "Invalid transfer request."}}, status_code=422)
            response.headers["Cache-Control"] = "no-store"
            return response
        return private


router = APIRouter(route_class=TransferRoute)


@router.get("/mesh/files/capabilities")
def capabilities(owner=Depends(require_session)):
    return T.capabilities()


@router.get("/mesh/files")
def listing(owner=Depends(require_session)):
    return T.listing(owner)


@router.post("/mesh/files/outgoing")
def outgoing(body: dict, request: Request, owner=Depends(require_session)):
    return T.create(body, owner, request)


@router.get("/mesh/files/{transfer_id}")
def get(transfer_id: str, owner=Depends(require_session)):
    return T.get(transfer_id, owner)


@router.post("/mesh/files/{transfer_id}/{operation}")
def operation(transfer_id: str, operation: str, body: dict, request: Request, owner=Depends(require_session)):
    if operation == "stage":
        return T.stage(transfer_id, body, owner, request)
    if operation == "accept":
        return T.accept(transfer_id, body, owner, request)
    T._exact(body, set())
    if operation in {"offer", "peer-status", "send-next", "complete", "review", "resume"}:
        function = {"peer-status": T.peer_status, "send-next": T.send_next}.get(operation) or getattr(T, operation)
        return function(transfer_id, owner, request)
    if operation in {"cancel", "decline", "discard"}:
        return T.stop(transfer_id, owner, request, decline=operation == "decline", discard=operation == "discard")
    P.fail(404, "transfer_operation_unavailable", "Unknown transfer operation.")


@router.get("/mesh/files/{transfer_id}/download")
def download(transfer_id: str, request: Request, owner=Depends(require_session)):
    filename, size, chunks = T.download(transfer_id, owner, request)
    return StreamingResponse(chunks, media_type="application/octet-stream", headers={
        "Content-Disposition": "attachment; filename*=UTF-8''" + quote(filename, safe=""),
        "Content-Length": str(size), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/agent/peer/files/capability")
def peer_capability(access=Depends(P.message_access)):
    P.revalidate(access)
    return T.capabilities()


@router.post("/agent/peer/files/offer")
def receive_offer(body: dict, access=Depends(P.message_access)):
    return T.receive_offer(body, access)


@router.post("/agent/peer/files/{operation}")
def receive(operation: str, body: dict, access=Depends(P.message_access)):
    if operation not in {"status", "chunk", "complete", "cancel"}:
        P.fail(404, "transfer_operation_unavailable", "Unknown transfer operation.")
    return T.receive(operation, body, access)
