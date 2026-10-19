"""Read-only HomeLab projection over saved registries, without live probes."""
from __future__ import annotations

from fastapi import HTTPException

import shelly_store
import tli_state as S
from intelligence.devices import metadata, stable_id
from routers.home_power import get_runtime

MAX_COMPUTERS = 4097
MAX_DEVICES = 1512
AI_DETAIL = ("Choose local AI or a reviewed LAN model in Ask TLI. This inventory does not "
             "check model readiness or change a conversation’s selection.")


def captured_check(authorize):
    """Latch every check failure, even if a store catches or converts it."""
    failure = None

    def check():
        nonlocal failure
        if failure is not None:
            raise failure
        try:
            authorize()
        except Exception as error:
            failure = error if isinstance(error, HTTPException) else HTTPException(
                503, "Browser security state is unavailable. Reopen TLI and try again.")
            raise failure from None
    return check


def _read(operation, check):
    check()
    try:
        result = operation()
    except Exception:
        check()
        raise
    check()
    return result


def _text(value, fallback="", limit=120):
    if value is None or value == "":
        return fallback
    if not isinstance(value, str):
        raise ValueError("Invalid saved display text")
    value.encode("utf-8")
    return value[:limit]


def _computers(overlays, check):
    check()
    with S._NODE_CONFIG_LOCK:
        check()
        host = _read(S.read_node_config, check)
    check()
    if host is None or len(host.node_id) > 128:
        raise ValueError("Saved host identity is unavailable")
    host.node_id.encode("utf-8")
    with S.MESH_DIRECTORY_LOCK:
        check()
        directory = _read(S.load_mesh_directory, check)
    check()
    if len(directory) + 1 > MAX_COMPUTERS:
        raise ValueError("Saved computer count exceeds the limit")
    ident = "node-" + host.node_id
    rows = [{"id": ident, "name": _text(overlays.get(ident, {}).get("name") or host.node_name),
             "kind": "host", "role": _text(host.role, "standalone", 40), "availability": "unknown"}]
    for peer_id, peer in directory.items():
        check()
        peer_id.encode("utf-8")
        if peer_id == host.node_id:
            continue
        ident = "node-" + peer_id
        rows.append({"id": ident,
                     "name": _text(overlays.get(ident, {}).get("name") or peer.get("node_name")
                                   or peer.get("display_name"), "Registered computer"),
                     "kind": "computer", "role": _text(peer.get("role"), "registered", 40),
                     "availability": "unknown"})
    check()
    return rows


def _devices(overlays, check):
    runtime = _read(get_runtime, check)
    home = _read(lambda: runtime.load_devices(check=check), check)
    shelly = _read(lambda: shelly_store.read(S.SHELLY_REGISTRY_PATH, check=check), check)
    if not isinstance(home, list) or not isinstance(shelly, list) or len(home) + len(shelly) > MAX_DEVICES:
        raise ValueError("Invalid saved device list")
    rows, occupied = [], set()
    for source, registry in (("homepower", home), ("shelly", shelly)):
        for device in registry:
            check()
            if not isinstance(device, dict):
                raise ValueError("Invalid saved device")
            vendor = "shelly" if source == "shelly" else _text(device.get("vendor"), "shelly").lower()
            source_id = device.get("device_id") or device.get("id")
            if vendor == "shelly":
                # Only Shelly registries share the legacy address/relay identity.
                # Other HomePower drivers may use URLs or vendor-specific target
                # strings and retain their registered device identity unchanged.
                address = device.get("ip") or device.get("host")
                relay = device.get("relay") or 0
                if type(relay) is not int or not 0 <= relay <= 255:
                    raise ValueError("Invalid saved relay")
                physical = (shelly_store.address_key(address), relay)
                if source == "shelly" and physical in occupied:
                    continue
                occupied.add(physical)
                source_id = source_id or f"{address.strip()}:{relay}"
            if not isinstance(source_id, str) or not source_id or len(source_id) > 1024:
                raise ValueError("Invalid saved device identity")
            ident = stable_id(source, source_id)
            overlay = overlays.get(ident, {})
            room = overlay.get("room", device.get("room"))
            rows.append({"id": ident,
                         "name": _text(overlay.get("name") or device.get("name") or device.get("label"),
                                       "Registered device"),
                         "kind": "smart_device", "room": _text(room) if room is not None else None,
                         "availability": "unknown"})
    check()
    return rows


def _source(operation, check, available, unavailable):
    check()
    try:
        rows = operation()
    except Exception:
        # A data-source failure may be isolated; captured authority never is.
        check()
        return {"state": "unavailable", "items": [], "detail": unavailable}
    check()
    return {"state": "available", "items": rows, "detail": available}


def overview(authorize):
    check = captured_check(authorize)
    check()
    try:
        overlays = _read(metadata, check)
    except Exception:
        check()
        unavailable = {"state": "unavailable", "items": [],
                       "detail": "Saved shared device details are unavailable. Existing files were retained."}
        computers, devices = dict(unavailable), dict(unavailable)
    else:
        computers = _source(lambda: _computers(overlays, check), check,
            "Saved computer entries are registration or discovery hints. Availability has not been checked.",
            "Saved computer information is unavailable. Existing files were retained.")
        devices = _source(lambda: _devices(overlays, check), check,
            "Devices saved in HomePower and Shelly. Availability has not been checked.",
            "Saved HomePower or Shelly device information is unavailable. Existing files were retained.")
    check()
    result = {"checked_at": S.now_iso(), "sources": {"computers": computers, "devices": devices,
              "ai": {"state": "not_checked", "selection": None, "detail": AI_DETAIL}}}
    check()
    return result
