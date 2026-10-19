"""Bounded JSON transport for explicit model observations, never chat fallback.

The elapsed budget is cooperative: an already-blocking DNS/socket operation can
finish after it. Callers must carry their captured authority into every probe.
"""
from __future__ import annotations

import json
import time

import requests

MAX_RESPONSE_BYTES = 1024 * 1024


class ModelProbeError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__({
            "timed_out": "Model observation timed out.",
            "unavailable": "Model observation is unavailable.",
            "redirected": "Model endpoint redirected. Configure its final address explicitly.",
            "too_large": "Model observation exceeded its size limit.",
            "invalid_response": "Model endpoint returned an invalid response.",
        }.get(code, "Model observation is unavailable."))


def probe_json(url, *, check=None, payload=None, timeout=(2.5, 4), budget_seconds=12):
    """Return status/data/header/latency without implicit host credentials.

    Non-200 bodies are not read. Redirects are refused, and successful JSON is
    bounded before decoding. Only an explicit payload selects a POST probe.
    Captured-check failures retain their original identity through all cleanup.
    """
    started = time.monotonic()
    authority_error = None

    def access():
        nonlocal authority_error
        if check is not None:
            try:
                check()
            except Exception as error:
                authority_error = error
                raise

    def checkpoint():
        access()
        if time.monotonic() - started >= budget_seconds:
            raise ModelProbeError("timed_out")

    try:
        checkpoint()
        with requests.Session() as session:
            session.trust_env = False
            checkpoint()
            options = {"timeout": timeout, "stream": True, "allow_redirects": False,
                       "headers": {"Accept": "application/json"}}
            response = (session.get(url, **options) if payload is None else
                        session.post(url, json=payload, **options))
            try:
                checkpoint()
                status = response.status_code
                if 300 <= status < 400:
                    raise ModelProbeError("redirected")
                server = response.headers.get("server") or response.headers.get("Server")
                server = server[:512] if isinstance(server, str) else None
                if server is not None:
                    server.encode("utf-8")
                data = None
                if status == 200:
                    body = bytearray()
                    for chunk in response.iter_content(chunk_size=64 * 1024):
                        checkpoint()
                        if chunk:
                            if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                                raise ModelProbeError("too_large")
                            body.extend(chunk)
                        checkpoint()
                    checkpoint()
                    data = json.loads(body) if body else {}
                    checkpoint()
                result = {"status_code": status, "data": data,
                          "server_header": server,
                          "latency_ms": int((time.monotonic() - started) * 1000)}
            finally:
                response.close()
        checkpoint()
        return result
    except Exception as error:
        # A cleanup error must never replace a captured authority failure.
        if authority_error is not None:
            raise authority_error
        access()
        if isinstance(error, ModelProbeError):
            raise
        if isinstance(error, requests.Timeout):
            raise ModelProbeError("timed_out") from None
        if isinstance(error, (ValueError, UnicodeError, RecursionError)):
            raise ModelProbeError("invalid_response") from None
        raise ModelProbeError("unavailable") from None
