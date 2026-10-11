"""
game_configs/rdr2.py — Red Dead Redemption 2 config reader.

Config file: system.xml
Typical path:
  %USERPROFILE%\Documents\Rockstar Games\Red Dead Redemption 2\Settings\system.xml
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import List, Optional

from .base import ConfigReadResult, GameConfigAdapter, NormalizedSetting


def _xml_value(text: str, tag: str) -> Optional[str]:
    """Extract value="..." from a self-closing or regular XML tag."""
    # Self-closing: <tag value="X"/>  or  <tag value="X" />
    m = re.search(rf'<{re.escape(tag)}[^>]*\bvalue=["\']([^"\']*)["\']', text, re.IGNORECASE)
    if m:
        return m.group(1)
    # Between tags: <tag>X</tag>
    m2 = re.search(rf'<{re.escape(tag)}[^>]*>([^<]*)</{re.escape(tag)}>', text, re.IGNORECASE)
    if m2:
        return m2.group(1).strip()
    return None


class RDR2Adapter(GameConfigAdapter):
    game_name = "Red Dead Redemption 2"
    aliases = [
        "red dead redemption 2", "rdr2", "red dead 2",
        "rdr 2", "reddeadredemption2",
    ]

    # RDR2 uses 0–7 scale for most quality settings
    _Q_RDR2 = {
        "0": "Off", "1": "Low", "2": "Medium", "3": "High",
        "4": "Ultra", "5": "Ultra (Enhanced)", "6": "Unlocked", "7": "Unlocked+",
    }

    def _q(self, val: Optional[str]) -> str:
        if val is None:
            return "Unknown"
        return self._Q_RDR2.get(val.strip(), val.strip())

    def _b(self, val: Optional[str]) -> str:
        if val is None:
            return "Unknown"
        return "On" if val.strip() in ("1", "true", "True") else "Off"

    def find_config(self) -> Optional[Path]:
        docs = os.environ.get("USERPROFILE", "")
        if not docs:
            return None
        p = (Path(docs) / "Documents" / "Rockstar Games"
             / "Red Dead Redemption 2" / "Settings" / "system.xml")
        return p if p.exists() else None

    def read(self) -> ConfigReadResult:
        path = self.find_config()
        if not path:
            return ConfigReadResult(
                supported=True,
                config_path=None,
                error="Config file not found. "
                      "Expected in Documents\\Rockstar Games\\Red Dead Redemption 2\\Settings\\",
                game_name=self.game_name,
            )

        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            return ConfigReadResult(
                supported=True,
                config_path=str(path),
                error=f"Could not read system.xml: {exc}",
                game_name=self.game_name,
            )

        settings: List[NormalizedSetting] = []

        # ── Resolution ──────────────────────────────────────────────────
        w = _xml_value(text, "width")
        h = _xml_value(text, "height")
        if w and h:
            settings.append(NormalizedSetting(
                key="resolution", label="Resolution",
                value=f"{w}×{h}", category="system",
            ))

        rr = _xml_value(text, "refreshRate")
        if rr and rr != "0":
            settings.append(NormalizedSetting(
                key="refresh_rate", label="Refresh Rate",
                value=f"{rr} Hz", category="system",
            ))

        # ── Screen mode ──────────────────────────────────────────────────
        fs = _xml_value(text, "fullscreen")
        borderless = _xml_value(text, "borderlessFullscreen")
        if fs is not None:
            if self._b(fs) == "On":
                mode = "Fullscreen"
            elif borderless and self._b(borderless) == "On":
                mode = "Borderless Windowed"
            else:
                mode = "Windowed"
            settings.append(NormalizedSetting(
                key="screen_mode", label="Screen Mode",
                value=mode, category="system",
            ))

        # ── Quality settings ─────────────────────────────────────────────
        quality_fields = [
            ("textureQuality",         "Texture Quality",       "visual",       "Scales with VRAM"),
            ("shaderQuality",          "Shader Quality",        "visual",       ""),
            ("shadowQuality",          "Shadow Quality",        "performance",  "High GPU cost"),
            ("lightQuality",           "Lighting Quality",      "visual",       ""),
            ("reflectionQuality",      "Reflection Quality",    "visual",       ""),
            ("waterQuality",           "Water Quality",         "visual",       ""),
            ("volumetricsQuality",     "Volumetrics Quality",   "performance",  "Mist/fog cost"),
            ("particleQuality",        "Particle Quality",      "performance",  ""),
            ("tessellationQuality",    "Tessellation Quality",  "visual",       ""),
            ("grassQuality",           "Grass & Foliage",       "performance",  "CPU + GPU cost"),
            ("treeQuality",            "Tree Quality",          "visual",       ""),
            ("pedestrianDensity",      "Crowd Density",         "performance",  "CPU-heavy"),
        ]

        for xml_key, label, category, note in quality_fields:
            val = _xml_value(text, xml_key)
            if val is not None and val != "":
                settings.append(NormalizedSetting(
                    key=xml_key.lower(), label=label,
                    value=self._q(val), category=category, note=note,
                ))

        # ── Upscaling / TAA ──────────────────────────────────────────────
        taa = _xml_value(text, "taaEnabled") or _xml_value(text, "tAA")
        dlss = _xml_value(text, "dlssQuality")
        if dlss is not None:
            dmap = {"0": "Off", "1": "Ultra Performance", "2": "Performance",
                    "3": "Balanced", "4": "Quality"}
            settings.append(NormalizedSetting(
                key="upscaling", label="DLSS Quality",
                value=dmap.get(dlss, dlss), category="upscaling",
            ))
        elif taa is not None:
            settings.append(NormalizedSetting(
                key="upscaling", label="TAA",
                value=self._b(taa), category="upscaling",
            ))

        # ── Post-processing ──────────────────────────────────────────────
        for xml_key, label in [
            ("motionBlur",   "Motion Blur"),
            ("depthOfField", "Depth of Field"),
            ("vSync",        "V-Sync"),
            ("hdr",          "HDR"),
        ]:
            val = _xml_value(text, xml_key)
            if val is not None:
                settings.append(NormalizedSetting(
                    key=xml_key.lower(), label=label,
                    value=self._b(val), category="visual",
                ))

        return ConfigReadResult(
            supported=True,
            config_path=str(path),
            settings=settings,
            raw={},
            game_name=self.game_name,
        )
