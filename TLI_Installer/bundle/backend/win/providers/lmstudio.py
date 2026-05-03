# backend/providers/lmstudio.py
ids = []

from typing import Any, Dict, List, Optional
from datetime import datetime
import time
import requests


class LMStudioProvider:
    """
    LM Studio / OpenAI-compatible provider.

    Contract used by backend/main.py:
      - health_check() -> bool
      - health_report() -> dict
      - list_models() -> list[dict]
      - complete(messages, model_id, temperature, max_tokens) -> dict
    """

    def __init__(
        self,
        chat_url: str,
        models_url: str,
        connect_timeout: float = 2.5,
        read_timeout: float = 120.0,
        debug_log=None,
        report_ttl_seconds: int = 15,
    ):
        self.chat_url = chat_url
        self.models_url = models_url
        self.connect_timeout = connect_timeout
        self.read_timeout = read_timeout
        self.debug_log = debug_log
        self.report_ttl_seconds = report_ttl_seconds

        self._report_cache = {"ts": 0.0, "report": None}

    # -----------------------------
    # internal logging helper
    # -----------------------------
    def _log(self, subsystem: str, level: str, message: str, **extra: Any) -> None:
        try:
            if callable(self.debug_log):
                self.debug_log(subsystem, level, message, **extra)
        except Exception:
            pass

    def _chat_probe(self, model_id: str) -> Dict[str, Any]:
        """
        Lightweight chat readiness probe (max_tokens=1).
        Keeps Brain OK truthful: models can be OK while chat is stalled.
        """
        payload: Dict[str, Any] = {
            "model": model_id,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
            "temperature": 0,
        }

        t0 = time.time()
        try:
            # Short timeout so UI never "hangs" on health checks
            r = requests.post(
                self.chat_url,
                json=payload,
                timeout=(self.connect_timeout, 8),
            )
            latency_ms = int((time.time() - t0) * 1000)

            if r.status_code != 200:
                return {"ok": False, "latency_ms": latency_ms, "error": f"HTTP {r.status_code}: {r.text[:200]}"}

            data = r.json() if r.content else {}
            # Validate OpenAI-ish structure exists (choices/message/content)
            choices = data.get("choices") or []
            if not (isinstance(choices, list) and choices):
                return {"ok": False, "latency_ms": latency_ms, "error": "No choices in response"}

            return {"ok": True, "latency_ms": latency_ms, "error": None}
        except Exception as e:
            latency_ms = int((time.time() - t0) * 1000)
            return {"ok": False, "latency_ms": latency_ms, "error": str(e)}

    # -----------------------------
    # health
    # -----------------------------
    def health_report(self) -> Dict[str, Any]:
        now = time.time()
        cached = self._report_cache.get("report")
        if cached and (now - float(self._report_cache.get("ts", 0.0)) < self.report_ttl_seconds):
            return cached

        report: Dict[str, Any] = {
    "ok": False,

    # chat readiness (added)
    "chat_ok": False,
    "chat_latency_ms": None,
    "chat_error": None,

    "server_url": self.models_url,
    "status_code": None,
    "latency_ms": None,
    "schema_ok": False,
    "schema": "openai_v1_models",
    "model_count": 0,
    "server_header": None,
    "error": None,
    "checked_at": datetime.utcnow().isoformat() + "Z",
}


        t0 = time.time()
        try:
            r = requests.get(self.models_url, timeout=(self.connect_timeout, 4))
            report["status_code"] = r.status_code
            report["server_header"] = r.headers.get("server") or r.headers.get("Server")
            report["latency_ms"] = int((time.time() - t0) * 1000)

            if r.status_code != 200:
                report["error"] = f"HTTP {r.status_code}"
            else:
                data = r.json() if r.content else {}
                arr = data.get("data")

                # Expect OpenAI: { "data": [ { "id": "...", ... }, ... ] }
                if isinstance(arr, list):
                    ids = []
                    for item in arr:
                        if isinstance(item, dict) and item.get("id"):
                            ids.append(item.get("id"))
                    report["model_count"] = len(ids)
                    report["schema_ok"] = True
                    report["ok"] = True
                else:
                    report["error"] = "Unexpected schema (missing 'data' list)"
        except Exception as e:
            report["error"] = str(e)

                    # Chat readiness probe (truth-test)
        if ids:
                        probe = self._chat_probe(ids[0])
                        report["chat_ok"] = bool(probe.get("ok"))
                        report["chat_latency_ms"] = probe.get("latency_ms")
                        report["chat_error"] = probe.get("error")
        else:
                        report["chat_ok"] = False
                        report["chat_latency_ms"] = None
                        report["chat_error"] = "No models available"

        # cache + log
        self._report_cache["ts"] = now
        self._report_cache["report"] = report

        self._log(
            "lmstudio",
            "INFO" if report["ok"] else "WARN",
            "LM Studio compatibility check",
            ok=report["ok"],
            status_code=report["status_code"],
            schema_ok=report["schema_ok"],
            model_count=report["model_count"],
            latency_ms=report["latency_ms"],
            error=report["error"],
        )

        return report

    def health_check(self) -> bool:
        rep = self.health_report()
        # Brain OK only when: models endpoint OK + chat probe OK
        return bool(rep.get("ok")) and bool(rep.get("chat_ok"))


    # -----------------------------
    # models
    # -----------------------------
    def list_models(self) -> List[Dict[str, str]]:
        """
        Returns provider-normalized list:
          [ {"id": "...", "label": "..."}, ... ]
        """
        r = requests.get(self.models_url, timeout=(self.connect_timeout, 10))
        if r.status_code != 200:
            raise RuntimeError(f"LM Studio models endpoint returned HTTP {r.status_code}")

        data = r.json() if r.content else {}
        arr = data.get("data")
        if not isinstance(arr, list):
            raise RuntimeError("LM Studio models endpoint returned unexpected schema")

        out: List[Dict[str, str]] = []
        for item in arr:
            if not isinstance(item, dict):
                continue
            mid = item.get("id")
            if not mid:
                continue
            out.append({"id": str(mid), "label": str(mid)})

        return out
    
        if not model_id:
            models = self.list_models()
            if not models:
                raise RuntimeError("No models found in LM Studio. Load/download a model and start the server.")
            model_id = models[0]["id"]

    # -----------------------------
    # completion
    # -----------------------------
    def complete(
        self,
        messages: List[Dict[str, str]],
        model_id: str,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Returns provider-normalized response:
          {
            "text": "...",
            "model": "...",
            "raw": <full json>
          }
        """
        payload: Dict[str, Any] = {
            "model": model_id,
            "messages": messages,
        }
        if temperature is not None:
            payload["temperature"] = float(temperature)
        if max_tokens is not None:
            payload["max_tokens"] = int(max_tokens)

        r = requests.post(
            self.chat_url,
            json=payload,
            timeout=(self.connect_timeout, self.read_timeout),
        )

        if r.status_code != 200:
            raise RuntimeError(f"LM Studio chat returned HTTP {r.status_code}: {r.text}")

        data = r.json() if r.content else {}

        # Try OpenAI shape: choices[0].message.content
        text = ""
        try:
            choices = data.get("choices") or []
            if choices and isinstance(choices, list):
                msg = choices[0].get("message") if isinstance(choices[0], dict) else None
                if isinstance(msg, dict):
                    text = msg.get("content") or ""
        except Exception:
            text = ""

        return {
            "text": str(text or ""),
            "model": data.get("model") or model_id,
            "raw": data,
        }
