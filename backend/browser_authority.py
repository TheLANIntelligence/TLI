"""Browser authority for private host operations and observations.

Open-local access is limited to a direct loopback connection and loopback Host.
Remote access requires HTTPS and an unlocked PIN browser. Companion/peer tokens
do not confer host-script, listener, peripheral or private-observation authority.
"""
from __future__ import annotations

import ipaddress
from collections.abc import Callable
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, Response

import tli_state as S
from companion_auth import operation_access


def _is_loopback(value: str | None) -> bool:
    try:
        return ipaddress.ip_address(value).is_loopback
    except (ValueError, TypeError):
        return False


def direct_request_address(request: Request):
    """Validate the original Host before framework URL normalization/fallback."""
    try:
        hosts = request.headers.getlist("host")
        if len(hosts) != 1:
            raise ValueError()
        host = hosts[0]
        scheme = request.scope.get("scheme", "http")
        if (not host or len(host) > 1024 or host.endswith(":")
                or scheme not in ("http", "https")
                or any(char.isspace() or ord(char) < 32 or ord(char) == 127 or char in "/\\?#@," for char in host)):
            raise ValueError()
        address = urlsplit(scheme + "://" + host)
        if (not address.hostname or address.username or address.password
                or address.port is not None and not 1 <= address.port <= 65535):
            raise ValueError()
    except ValueError:
        raise HTTPException(403, "Use the TLI address with one valid Host header.",
                            headers={"Cache-Control": "no-store"}) from None
    return address


def browser_request_local(request: Request, response: Response) -> bool:
    """Check direct browser transport/origin, including before PIN login."""
    response.headers["Cache-Control"] = "no-store"
    if request.headers.getlist("authorization") or any(
        key.startswith("x-tli-peer-") for key in request.headers
    ):
        raise HTTPException(403, "Use the TLI browser for these private host operations; device credentials cannot authorize them.")
    if any(key == "forwarded" or key.startswith("x-forwarded-") for key in request.headers):
        raise HTTPException(403, "Use a direct TLI connection; proxy access to these controls is unsupported.")

    address = direct_request_address(request)

    origins = request.headers.getlist("origin")
    expected = str(request.base_url).rstrip("/")
    mutation = request.method not in ("GET", "HEAD", "OPTIONS")
    if (len(origins) > 1 or origins and origins != [expected]
            or mutation and origins != [expected]
            or request.headers.get("sec-fetch-site") not in (None, "same-origin", "none")):
        raise HTTPException(403, "Use this TLI page to access private host information and controls.")

    local = bool(request.client and _is_loopback(request.client.host)) and (
        address.hostname == "localhost" or _is_loopback(address.hostname)
    )
    if address.scheme != "https" and not local:
        raise HTTPException(403, "Use HTTPS and unlock TLI, or open TLI at localhost on its host.")

    return local


def browser_control_access(request: Request, response: Response) -> Callable[[], None]:
    """Admit a browser and return a check to repeat before effects/disclosure."""
    revocation_epoch = S.session_revocation_epoch()
    local = browser_request_local(request, response)

    pin_enabled = S.load_pin_config()["enabled"]
    token = request.cookies.get("tli_session")
    # Never turn an explicitly expired/revoked browser into open-local access.
    if token is not None and not S.validate_session_token(token):
        raise HTTPException(401, "This TLI session expired or was revoked. Unlock TLI again; if the PIN is off, clear this site's cookies or use a new private window on localhost.")
    if pin_enabled and not token:
        raise HTTPException(401, "Unlock TLI with its PIN before using these controls.")
    if not pin_enabled and not local:
        raise HTTPException(403, "Set and unlock a PIN for remote access, or open TLI at localhost on its host.")

    owner = S.get_session_user_id(token) if token else "local"
    bound_check = operation_access(request, owner)

    def check_epoch():
        # Open-local requests have no cookie. A PIN off/on/off cycle must still
        # revoke their captured authority even when the final mode is unchanged.
        if S.session_revocation_epoch() is not revocation_epoch:
            raise HTTPException(401, "Browser access was revoked or PIN protection changed. Reopen TLI and try again.")

    def check() -> None:
        check_epoch()
        if S.load_pin_config()["enabled"] != pin_enabled:
            raise HTTPException(401, "PIN protection changed during this request. Reopen TLI and try again.")
        # operation_access supports deliberate open-local fallback at admission.
        # These controls must instead retain the exact cookie captured above,
        # including if it is revoked while operation_access is being constructed.
        if token is not None and (
            not S.validate_session_token(token) or S.get_session_user_id(token) != owner
        ):
            raise HTTPException(401, "The original browser session expired or was revoked. Remaining steps were not run.")
        bound_check()
        if token is not None and not S.validate_session_token(token):
            raise HTTPException(401, "The original browser session expired or was revoked. Remaining steps were not run.")
        check_epoch()

    check()
    return check
