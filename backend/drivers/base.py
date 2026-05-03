# backend/drivers/base.py
from typing import Any, Dict


class DeviceDriver:
    """
    Base class for all TLI smart-home device drivers.
    Each driver receives the full device dict (which includes `ip`, `relay`,
    and an `extra` dict for vendor-specific config like API keys, light IDs, etc.).
    """
    vendor: str = "unknown"

    def execute(self, device: Dict[str, Any], capability: str) -> Dict[str, Any]:
        """
        Execute a capability on a device.
        Returns {"ok": bool, "summary": str, ...}
        Must be overridden.
        """
        raise NotImplementedError(f"{self.__class__.__name__}.execute not implemented")

    def get_status(self, device: Dict[str, Any]) -> Dict[str, Any]:
        """
        Fetch current device status.
        Returns {"ok": bool, "on": bool|None, "summary": str, ...}
        Optional — drivers that support it should override.
        """
        return {"ok": False, "on": None, "summary": "Status not supported for this driver"}

    # ── helpers ──────────────────────────────────────────────────────────
    @staticmethod
    def _ip(device: Dict[str, Any]) -> str:
        import re
        ip = str(device.get("ip") or "").strip()
        ip = re.sub(r"^https?://", "", ip, flags=re.I).strip("/")
        return ip

    @staticmethod
    def _extra(device: Dict[str, Any]) -> Dict[str, Any]:
        ex = device.get("extra")
        return ex if isinstance(ex, dict) else {}

    @staticmethod
    def _ok(summary: str = "done") -> Dict[str, Any]:
        return {"ok": True, "summary": summary}

    @staticmethod
    def _err(msg: str) -> Dict[str, Any]:
        return {"ok": False, "summary": msg}
