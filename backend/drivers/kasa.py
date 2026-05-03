# backend/drivers/kasa.py
"""
TP-Link Kasa legacy driver — XOR TCP protocol (port 9999).

Works with older Kasa devices (HS100, HS110, KP100, etc.) that use
the legacy encrypted LAN protocol. Newer KASA Matter/KLAP devices
are not supported here.

Device extra fields: (none required beyond ip)
  port   : int — defaults to 9999
  plug_index : int — for power strips, 0-indexed child plug (default: None = main)
"""

import json
import socket
import struct
from typing import Any, Dict
from .base import DeviceDriver

_PORT = 9999
_TIMEOUT = 3.0


def _xor_encrypt(data: bytes) -> bytes:
    key = 171
    out = []
    for b in data:
        key = key ^ b
        out.append(key)
    return bytes(out)


def _xor_decrypt(data: bytes) -> bytes:
    key = 171
    out = []
    for b in data:
        out.append(key ^ b)
        key = b
    return bytes(out)


def _kasa_send(ip: str, port: int, payload: dict) -> dict:
    msg = json.dumps(payload).encode()
    enc = _xor_encrypt(msg)
    packet = struct.pack(">I", len(enc)) + enc
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(_TIMEOUT)
    try:
        sock.connect((ip, port))
        sock.sendall(packet)
        # Read 4-byte length header
        header = b""
        while len(header) < 4:
            chunk = sock.recv(4 - len(header))
            if not chunk:
                break
            header += chunk
        if len(header) < 4:
            return {}
        length = struct.unpack(">I", header)[0]
        data = b""
        while len(data) < length:
            chunk = sock.recv(min(4096, length - len(data)))
            if not chunk:
                break
            data += chunk
        return json.loads(_xor_decrypt(data).decode())
    finally:
        sock.close()


class KasaDriver(DeviceDriver):
    vendor = "kasa"

    def _relay_cmd(self, ip: str, port: int, state: bool, plug_index: Any) -> dict:
        if plug_index is not None:
            # Power strip child plug
            payload = {
                "context": {"child_ids": [f"{plug_index:02d}"]},
                "system": {"set_relay_state": {"state": 1 if state else 0}},
            }
        else:
            payload = {"system": {"set_relay_state": {"state": 1 if state else 0}}}
        return _kasa_send(ip, port, payload)

    def _get_info(self, ip: str, port: int) -> dict:
        return _kasa_send(ip, port, {"system": {"get_sysinfo": {}}})

    def execute(self, device: Dict[str, Any], capability: str) -> Dict[str, Any]:
        ip = self._ip(device)
        extra = self._extra(device)
        port = int(extra.get("port") or _PORT)
        plug_index = extra.get("plug_index")
        if plug_index is not None:
            plug_index = int(plug_index)
        try:
            if capability == "switch.on":
                self._relay_cmd(ip, port, True, plug_index)
                return self._ok("ON")
            elif capability == "switch.off":
                self._relay_cmd(ip, port, False, plug_index)
                return self._ok("OFF")
            elif capability == "switch.toggle":
                status = self.get_status(device)
                new_state = not bool(status.get("on"))
                self._relay_cmd(ip, port, new_state, plug_index)
                return self._ok("ON" if new_state else "OFF")
            else:
                return self._err(f"Kasa: unsupported capability {capability}")
        except Exception as e:
            return self._err(f"Kasa error: {e}")

    def get_status(self, device: Dict[str, Any]) -> Dict[str, Any]:
        ip = self._ip(device)
        extra = self._extra(device)
        port = int(extra.get("port") or _PORT)
        plug_index = extra.get("plug_index")
        if plug_index is not None:
            plug_index = int(plug_index)
        try:
            resp = self._get_info(ip, port)
            sysinfo = resp.get("system", {}).get("get_sysinfo", {})
            if plug_index is not None:
                children = sysinfo.get("children") or []
                child = next((c for c in children if int(c.get("id", -1)) == plug_index), None)
                on = bool(child.get("state")) if child else False
            else:
                on = bool(sysinfo.get("relay_state"))
            alias = sysinfo.get("alias", "")
            return {"ok": True, "on": on, "alias": alias, "summary": "ON" if on else "OFF"}
        except Exception as e:
            return self._err(f"Kasa status error: {e}")
