# backend/drivers/generic_http.py
"""
Generic HTTP driver — call any URL for on/off/toggle/status.

Useful for custom firmware, ESPHome, custom scripts, etc.

Device extra fields:
  url_on      : str — full URL to call when switching ON
  url_off     : str — full URL to call when switching OFF
  url_toggle  : str — full URL to call for toggle (optional)
  url_status  : str — full URL to GET device status (optional)
  method      : str — "GET" (default) | "POST"
  on_value    : str — JSON path substring that means "on" in status response (default: "on")
  headers     : dict — extra HTTP headers as JSON object (optional)
"""

import json
import requests
from typing import Any, Dict, Optional
from .base import DeviceDriver

_TIMEOUT = 5.0


class GenericHttpDriver(DeviceDriver):
    vendor = "generic_http"

    def _call(self, url: str, method: str, headers: Optional[Dict] = None) -> requests.Response:
        m = method.upper()
        if m == "POST":
            return requests.post(url, headers=headers, timeout=_TIMEOUT)
        return requests.get(url, headers=headers, timeout=_TIMEOUT)

    def execute(self, device: Dict[str, Any], capability: str) -> Dict[str, Any]:
        extra = self._extra(device)
        method = str(extra.get("method") or "GET").upper()
        raw_headers = extra.get("headers")
        headers = dict(raw_headers) if isinstance(raw_headers, dict) else None

        try:
            if capability == "switch.on":
                url = str(extra.get("url_on") or "")
                if not url:
                    return self._err("Generic HTTP: url_on not configured")
                self._call(url, method, headers)
                return self._ok("ON")
            elif capability == "switch.off":
                url = str(extra.get("url_off") or "")
                if not url:
                    return self._err("Generic HTTP: url_off not configured")
                self._call(url, method, headers)
                return self._ok("OFF")
            elif capability == "switch.toggle":
                url = str(extra.get("url_toggle") or "")
                if url:
                    self._call(url, method, headers)
                    return self._ok("toggled")
                # Fallback: check status then call on or off
                status = self.get_status(device)
                if status.get("ok") and status.get("on") is not None:
                    cap = "switch.off" if status["on"] else "switch.on"
                    return self.execute(device, cap)
                return self._err("Generic HTTP: url_toggle not configured and status unavailable")
            else:
                return self._err(f"Generic HTTP: unsupported capability {capability}")
        except Exception as e:
            return self._err(f"Generic HTTP error: {e}")

    def get_status(self, device: Dict[str, Any]) -> Dict[str, Any]:
        extra = self._extra(device)
        url = str(extra.get("url_status") or "")
        if not url:
            return self._err("Generic HTTP: url_status not configured")
        on_value = str(extra.get("on_value") or "on").lower()
        try:
            r = requests.get(url, timeout=_TIMEOUT)
            text = r.text.lower()
            on: Optional[bool] = None
            if r.ok:
                try:
                    data = r.json()
                    # Check common patterns
                    for key in ("on", "state", "power", "status", "relay"):
                        val = data.get(key)
                        if val is not None:
                            on = bool(val) if isinstance(val, bool) else (str(val).lower() in ("on", "1", "true", on_value))
                            break
                except Exception:
                    on = on_value in text
            summary = ("ON" if on else "OFF") if on is not None else "UNKNOWN"
            return {"ok": True, "on": on, "summary": summary}
        except Exception as e:
            return self._err(f"Generic HTTP status error: {e}")
