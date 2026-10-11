# backend/drivers/hue.py
"""
Philips Hue driver — local Bridge REST API (no cloud).

Device extra fields:
  bridge_ip  : str   — IP of the Hue Bridge (required)
  api_key    : str   — Bridge API username/key (required)
              Obtain: POST http://BRIDGE_IP/api {"devicetype":"tli#tli"}
              while pressing the Bridge link button.
  light_id   : str   — light number ("1") or group number ("1")
  resource   : str   — "lights" (default) | "groups"
"""

from typing import Any, Dict
import requests
from .base import DeviceDriver


class HueDriver(DeviceDriver):
    vendor = "hue"

    def __init__(self, timeout: float = 3.0):
        self.timeout = timeout

    def _base(self, extra: Dict[str, Any]) -> str:
        bridge = str(extra.get("bridge_ip") or extra.get("ip") or "").strip().strip("/")
        key = str(extra.get("api_key") or "").strip()
        return f"http://{bridge}/api/{key}"

    def _light_url(self, extra: Dict[str, Any]) -> str:
        resource = str(extra.get("resource") or "lights")
        light_id = str(extra.get("light_id") or "1")
        endpoint = "state" if resource == "lights" else "action"
        return f"{self._base(extra)}/{resource}/{light_id}/{endpoint}"

    def _put(self, url: str, body: dict) -> Dict[str, Any]:
        r = requests.put(url, json=body, timeout=self.timeout)
        return r.json() if r.ok else {"error": r.text}

    def execute(self, device: Dict[str, Any], capability: str) -> Dict[str, Any]:
        extra = self._extra(device)
        if not extra.get("bridge_ip") and not extra.get("ip"):
            return self._err("Hue: bridge_ip not configured")
        if not extra.get("api_key"):
            return self._err("Hue: api_key not configured")

        url = self._light_url(extra)
        try:
            if capability == "switch.on":
                self._put(url, {"on": True})
                return self._ok("ON")
            elif capability == "switch.off":
                self._put(url, {"on": False})
                return self._ok("OFF")
            elif capability == "switch.toggle":
                status = self.get_status(device)
                new_state = not bool(status.get("on"))
                self._put(url, {"on": new_state})
                return self._ok("ON" if new_state else "OFF")
            elif capability == "light.brightness":
                level = int(extra.get("brightness", 100))
                bri = max(1, min(254, round(level * 254 / 100)))
                self._put(url, {"bri": bri, "on": True})
                return self._ok(f"Brightness {level}%")
            else:
                return self._err(f"Hue: unsupported capability {capability}")
        except Exception as e:
            return self._err(f"Hue error: {e}")

    def get_status(self, device: Dict[str, Any]) -> Dict[str, Any]:
        extra = self._extra(device)
        resource = str(extra.get("resource") or "lights")
        light_id = str(extra.get("light_id") or "1")
        url = f"{self._base(extra)}/{resource}/{light_id}"
        try:
            r = requests.get(url, timeout=self.timeout)
            d = r.json()
            state = d.get("state") or d.get("action") or {}
            on = state.get("on")
            bri = state.get("bri")
            bri_pct = round(bri / 254 * 100) if bri is not None else None
            summary = ("ON" if on else "OFF") + (f" · {bri_pct}%" if bri_pct is not None else "")
            return {"ok": True, "on": on, "brightness": bri_pct, "summary": summary}
        except Exception as e:
            return self._err(f"Hue status error: {e}")
