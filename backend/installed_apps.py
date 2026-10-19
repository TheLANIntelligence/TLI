"""Private, opaque-origin rendering for installed single-file HTML apps.

Installed content is untrusted. Only the registered index.html is rendered; no
raw asset tree is exposed. The response sandbox applies to direct/top-level
navigation as well as an iframe, and the compatibility SDK grants no host APIs.
"""
from __future__ import annotations

import re
from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from browser_authority import browser_control_access

router = APIRouter(tags=["installed-apps"])
APP_HTML_LIMIT = 512 * 1024
APP_CSP = (
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; "
    "style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; "
    "media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
)
APP_HEADERS = {
    "Content-Security-Policy": APP_CSP,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), bluetooth=(), payment=(), display-capture=()",
    "Cross-Origin-Opener-Policy": "same-origin",
}
_SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
_DOCTYPE = re.compile(r"\A\s*<!doctype\s+html\s*>", re.I)
# Kept identical to the inert frontend SDK; tests detect drift. It is embedded
# here so a mutable runtime file cannot change the trusted compatibility shim.
BRIDGE_SOURCE = r"""// TLI App Bridge — isolated local-shell compatibility shim.
// The host injects this shim before package scripts. Package declarations do
// not grant authority. Saved bridge storage remains untouched and unavailable.
(function (global) {
  const permissions = Object.freeze([]);
  const unavailable = function () {
    return Promise.reject(new Error('Host-connected app features are unavailable. Package permissions are requests, not user grants.'));
  };
  global.TLIBridge = Object.freeze({
    available: false,
    ready: function (fn) {
      if (typeof fn !== 'function') return;
      const notify = function () { fn(permissions); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', notify, {once: true});
      else Promise.resolve().then(notify);
    },
    call: unavailable,
    notify: unavailable,
    getMeshDevices: unavailable,
    getSettings: unavailable,
    setBadge: unavailable,
    storage: unavailable,
  });
})(window);
"""


def app_snapshot(app_id: str, check: Callable[[], None]):
    # Import lazily: this module is a serving boundary, not a startup worker.
    from hub_store import app_snapshot as read_snapshot
    return read_snapshot(app_id, check)


def _error(status: int, detail: str) -> HTTPException:
    return HTTPException(status, detail, headers={"Cache-Control": "no-store"})


def render_document(raw: bytes) -> str:
    if not isinstance(raw, bytes) or len(raw) > APP_HTML_LIMIT:
        raise _error(503, "The installed app entry is unavailable or too large. Saved files were preserved.")
    try:
        source = raw.decode("utf-8-sig")
    except UnicodeError:
        raise _error(503, "The installed app entry is not readable UTF-8 HTML. Saved files were preserved.") from None
    # The shim precedes all package scripts. No package bytes are changed on disk.
    bootstrap = "<script>" + BRIDGE_SOURCE.replace("</script", "<\\/script") + "</script>"
    doctype = _DOCTYPE.match(source)
    offset = doctype.end() if doctype else 0
    return source[:offset] + bootstrap + source[offset:]


@router.api_route("/apps", methods=["GET", "HEAD"])
@router.api_route("/apps/{app_path:path}", methods=["GET", "HEAD"])
def installed_app(request: Request, app_path: str = "", check=Depends(browser_control_access)):
    check()
    try:
        parts = app_path.split("/")
        if len(parts) != 2 or parts[1] != "index.html":
            raise _error(404, "Only a registered app's index.html is available. Raw app files are private.")
        app_id = parts[0]
        if not _SAFE_ID.fullmatch(app_id) or app_id.endswith("."):
            raise _error(400, "Choose a valid installed app identifier.")
        record, manifest, raw = app_snapshot(app_id, check)
        check()
        # Do not trust an accidental broadening of a repository helper's contract.
        if (not isinstance(record, dict) or record.get("id") != app_id or record.get("type") != "app"
                or not isinstance(manifest, dict) or manifest.get("id") != app_id
                or manifest.get("entry") != "index.html"):
            raise _error(503, "The installed app registration does not match its entry. Saved files were preserved.")
        content = render_document(raw)
        check()
    except Exception as error:
        check()
        if isinstance(error, HTTPException):
            error.headers = {**(error.headers or {}), "Cache-Control": "no-store"}
            raise
        raise _error(503, "The installed app could not be read safely. Saved files were preserved.") from None
    request.state.tli_isolated_installed_app = True
    check()
    return Response(content, media_type="text/html", headers=APP_HEADERS)
