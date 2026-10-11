"""
game_configs/base.py — shared types for TLI game config adapters.

Architecture note:
  The recommendation engine in games.py receives a list of NormalizedSetting
  objects and formats them into an AI prompt. It does not care whether those
  settings came from a config-file adapter (Phase 1) or a vision adapter
  (Phase 2 — screenshot analysis via Qwen VL). The source field distinguishes them.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class NormalizedSetting:
    key: str            # stable internal key e.g. "shadow_quality"
    label: str          # display label e.g. "Shadow Quality"
    value: str          # current value as human-readable string e.g. "High"
    category: str       # "performance" | "visual" | "upscaling" | "system"
    note: str = ""      # optional context e.g. "High VRAM cost"


@dataclass
class ConfigReadResult:
    supported: bool                                   # True = adapter found AND config parsed
    config_path: Optional[str]                        # absolute path that was read, or None
    settings: List[NormalizedSetting] = field(default_factory=list)
    raw: Dict[str, Any] = field(default_factory=dict) # raw parsed data (for debugging)
    error: Optional[str] = None                       # human-readable error if supported=False
    game_name: str = ""
    source: str = "config"                            # "config" | "screenshot" (future)


class GameConfigAdapter:
    """
    Base class for all game config adapters.
    Subclasses implement find_config() and read().
    """
    game_name: str = ""
    aliases: List[str] = []   # lowercase substrings that identify this game

    def find_config(self) -> Optional[Path]:
        """Return path to the primary settings file, or None if not found."""
        raise NotImplementedError

    def read(self) -> ConfigReadResult:
        """
        Parse the config file and return normalized settings.
        Must not raise — return ConfigReadResult(supported=False, error=...) on failure.
        """
        raise NotImplementedError

    # ── Shared quality helpers ──────────────────────────────────────────────

    _QUALITY_MAP_4 = {0: "Low", 1: "Medium", 2: "High", 3: "Ultra"}
    _QUALITY_MAP_5 = {0: "Off", 1: "Low", 2: "Medium", 3: "High", 4: "Ultra"}

    def _q4(self, v) -> str:
        """Map int 0-3 → Low/Medium/High/Ultra."""
        try:
            return self._QUALITY_MAP_4.get(int(v), str(v))
        except Exception:
            return str(v)

    def _q5(self, v) -> str:
        """Map int 0-4 → Off/Low/Medium/High/Ultra."""
        try:
            return self._QUALITY_MAP_5.get(int(v), str(v))
        except Exception:
            return str(v)

    def _bool_str(self, v) -> str:
        if isinstance(v, bool):
            return "On" if v else "Off"
        if isinstance(v, str):
            return "On" if v.lower() in ("true", "1", "on", "yes") else "Off"
        try:
            return "On" if int(v) else "Off"
        except Exception:
            return str(v)
