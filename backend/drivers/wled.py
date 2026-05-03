# backend/drivers/wled.py
"""
WLED driver — local JSON REST API.
Works with any WLED device (LED strips, matrix, etc.).

Device extra fields: (none required beyond ip)
  brightness : int 0-255 — used by light.brightness capability
"""

import requests
from typing import Any, Dict
from .base import DeviceDriver


class WledDriver(DeviceDriver):
    vendor = "wled"

    def __init__(self, timeout: float = 3.0):
        self.timeout = timeout

    def _post(self, ip: str, body: dict) -> dict:
        r = requests.post(f"http://{ip}/json/state", json=body, timeout=self.timeout)
        return r.json() if r.ok else {}

    def execute(self, device: Dict[str, Any], capability: str) -> Dict[str, Any]:
        ip = self._ip(device)
        extra = self._extra(device)
        try:
            if capability == "switch.on":
                self._post(ip, {"on": True})
                return self._ok("ON")
            elif capability == "switch.off":
                self._post(ip, {"on": False})
                return self._ok("OFF")
            elif capability == "switch.toggle":
                self._post(ip, {"on": "t"})
                return self._ok("toggled")
            elif capability == "light.brightness":
                level = int(extra.get("brightness", 100))
                bri = max(0, min(255, round(level * 255 / 100)))
                self._post(ip, {"on": True, "bri": bri})
                return self._ok(f"Brightness {level}%")
            else:
                return self._err(f"WLED: unsupported capability {capability}")
        except Exception as e:
            return self._err(f"WLED error: {e}")

    def get_status(self, device: Dict[str, Any]) -> Dict[str, Any]:
        ip = self._ip(device)
        try:
            r = requests.get(f"http://{ip}/json/state", timeout=self.timeout)
            d = r.json()
            on = bool(d.get("on"))
            bri = d.get("bri")
            bri_pct = round(bri / 255 * 100) if bri is not None else None
            summary = ("ON" if on else "OFF") + (f" · {bri_pct}%" if bri_pct is not None else "")
            return {"ok": True, "on": on, "brightness": bri_pct, "summary": summary}
        except Exception as e:
            return self._err(f"WLED status error: {e}")
