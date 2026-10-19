"""Bounded task research. Public fetches pin a validated public DNS answer."""
from __future__ import annotations

import http.client
import ipaddress
import json
import os
import socket
import ssl
import threading
import time
from html.parser import HTMLParser
from urllib.parse import urlsplit, urlencode
from fastapi import HTTPException


class Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, text):
        if not self.hidden and text.strip():
            self.parts.append(text.strip())


def retrieve(url, check, *, public=True):
    check()
    parsed = urlsplit(url)
    if (parsed.scheme not in (("https",) if public else ("http", "https")) or not parsed.hostname
            or parsed.username or parsed.password or parsed.fragment or len(url) > 4096):
        raise HTTPException(422, "Use a public HTTPS page without credentials or a fragment.")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
        if not addresses or public and any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            raise ValueError("Nonpublic destination")
        address = addresses[0][4][0]
        connection = http.client.HTTPConnection(parsed.hostname, port, timeout=8)
        connection.sock = socket.create_connection((address, port), timeout=8)
        if parsed.scheme == "https":
            connection.sock = ssl.create_default_context().wrap_socket(connection.sock, server_hostname=parsed.hostname)
        started = time.monotonic()
        def deadline():
            try:
                connection.sock.shutdown(socket.SHUT_RDWR)
            except (AttributeError, OSError):
                pass
        timer = threading.Timer(20, deadline)
        timer.daemon = True
        timer.start()
        try:
            check()
            connection.request("GET", (parsed.path or "/") + ("?" + parsed.query if parsed.query else ""),
                               headers={"Accept": "text/html,text/plain,application/json", "User-Agent": "TLI-Research/1"})
            response = connection.getresponse()
            if response.status != 200:
                raise HTTPException(502, f"Source returned HTTP {response.status}; redirects are not followed.")
            kind = response.getheader("Content-Type", "").split(";")[0].lower()
            if kind not in {"text/html", "text/plain", "application/json", "application/xhtml+xml"}:
                raise HTTPException(422, "This source is not a supported text page.")
            data = bytearray()
            while True:
                check()
                if time.monotonic() - started > 20:
                    raise HTTPException(504, "Source exceeded the research deadline.")
                block = response.read1(16384)
                if not block:
                    break
                data.extend(block)
                if len(data) > 512 * 1024:
                    raise HTTPException(413, "Source exceeded the research size limit.")
            check()
            return data.decode("utf-8", errors="replace"), kind
        finally:
            timer.cancel()
            connection.close()
    except (OSError, ValueError, http.client.HTTPException) as exc:
        raise HTTPException(502, "Could not retrieve the selected research source.") from exc


def fetch(url, check):
    text, kind = retrieve(url, check)
    if "html" in kind:
        parser = Text()
        parser.feed(text)
        text = "\n".join(parser.parts)
    return {"url": url, "text": text[:16000], "truncated": len(text) > 16000, "source_kind": "untrusted_public_page"}


def search(query, check):
    endpoint = os.environ.get("TLI_TASK_SEARXNG_URL", "").strip().rstrip("/")
    if not endpoint:
        raise HTTPException(409, "Configure TLI_TASK_SEARXNG_URL on the host to enable local-model web research.")
    if not query.strip() or len(query) > 500:
        raise HTTPException(422, "Use a research query of 1–500 characters.")
    text, _ = retrieve(endpoint + "/search?" + urlencode({"q": query, "format": "json", "safesearch": "1"}), check, public=False)
    try:
        rows = json.loads(text).get("results", [])
        return {"results": [{"title": str(r.get("title", ""))[:300], "url": str(r.get("url", ""))[:4096],
                             "snippet": str(r.get("content", ""))[:2000]} for r in rows[:8] if isinstance(r, dict)]}
    except (ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(502, "The configured search service returned an invalid result.") from exc
