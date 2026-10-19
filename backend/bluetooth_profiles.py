"""Code-owned BLE compatibility metadata, separate from radio and wire protocols.

Advertisement matches are hints for explicit review, never enrollment, identity
proof or permission to send packets. Adding a profile requires a reviewed driver
and tests; saved data and HTTP input cannot add descriptors or executable code.
"""
from __future__ import annotations

from dataclasses import dataclass
import re

_ADDRESS = re.compile(r"(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\Z", re.ASCII)
_KEY = re.compile(r"[a-z][a-z0-9_]{0,63}\Z", re.ASCII)
_MODEL = re.compile(r"[A-Z0-9][A-Z0-9_-]{0,31}\Z", re.ASCII)
_CAPABILITIES = frozenset({"switch.on", "switch.off"})


@dataclass(frozen=True)
class Profile:
    id: str
    vendor: str
    brand: str
    model: str
    id_prefix: str
    capabilities: tuple[str, ...]
    validation: str = "experimental"

    def __post_init__(self):
        # Descriptors are source constants, not a plugin manifest format.
        if not _KEY.fullmatch(self.id) or not _KEY.fullmatch(self.vendor):
            raise ValueError("Invalid Bluetooth profile identity")
        if not _MODEL.fullmatch(self.model):
            raise ValueError("Invalid Bluetooth model token")
        if not isinstance(self.brand, str) or not 1 <= len(self.brand) <= 64 or not self.brand.isprintable():
            raise ValueError("Invalid Bluetooth brand")
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,46}-", self.id_prefix, re.ASCII):
            raise ValueError("Invalid Bluetooth record prefix")
        if (not isinstance(self.capabilities, tuple) or not self.capabilities or
                len(set(self.capabilities)) != len(self.capabilities) or
                not set(self.capabilities) <= _CAPABILITIES):
            raise ValueError("Invalid Bluetooth capability vocabulary")
        if self.validation != "experimental":
            raise ValueError("Physical Bluetooth validation has not been established")

    def public(self) -> dict:
        return {"id": self.id, "vendor": self.vendor, "brand": self.brand,
                "model": self.model, "id_prefix": self.id_prefix,
                "capabilities": list(self.capabilities), "validation": self.validation}


_PROFILES = (Profile(id="govee_h6125_v1", vendor="govee_ble", brand="Govee",
                     model="H6125", id_prefix="govee-ble-",
                     capabilities=("switch.on", "switch.off")),)


def _catalog() -> tuple[Profile, ...]:
    """Reject invalid source extensions rather than silently choosing a driver."""
    profiles = _PROFILES
    if (not isinstance(profiles, tuple) or not 1 <= len(profiles) <= 32 or
            any(not isinstance(profile, Profile) for profile in profiles)):
        raise ValueError("Bluetooth profile catalog is invalid")
    if (len({p.id for p in profiles}) != len(profiles) or
            len({(p.vendor, p.model) for p in profiles}) != len(profiles) or
            len({p.id_prefix for p in profiles}) != len(profiles)):
        raise ValueError("Bluetooth profile catalog is ambiguous")
    return profiles


def list_profiles() -> list[dict]:
    """Detached public descriptors; callers cannot mutate the catalog."""
    return [profile.public() for profile in _catalog()]


def get_profile(profile_id) -> dict | None:
    if not isinstance(profile_id, str):
        return None
    return next((profile.public() for profile in _catalog() if profile.id == profile_id), None)


def model_profiles(model) -> list[dict]:
    """Exact model match for legacy requests; ambiguity is left to the caller."""
    if not isinstance(model, str):
        return []
    return [profile.public() for profile in _catalog() if profile.model == model]


def is_bluetooth_record(row) -> bool:
    """Conservative classification also catches malformed/unknown BLE bindings."""
    if not isinstance(row, dict):
        return False
    extra = row.get("extra")
    extra = extra if isinstance(extra, dict) else {}
    vendor = row.get("vendor")
    transport = extra.get("transport")
    ip = row.get("ip")
    return (isinstance(vendor, str) and vendor.lower() in {p.vendor for p in _catalog()} or
            isinstance(transport, str) and transport.lower() == "bluetooth" or
            isinstance(ip, str) and ip.lower().startswith("ble://") or
            get_profile(extra.get("profile")) is not None)


def record_profile(row) -> dict | None:
    """Validate a registered transport binding without changing IDs or metadata."""
    if not isinstance(row, dict) or not isinstance(row.get("extra"), dict):
        return None
    extra = row["extra"]
    profile = get_profile(extra.get("profile"))
    if profile is None:
        return None
    address = extra.get("address")
    capabilities = row.get("capabilities")
    if (row.get("vendor") != profile["vendor"] or extra.get("transport") != "bluetooth" or
            extra.get("model") != profile["model"] or not isinstance(address, str) or
            not _ADDRESS.fullmatch(address) or row.get("ip") != "ble://" + address or
            type(row.get("relay", 0)) is not int or row.get("relay", 0) != 0 or
            not isinstance(capabilities, list) or capabilities != profile["capabilities"]):
        return None
    return profile


def discovery_hints(name) -> list[str]:
    """Bounded model-token suggestions; never infer support for an entire brand."""
    if not isinstance(name, str):
        return []
    text = name[:128]
    return [profile.id for profile in _catalog() if re.search(
        r"(?:^|[^A-Z0-9])" + re.escape(profile.model) + r"(?:$|[^A-Z0-9])",
        text, re.ASCII | re.IGNORECASE)]
