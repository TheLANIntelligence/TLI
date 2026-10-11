# backend/drivers/yeelight.py
"""
Yeelight driver — local TCP API (port 55443).

Enable in Yeelight app: Settings → LAN Control → ON.

Device extra fields: (none required beyond ip)
  port : int — defaults to 55443
"""

import json
import socket
import time
from typing import Any, Dict
from .base import DeviceDriver

_PORT = 55443
_TIMEOUT = 3.0
_REQ_ID = 1


def _yee_cmd(ip: str, port: int, method: str, params: list) -> dict:
    global _REQ_ID
    _REQ_ID += 1
    msg = json.dumps({"id": _REQ_ID, "method": method, "params": params}) + "\r\n"
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(_TIMEOUT)
    try:
        sock.connect((ip, port))
        sock.sendall(msg.encode())
        resp = b""
        while True:
            chunk = sock.recv(1024)
            if not chunk:
                break
            resp += chunk
            if b"\r\n" in resp:
                break
        return json.loads(resp.decode().strip())
    finally:
        sock.close()


class YeelightDriver(DeviceDriver):
    vendor = "yeelight"

    def execute(self, device: Dict[str, Any], capability: str) -> Dict[str, Any]:
        ip = self._ip(device)
        extra = self._extra(device)
        port = int(extra.get("port") or _PORT)
        try:
            if capability == "switch.on":
                _yee_cmd(ip, port, "set_power", ["on", "smooth", 500])
                return self._ok("ON")
            elif capability == "switch.off":
                _yee_cmd(ip, port, "set_power", ["off", "smooth", 500])
                return self._ok("OFF")
            elif capability == "switch.toggle":
                _yee_cmd(ip, port, "toggle", [])
                return self._ok("toggled")
            elif capability == "light.brightness":
                level = int(extra.get("brightness", 100))
                _yee_cmd(ip, port, "set_bright", [max(1, min(100, level)), "smooth", 500])
                return self._ok(f"Brightness {level}%")
            elif capability == "light.color":
                hue = int(extra.get("hue", 0))
                sat = int(extra.get("saturation", 100))
                # Convert HSV → RGB integer for Yeelight
                import colorsys
                r, g, b = colorsys.hsv_to_rgb(hue / 360, sat / 100, 1.0)
                rgb = (int(r * 255) << 16) | (int(g * 255) << 8) | int(b * 255)
                _yee_cmd(ip, port, "set_rgb", [rgb, "smooth", 500])
                return self._ok(f"Color H{hue} S{sat}")
            else:
                return self._err(f"Yeelight: unsupported capability {capability}")
        except Exception as e:
            return self._err(f"Yeelight error: {e}")

    def get_status(self, device: Dict[str, Any]) -> Dict[str, Any]:
        ip = self._ip(device)
        extra = self._extra(device)
        port = int(extra.get("port") or _PORT)
        try:
            resp = _yee_cmd(ip, port, "get_prop", ["power", "bright"])
            result = resp.get("result", [])
            on = result[0] == "on" if result else None
            bri = int(result[1]) if len(result) > 1 else None
            summary = ("ON" if on else "OFF") + (f" · {bri}%" if bri is not None else "")
            return {"ok": True, "on": on, "brightness": bri, "summary": summary}
        except Exception as e:
            return self._err(f"Yeelight status error: {e}")
