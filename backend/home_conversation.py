"""Deterministic home conversations using the authenticated host's device services.

The model never selects a network address or decides whether a command succeeded.
Only complete requests naming one registered device reach an existing driver.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import HTTPException, Response

import tli_state as S
from action_results import driver_succeeded
from browser_authority import browser_control_access
from companion_auth import operation_access, resolve_user
from device_resolution import normalize, resolve
from intelligence import devices
from license_gate import gate
from routers import home_power, shelly_routes


_license = gate("home_automation")
_LIST = re.compile(r"(?:what|which) (?:smart |shelly |home )?devices (?:are (?:configured|registered)|do (?:i|we|you) have)|list (?:my |our |the )?(?:smart |shelly |home )devices")
_CONTROL = (
    ("on", r"(?:turn|switch|power) on (?:the )?(.+)"),
    ("off", r"(?:turn|switch|power) off (?:the )?(.+)"),
    ("on", r"turn (?:the )?(.+?) on"),
    ("off", r"turn (?:the )?(.+?) off"),
    ("toggle", r"(?:toggle|flip) (?:the )?(.+)"),
)
_CLAUSE = re.compile(r"[\n\r;\"`]|\b(?:and|or|then|if|unless|after|before|because|when|while|tomorrow|tonight|for|in\s+\d)\b")


class _HomeReply(str):
    """Carry original authority through chat persistence and response frames."""
    def __new__(cls, text, check):
        check()
        value = super().__new__(cls, text)
        value.authorize = check
        return value


def _access(request):
    """Browser controls or the existing paired native Companion home contract."""
    if not request.headers.getlist("authorization"):
        check = browser_control_access(request, Response())
        user = resolve_user(request)
        check()
        return user, check
    # Native clients send a single HTTPS Bearer credential, without browser
    # cookies/origin metadata. Never downgrade a conflicting or revoked token.
    if len(request.headers.getlist("authorization")) != 1:
        raise HTTPException(401, "Supply one Companion credential.")
    if any(k in ("cookie", "origin", "forwarded") or k.startswith(("sec-fetch-", "x-forwarded-", "x-tli-peer-"))
           for k in request.headers):
        raise HTTPException(403, "Use a direct paired Companion connection or the unlocked TLI browser.")
    try:
        address = urlsplit(str(request.base_url))
        if (len(request.headers.getlist("host")) != 1 or not address.hostname
                or address.username or address.password or address.scheme != "https"
                or address.port is not None and not 1 <= address.port <= 65535):
            raise ValueError()
    except ValueError:
        raise HTTPException(403, "Use the paired Companion HTTPS address.") from None
    user = resolve_user(request)
    return user, operation_access(request, user)


def _checked(check, operation):
    check()
    try:
        result = operation()
    except Exception:
        check()
        raise
    check()
    return result


def _query(text: str) -> str:
    q = str(text or "").strip().lower().replace("’", "'").rstrip("?!. ")
    q = re.sub(r"^(?:hey|hi|hello)(?:,\s*|\s+)", "", q, count=1)
    q = re.sub(r"^(?:please[\s,]+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please[\s,]+)?", "", q, count=1)
    return re.sub(r"(?:,\s*|\s+)please$", "", q).strip()


def _registry(check) -> list[dict]:
    """Reuse the shared view: names, aliases, room and deduplicated relay IDs."""
    legacy = _checked(check, S.load_shelly_registry)
    runtime = _checked(check, home_power.get_runtime)
    home = _checked(check, runtime.load_devices)
    rows = []
    for d in _checked(check, devices.inventory)["devices"]:
        if d.get("kind") != "smart_device":
            continue
        aliases = d.get("aliases") or []
        aliases = [aliases] if isinstance(aliases, str) else list(aliases)
        if d.get("source_id"):
            aliases.append(d["source_id"])
        # The shared view prefers homepower and display-name overlays. Keep
        # previously configured names/aliases for the same physical relay so
        # adding a routine or renaming a display does not break old commands.
        originals = [item for item in home if d["source"] == "homepower" and item.get("device_id") == d["source_id"]]
        if d.get("vendor") == "shelly":
            originals += [item for item in legacy if str(item.get("ip") or item.get("host") or "").strip().lower() == str(d.get("address") or "").strip().lower()
                          and item.get("relay", 0) == d.get("relay", 0)]
        for original in originals:
            aliases.extend(v for v in (original.get("name"), original.get("label"), original.get("device_id"), original.get("id")) if v)
            configured = original.get("aliases") or []
            aliases.extend([configured] if isinstance(configured, str) else configured)
        if d.get("room") and d.get("name"):
            aliases.extend((f"{d['room']} {d['name']}", f"{d['name']} in {d['room']}", f"{d['name']} in the {d['room']}"))
        rows.append({**d, "aliases": aliases, "ip": d.get("address"), "device_id": d["id"]})
    check()
    return rows


def _label(device: dict) -> str:
    # Registry labels are data, not Markdown structure or chat instructions.
    return re.sub(r"([\\`*_{}\[\]<>])", r"\\\1", str(device.get("name") or device["id"]))


def _exact_target(target: str, rows: list[dict]) -> bool:
    for d in rows:
        aliases = d.get("aliases") or []
        aliases = [aliases] if isinstance(aliases, str) else aliases
        if normalize(target) in {normalize(v) for v in (d.get("name"), d.get("id"), d.get("source_id"), *aliases) if v}:
            return True
    return False


def _current(device: dict, check) -> dict:
    """Refuse a renamed, removed or rebound target between resolution and use."""
    matches = [d for d in _registry(check) if d["id"] == device["id"]]
    fields = ("id", "source", "source_id", "vendor", "address", "relay", "name", "aliases")
    if len(matches) != 1 or any(matches[0].get(k) != device.get(k) for k in fields):
        raise HTTPException(409, "Device details changed. Review the registered device and ask again; no command was sent.")
    return matches[0]


def _read(device: dict, user: str, check) -> dict:
    if device["source"] == "homepower":
        return home_power.get_device_status(device["source_id"], _s=user, check=check)
    if device["source"] == "shelly":
        return shelly_routes.shelly_status(ip=device["address"], relay=device["relay"], _s=user, _l=None, check=check)
    raise HTTPException(422, "This registered device has no supported local status reader.")


def _command(device: dict, action: str, user: str, check) -> dict:
    # Retain an in-process outcome even if access ends after dispatch. This is
    # per invocation, not a promise of durable deduplication across chat retries.
    request_id = uuid4().hex
    if device["source"] == "homepower":
        rt = _checked(check, home_power.get_runtime)
        rows = [d for d in _checked(check, rt.load_devices) if d.get("device_id") == device["source_id"]]
        if len(rows) != 1 or "switch." + action not in (rows[0].get("capabilities") or []):
            raise HTTPException(422, "This device does not advertise that switch capability. No command was sent.")
        return home_power.execute_device(device["source_id"], home_power.ExecuteDeviceRequest(capability="switch." + action, request_id=request_id), _s=user, check=check)
    if device["source"] == "shelly":
        return shelly_routes.shelly_relay(shelly_routes.ShellyRelayRequest(ip=device["address"], relay=device["relay"], action=action, request_id=request_id), user=user, _l=None, check=check)
    raise HTTPException(422, "This registered device has no supported local control driver.")


def _status_text(device: dict, reading: object) -> str:
    name = _label(device)
    if not isinstance(reading, dict) or not driver_succeeded(reading) or type(reading.get("on")) is not bool:
        return f"The current state of **{name}** could not be verified. An unavailable reading does not mean it is off."
    parts = [f"**{name}** is **{'ON' if reading['on'] else 'OFF'}**"]
    raw = reading.get("raw")
    switch = raw.get(f"switch:{device['relay']}") if isinstance(raw, dict) else None
    if isinstance(switch, dict):
        for key, unit in (("apower", "W"), ("voltage", "V"), ("current", "A")):
            value = switch.get(key)
            if type(value) in (float, int) and math.isfinite(value):
                parts.append(f"{value:g} {unit}")
    checked = reading.get("checked_at")
    if type(checked) in (int, float) and math.isfinite(checked):
        try:
            stamp = datetime.fromtimestamp(checked, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
            parts.append(f"checked {stamp}")
        except (ValueError, OverflowError, OSError):
            pass
    return " · ".join(parts) + ". This reading describes the switch, not the health of what it powers."


def answer(request, text: str) -> str | None:
    """Return a complete home answer, or None when no whole-message intent fits.

    Capture browser/Companion authentication before private inventory reads.
    Internal calls retain the same user, access check and shared command
    lock as the panels, with no self-HTTP request or session-cookie forwarding.
    """
    from ai.intent_engine import _shelly_status_target, _SHELLY_STATUS_PATTERNS
    from ai.status_answers import is_status_question

    query = _query(text)
    if not query or len(query) > 2000 or is_status_question(text):
        return None
    action, target = None, None
    for effect, pattern in _CONTROL:
        match = re.fullmatch(pattern, query)
        if match:
            action, target = effect, match.group(1)
            break
    listing = bool(_LIST.fullmatch(query))
    # The preliminary check is read-only and avoids inventory reads for prose.
    if not action and not listing and not any(re.fullmatch(pattern, query) for pattern in _SHELLY_STATUS_PATTERNS):
        return None
    user, check = _access(request)
    check = home_power._capture(check)

    def run():
        _checked(check, _license)
        rows = _registry(check)
        if listing:
            if not rows:
                return "No smart devices are registered with this TLI host yet. Open Smart devices to add a Shelly or another supported device."
            names = [f"- **{_label(d)}**" + (f" · {d['room']}" if d.get("room") else "") + f" · ID: `{d['id']}`" for d in rows[:30]]
            return ("Registered smart devices on this TLI host:\n\n" + "\n".join(names) +
                    (f"\n\nShowing 30 of {len(rows)} devices." if len(rows) > 30 else "") +
                    "\n\nThese are configured devices, not a live network scan. Ask 'Check <device name or ID>' for a current reading, or 'Turn on <device name or ID>' to control one device. Use Routines to review several actions together.")
        selected = target if action else _shelly_status_target(text, rows)
        if selected is None:
            return None
        if _CLAUSE.search(selected) and not _exact_target(selected, rows):
            return "No device command was sent. Name one device and one action, or use Routines to review a sequence or schedule."
        result = _checked(check, lambda: resolve(selected, rows))
        if result.status != "resolved":
            return result.message(selected)
        device = _current(result.device, check)
        if not action:
            return _status_text(device, _checked(check, lambda: _read(device, user, check)))
        output = _checked(check, lambda: _command(device, action, user, check))
        if not driver_succeeded(output):
            if isinstance(output, dict) and output.get("outcome") == "unknown":
                return f"The {action} command for **{_label(device)}** has an unconfirmed outcome. It may have reached the device. Check its state before trying again; TLI did not retry."
            return f"**{_label(device)}** did not confirm the {action} command. Its current state is unknown; TLI did not retry."
        prefix = (f"The {action} command was sent to **{_label(device)}** over Bluetooth; its state is not yet confirmed. "
                  if output.get("acknowledged") is False else
                  f"**{_label(device)}** acknowledged the {action} command. ")
        # One fresh read after sending; never infer output from transport success.
        try:
            device = _current(device, check)
            reading = _checked(check, lambda: _read(device, user, check))
            actual = reading.get("on") if isinstance(reading, dict) and driver_succeeded(reading) else None
            if action in {"on", "off"} and type(actual) is bool and actual != (action == "on"):
                prefix += "The follow-up reading does not match the requested state. "
            return prefix + _status_text(device, reading)
        except HTTPException as exc:
            check()
            if exc.status_code in (401, 403):
                raise
            return prefix + "The follow-up state could not be verified. Check the device before trying again; TLI did not retry."
        except Exception:
            check()
            return prefix + "The follow-up state could not be verified. Check the device before trying again; TLI did not retry."

    try:
        result = _checked(check, run)
    except HTTPException as exc:
        check()
        if exc.status_code in (401, 403):
            raise
        if isinstance(exc.detail, str):
            result = exc.detail
        else:
            result = "Smart-device access is unavailable for this session or license. No device command was sent."
    except Exception:
        check()
        result = "TLI could not complete this device request. Its current state is unknown. No automatic retry was made."
    return _HomeReply(result, check) if result is not None else None
