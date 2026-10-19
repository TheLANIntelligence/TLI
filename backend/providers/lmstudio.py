# backend/providers/lmstudio.py

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

    @staticmethod
    def _checked_model_ids(rows, check, *, allow_name=False):
        """Bound the schema consumed by private health and setup observations."""
        from model_probe import ModelProbeError
        check()
        if not isinstance(rows, list) or len(rows) > 1000:
            raise ModelProbeError("invalid_response")
        ids = []
        for item in rows:
            check()
            if not isinstance(item, dict):
                raise ModelProbeError("invalid_response")
            value = item.get("id") or (item.get("name") if allow_name else None)
            if value is None or value == "":
                continue
            if not isinstance(value, str) or len(value) > 1024:
                raise ModelProbeError("invalid_response")
            try:
                value.encode("utf-8")
            except UnicodeError:
                raise ModelProbeError("invalid_response") from None
            ids.append(value)
        check()
        return ids

    def _chat_probe(self, model_id: str, *, check=None) -> Dict[str, Any]:
        """
        Lightweight chat readiness probe (max_tokens=1).
        Keeps Brain OK truthful: models can be listed while chat is stalled.
        """
        payload: Dict[str, Any] = {
            "model": model_id,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
            "temperature": 0,
        }

        if check is not None:
            from model_probe import ModelProbeError, probe_json
            check()
            try:
                result = probe_json(self.chat_url, check=check, payload=payload,
                                    timeout=(self.connect_timeout, 8))
            except ModelProbeError as error:
                check()
                return {"ok": False, "latency_ms": None, "error": str(error)}
            check()
            status = result["status_code"]
            data = result["data"]
            choices = data.get("choices") if isinstance(data, dict) else None
            ok = status == 200 and isinstance(choices, list) and 0 < len(choices) <= 1000
            response = {"ok": ok, "latency_ms": result["latency_ms"],
                        "error": None if ok else f"HTTP {status}" if status != 200 else "No choices in response"}
            check()
            return response

        t0 = time.time()
        try:
            r = requests.post(
                self.chat_url,
                json=payload,
                timeout=(self.connect_timeout, 8),
            )
            latency_ms = int((time.time() - t0) * 1000)

            if r.status_code != 200:
                return {
                    "ok": False,
                    "latency_ms": latency_ms,
                    "error": f"HTTP {r.status_code}: {r.text[:200]}",
                }

            data = r.json() if r.content else {}
            choices = data.get("choices") or []
            if not (isinstance(choices, list) and choices):
                return {
                    "ok": False,
                    "latency_ms": latency_ms,
                    "error": "No choices in response",
                }

            return {"ok": True, "latency_ms": latency_ms, "error": None}

        except Exception as e:
            latency_ms = int((time.time() - t0) * 1000)
            return {"ok": False, "latency_ms": latency_ms, "error": str(e)}

    # -----------------------------
    # health
    # -----------------------------
    def health_report(self, *, check=None) -> Dict[str, Any]:
        if check is not None:
            check()
        now = time.time()
        cache_entry = self._report_cache
        cached = cache_entry.get("report")
        if (cached and (check is None or cache_entry.get("checked") is True)
                and now - float(cache_entry.get("ts", 0.0)) < self.report_ttl_seconds):
            if check is not None:
                check()
            return cached

        report: Dict[str, Any] = {
            "ok": False,
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

        # FIX: ids is always initialized here so it's never unbound
        ids: List[str] = []

        t0 = time.time()
        if check is not None:
            from model_probe import ModelProbeError, probe_json
            try:
                result = probe_json(self.models_url, check=check,
                                    timeout=(self.connect_timeout, 4))
                check()
                report["status_code"] = result["status_code"]
                report["server_header"] = result["server_header"]
                report["latency_ms"] = result["latency_ms"]
                if result["status_code"] != 200:
                    report["error"] = f"HTTP {result['status_code']}"
                else:
                    data = result["data"]
                    rows = data.get("data") if isinstance(data, dict) else None
                    ids = self._checked_model_ids(rows, check)
                    report["model_count"] = len(ids)
                    report["schema_ok"] = True
                    report["ok"] = True
            except ModelProbeError as error:
                check()
                report["error"] = str(error)
        else:
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

                    if isinstance(arr, list):
                        for item in arr:
                            if isinstance(item, dict) and item.get("id"):
                                ids.append(item["id"])
                        report["model_count"] = len(ids)
                        report["schema_ok"] = True
                        report["ok"] = True
                    else:
                        report["error"] = "Unexpected schema (missing 'data' list)"

            except Exception as e:
                report["latency_ms"] = int((time.time() - t0) * 1000)
                report["error"] = str(e)

        # FIX: chat probe is now properly inside health_report
        # ids is always a list — either populated above or empty
        if ids:
            if check is not None:
                check()
            probe = self._chat_probe(ids[0], check=check) if check is not None else self._chat_probe(ids[0])
            report["chat_ok"] = bool(probe.get("ok"))
            report["chat_latency_ms"] = probe.get("latency_ms")
            report["chat_error"] = probe.get("error")
        else:
            report["chat_ok"] = False
            report["chat_latency_ms"] = None
            report["chat_error"] = "No models available or LM Studio not running"

        # Keep the legacy cache contract; checked observations publish only
        # after all slow logging and authority checks have completed.
        if check is None:
            self._report_cache = {"ts": now, "report": report}

        if check is not None:
            check()
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

        if check is not None:
            check()
            previous = self._report_cache
            published = {"ts": now, "report": report, "checked": True}
            self._report_cache = published
            try:
                check()
            except Exception:
                if self._report_cache is published:
                    self._report_cache = previous
                raise
        return report

    def health_check(self, *, check=None) -> bool:
        rep = self.health_report(check=check) if check is not None else self.health_report()
        result = bool(rep.get("ok")) and bool(rep.get("chat_ok"))
        if check is not None:
            check()
        return result

    # -----------------------------
    # models
    # -----------------------------
    def list_models(self, *, check=None) -> List[Dict[str, str]]:
        """
        Returns provider-normalized list:
          [ {"id": "...", "label": "..."}, ... ]
        """
        if check is not None:
            from model_probe import ModelProbeError, probe_json
            check()
            result = probe_json(self.models_url, check=check,
                                timeout=(self.connect_timeout, 10))
            check()
            if result["status_code"] != 200:
                raise ModelProbeError("unavailable")
            data = result["data"]
            ids = self._checked_model_ids(data.get("data") if isinstance(data, dict) else None, check)
            out = [{"id": value, "label": value} for value in ids]
            check()
            return out
        r = requests.get(self.models_url, timeout=(self.connect_timeout, 10))
        if r.status_code != 200:
            raise RuntimeError(
                f"LM Studio models endpoint returned HTTP {r.status_code}"
            )

        data = r.json() if r.content else {}
        arr = data.get("data")
        if not isinstance(arr, list):
            raise RuntimeError(
                "LM Studio models endpoint returned unexpected schema"
            )

        out: List[Dict[str, str]] = []
        for item in arr:
            if not isinstance(item, dict):
                continue
            mid = item.get("id")
            if not mid:
                continue
            out.append({"id": str(mid), "label": str(mid)})

        return out

    # -----------------------------
    # completion
    # -----------------------------
    def text_capacity(self, model_id=None):
        """The current OpenAI-compatible adapter has no verified capacity API.

        Listed models and chat health do not identify a loaded context size.
        Keep discovery side-effect free instead of calling the readiness probe.
        """
        return {"status": "unknown", "context_tokens": None,
                "source": "unavailable", "model": model_id}

    def complete(
        self,
        messages: List[Dict[str, str]],
        model_id: str,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        *,
        allow_redirects: bool = True,
        enforce_text_budget: bool = False,
    ) -> Dict[str, Any]:
        """
        Returns provider-normalized response:
          {
            "text": "...",
            "model": "...",
            "raw": <full json>
          }
        """
        budget_receipt = None
        if enforce_text_budget:
            from intelligence.input_budget import for_provider, DEFAULT_OUTPUT_TOKENS
            if max_tokens is None:
                max_tokens = DEFAULT_OUTPUT_TOKENS
            # Chat opts in; Builder and other provider consumers keep their
            # existing input limits and provider-selected response length.
            for_provider("lmstudio", provider=self, model_id=model_id, max_tokens=max_tokens).validate(messages)
        # If no model_id provided, pick the first available
        if not model_id:
            models = self.list_models()
            if not models:
                raise RuntimeError(
                    "No models found in LM Studio. Load a model and start the server."
                )
            model_id = models[0]["id"]
        if enforce_text_budget:
            budget_receipt = for_provider("lmstudio", provider=self, model_id=model_id, max_tokens=max_tokens).validate(messages)

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
            **({"allow_redirects": False} if not allow_redirects else {}),
        )

        if r.status_code != 200:
            raise RuntimeError(
                f"LM Studio chat returned HTTP {r.status_code}: {r.text}"
            )

        data = r.json() if r.content else {}

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
            **({"input_budget": budget_receipt} if budget_receipt is not None else {}),
        }
