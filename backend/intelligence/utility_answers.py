"""Small read-only answers left over from the legacy bundled chat fast path.

These questions never call HTTP endpoints derived from an incoming Host header,
probe a relay or enumerate the LAN. Registry records are not live device health.
"""
from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import re

from intelligence.observed_answers import MAX_ROWS, _markdown, _plain

_PATTERNS = {
    "clock": (
        r"what(?:'s| is) (?:today's|the current|the) date", r"what date is it", r"what day is (?:it|today)",
        r"what(?:'s| is) today", r"what time is it(?: now)?", r"what is the current time", r"what year is it",
        r"(?:current|today's) (?:date|time)",
    ),
    "usb": (
        r"(?:show|list|check)(?: me)? (?:(?:my|the|this host's) )?usb devices",
        r"what usb devices (?:are connected|do i have)", r"what(?:'s| is) plugged in(?: to my computer)?",
    ),
    "vault": (
        r"is (?:my |the )?vault (?:locked|unlocked|set up|initialized)",
        r"(?:(?:what(?:'s| is)|show|check) )?(?:my |the )?vault status",
    ),
    "mesh": (
        r"(?:show|list|check)(?: me)? (?:(?:my|the) )?(?:mesh computers|mesh nodes|tli computers|other tli computers)",
        r"(?:what|which) (?:tli computers|mesh nodes) are (?:registered|connected)",
        r"(?:(?:what(?:'s| is)|show|check) )?(?:my |the )?mesh status",
    ),
    "registry": (
        r"(?:show|list|check)(?: me)? (?:(?:my|the|registered) )?(?:smart devices|smart plugs|shelly devices)",
        r"(?:what|which) (?:smart devices|smart plugs|shelly devices) (?:do i have|are registered)",
    ),
}
_PATTERNS = {topic: tuple(re.compile(pattern) for pattern in patterns) for topic, patterns in _PATTERNS.items()}


def classify(text):
    if not isinstance(text, str) or len(text) > 240:
        return None
    q = re.sub(r"\s+", " ", text.lower().replace("’", "'")).strip().rstrip("?!. ")
    q = re.sub(r"^(?:please\s+|can you\s+|could you\s+)", "", q, count=1)
    return next((topic for topic, patterns in _PATTERNS.items() if any(pattern.fullmatch(q) for pattern in patterns)), None)


def _read_json(path, empty):
    try:
        with Path(path).open("rb") as handle:
            raw = handle.read(1024 * 1024 + 1)
    except FileNotFoundError:
        return empty
    if len(raw) > 1024 * 1024:
        raise ValueError("Registry exceeds the bounded read limit")
    return json.loads(raw)


def _mesh():
    import tli_state as S
    result = _read_json(S.MESH_DIRECTORY_PATH, {})
    if not isinstance(result, dict) or any(not isinstance(value, dict) for value in result.values()):
        raise ValueError("Invalid computer registry")
    return result


def _registry():
    import tli_state as S
    shelly = _read_json(S.SHELLY_REGISTRY_PATH, [])
    home = _read_json(Path(S.DATA_DIR) / "home_power" / "devices.json", {"devices": []})
    if not isinstance(shelly, list) or not isinstance(home, dict) or not isinstance(home.get("devices"), list):
        raise ValueError("Invalid device registry")
    result = [("Shelly registry", item) for item in shelly] + [("Smart devices registry", item) for item in home["devices"]]
    if any(not isinstance(item, dict) for _, item in result):
        raise ValueError("Invalid registered device")
    return result


def _vault(request):
    from routers.system_routes import require_session
    from vault_security import get_status
    return get_status(require_session(request=request))


def answer(request, text, *, readers=None, now=None):
    topic = classify(text)
    if topic is None:
        return None
    if topic == "clock":
        moment = now or datetime.now().astimezone()
        return f"The TLI host's clock reads **{moment.strftime('%A, %B %d, %Y · %I:%M:%S %p %Z')}**. This is the host's local time, which may differ from your phone's time zone."
    if topic == "usb":
        return ("Chat has no confirmed cached USB inventory. Open **Printers & USB** and choose **Refresh** to read the host's devices. "
                "No enumeration was run by this answer; an unavailable inventory does not mean that no USB devices are connected.")
    try:
        reader = readers[topic] if readers is not None else {"mesh": _mesh, "registry": _registry, "vault": lambda: _vault(request)}[topic]
        data = reader()
        if topic == "vault":
            if not isinstance(data, dict) or any(type(data.get(key)) is not bool for key in ("is_initialized", "is_unlocked_for_user")):
                raise ValueError("Vault status unconfirmed")
            state = "not set up" if not data["is_initialized"] else "unlocked for this TLI account" if data["is_unlocked_for_user"] else "locked for this TLI account"
            return f"Your Vault is **{state}** on this host. Source: the existing Vault status reader. No Vault files or secrets were opened."
        if topic == "mesh":
            if not isinstance(data, dict) or any(not isinstance(value, dict) for value in data.values()):
                raise ValueError("Computer registry unavailable")
            lines = ["**TLI computer records** — saved on this host; current reachability was not checked."]
            for identity, item in list(data.items())[:MAX_ROWS]:
                name = item.get("display_name") or item.get("node_name") or item.get("hostname") or str(identity)
                status = _plain(item.get("status")) or "unknown"
                observed = _plain(item.get("last_seen")) or "time unavailable"
                lines.append(f"- **{_markdown(name)}** · ID {_markdown(str(identity))} · recorded status: {_markdown(status)} · last reported: {_markdown(observed)}.")
            if not data:
                lines.append("No computers are recorded in this directory. This does not establish whether other computers are on your network.")
            if len(data) > MAX_ROWS:
                lines.append(f"Showing {MAX_ROWS} of {len(data)} computer records.")
            return "\n".join(lines) + "\n\nSource: the saved mesh directory. Open Computers to review connections. No LAN scan or peer request was run."
        if not isinstance(data, list) or any(not isinstance(row, tuple) or len(row) != 2 or not isinstance(row[1], dict) for row in data):
            raise ValueError("Device registries unavailable")
        lines = ["**Registered smart-device entries** — current power and reachability were not checked."]
        for source, item in data[:MAX_ROWS]:
            name = item.get("name") or item.get("label") or item.get("device_id") or item.get("id") or "Unnamed entry"
            address = item.get("ip") or item.get("host") or "address unavailable"
            relay = item.get("relay")
            relay = str(relay) if type(relay) is int and relay >= 0 else "not specified"
            ident = item.get("device_id") or item.get("id") or "not recorded"
            lines.append(f"- **{_markdown(name)}** · {_markdown(str(address))} · relay {relay} · ID {_markdown(str(ident))} · {_markdown(source)}.")
        if not data:
            lines.append("No entries are recorded in these host registries. This was not device discovery.")
        if len(data) > MAX_ROWS:
            lines.append(f"Showing {MAX_ROWS} of {len(data)} registered entries.")
        return "\n".join(lines) + "\n\nSource: the saved Shelly and Smart devices registries. Open Smart devices to check an explicit device and relay. No device was contacted or controlled."
    except Exception:
        area = {"vault": "Vault status", "mesh": "computer directory", "registry": "smart-device registries"}[topic]
        return f"The host's {area} could not be read. Current status is unconfirmed; no empty or successful result can be inferred. Open the existing panel to check before retrying."
