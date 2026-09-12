"""Conservative name resolution shared by chat and saved device actions."""
from __future__ import annotations

from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Literal

DEFAULT_ALIASES = {
    "external hdd": ["drive", "hard drive", "external drive", "hdd", "external", "usb drive", "storage drive", "backup drive"],
    "charger": ["charger plug", "phone charger", "charging", "charge", "charger outlet"],
}


def normalize(value: object) -> str:
    return " ".join(str(value or "").casefold().split())


def label(device: dict) -> str:
    name = device.get("name") or device.get("label") or device.get("device_id") or device.get("id") or "Device"
    host = device.get("ip") or device.get("host") or ""
    return f"{name} ({host}, relay {device.get('relay') or 0})"


@dataclass
class Resolution:
    status: Literal["resolved", "ambiguous", "not_found"]
    device: dict | None = None
    candidates: list[dict] = field(default_factory=list)

    def message(self, query: str) -> str:
        prefix = (f"Multiple devices match '{query}'. Use an exact name or device ID." if self.status == "ambiguous"
                  else f"No device matched '{query}'. Use an exact name or device ID.")
        choices = "; ".join(label(d) for d in self.candidates)
        return f"{prefix} Candidates: {choices}" if choices else prefix


def resolve(query: str, registry: list[dict], aliases: dict[str, list[str]] | None = None) -> Resolution:
    aliases = DEFAULT_ALIASES if aliases is None else aliases
    q = normalize(query)
    devices = [d for d in registry if isinstance(d, dict)]
    if not q:
        return Resolution("not_found")

    def choose(matches: list[dict]) -> Resolution:
        return Resolution("resolved", matches[0]) if len(matches) == 1 else Resolution("ambiguous", candidates=matches)

    # Explicit identifiers outrank human names. IPs may address several relays.
    identifiers = [d for d in devices if q in {normalize(d.get(k)) for k in ("device_id", "id")}]
    if identifiers:
        return choose(identifiers)
    addresses = [d for d in devices if q == normalize(d.get("ip") or d.get("host")) or
                 q == normalize(f"{d.get('ip') or d.get('host')} relay {d.get('relay') or 0}")]
    if addresses:
        return choose(addresses)
    names = [d for d in devices if q == normalize(d.get("name") or d.get("label"))]
    if names:
        return choose(names)

    def names_and_aliases(d: dict) -> set[str]:
        name = normalize(d.get("name") or d.get("label"))
        configured = d.get("aliases") or []
        if isinstance(configured, str):
            configured = [configured]
        return {name, *(normalize(a) for a in configured),
                *(normalize(a) for a in (aliases or {}).get(name, []))} - {""}

    exact_aliases = [d for d in devices if q in names_and_aliases(d)]
    if exact_aliases:
        return choose(exact_aliases)
    partial = [d for d in devices if any(q in name or name in q for name in names_and_aliases(d))]
    if partial:
        return choose(partial)
    suggested = sorted(devices, key=lambda d: max((SequenceMatcher(None, q, n).ratio()
                       for n in names_and_aliases(d)), default=0), reverse=True)
    return Resolution("not_found", candidates=suggested[:8])
