"""One active turn per shared conversation, across desktop and phone routes."""
from functools import wraps
import inspect
import threading
import uuid

from fastapi import HTTPException
from starlette.responses import StreamingResponse

_lock = threading.Lock()
_active: set[str] = set()
_reservations: dict[str, str] = {}


def reserve_run(ident, run_id):
    with _lock:
        if ident in _active:
            raise HTTPException(409, "This conversation already has a response in progress.")
        _active.add(ident)
        _reservations[ident] = run_id


def release_run(ident, run_id):
    with _lock:
        if _reservations.get(ident) == run_id:
            _reservations.pop(ident, None)
            _active.discard(ident)


def assert_idle(conversation_ids):
    """Call inside the store transaction before deleting existing histories.

    An already-running turn prevents deletion. A turn beginning after this
    check waits for that transaction before loading or creating its history.
    """
    with _lock:
        if any(ident in _active for ident in conversation_ids):
            raise HTTPException(409, "A selected conversation has a response in progress. Stop it or wait before deleting its history.")


class _LeasedStreamingResponse(StreamingResponse):
    """Finalize the lease even when the connection fails before the first byte."""
    def __init__(self, original, release):
        # Retain the original response's iterator, raw headers (including
        # duplicate Set-Cookie), charset, status and background task exactly.
        self.__dict__.update(original.__dict__)
        self._release_lease = release

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            try:
                close = getattr(self.body_iterator, "aclose", None)
                if close:
                    await close()
            finally:
                self._release_lease()


def exclusive_turn(function):
    signature = inspect.signature(function, eval_str=True)

    @wraps(function)
    def guarded(*args, **kwargs):
        bound = signature.bind(*args, **kwargs)
        bound.apply_defaults()
        req = bound.arguments.get("req")
        ident = (getattr(req, "conversation_id", None) or getattr(req, "session_id", None)
                 if req is not None else bound.arguments.get("session_id"))
        ident = ident or "conv-" + uuid.uuid4().hex
        if not isinstance(ident, str) or len(ident) > 256:
            raise HTTPException(422, "Invalid conversation identifier.")
        if req is not None:
            req.conversation_id = ident
        elif "session_id" in bound.arguments:
            bound.arguments["session_id"] = ident
        from run_context import run_id
        with _lock:
            reserved = bool(run_id() and _reservations.get(ident) == run_id())
        if reserved:
            # The detached worker owns this lease from durable admission through
            # finalization, including while its response has no subscribers.
            return function(*bound.args, **bound.kwargs)
        with _lock:
            if ident in _active:
                raise HTTPException(409, "This conversation already has a response in progress. Wait for it to finish before sending again.")
            _active.add(ident)

        released = False

        def release():
            nonlocal released
            with _lock:
                # Stream finalization and BackgroundTask may both run, with a
                # subsequent request already holding this conversation ID.
                if not released:
                    released = True
                    _active.discard(ident)

        try:
            response = function(*bound.args, **bound.kwargs)
        except BaseException:
            release()
            raise
        if not isinstance(response, StreamingResponse):
            release()
            return response

        original = response.body_iterator

        async def stream():
            try:
                async for chunk in original:
                    yield chunk
            finally:
                try:
                    close = getattr(original, "aclose", None)
                    if close:
                        await close()
                finally:
                    release()

        response.body_iterator = stream()
        # Also covers a response whose iterator is never entered (early close).
        from starlette.background import BackgroundTask
        previous = response.background

        async def cleanup():
            try:
                if previous:
                    await previous()
            finally:
                release()

        response.background = BackgroundTask(cleanup)
        return _LeasedStreamingResponse(response, release)

    # Resolve forward annotations in their defining module for FastAPI.
    guarded.__signature__ = signature
    return guarded
