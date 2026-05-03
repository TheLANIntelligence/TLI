"""
game_configs/witcher3.py — The Witcher 3: Wild Hunt config reader.

Config file: user.settings (INI-like, key=value)
Typical path:
  %USERPROFILE%\Documents\The Witcher 3\user.settings
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Dict, List, Optional

from .base import ConfigReadResult, GameConfigAdapter, NormalizedSetting


def _parse_witcher_ini(text: str) -> Dict[str, Dict[str, str]]:
    """
    Parse Witcher 3 user.settings INI-like format.
    Returns {section: {key: value}}.
    """
    result: Dict[str, Dict[str, str]] = {}
    current_section = "__default__"
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(";") or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current_section = line[1:-1].strip()
            result.setdefault(current_section, {})
            continue
        m = re.match(r"^([^=]+)=(.*)$", line)
        if m:
            key = m.group(1).strip()
            val = m.group(2).strip()
            result.setdefault(current_section, {})[key] = val
    return result


class Witcher3Adapter(GameConfigAdapter):
    game_name = "The Witcher 3"
    aliases = [
        "witcher 3", "witcher3", "the witcher 3", "wild hunt",
        "witcher 3 wild hunt", "tw3",
    ]

    _Q = {
        "0": "Low", "1": "Medium", "2": "High", "3": "Ultra",
        "4": "Ultra+",
    }

    def find_config(self) -> Optional[Path]:
        docs = os.environ.get("USERPROFILE", "")
        candidates = []
        if docs:
            base = Path(docs) / "Documents" / "The Witcher 3"
            candidates.append(base / "user.settings")
            # Next-Gen update may use a different sub-path
            candidates.append(base / "UserSettings" / "user.settings")
        for p in candidates:
            if p.exists():
                return p
        return None

    def read(self) -> ConfigReadResult:
        path = self.find_config()
        if not path:
            return ConfigReadResult(
                supported=True,
                config_path=None,
                error="Config file not found. "
                      "Expected in Documents\\The Witcher 3\\user.settings",
                game_name=self.game_name,
            )

        try:
            text = path.read_text(encoding="utf-8", errors="replace")
            sections = _parse_witcher_ini(text)
        except Exception as exc:
            return ConfigReadResult(
                supported=True,
                config_path=str(path),
                error=f"Could not parse user.settings: {exc}",
                game_name=self.game_name,
            )

        # Witcher 3 stores most graphics in [Rendering] section
        r = sections.get("Rendering") or {}
        v = sections.get("Video") or {}

        settings: List[NormalizedSetting] = []

        def _q(val: Optional[str]) -> str:
            if val is None:
                return "Unknown"
            return Witcher3Adapter._Q.get(val.strip(), val.strip())

        def _b(val: Optional[str]) -> str:
            if val is None:
                return "Unknown"
            return "On" if val.strip().lower() in ("true", "1") else "Off"

        # ── Resolution ──────────────────────────────────────────────────
        w = v.get("ResolutionWidth") or r.get("ResolutionWidth")
        h = v.get("ResolutionHeight") or r.get("ResolutionHeight")
        if w and h:
            settings.append(NormalizedSetting(
                key="resolution", label="Resolution",
                value=f"{w}×{h}", category="system",
            ))

        # ── Fullscreen ──────────────────────────────────────────────────
        fs = v.get("Fullscreen") or r.get("Fullscreen")
        if fs is not None:
            settings.append(NormalizedSetting(
                key="screen_mode", label="Screen Mode",
                value="Fullscreen" if _b(fs) == "On" else "Windowed",
                category="system",
            ))

        # ── Texture quality ──────────────────────────────────────────────
        for key, label, note in [
            ("TextureQuality", "Texture Quality", "Scales with VRAM"),
            ("ShadowQuality", "Shadow Quality", "High GPU cost"),
            ("ShadowDistance", "Shadow Distance", ""),
            ("TerrainQuality", "Terrain Quality", ""),
            ("WaterQuality", "Water Quality", ""),
            ("FoliageQuality", "Foliage Quality", ""),
            ("HairWorksQuality", "HairWorks Quality", "NVIDIA only — high GPU cost"),
            ("AmbientOcclusion", "Ambient Occlusion", ""),
        ]:
            val = r.get(key)
            if val is not None:
                settings.append(NormalizedSetting(
                    key=key.lower(), label=label,
                    value=_q(val), category="performance" if "Shadow" in key else "visual",
                    note=note,
                ))

        # ── Post-processing ──────────────────────────────────────────────
        for key, label in [
            ("MotionBlur", "Motion Blur"),
            ("Bloom", "Bloom"),
            ("AntiAliasing", "Anti-Aliasing"),
            ("ChromaticAberration", "Chromatic Aberration"),
            ("DepthOfField", "Depth of Field"),
            ("VSync", "V-Sync"),
        ]:
            val = r.get(key) or v.get(key)
            if val is not None:
                # Some are quality-int, some are bool
                if val.strip() in Witcher3Adapter._Q:
                    disp = _q(val)
                else:
                    disp = _b(val)
                settings.append(NormalizedSetting(
                    key=key.lower(), label=label,
                    value=disp, category="visual",
                ))

        return ConfigReadResult(
            supported=True,
            config_path=str(path),
            settings=settings,
            raw=dict(sections),
            game_name=self.game_name,
        )
