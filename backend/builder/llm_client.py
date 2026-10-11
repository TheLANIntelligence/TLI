from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import tli_state as S


PROMPTS_DIR = Path(__file__).parent / "prompts"


class ModelOffline(RuntimeError):
    """Raised when no local model backend is reachable."""


class ModelInvalid(RuntimeError):
    """Raised when the model returned output that could not be parsed into the patch schema."""

    def __init__(self, message: str, raw_text: str = "") -> None:
        super().__init__(message)
        self.raw_text = raw_text


def load_patch_system_prompt() -> str:
    path = PROMPTS_DIR / "patch.txt"
    return path.read_text(encoding="utf-8")


def lm_studio_model_id() -> str:
    cfg = getattr(S, "MODEL_CONFIG", {}) or {}
    key = getattr(S, "DEFAULT_MODEL_KEY", "") or ""
    entry = cfg.get(key) if isinstance(cfg, dict) else None
    if isinstance(entry, dict):
        model_id = entry.get("id") or ""
        if model_id:
            return str(model_id)
    return ""


def _bundled_manager() -> Any | None:
    """Return the bundled llama.cpp manager when the runtime/model are present.

    Importing ai_manager has side effects (Windows job object, atexit), so we
    do it lazily and swallow failures — Builder must still work when the
    bundled stack isn't installed.
    """
    try:
        from ai.ai_manager import BundledAIManager
    except Exception:
        return None
    try:
        mgr = BundledAIManager.get()
    except Exception:
        return None
    return mgr


def _bundled_call(mgr: Any, messages: list[dict[str, str]], temperature: float, max_tokens: int) -> str:
    if not mgr.is_healthy():
        try:
            mgr.ensure_running()
        except Exception as exc:
            raise ModelOffline(f"Bundled AI runtime failed to start: {exc}") from exc
        if not mgr.is_healthy():
            raise ModelOffline("Bundled AI runtime is not healthy.")

    payload = {
        "messages": messages,
        "temperature": float(temperature),
        "max_tokens": int(max_tokens),
        "stream": False,
    }
    url = mgr.base_url.rstrip("/") + "/v1/chat/completions"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with mgr.generation(), urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        raise ModelOffline(f"Bundled AI HTTP {exc.code}: {detail}") from exc
    except Exception as exc:
        raise ModelOffline(f"Bundled AI request failed: {exc}") from exc

    text = ""
    choices = data.get("choices") if isinstance(data, dict) else None
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            msg = first.get("message")
            if isinstance(msg, dict):
                text = msg.get("content") or ""
    return str(text or "").strip()


def _lmstudio_call(messages: list[dict[str, str]], temperature: float, max_tokens: int) -> str:
    provider = getattr(S, "lm_provider", None)
    if provider is None:
        raise ModelOffline("No local AI backend available (bundled runtime and LM Studio are both offline).")
    try:
        if not provider.health_check():
            raise ModelOffline("LM Studio is not reachable or no model is loaded.")
    except ModelOffline:
        raise
    except Exception as exc:
        raise ModelOffline(f"LM Studio health check failed: {exc}") from exc

    try:
        result = provider.complete(
            messages=messages,
            model_id=lm_studio_model_id(),
            temperature=temperature,
            max_tokens=max_tokens,
        )
    except Exception as exc:
        raise ModelOffline(f"LM Studio completion failed: {exc}") from exc
    text = result.get("text") if isinstance(result, dict) else None
    return str(text or "").strip()


def _chat(messages: list[dict[str, str]], temperature: float, max_tokens: int) -> tuple[str, str]:
    """Call the preferred local backend (bundled Qwen first, LM Studio fallback).

    Returns (text, backend) where backend is "bundled" or "lmstudio".
    """
    mgr = _bundled_manager()
    bundled_error: Exception | None = None
    if mgr is not None:
        try:
            return _bundled_call(mgr, messages, temperature, max_tokens), "bundled"
        except ModelOffline as exc:
            bundled_error = exc

    try:
        return _lmstudio_call(messages, temperature, max_tokens), "lmstudio"
    except ModelOffline as exc:
        if bundled_error is not None:
            raise ModelOffline(f"Bundled AI: {bundled_error}. LM Studio: {exc}") from exc
        raise


def complete_patch_json(user_prompt: str, max_tokens: int = 2048, temperature: float = 0.1) -> dict[str, Any]:
    """Call the local model and return a parsed patch object: {"summary": str, "edits": [...], "backend": str}.

    Raises ModelOffline when no backend is reachable, ModelInvalid when the model output
    cannot be parsed after one repair attempt.
    """
    system_prompt = load_patch_system_prompt()
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    raw_text, backend = _chat(messages, temperature, max_tokens)
    parsed, parse_error = _try_parse_patch(raw_text)
    if parsed is not None:
        parsed["backend"] = backend
        return parsed

    repair_messages = messages + [
        {"role": "assistant", "content": raw_text},
        {
            "role": "user",
            "content": (
                "Your previous reply was not valid JSON matching the required schema. "
                f"Parser error: {parse_error}. "
                "Re-emit only the JSON object with keys `summary` and `edits`. "
                "No prose, no markdown, no code fences."
            ),
        },
    ]
    retry_text, backend = _chat(repair_messages, temperature, max_tokens)
    parsed, parse_error = _try_parse_patch(retry_text)
    if parsed is not None:
        parsed["backend"] = backend
        return parsed
    raise ModelInvalid(parse_error or "Model output did not match patch schema.", raw_text=retry_text or raw_text)


def complete_chat(
    user_prompt: str,
    project_context: str = "",
    max_tokens: int = 700,
    temperature: float = 0.35,
) -> dict[str, Any]:
    system_prompt = (
        "You are TLI Builder, a local coding workspace assistant. "
        "Answer like a helpful installed coding model. "
        "Do not claim you changed files. If the user wants edits, say they can use Code change. "
        "Keep answers concise and practical."
    )
    content = user_prompt.strip()
    if project_context.strip():
      content = project_context.strip() + "\n\nUser message:\n" + content
    text, backend = _chat(
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content},
        ],
        temperature,
        max_tokens,
    )
    return {"text": text, "backend": backend}


_JSON_OBJECT_RE = re.compile(r"\{[\s\S]+\}")
_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def _try_parse_patch(text: str) -> tuple[dict[str, Any] | None, str]:
    if not text:
        return None, "Model returned empty text."
    cleaned = _FENCE_RE.sub("", text).strip()
    candidate = cleaned
    if not (candidate.startswith("{") and candidate.endswith("}")):
        match = _JSON_OBJECT_RE.search(cleaned)
        if not match:
            return None, "No JSON object found in model output."
        candidate = match.group()
    try:
        data = json.loads(candidate)
    except json.JSONDecodeError as exc:
        return None, f"JSON parse error: {exc.msg}"
    if not isinstance(data, dict):
        return None, "Top-level JSON must be an object."
    edits = data.get("edits")
    if not isinstance(edits, list):
        return None, "`edits` must be a list."
    normalized_edits: list[dict[str, Any]] = []
    for idx, edit in enumerate(edits):
        if not isinstance(edit, dict):
            return None, f"`edits[{idx}]` must be an object."
        file_path = edit.get("file_path")
        find_text = edit.get("find")
        if not isinstance(file_path, str) or not file_path.strip():
            return None, f"`edits[{idx}].file_path` must be a non-empty string."
        if not isinstance(find_text, str) or not find_text:
            return None, f"`edits[{idx}].find` must be a non-empty string."
        replace_text = edit.get("replace", "")
        if not isinstance(replace_text, str):
            return None, f"`edits[{idx}].replace` must be a string."
        normalized_edits.append({
            "file_path": file_path.strip().replace("\\", "/"),
            "find": find_text,
            "replace": replace_text,
            "replace_all": bool(edit.get("replace_all", False)),
        })
    summary = data.get("summary") or ""
    if not isinstance(summary, str):
        summary = str(summary)
    return {"summary": summary.strip(), "edits": normalized_edits}, ""
