# backend/drivers/shelly.py

from typing import Any, Dict, Optional
import re
import requests


class ShellyDriver:
    """
    Shelly Gen2 RPC driver (Plus/Gen2 devices).

    Normalizes all Shelly JSON into:
      { "raw": <json>, "summary": "<text>" }
    """

    def __init__(
        self,
        connect_timeout: float = 2.5,
        read_timeout: float = 30.0,
        debug_log=None,
    ):
        self.connect_timeout = connect_timeout
        self.read_timeout = read_timeout
        self.debug_log = debug_log

    # -----------------------------
    # internal helpers
    # -----------------------------
    def _log(self, level: str, message: str, **extra: Any) -> None:
        try:
            if callable(self.debug_log):
                self.debug_log("shelly", level, message, **extra)
        except Exception:
            pass

    def _normalize_ip(self, ip: str) -> str:
        ip = (ip or "").strip()
        ip = re.sub(r"^https?://", "", ip, flags=re.I)
        ip = ip.strip("/")
        return ip

    def _extract_summary_gen2(self, raw: Dict[str, Any], relay_index: int = 0) -> str:
        """
        Best-effort summary for Shelly Gen2 RPC status/action responses.
        Works with Shelly.GetStatus + Switch.Set/Toggle responses.
        """
        if not isinstance(raw, dict):
            return "status unavailable"

        parts = []

        # From Shelly.GetStatus:
        sw_key = f"switch:{relay_index}"
        sw = raw.get(sw_key) if isinstance(raw.get(sw_key), dict) else {}
        if sw:
            if isinstance(sw.get("output"), bool):
                parts.append("ON" if sw.get("output") else "OFF")

            a = sw.get("aenergy") if isinstance(sw.get("aenergy"), dict) else None
            if isinstance(a, dict) and isinstance(a.get("total"), (int, float)):
                # aenergy total is typically in Wh
                parts.append(f"{a.get('total'):.0f} Wh")

            if isinstance(sw.get("apower"), (int, float)):
                parts.append(f"{sw.get('apower'):.1f} W")
            if isinstance(sw.get("voltage"), (int, float)):
                parts.append(f"{sw.get('voltage'):.1f} V")
            if isinstance(sw.get("current"), (int, float)):
                parts.append(f"{sw.get('current'):.3f} A")

        # Temperature usually under "temperature:0" on some devices; keep best effort
        t0 = raw.get("temperature:0") if isinstance(raw.get("temperature:0"), dict) else None
        if isinstance(t0, dict) and isinstance(t0.get("tC"), (int, float)):
            parts.append(f"{t0.get('tC'):.1f} °C")

        # From action responses: Switch.Set / Switch.Toggle (often returns output/on)
        if not parts:
            if isinstance(raw.get("output"), bool):
                parts.append("ON" if raw.get("output") else "OFF")
            if isinstance(raw.get("on"), bool):
                parts.append("ON" if raw.get("on") else "OFF")

        return " · ".join(parts) if parts else "status loaded"

    def _get_json(self, url: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        r = requests.get(url, params=params, timeout=(self.connect_timeout, self.read_timeout))
        if not r.ok:
            raise RuntimeError(f"HTTP {r.status_code}")
        try:
            result = r.json()
        except Exception as exc:
            raise RuntimeError("Device returned invalid JSON; outcome is unconfirmed.") from exc
        if not isinstance(result, dict):
            raise RuntimeError("Device returned an unexpected response; outcome is unconfirmed.")
        return result

    # -----------------------------
    # public driver API
    # -----------------------------
    def get_status(self, ip: str, relay: int = 0) -> Dict[str, Any]:
        target_ip = self._normalize_ip(ip)
        url = f"http://{target_ip}/rpc/Shelly.GetStatus"
        from intelligence.power_history import binding, record
        observation_target = binding(target_ip, relay)

        try:
            raw = self._get_json(url)
        except Exception as exc:
            record(observation_target, None, failed=True)
            self._log("ERROR", "Gen2 status request failed", ip=target_ip, error=str(exc))
            raise

        summary = self._extract_summary_gen2(raw, relay_index=relay)
        record(observation_target, raw)
        self._log("INFO", "Gen2 status OK", ip=target_ip, relay=relay, summary=summary)
        return {"raw": raw, "summary": summary, "ip": target_ip, "relay": relay}

    def turn_on(self, ip: str, relay: int = 0) -> Dict[str, Any]:
        return self._set(ip, relay, on=True)

    def turn_off(self, ip: str, relay: int = 0) -> Dict[str, Any]:
        return self._set(ip, relay, on=False)

    def toggle(self, ip: str, relay: int = 0) -> Dict[str, Any]:
        target_ip = self._normalize_ip(ip)
        url = f"http://{target_ip}/rpc/Switch.Toggle"
        params = {"id": relay}

        try:
            raw = self._get_json(url, params=params)
        except Exception as exc:
            self._log("ERROR", "Gen2 relay action failed", ip=target_ip, action="toggle", error=str(exc))
            raise

        summary = self._extract_summary_gen2(raw, relay_index=relay)
        self._log("INFO", "Gen2 relay OK", ip=target_ip, action="toggle", relay=relay, summary=summary)
        return {"raw": raw, "summary": summary, "ip": target_ip, "relay": relay, "action": "toggle"}

    def _set(self, ip: str, relay: int, on: bool) -> Dict[str, Any]:
        target_ip = self._normalize_ip(ip)
        url = f"http://{target_ip}/rpc/Switch.Set"
        params = {"id": relay, "on": "true" if on else "false"}
        action = "on" if on else "off"

        try:
            raw = self._get_json(url, params=params)
        except Exception as exc:
            self._log("ERROR", "Gen2 relay action failed", ip=target_ip, action=action, error=str(exc))
            raise

        summary = self._extract_summary_gen2(raw, relay_index=relay)
        self._log("INFO", "Gen2 relay OK", ip=target_ip, action=action, relay=relay, summary=summary)
        return {"raw": raw, "summary": summary, "ip": target_ip, "relay": relay, "action": action}
