# backend/drivers/tuya.py
"""
Tuya Local driver — uses tinytuya if installed, otherwise gracefully errors.

Install: pip install tinytuya

Device extra fields (all required for Tuya Local):
  local_key  : str — device local key (from Tuya IoT Platform or tuya-cli)
  device_id  : str — Tuya device ID
  version    : str — "3.3" (default) | "3.1" | "3.4"
  port       : int — defaults to 6668
  brightness_dp : int — DPS index for brightness (default: 2)
"""

from typing import Any, Dict
from .base import DeviceDriver


def _get_device(ip: str, device_id: str, local_key: str, version: str, port: int):
    try:
        import tinytuya  # type: ignore
        d = tinytuya.OutletDevice(device_id, ip, local_key)
        d.set_version(float(version))
        d.set_port(port)
        return d
    except ImportError:
        raise RuntimeError("tinytuya not installed — run: pip install tinytuya")


class TuyaDriver(DeviceDriver):
    vendor = "tuya"

    def execute(self, device: Dict[str, Any], capability: str) -> Dict[str, Any]:
        ip = self._ip(device)
        extra = self._extra(device)
        device_id = str(extra.get("device_id") or "")
        local_key = str(extra.get("local_key") or "")
        version = str(extra.get("version") or "3.3")
        port = int(extra.get("port") or 6668)
        if not device_id or not local_key:
            return self._err("Tuya: device_id and local_key are required in extra fields")
        try:
            d = _get_device(ip, device_id, local_key, version, port)
            if capability == "switch.on":
                d.turn_on()
                return self._ok("ON")
            elif capability == "switch.off":
                d.turn_off()
                return self._ok("OFF")
            elif capability == "switch.toggle":
                status = self.get_status(device)
                if status.get("on"):
                    d.turn_off()
                    return self._ok("OFF")
                else:
                    d.turn_on()
                    return self._ok("ON")
            elif capability == "light.brightness":
                level = int(extra.get("brightness", 100))
                dp = int(extra.get("brightness_dp") or 2)
                # Tuya brightness is typically 10–1000
                tuya_bri = max(10, min(1000, round(level * 10)))
                d.set_value(dp, tuya_bri)
                return self._ok(f"Brightness {level}%")
            else:
                return self._err(f"Tuya: unsupported capability {capability}")
        except Exception as e:
            return self._err(f"Tuya error: {e}")

    def get_status(self, device: Dict[str, Any]) -> Dict[str, Any]:
        ip = self._ip(device)
        extra = self._extra(device)
        device_id = str(extra.get("device_id") or "")
        local_key = str(extra.get("local_key") or "")
        version = str(extra.get("version") or "3.3")
        port = int(extra.get("port") or 6668)
        if not device_id or not local_key:
            return self._err("Tuya: device_id and local_key are required")
        try:
            d = _get_device(ip, device_id, local_key, version, port)
            data = d.status()
            dps = data.get("dps") or {}
            on = bool(dps.get("1") or dps.get(1))
            bri_raw = dps.get("2") or dps.get(2)
            bri_pct = round(bri_raw / 10) if bri_raw is not None else None
            summary = ("ON" if on else "OFF") + (f" · {bri_pct}%" if bri_pct is not None else "")
            return {"ok": True, "on": on, "brightness": bri_pct, "summary": summary}
        except Exception as e:
            return self._err(f"Tuya status error: {e}")
