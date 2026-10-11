"""Signed compute ingress shared by the full host and the lightweight Node.

This module deliberately has no browser session, Vault, chat or action imports.
"""
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

import lan_inference as L
import peer_trust as P
from stream_lifecycle import ClosingStreamingResponse


class InferenceRoute(P.BoundedPeerRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private(request):
            try:
                response = await handler(request)
            except HTTPException as error:
                response = JSONResponse({"detail": error.detail}, status_code=error.status_code)
            except RequestValidationError:
                response = JSONResponse({"detail": {"code": "invalid_inference_request", "message": "Invalid inference request."}}, status_code=422)
            response.headers["Cache-Control"] = "no-store"
            return response

        return private


def peer_response(body, access, *, resource_loader=None):
    # Advance admission before HTTP 200 so stale resources and busy workers
    # receive an ordinary error without an apparent successful event stream.
    events = L.worker_stream(body, access, resource_loader=resource_loader)
    first = next(events)

    def encoded():
        try:
            yield "data: " + json.dumps(first, ensure_ascii=False) + "\n\n"
            for event in events:
                yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
        except HTTPException as error:
            # Never return prompts, upstream responses, credentials or errors.
            yield "data: " + json.dumps({"type": "error", "status_code": error.status_code,
                                        "detail": "The selected computer could not complete inference."}) + "\n\n"
        finally:
            events.close()

    return ClosingStreamingResponse(encoded(), cleanup=events.close, media_type="text/event-stream",
                                    headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


def capability(access=Depends(P.inference_access)):
    """Default full-host handler retained for direct callers."""
    return L.capability(access)


def inference(body: dict, access=Depends(P.inference_access)):
    """Default full-host handler retained for direct callers."""
    return peer_response(body, access)


def make_peer_router(*, resource_loader=None):
    """Expose only the signed catalog and inference stream, with explicit compute."""
    router = APIRouter(route_class=InferenceRoute)
    if resource_loader is None:
        router.add_api_route("/agent/peer/inference", capability, methods=["GET"])
        router.add_api_route("/agent/peer/inference/stream", inference, methods=["POST"])
    else:
        def selected_capability(access=Depends(P.inference_access)):
            return L.capability(access, resource_loader=resource_loader)

        def selected_inference(body: dict, access=Depends(P.inference_access)):
            return peer_response(body, access, resource_loader=resource_loader)

        router.add_api_route("/agent/peer/inference", selected_capability, methods=["GET"])
        router.add_api_route("/agent/peer/inference/stream", selected_inference, methods=["POST"])
    return router
