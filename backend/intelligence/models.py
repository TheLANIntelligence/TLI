"""Read-only capability discovery. Text model selection remains owned by TLI."""
import time
import requests
from fastapi import HTTPException
import tli_state as S
from intelligence.store import LOCK, root


def settings():
    return S.load_json_file(root() / "model_capabilities.json", {})


def bundled_capabilities():
    from ai.ai_manager import BundledAIManager, MODEL_PRESETS, get_models_dir
    from ai.model_library import installation
    mgr = BundledAIManager.get()
    preset = MODEL_PRESETS.get(mgr.active_preset_id)
    complete = installation(preset, get_models_dir())["complete"] if preset else False
    running = not mgr._transition and mgr.is_healthy()
    return {"provider": "bundled", "selected": mgr.active_preset_id,
            "name": preset["name"] if preset else mgr.cfg.model_path.name,
            "running": running, "installation_complete": complete,
            "vision": bool(preset and preset.get("is_vision") and complete and running),
            "capability_source": "bundled preset and runtime health" if preset else "custom model; image capability unknown"}


def catalogue():
    from ai.ai_manager import BundledAIManager, MODEL_PRESETS
    mgr = BundledAIManager.get()
    caps = bundled_capabilities()
    healthy = caps["running"]
    prefs = settings()
    models = [{"id": ident, "provider": "bundled", "name": preset.get("name", ident),
               "selected": ident == mgr.active_preset_id,
               "available": healthy and caps["installation_complete"] and ident == mgr.active_preset_id,
               "vision": bool(preset.get("is_vision")), "capability_source": "bundled preset"}
              for ident, preset in MODEL_PRESETS.items()]
    error = None
    try:
        response = requests.get(S.lm_provider.models_url, timeout=(2, 3))
        response.raise_for_status()
        for model in response.json().get("data", []):
            ident = model.get("id")
            if not isinstance(ident, str):
                continue
            models.append({"id": ident, "name": ident, "provider": "lmstudio", "available": True,
                           "selected": False, "vision": ident in prefs.get("vision_models", []),
                           "capability_source": "user confirmed" if ident in prefs.get("vision_models", []) else "unknown"})
    except Exception:
        error = "LM Studio model discovery is unavailable. No model was loaded or switched."
    return {"models": models, "lmstudio_error": error, "checked_at": S.now_iso(),
            "vision_model": prefs.get("vision_model"),
            "note": "Available LM Studio models are advertised by its API; this does not prove they are loaded. Vision support must be confirmed explicitly."}


def configure(model_id, enabled):
    known = catalogue()["models"]
    if not any(m["id"] == model_id and m["provider"] == "lmstudio" for m in known):
        raise HTTPException(422, "Select a model currently advertised by LM Studio.")
    with LOCK:
        prefs = settings()
        capable = set(prefs.get("vision_models", []))
        capable.add(model_id) if enabled else capable.discard(model_id)
        prefs["vision_models"] = sorted(capable)
        prefs["vision_model"] = model_id if enabled else (None if prefs.get("vision_model") == model_id else prefs.get("vision_model"))
        S.save_json_file(root() / "model_capabilities.json", prefs)
    return prefs


def image_provider():
    from ai.ai_manager import BundledAIManager, MODEL_PRESETS
    mgr = BundledAIManager.get()
    if bundled_capabilities()["vision"]:
        return {"provider": "bundled", "model": "tli-bundled", "selection": mgr.active_preset_id,
                "url": mgr.base_url.rstrip("/") + "/v1/chat/completions"}
    chosen = settings().get("vision_model")
    if chosen and any(m["provider"] == "lmstudio" and m["id"] == chosen and m["vision"] for m in catalogue()["models"]):
        return {"provider": "lmstudio", "model": chosen, "url": S.lm_provider.chat_url}
    raise HTTPException(409, "No available image-capable model. Start the existing bundled Vision preset, or explicitly select a vision-capable LM Studio model in Settings. The image was not sent.")
