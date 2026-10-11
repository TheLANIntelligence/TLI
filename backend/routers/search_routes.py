# backend/routers/search_routes.py
# SearXNG proxy — browser calls /search/query, backend proxies to SearXNG.
# Eliminates CORS dependency on the SearXNG instance.
from __future__ import annotations

import time
from typing import List
from urllib.parse import urlparse

import requests
from fastapi import APIRouter, HTTPException, Query

import tli_state as S

router = APIRouter(tags=["search"])


def _validate_endpoint(endpoint: str) -> str:
    """Raise 400 if endpoint is not a plain http/https URL."""
    try:
        p = urlparse(endpoint)
        if p.scheme not in ("http", "https") or not p.netloc:
            raise ValueError
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid search endpoint URL")
    return endpoint.rstrip("/")


@router.get("/search/query")
def proxy_search(
    q: str = Query(..., min_length=1, max_length=500),
    k: int = Query(default=5, ge=1, le=10),
    endpoint: str = Query(default="http://localhost:8080"),
):
    """
    Proxy a search query to a SearXNG instance.
    Returns { results: [{title, url, snippet}], ms, endpoint }.
    """
    base = _validate_endpoint(endpoint)
    url = f"{base}/search"
    params = {
        "q": q,
        "format": "json",
        "language": "en-US",
        "safesearch": "1",
    }

    t0 = time.monotonic()
    try:
        resp = requests.get(
            url,
            params=params,
            timeout=(3.0, 8.0),   # connect, read
            headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.Timeout:
        raise HTTPException(status_code=504, detail="SearXNG timed out")
    except requests.ConnectionError:
        raise HTTPException(status_code=502, detail="SearXNG unreachable")
    except Exception as exc:
        S.log_debug("search", "ERROR", "SearXNG proxy failed", error=str(exc))
        raise HTTPException(status_code=502, detail=f"SearXNG error: {exc}")

    ms = int((time.monotonic() - t0) * 1000)

    raw = data.get("results", []) if isinstance(data, dict) else []
    seen: set = set()
    results = []
    for r in raw:
        link = r.get("url") or r.get("href") or ""
        if not link or link in seen:
            continue
        seen.add(link)
        results.append({
            "title":   r.get("title") or link,
            "url":     link,
            "snippet": r.get("content") or r.get("snippet") or "",
        })
        if len(results) >= k:
            break

    return {"results": results, "ms": ms, "endpoint": base}
