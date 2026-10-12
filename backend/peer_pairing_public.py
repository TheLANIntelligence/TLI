"""Bounded public handshake routes, with no browser or local approval endpoint."""
import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.routing import APIRoute

import peer_pairing as pairing


class PairingRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def bounded(request: Request):
            async def collect():
                raw = bytearray()
                async for part in request.stream():
                    if len(raw) + len(part) > pairing.MAX_BODY:
                        pairing._fail(413, "pairing_body_limit", "The connection request exceeded its limit.")
                    raw.extend(part)
                request._body = bytes(raw)
            try:
                await asyncio.wait_for(collect(), timeout=8)
            except asyncio.TimeoutError:
                pairing._fail(408, "pairing_body_timeout", "The connection request took too long.")
            response = await handler(request)
            response.headers["Cache-Control"] = "no-store"
            return response
        return bounded


def make_public_router(*, node_window=None):
    def guard():
        if node_window is not None:
            node_window.check()
    router = APIRouter(tags=['public computer pairing'], route_class=PairingRoute, dependencies=[Depends(guard)])

    @router.post('/agent/pairing/request')
    def receive(body: dict, request: Request):
        return pairing.receive(body, request)

    @router.post('/agent/pairing/reveal')
    def reveal(body: dict, request: Request):
        return pairing.reveal(body, request)

    @router.post('/agent/pairing/status')
    def status(body: dict, request: Request):
        return pairing.status(body, request)
    return router


router = make_public_router()
