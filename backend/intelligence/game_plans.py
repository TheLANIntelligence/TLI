"""Source-derived game settings trials. The model selects IDs, never facts.

Control vocabulary matches the existing three config readers. This catalogue
does not estimate FPS or diagnose a bottleneck. No settings are written.
"""
from __future__ import annotations

import json
import re

from fastapi import HTTPException

QUALITY = ["Low", "Medium", "High", "Ultra"]
CONTROLS = {
    "shadow_quality": ("Shadow Quality", "gpu", "shadow detail"),
    "texture_quality": ("Texture Quality", "vram", "texture detail"),
    "mirror_quality": ("Mirror Quality", "gpu", "detail in mirrors"),
    "crowd_density": ("Crowd Density", "cpu", "the number of people shown"),
    "ambient_occlusion": ("Ambient Occlusion", "gpu", "contact shading"),
    "water_quality": ("Water Quality", "gpu", "water detail"),
    "foliage_quality": ("Foliage Quality", "cpu_gpu", "vegetation detail"),
    "reflection_quality": ("Reflection Quality", "gpu", "reflection detail"),
    "volumetrics_quality": ("Volumetrics Quality", "gpu", "fog and volumetric detail"),
}
GAMES = {
    "Cyberpunk 2077": ["shadow_quality", "texture_quality", "mirror_quality", "crowd_density", "ambient_occlusion"],
    "The Witcher 3": ["shadow_quality", "texture_quality", "water_quality", "foliage_quality"],
    "Red Dead Redemption 2": ["shadow_quality", "texture_quality", "water_quality", "reflection_quality", "volumetrics_quality"],
}


def schema(game_name):
    from game_configs.registry import find_adapter
    adapter = find_adapter(game_name)
    keys = GAMES.get(adapter.game_name if adapter else "", [])
    return [{"key": key, "label": CONTROLS[key][0], "values": QUALITY} for key in keys]


def _normalized(value):
    return re.sub(r"[^a-z0-9]", "", str(value).casefold())


def _setting_lookup(fields):
    permitted = {item["key"] for item in fields}
    lookup = {_normalized(item["key"]): item["key"] for item in fields}
    lookup.update({_normalized(item["label"]): item["key"] for item in fields})
    lookup.update({alias: key for alias, key in {
        "shadows": "shadow_quality", "textures": "texture_quality", "pedestriandensity": "crowd_density"
    }.items() if key in permitted})
    return lookup


def currents(request, settings):
    fields = schema(request.game_name)
    permitted = {item['key']: item for item in fields}
    for key, value in request.manual_values.items():
        if key not in permitted or (value and value not in permitted[key]['values']):
            raise HTTPException(422, "Choose a listed current setting value for this game.")
    values = {key: {"value": None, "source": "unknown"} for key in permitted}
    lookup = _setting_lookup(fields)
    for setting in settings:
        key = lookup.get(_normalized(setting.key)) or lookup.get(_normalized(setting.label))
        if key not in values:
            continue
        value = str(setting.value).strip().title()
        if value in QUALITY:
            values[key] = {"value": value, "source": "read"}
    for key, value in request.manual_values.items():
        values[key] = {"value": value or None, "source": "user" if value else "unknown"}
    return values


def build_plan(request, settings, *, check):
    """Prepare reversible comparisons from known values, without an AI call.

    The existing reader vocabulary is not a verified menu for every game version.
    Unknown games require explicit user-provided trial values instead of a made-up
    quality ladder. The output is transient and carries no setting-write authority.
    """
    check()
    controls = schema(request.game_name)
    current = currents(request, settings)
    plan, missing = [], []
    lookup = _setting_lookup(controls)
    labels, explicit_controls = set(), set()
    for index, trial in enumerate(request.custom_trials):
        check()
        label, previous, value = trial.label.strip(), trial.current.strip(), trial.suggested.strip()
        known_key = lookup.get(_normalized(label))
        identity = ("control", known_key) if known_key else ("label", " ".join(label.casefold().split()))
        if not label or not previous or not value or identity in labels or previous.casefold() == value.casefold():
            raise HTTPException(422, "Give each manual trial a distinct setting name and different current and trial values.")
        labels.add(identity)
        if known_key:
            explicit_controls.add(known_key)
        key = f"custom_{index}"
        if key in request.avoid_settings or known_key in request.avoid_settings:
            continue
        # Explicit user values take priority over catalogue suggestions, even
        # when they name a known setting or use options outside its vocabulary.
        plan.append({"id": key + "=" + value, "key": key, "label": label,
                     "current": previous, "current_source": "user", "suggested": value,
                     "scope": "user-named; options unverified",
                     "reason": "This compares the exact current and trial values you entered; TLI has not verified this menu or its performance effect.",
                     "tradeoff": "Confirm the option in the game menu. Change only this setting, compare the same scene, and restore the original value if the result is worse."})
    visual = request.preset == "max_visual"
    for control in controls:
        check()
        key, label = control["key"], control["label"]
        if key in request.avoid_settings or key in explicit_controls:
            continue
        reading = current[key]
        previous = reading["value"]
        if previous is None:
            missing.append({"key": key, "label": label})
            continue
        options = control["values"]
        position = options.index(previous) + (1 if visual else -1)
        if not 0 <= position < len(options) or len(plan) >= 3:
            continue
        value = options[position]
        detail = CONTROLS[key][2]
        plan.append({"id": key + "=" + value, "key": key, "label": label,
                     "current": previous, "current_source": reading["source"], "suggested": value,
                     "scope": "installed reader vocabulary",
                     "reason": f"Compare one step {'up' if visual else 'down'} in {detail}; this is a setting trial, not a measured bottleneck or promised FPS gain.",
                     "tradeoff": ("More detail may worsen frame times." if visual else "Less detail may improve frame times; the effect must be measured.")
                     + (" Texture changes primarily test memory use, not a guaranteed FPS gain." if key == "texture_quality" else "")
                     + " Confirm both options exist in your game version and restore the original value if the result is worse."})
    # Retain legacy manual input compatibility without guessing an option the
    # game may not offer. Explicit current + suggested values are required here.
    if not controls and not request.custom_trials:
        for index, item in enumerate(request.custom_settings):
            check()
            if item.current is None and item.label.strip():
                missing.append({"key": f"custom_{index}", "label": item.label.strip()})
    steps = [
        "Record the current value, resolution, scene and FPS or frame-time reading from your own game display.",
        "Change one setting manually, then repeat the same scene with the same resolution, FPS cap and measurement tool.",
        "Compare the readings and image quality. A single run is noisy; repeat before deciding to keep the trial or restore the original value.",
    ]
    if plan:
        text = render(request, plan)
    elif not controls:
        text = "Manual comparison: enter a setting name, its current value and a different trial value exactly as shown in this game's menu. TLI has no settings reader for this game and will not invent menu options."
    elif missing:
        text = "Choose the current values you know, or explicitly read this game's settings, to prepare one-step comparisons. Unknown values are not a baseline."
    else:
        text = "The supplied values are already at the end of the listed quality range for this goal, or those settings were excluded. Choose another goal or provide a different explicit manual trial."
    check()
    return {"protocol": "tli-game-plan-v1", "source": "setting-trials", "game_name": request.game_name,
            "mode": "reader-vocabulary" if controls else "manual", "controls": controls,
            "settings_plan": plan, "needs_current": missing, "text": text,
            "comparison_steps": steps, "applied": False}


def candidates(request, settings):
    current = currents(request, settings)
    custom_labels = {}
    if not schema(request.game_name):
        names = set()
        for index, item in enumerate(request.custom_settings):
            label = item.label.strip()
            if not label or label.casefold() in names:
                raise HTTPException(422, "Give each manual quality setting a distinct name from the game menu.")
            names.add(label.casefold())
            key = f"custom_{index}"
            current[key] = {"value": item.current, "source": "user" if item.current is not None else "unknown"}
            custom_labels[key] = label
    gpu = request.corrections.gpu or request.system.gpu.model or request.system.gpu.name or "the GPU"
    cpu = request.corrections.cpu or request.system.cpu.model or request.system.cpu.name or "the CPU"
    visual = request.preset == 'max_visual'
    vram = request.system.gpu.vram_gb if not request.corrections.gpu else None
    result = []
    for key, reading in current.items():
        if key in request.avoid_settings:
            continue
        custom = key in custom_labels
        label, resource, detail = (custom_labels[key], 'unknown', 'this user-named quality setting') if custom else CONTROLS[key]
        previous = reading['value']
        target = cpu if resource == 'cpu' else f"{cpu} and {gpu}" if resource == 'cpu_gpu' else gpu
        if visual:
            value = 'Ultra' if previous == 'High' else 'High'
            if previous == 'Ultra' or (key == 'texture_quality' and value == 'Ultra' and (vram is None or vram < 8)):
                continue
            memory_context = f" (reported VRAM: {vram:g} GB)" if resource == 'vram' and vram is not None else ""
            reason = f"A visual-quality trial for {detail} on {target}{memory_context}; performance headroom is not measured."
            tradeoff = "Increasing detail uses more " + ("GPU memory" if resource == 'vram' else "CPU work" if resource == 'cpu' else "CPU and GPU work" if resource == 'cpu_gpu' else "GPU work") + "; frame times may worsen."
        else:
            if previous == 'Low':
                continue
            value = 'Low' if request.preset == 'high_fps' or previous == 'Medium' else 'Medium'
            reason = f"A workload-reduction trial for {target}; this does not establish that it is the bottleneck."
            tradeoff = f"Reducing this value lowers {detail}. " + ("Texture changes affect memory use; an FPS improvement is not established." if resource == 'vram' else "Compare frame times to find out whether this helps.")
        if previous is None:
            reason = "Check the current value first. " + reason
            tradeoff += " Try this only if it " + ("raises" if visual else "lowers") + " the current value."
        if custom:
            reason = f"A trial for the quality setting you named on {gpu}. Its options and effects are not verified by a TLI reader."
            tradeoff = "Confirm that this value is offered in the game menu. " + ("Increasing a quality value may cost performance." if visual else "Lowering a quality value may reduce image quality.") + " Compare one change at a time."
            if previous is None:
                reason = "Check the current value first. " + reason
                tradeoff += " Try this only if it " + ("raises" if visual else "lowers") + " the current value."
        result.append({"id": key + '=' + value, "key": key, "label": label,
                       "current": previous, "current_source": reading['source'], "suggested": value,
                       "scope": "user-named; options unverified" if custom else "installed reader vocabulary",
                       "reason": reason, "tradeoff": tradeoff})
    return result


def validate(raw, choices):
    text = raw.strip()
    if text.startswith('```') and text.endswith('```'):
        text = re.sub(r'^```(?:json)?\s*', '', text, flags=re.I)[:-3].strip()
    try:
        value = json.loads(text)
    except (ValueError, TypeError):
        raise HTTPException(502, "The AI could not produce a reliable settings plan. Your earlier plan is unchanged; try a shorter follow-up or another available AI provider.") from None
    ids = value.get('choices') if isinstance(value, dict) and set(value) == {'choices'} else None
    allowed = {item['id']: item for item in choices}
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 3 or
            any(not isinstance(ident, str) or ident not in allowed for ident in ids) or len(set(ids)) != len(ids)):
        raise HTTPException(502, "The AI could not select reliable, supported setting trials. No unverified plan was displayed. Your earlier plan is unchanged.")
    return [allowed[ident] for ident in ids]


def render(request, plan):
    goal = {'stable_60':'smoother frame times', 'high_fps':'responsiveness', 'max_visual':'image quality'}[request.preset]
    lines = [f"Settings to compare for {request.game_name}, favoring {goal}."]
    if any(item['scope'] == 'installed reader vocabulary' for item in plan):
        lines.append("Reader vocabulary: confirm each suggested option exists in your game version before trying it.")
    for index, item in enumerate(plan, 1):
        source = {'read':'read from this game', 'user':'you entered this value', 'unknown':'current value unknown'}[item['current_source']]
        current = f"{item['current']} ({source})" if item['current'] is not None else source
        lines.append(f"{index}. {item['label']} — {current} → try {item['suggested']}. Why: {item['reason']} Tradeoff: {item['tradeoff']}")
    lines.append("Compare the same scene with one change at a time, using your own FPS/frame-time display. Record the previous value and restore it if the result is worse. Achievable FPS is unknown until compared; TLI changed no settings.")
    return '\n\n'.join(lines)
