"""Deterministic closure of synchronous streams, including ASGI send failures."""
from __future__ import annotations

import threading

import anyio
from starlette.responses import StreamingResponse


class ClosingStreamingResponse(StreamingResponse):
    """Close owned generators before returning, even before the first body byte.

    Starlette's thread-pool iterator does not own the synchronous generator's
    close operation. Serialize next/close so disconnect cleanup cannot close a
    generator while another thread is executing it. The source itself must use
    bounded I/O; cancellation waits for an in-progress next call to finish.
    """
    def __init__(self, content, *, cleanup=None, **kwargs):
        self._owned_source = iter(content)
        self._owned_cleanup = cleanup
        self._owned_lock = threading.RLock()
        self._owned_closed = False
        super().__init__(self._owned_chunks(), **kwargs)

    def _owned_next(self):
        with self._owned_lock:
            if self._owned_closed:
                return False, None
            try:
                return True, next(self._owned_source)
            except StopIteration:
                return False, None

    def _owned_close(self):
        with self._owned_lock:
            if self._owned_closed:
                return
            self._owned_closed = True
            try:
                close = getattr(self._owned_source, "close", None)
                if close:
                    close()
            finally:
                if self._owned_cleanup:
                    self._owned_cleanup()

    async def _finish(self):
        with anyio.CancelScope(shield=True):
            await anyio.to_thread.run_sync(self._owned_close)

    async def _owned_chunks(self):
        try:
            while True:
                available, chunk = await anyio.to_thread.run_sync(self._owned_next)
                if not available:
                    break
                yield chunk
        finally:
            await self._finish()

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self._finish()
