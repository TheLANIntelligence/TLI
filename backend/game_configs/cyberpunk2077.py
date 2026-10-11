r"""
game_configs/cyberpunk2077.py — Cyberpunk 2077 config reader.

Config file: UserSettings.json
Typical paths:
  %USERPROFILE%\Saved Games\CD Projekt Red\Cyberpunk 2077\UserSettings.json
  %LOCALAPPDATA%\CD Projekt Red\Cyberpunk 2077\UserSettings.json
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import List, Optional

from .base import ConfigReadResult, GameConfigAdapter, NormalizedSetting


class Cyberpunk2077Adapter(GameConfigAdapter):
    game_name = "Cyberpunk 2077"
    aliases = ["cyberpunk 2077", "cyberpunk2077", "cyberpunk", "cp77", "cp2077"]

    # Integer → quality label (Cyberpunk uses 0–3)
    _Q = {0: "Low", 1: "Medium", 2: "High", 3: "Ultra"}

    # DLSSIndex → mode label
    _DLSS_IDX = {
        0: "Ultra Performance", 1: "Performance", 2: "Balanced",
        3: "Quality", 4: "Ultra Quality", 5: "DLAA",
    }

    def find_config(self) -> Optional[Path]:
        candidates = []

        saved = os.environ.get("USERPROFILE", "")
        local = os.environ.get("LOCALAPPDATA", "")
        appdata = os.environ.get("APPDATA", "")

        sub = r"CD Projekt Red\Cyberpunk 2077\UserSettings.json"
        if saved:
            candidates.append(Path(saved) / "Saved Games" / sub)
        if local:
            candidates.append(Path(local) / sub)
        if appdata:
            candidates.append(Path(appdata) / sub)

        for p in candidates:
            if p.exists():
                return p
        return None

    def read(self) -> ConfigReadResult:
        path = self.find_config()
        if not path:
            return ConfigReadResult(
                supported=True,   # we support this game
                config_path=None,
                error="Config file not found. "
                      "Expected in Saved Games\\CD Projekt Red\\Cyberpunk 2077\\",
                game_name=self.game_name,
            )

        try:
            raw = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        except Exception as exc:
            return ConfigReadResult(
                supported=True,
                config_path=str(path),
                error=f"Could not parse UserSettings.json: {exc}",
                game_name=self.game_name,
            )

        data = raw.get("Data") or raw
        basic = data.get("/graphics/BasicGraphicOptions") or {}
        adv = data.get("/graphics/AdvancedGraphicOptions") or {}

        settings: List[NormalizedSetting] = []

        # ── Resolution ──────────────────────────────────────────────────
        res = basic.get("Resolution")
        if isinstance(res, dict) and res.get("Width") and res.get("Height"):
            settings.append(NormalizedSetting(
                key="resolution", label="Resolution",
                value=f"{res['Width']}×{res['Height']}",
                category="system",
            ))

        # ── Screen mode ──────────────────────────────────────────────────
        mode = basic.get("ScreenMode")
        if mode:
            settings.append(NormalizedSetting(
                key="screen_mode", label="Screen Mode",
                value=str(mode).replace("FullscreenExclusive", "Fullscreen"),
                category="system",
            ))

        # ── DLSS / upscaling ─────────────────────────────────────────────
        dlss = basic.get("DLSS")
        dlss_idx = basic.get("DLSSIndex")
        if dlss is not None:
            dlss_str = str(dlss)
            if dlss_str not in ("Off", "0", "") and dlss_idx is not None:
                quality = self._DLSS_IDX.get(int(dlss_idx), str(dlss_idx))
                settings.append(NormalizedSetting(
                    key="upscaling", label="DLSS Mode",
                    value=f"{dlss_str} · {quality}",
                    category="upscaling",
                    note="Improves performance by rendering at lower res",
                ))
            else:
                settings.append(NormalizedSetting(
                    key="upscaling", label="DLSS / Upscaling",
                    value="Off",
                    category="upscaling",
                    note="Native resolution — highest quality, highest GPU cost",
                ))

        # ── Frame generation ─────────────────────────────────────────────
        fg = basic.get("DLSSFG")
        if fg is not None:
            settings.append(NormalizedSetting(
                key="frame_generation", label="Frame Generation (DLSS FG)",
                value=self._bool_str(fg),
                category="performance",
                note="Requires RTX 40-series or newer",
            ))

        # ── Ray tracing ──────────────────────────────────────────────────
        rt_ao = basic.get("RayTracedAmbientOcclusion")
        rt_ref = basic.get("RayTracedReflections")
        rt_local = basic.get("RayTracedLocalShadows")
        rt_sun = basic.get("RayTracedSunShadows")
        path_trace = basic.get("PathTracing")

        if path_trace is not None and self._bool_str(path_trace) == "On":
            settings.append(NormalizedSetting(
                key="ray_tracing", label="Ray Tracing",
                value="Path Tracing",
                category="visual",
                note="Maximum quality — very high GPU cost",
            ))
        elif any(x is not None for x in [rt_ao, rt_ref, rt_local, rt_sun]):
            enabled = [
                ("RTAO" if self._bool_str(rt_ao) == "On" else None),
                ("RT Reflections" if self._bool_str(rt_ref) == "On" else None),
                ("RT Local Shadows" if self._bool_str(rt_local) == "On" else None),
                ("RT Sun Shadows" if self._bool_str(rt_sun) == "On" else None),
            ]
            on = [x for x in enabled if x]
            settings.append(NormalizedSetting(
                key="ray_tracing", label="Ray Tracing",
                value=", ".join(on) if on else "Off",
                category="visual",
                note="High GPU cost per RT feature enabled",
            ))

        # ── Texture quality ──────────────────────────────────────────────
        tq = adv.get("TextureQuality")
        if tq is not None:
            settings.append(NormalizedSetting(
                key="texture_quality", label="Texture Quality",
                value=self._q4(tq),
                category="visual",
                note="Scales with VRAM — keep High/Ultra if VRAM allows",
            ))

        # ── Shadow quality ───────────────────────────────────────────────
        sq = adv.get("ShadowQuality")
        if sq is not None:
            settings.append(NormalizedSetting(
                key="shadow_quality", label="Shadow Quality",
                value=self._q4(sq),
                category="performance",
                note="One of the biggest GPU consumers in CP2077",
            ))

        # ── Ambient occlusion ────────────────────────────────────────────
        ao = adv.get("AmbientOcclusion")
        if ao is not None:
            settings.append(NormalizedSetting(
                key="ambient_occlusion", label="Ambient Occlusion",
                value=self._q4(ao),
                category="visual",
            ))

        # ── Mirror quality ───────────────────────────────────────────────
        mq = adv.get("MirrorQuality")
        if mq is not None:
            settings.append(NormalizedSetting(
                key="mirror_quality", label="Mirror Quality",
                value=self._q4(mq),
                category="visual",
                note="Reflective surfaces — high cost in Night City",
            ))

        # ── Crowd density ────────────────────────────────────────────────
        cd = adv.get("CrowdDensity")
        if cd is not None:
            settings.append(NormalizedSetting(
                key="crowd_density", label="Crowd Density",
                value=self._q4(cd),
                category="performance",
                note="CPU-heavy in Night City centre",
            ))

        # ── Motion blur ──────────────────────────────────────────────────
        mb = adv.get("MotionBlur")
        if mb is not None:
            # Can be int (0=Off, 1=Low, 2=High) or bool
            if isinstance(mb, bool):
                mb_val = "On" if mb else "Off"
            else:
                mb_val = {0: "Off", 1: "Low", 2: "High"}.get(int(mb), str(mb))
            settings.append(NormalizedSetting(
                key="motion_blur", label="Motion Blur",
                value=mb_val,
                category="visual",
                note="Off = cleaner image, no performance cost",
            ))

        # ── Lens flare / film grain / chromatic aberration ───────────────
        for raw_key, label in [
            ("LensFlare", "Lens Flare"),
            ("FilmGrain", "Film Grain"),
            ("ChromaticAberration", "Chromatic Aberration"),
            ("DepthOfField", "Depth of Field"),
        ]:
            v = adv.get(raw_key)
            if v is not None:
                settings.append(NormalizedSetting(
                    key=raw_key.lower(), label=label,
                    value=self._bool_str(v),
                    category="visual",
                ))

        # ── V-Sync ───────────────────────────────────────────────────────
        vsync = basic.get("VSync") or adv.get("VSync") or data.get("/video/VSync")
        if vsync is not None:
            settings.append(NormalizedSetting(
                key="vsync", label="V-Sync",
                value=self._bool_str(vsync),
                category="performance",
                note="Use frame limiter instead for lower latency",
            ))

        return ConfigReadResult(
            supported=True,
            config_path=str(path),
            settings=settings,
            raw={"basic": basic, "advanced": adv},
            game_name=self.game_name,
        )
