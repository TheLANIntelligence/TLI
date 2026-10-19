"""Browser-authorized SearXNG proxy for an explicitly configured destination."""
from __future__ import annotations

import json
import time
from urllib.parse import urlsplit

import requests
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from browser_authority import browser_control_access

MAX_RESPONSE_BYTES = 1024 * 1024
MAX_RESULT_ROWS = 1000
MAX_ELAPSED_SECONDS = 12.0
_now = time.monotonic


class _SearchRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def private_response(request):
            try:
                response = await handler(request)
            except RequestValidationError:
                # Validation must not echo private queries or endpoint input.
                return JSONResponse({"detail": "Provide a valid search query, result count and endpoint."},
                                    status_code=422, headers={"Cache-Control": "no-store"})
            except HTTPException as error:
                error.headers = {**(error.headers or {}), "Cache-Control": "no-store"}
                raise
            response.headers["Cache-Control"] = "no-store"
            return response
        return private_response


router = APIRouter(tags=["search"], route_class=_SearchRoute)


def _http_url(value: str, *, base: bool) -> bool:
    try:
        if (not isinstance(value, str) or not value or len(value) > (2048 if base else 8192)
                or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value)
                or "\\" in value):
            return False
        value.encode("utf-8")
        parsed = urlsplit(value)
        return bool(parsed.scheme in ("http", "https") and parsed.hostname
                    and parsed.username is None and parsed.password is None
                    and (parsed.port is None or 1 <= parsed.port <= 65535)
                    and (not base or not parsed.query and not parsed.fragment and "?" not in value and "#" not in value))
    except (ValueError, UnicodeError):
        return False


def _validate_endpoint(endpoint: str) -> str:
    """Retain explicit HTTP(S) host/path endpoints, including local SearXNG."""
    if not _http_url(endpoint, base=True):
        raise HTTPException(400, "Invalid search endpoint URL")
    return endpoint.rstrip("/")


def _results(data, count, check):
    if not isinstance(data, dict) or not isinstance(data.get("results", []), list):
        raise HTTPException(502, "SearXNG returned an invalid search response")
    raw = data.get("results", [])
    if len(raw) > MAX_RESULT_ROWS:
        raise HTTPException(502, "SearXNG returned too many search results")
    seen, results = set(), []
    for row in raw:
        check()
        if not isinstance(row, dict):
            continue
        link = row.get("url") or row.get("href") or ""
        if not _http_url(link, base=False) or link in seen:
            continue
        seen.add(link)
        title = row.get("title")
        snippet = row.get("content") or row.get("snippet") or ""
        if isinstance(title, str):
            title.encode("utf-8")
        if isinstance(snippet, str):
            snippet.encode("utf-8")
        results.append({"title": title[:2000] if isinstance(title, str) and title else link,
                        "url": link, "snippet": snippet[:20000] if isinstance(snippet, str) else ""})
        if len(results) >= count:
            break
    check()
    return results


@router.get("/search/query")
def proxy_search(
    q: str = Query(..., min_length=1, max_length=500),
    k: int = Query(default=5, ge=1, le=10),
    endpoint: str = Query(default="http://localhost:8080", max_length=2048),
    check=Depends(browser_control_access),
):
    """Return {results: [{title, url, snippet}], ms, endpoint} without caching."""
    started = _now()
    authorize = check
    def check():
        authorize()
        elapsed = _now() - started
        authorize()
        # Cooperative budget: a blocking DNS/socket read can finish later.
        # Cancellation or a hard wall-clock deadline is not provided here.
        if elapsed > MAX_ELAPSED_SECONDS:
            raise HTTPException(504, "SearXNG timed out")
    try:
        check()
        base = _validate_endpoint(endpoint)
        params = {"q": q, "format": "json", "language": "en-US", "safesearch": "1"}
        check()
        # Do not borrow host .netrc credentials, proxy settings, browser cookies
        # or auth headers for this user-selected search destination.
        with requests.Session() as session:
            session.trust_env = False
            check()
            response = session.get(base + "/search", params=params, timeout=(3.0, 8.0),
                                   headers={"Accept": "application/json"}, stream=True, allow_redirects=False)
            try:
                check()
                if 300 <= response.status_code < 400:
                    raise HTTPException(502, "SearXNG redirected the request. Configure its final endpoint explicitly.")
                response.raise_for_status()
                check()
                body = bytearray()
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    check()
                    if chunk:
                        if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                            raise HTTPException(502, "SearXNG response exceeded the size limit")
                        body.extend(chunk)
                    check()
                check()
                data = json.loads(body)
                check()
            finally:
                response.close()
        check()
        results = _results(data, k, check)
        result = {"results": results, "ms": int((_now() - started) * 1000), "endpoint": base}
        check()
        return result
    except requests.Timeout:
        check()
        raise HTTPException(504, "SearXNG timed out") from None
    except requests.ConnectionError:
        check()
        raise HTTPException(502, "SearXNG unreachable") from None
    except HTTPException:
        check()
        raise
    except Exception:
        check()
        # Upstream exceptions often include the query URL or credentials.
        raise HTTPException(502, "SearXNG returned an unavailable or invalid response") from None
