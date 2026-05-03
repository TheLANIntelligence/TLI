from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict


class LLMProvider(ABC):
    """
    Contract: the rest of TLI must NOT care about LM Studio’s schema.
    """

    @abstractmethod
    def complete(self, *, payload: Dict[str, Any], request_id: str) -> Dict[str, Any]:
        """Send a chat completion request and return parsed JSON response."""

    @abstractmethod
    def list_models(self) -> Dict[str, Any]:
        """Return {"server_url": ..., "models": [...], "compat": {...}} shape used by UI."""

    @abstractmethod
    def health_check(self) -> bool:
        """Fast boolean: is the provider reachable?"""

    @abstractmethod
    def health_report(self) -> Dict[str, Any]:
        """Richer diagnostics used by /health/lmstudio/report."""
