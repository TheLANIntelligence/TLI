# backend/drivers/sonoff.py
"""
Sonoff DIY Mode driver — local HTTP API (port 8081).

Enable: hold button 5s until light flashes, put in DIY mode via app.
Supports Sonoff Basic R3, Mini R2, etc. in DIY mode.

Device extra fields:
  port      : int — defaults to 8081
  device_id : str — Sonoff device ID (optional, sent in request body)
"""

import requests
from typing import Any, Dict
from .base import DeviceDriver

_PORT = 8081
_TIMEOUT = 3.0


class SonoffDriver(DeviceDriver):
    vendor = "sonoff"

    def _post(self, ip: str, port: int, path: str, body: dict) -> dict:
        url = f"http://{ip}:{port}/zeroconf/{path}"
        r = requests.post(url, json=body, timeout=_TIMEOUT)
        return r.json() if r.ok else {"error": r.text}

    def execute(self, device: Dict[str, Any], capability: str) -> Dict[str, Any]:
        ip = self._ip(device)
        extra = self._extra(device)
        port = int(extra.get("port") or _PORT)
        device_id = str(extra.get("device_id") or "")
        base_body = {"deviceid": device_id, "data": {}}
        try:
            if capability == "switch.on":
                self._post(ip, port, "switch", {**base_body, "data": {"switch": "on"}})
                return self._ok("ON")
            elif capability == "switch.off":
                self._post(ip, port, "switch", {**base_body, "data": {"switch": "off"}})
                return self._ok("OFF")
            elif capability == "switch.toggle":
                status = self.get_status(device)
                new_state = "off" if status.get("on") else "on"
                self._post(ip, port, "switch", {**base_body, "data": {"switch": new_state}})
                return self._ok(new_state.upper())
            else:
                return self._err(f"Sonoff: unsupported capability {capability}")
        except Exception as e:
            return self._err(f"Sonoff error: {e}")

    def get_status(self, device: Dict[str, Any]) -> Dict[str, Any]:
        ip = self._ip(device)
        extra = self._extra(device)
        port = int(extra.get("port") or _PORT)
        device_id = str(extra.get("device_id") or "")
        try:
            resp = self._post(ip, port, "info", {"deviceid": device_id, "data": {}})
            data = resp.get("data", {})
            on = data.get("switch") == "on"
            return {"ok": True, "on": on, "summary": "ON" if on else "OFF"}
        except Exception as e:
            return self._err(f"Sonoff status error: {e}")
