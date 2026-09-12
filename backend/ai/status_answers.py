"""Narrow, read-only answers about AI readiness; never start or select a model."""
from __future__ import annotations

import re
import time


_SUBJECT = r"(?:(?:the|my|our|your)\s+)?(?:(?:tli(?:'s)?|local|bundled|integrated|built-in)\s+)?(?:ai(?:\s+model)?|qwen(?:\s+model)?|model|llm|lm\s*studio)"
_STATE = r"(?:currently\s+|actually\s+|still\s+)?(?:running|online|active|available|ready|working|loaded|on)"
_QUESTIONS = tuple(re.compile(pattern) for pattern in (
    rf"(?:is|are)\s+{_SUBJECT}\s+{_STATE}",
    rf"(?:check\s+(?:if\s+|whether\s+)?)(?:{_SUBJECT}\s+(?:is|are)\s+{_STATE})",
    rf"(?:what(?:'s|\s+is)\s+)?(?:the\s+)?status\s+of\s+{_SUBJECT}",
    rf"(?:what(?:'s|\s+is)\s+)?{_SUBJECT}\s+status",
    r"(?:what|which)\s+(?:ai\s+)?model\s+(?:are\s+you|is\s+tli)\s+(?:running|using)",
    r"(?:what|which)\s+(?:ai|model)\s+is\s+(?:currently\s+)?(?:running|loaded|selected)",
))


def _question(text: str) -> str:
    q = re.sub(r"\s+", " ", str(text or "").lower().replace("’", "'")).strip().rstrip("?!. ")
    return re.sub(r"^(?:please\s+|can\s+you\s+|could\s+you\s+)", "", q, count=1)


def is_status_question(text: str) -> bool:
    """Match entire status questions, not mentions inside requests or device names."""
    return any(pattern.fullmatch(_question(text)) for pattern in _QUESTIONS)


def answer(text: str, *, preferred="bundled", selected_model=None, mesh_host=None):
    if not is_status_question(text):
        return None
    q = _question(text)
    # An explicitly named provider can be checked independently of chat routing.
    if re.search(r"lm\s*studio", q):
        preferred = "lmstudio"
    elif re.search(r"\b(?:bundled|integrated|built-in)\b", q):
        preferred = "bundled"
        mesh_host = None
    if mesh_host and not re.search(r"lm\s*studio", q):
        return ("This chat is configured to use a mesh host. Its current AI readiness is unknown here. "
                "Check AI status on that host. No model was started and this question was not forwarded.")
    if preferred == "lmstudio":
        return _lmstudio_answer(selected_model)
    return _bundled_answer()


def _bundled_answer():
    from .ai_manager import BundledAIManager, MODEL_PRESETS

    try:
        mgr = BundledAIManager.get()
        selected = mgr.active_preset_id
        label = MODEL_PRESETS.get(selected, {}).get("name") or getattr(mgr.cfg.model_path, "name", None)
        selection = f" Selected model: **{label}**." if label else " The selected model is unknown."
        if mgr._transition:
            return "The bundled AI is changing models; readiness is not yet confirmed." + selection
        healthy = mgr.is_healthy()
        # A switch during the probe invalidates the captured model identity.
        if mgr._transition or mgr.active_preset_id != selected:
            return "The bundled model changed during this check. Recheck AI status once the switch finishes."
        if healthy:
            return "The bundled AI is running on this TLI host. Its runtime health check passed." + selection
        return ("The bundled AI is not currently confirmed running on this TLI host." + selection +
                " Open the model library to check it. LM Studio and mesh hosts have separate availability. "
                "This check did not start or switch a model.")
    except Exception:
        return ("I couldn't verify the bundled AI's current status. Open the model library to recheck. "
                "This check did not start or switch a model.")


def _lmstudio_answer(selected_model):
    import tli_state as S

    selection = f" The configured model is **{selected_model}**." if selected_model else " The configured model is unknown."
    # health_report() can generate a probe and load a model. Status questions
    # deliberately consume only its already-recorded, bounded-fresh evidence.
    try:
        cache = S.lm_provider._report_cache
        age = time.time() - float(cache.get("ts", 0))
        report = cache.get("report")
        ttl = min(30, float(S.lm_provider.report_ttl_seconds))
        if isinstance(report, dict) and 0 <= age < ttl:
            if report.get("ok") is True and report.get("chat_ok") is True:
                return ("LM Studio responded to its latest readiness check." + selection +
                        " That check does not confirm this specific model is loaded. No new inference check was run.")
            return ("LM Studio was not confirmed ready in its latest check." + selection +
                    " Open AI settings to check the connection. No new inference check was run.")
    except (AttributeError, TypeError, ValueError):
        pass
    return ("LM Studio's current readiness is unknown because there is no recent check." +
            selection + " Open AI settings to check the connection. No model was loaded or switched.")
