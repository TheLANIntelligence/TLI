"""
game_configs/registry.py — adapter registry for TLI Game Optimizer.

To add a new game:
  1. Create backend/game_configs/<game>.py with a class extending GameConfigAdapter
  2. Import and append it to _build_adapters() below
"""
from __future__ import annotations

from typing import List, Optional

from .base import GameConfigAdapter, ConfigReadResult

_ADAPTERS: List[GameConfigAdapter] = []
_LOADED = False


def _build_adapters() -> List[GameConfigAdapter]:
    adapters: List[GameConfigAdapter] = []
    try:
        from .cyberpunk2077 import Cyberpunk2077Adapter
        adapters.append(Cyberpunk2077Adapter())
    except Exception:
        pass
    try:
        from .witcher3 import Witcher3Adapter
        adapters.append(Witcher3Adapter())
    except Exception:
        pass
    try:
        from .rdr2 import RDR2Adapter
        adapters.append(RDR2Adapter())
    except Exception:
        pass
    return adapters


def _ensure_loaded() -> None:
    global _ADAPTERS, _LOADED
    if not _LOADED:
        _ADAPTERS = _build_adapters()
        _LOADED = True


def find_adapter(game_name: str) -> Optional[GameConfigAdapter]:
    """Return the first adapter whose aliases match the given game name."""
    _ensure_loaded()
    name_lower = (game_name or "").lower().strip()
    if not name_lower:
        return None
    for adapter in _ADAPTERS:
        for alias in adapter.aliases:
            if " ".join(alias.casefold().split()) == " ".join(name_lower.casefold().split()):
                return adapter
    return None


def read_game_config(game_name: str) -> ConfigReadResult:
    """
    Find and run the appropriate adapter for this game.
    Always returns a ConfigReadResult — never raises.
    """
    adapter = find_adapter(game_name)
    if not adapter:
        return ConfigReadResult(
            supported=False,
            config_path=None,
            error=f"No config adapter available for '{game_name}'. "
                  f"Supported: {', '.join(list_supported_games()) or 'none yet'}.",
            game_name=game_name,
        )
    try:
        result = adapter.read()
        result.game_name = game_name
        return result
    except Exception as exc:
        return ConfigReadResult(
            supported=False,
            config_path=None,
            error=str(exc),
            game_name=game_name,
        )


def list_supported_games() -> List[str]:
    """Return canonical game names for all loaded adapters."""
    _ensure_loaded()
    return [a.game_name for a in _ADAPTERS]
