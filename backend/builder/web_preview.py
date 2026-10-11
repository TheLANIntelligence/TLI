"""Render saved app code behind an explicit, opaque-origin response sandbox.

An authenticated response URL is necessary: srcdoc inherits the main TLI page's
script policy and therefore cannot execute its nonce-tagged preview scripts.
The response sandbox also protects direct/top-level navigation to this URL.
"""
from __future__ import annotations

import json
import re
import secrets

from .web_apps import get_app, validate_bundle

_TOKEN = re.compile(r"tli[a-f0-9]{32}\Z")
_RUNNER = r"""(() => {
  const config = __CONFIG__; const errors = [];
  const send = result => parent.postMessage({tliAppPreview:config.token,...result}, '*');
  addEventListener('error', event => errors.push(String(event.message || 'Script error').slice(0, 300)));
  addEventListener('unhandledrejection', event => errors.push(String(event.reason || 'Unhandled rejection').slice(0, 300)));
  addEventListener('load', () => setTimeout(async () => {
    try {
      if (errors.length) throw Error(errors.join('; '));
      if (config.check) for (const step of config.check.steps) {
        const matches = document.querySelectorAll(step.selector), element = matches[0];
        if (step.action === 'count') { if (matches.length !== step.equals) throw Error(step.selector + ': expected count ' + step.equals + ', got ' + matches.length); continue; }
        if (!element) throw Error('Missing element: ' + step.selector);
        if (step.action === 'click') element.click();
        if (step.action === 'fill') { element.value = step.value; element.dispatchEvent(new Event('input', {bubbles:true})); element.dispatchEvent(new Event('change', {bubbles:true})); }
        if (step.action === 'text' && !element.textContent.includes(step.contains)) throw Error(step.selector + ': expected text ' + step.contains);
        if (step.action === 'value' && element.value !== step.equals) throw Error(step.selector + ': expected value ' + step.equals);
        await new Promise(resolve => setTimeout(resolve, 30));
        if (errors.length) throw Error(errors.join('; '));
      }
      send({passed:true});
    } catch (error) { send({passed:false,error:String(error.message || error).slice(0,500)}); }
  }, 100));
})();"""


def render_preview(app_id: str, *, owner: str, revision: int, token: str,
                   check_index: int | None = None) -> tuple[str, dict[str, str]]:
    if not _TOKEN.fullmatch(token):
        raise ValueError("Invalid preview correlation token.")
    project = get_app(app_id, owner=owner)
    revisions = project["revisions"]
    if type(revision) is not int or not 1 <= revision <= len(revisions):
        raise ValueError("Choose a saved app revision before previewing.")
    bundle = validate_bundle(revisions[revision - 1])
    if check_index is not None and (type(check_index) is not int or not 0 <= check_index < len(bundle["checks"])):
        raise ValueError("Unknown browser check.")
    nonce = secrets.token_hex(24)
    policy = (
        "sandbox allow-scripts; default-src 'none'; script-src 'nonce-" + nonce + "'; "
        "style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; "
        "media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
    )
    payload = json.dumps({"token": token, "check": bundle["checks"][check_index] if check_index is not None else None}, ensure_ascii=True).replace("<", "\\u003c")
    bootstrap = _RUNNER.replace("__CONFIG__", payload)
    css = re.sub(r"</style", r"<\\/style", bundle["files"]["style.css"], flags=re.I)
    scripts = "".join('<script nonce="' + nonce + '">' + re.sub(r"</script", r"<\\/script", text, flags=re.I) + '</script>'
                      for text in (bootstrap, bundle["files"]["app.js"]))
    content = '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>' + css + '</style></head><body>' + bundle["preview_html"] + scripts + '</body></html>'
    return content, {"Content-Security-Policy": policy, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                     "Referrer-Policy": "no-referrer", "Permissions-Policy": "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()"}
