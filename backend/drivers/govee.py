# backend/drivers/govee.py
"""
Govee LAN driver — UDP control API (port 4003).

Enable in Govee app: Devices → select device → Settings → LAN Control → ON.
Device must be on the same subnet.

Device extra fields: (none required beyond ip)
  port : int — defaults to 4003
"""

import json
import socket
from typing import Any, Dict
from .base import DeviceDriver

_GOVEE_PORT = 4003
_TIMEOUT = 3.0


def _send_govee(ip: str, port: int, cmd: str, data: dict) -> dict:
    msg = json.dumps({"msg": {"cmd": cmd, "data": data}}).encode()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(_TIMEOUT)
    try:
        sock.sendto(msg, (ip, port))
        resp, _ = sock.recvfrom(1024)
        return json.loads(resp.decode())
    finally:
        sock.close()


class GoveeDriver(DeviceDriver):
    vendor = "govee"

    def execute(self, device: Dict[str, Any], capability: str) -> Dict[str, Any]:
        ip = self._ip(device)
        extra = self._extra(device)
        port = int(extra.get("port") or _GOVEE_PORT)

        try:
            if capability == "switch.on":
                _send_govee(ip, port, "turn", {"value": 1})
                return self._ok("ON")
            elif capability == "switch.off":
                _send_govee(ip, port, "turn", {"value": 0})
                return self._ok("OFF")
            elif capability == "switch.toggle":
                status = self.get_status(device)
                new_val = 0 if status.get("on") else 1
                _send_govee(ip, port, "turn", {"value": new_val})
                return self._ok("ON" if new_val else "OFF")
            elif capability == "light.brightness":
                level = int(extra.get("brightness", 100))
                _send_govee(ip, port, "brightness", {"value": max(0, min(100, level))})
                return self._ok(f"Brightness {level}%")
            else:
                return self._err(f"Govee: unsupported capability {capability}")
        except Exception as e:
            return self._err(f"Govee error: {e}")

    def get_status(self, device: Dict[str, Any]) -> Dict[str, Any]:
        ip = self._ip(device)
        extra = self._extra(device)
        port = int(extra.get("port") or _GOVEE_PORT)
        try:
            resp = _send_govee(ip, port, "devStatus", {})
            data = resp.get("msg", {}).get("data", {})
            on = bool(data.get("onOff"))
            bri = data.get("brightness")
            summary = ("ON" if on else "OFF") + (f" · {bri}%" if bri is not None else "")
            return {"ok": True, "on": on, "brightness": bri, "summary": summary}
        except Exception as e:
            return self._err(f"Govee status error: {e}")
