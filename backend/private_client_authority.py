"""Captured authority for private reads shared by browsers and native Companion.

This is an opt-in HTTP boundary, not a grant to other routes or internal callers.
Browser access retains the existing PIN/session epoch policy. Native access uses
the original paired HTTPS credential and is independent of browser lock events.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from fastapi import HTTPException, Request, Response
from starlette.responses import JSONResponse

import browser_authority
import companion_auth
import tli_state as S


Check = Callable[[], None]
_T = TypeVar("_T")
_NO_STORE = {"Cache-Control": "no-store"}
_AUTHORITY_DETAILS = {
    401: "The original access expired, was locked or was revoked. Reopen the browser or reconnect the paired Companion.",
    403: "Use a direct unlocked TLI browser or the paired Companion HTTPS connection.",
    503: "Private access could not be verified because security state is unavailable. Existing files were preserved.",
}


def _authority_error(error: Exception) -> HTTPException:
    status = error.status_code if isinstance(error, HTTPException) and error.status_code in _AUTHORITY_DETAILS else 503
    result = HTTPException(status, _AUTHORITY_DETAILS[status], headers=dict(_NO_STORE))
    result.private_client_authority_failure = True
    return result


def _sticky(check: Check) -> Check:
    failed: HTTPException | None = None

    def captured() -> None:
        nonlocal failed
        if failed is not None:
            raise failed from None
        try:
            check()
        except Exception as error:
            failed = _authority_error(error)
            raise failed from None

    return captured


def _native_credential(request: Request) -> str:
    values = request.headers.getlist("authorization")
    if len(values) != 1:
        raise HTTPException(401, "Supply one Companion credential.")
    parts = values[0].split()
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].startswith("tlic_"):
        raise HTTPException(401, "Use a valid paired Companion credential.")
    if any(key in ("cookie", "origin", "forwarded") or key.startswith(("sec-fetch-", "x-forwarded-", "x-tli-peer-"))
           for key in request.headers):
        raise HTTPException(403, "Use the direct native Companion connection.")
    address = browser_authority.direct_request_address(request)
    if address.scheme != "https":
        raise HTTPException(403, "Use the paired Companion HTTPS address.")
    return parts[1]


def private_client_access(request: Request, response: Response) -> tuple[str, Check]:
    """Resolve the original owner and return a sticky check for private work.

    Callers must pass the check through slow reads and locks, then recheck after
    response encoding. A failed check cannot recover within this request.
    """
    response.headers["Cache-Control"] = "no-store"
    try:
        if request.headers.getlist("authorization"):
            credential = _native_credential(request)
            owner = companion_auth.credential_owner(credential)

            def current() -> None:
                # Bind and recheck the exact native credential directly; browser
                # lock state is independent of this paired client's authority.
                if companion_auth.credential_owner(credential) != owner:
                    raise HTTPException(401, "The paired credential owner changed.")
                additional = getattr(request.state, "tli_run_check", None)
                if additional is not None:
                    additional()
                    if companion_auth.credential_owner(credential) != owner:
                        raise HTTPException(401, "The paired credential owner changed.")
        else:
            browser_check = browser_authority.browser_control_access(request, response)
            token = request.cookies.get("tli_session")
            owner = S.get_session_user_id(token) if token else "local"

            def current() -> None:
                browser_check()
                if token is not None and S.get_session_user_id(token) != owner:
                    raise HTTPException(401, "The original browser owner changed.")
                browser_check()

        if not isinstance(owner, str) or not owner:
            raise HTTPException(503, "The original access owner is unavailable.")
        check = _sticky(current)
        check()
        return owner, check
    except Exception as error:
        raise _authority_error(error) from None


def checked_call(check: Check, operation: Callable[[], _T]) -> _T:
    """Check before work and on every successful or failing exit."""
    check()
    try:
        result = operation()
    except Exception as error:
        check()
        if isinstance(error, HTTPException):
            error.headers = {**(error.headers or {}), **_NO_STORE}
            raise
        raise HTTPException(503, "Private information is unavailable.", headers=dict(_NO_STORE)) from None
    check()
    return result


def checked_json(check: Check, value: Any, *, status_code: int = 200) -> JSONResponse:
    """Encode while authority is retained; no private bytes escape on denial."""
    return checked_call(check, lambda: JSONResponse(value, status_code=status_code, headers=dict(_NO_STORE)))
