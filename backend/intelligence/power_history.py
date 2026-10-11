"""Bounded, volatile observations from existing Shelly status requests only.

No polling, persistence, power commands, energy integration or guessed readings.
Meter fields follow Shelly's Switch status schema, not its text summary.
https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/#status
"""
from collections import OrderedDict, deque
import copy
from datetime import datetime, timezone
import math
import threading
import time

import tli_state as S

MAX_TARGETS = 32
MAX_SAMPLES = 512
RETENTION_SECONDS = 24 * 60 * 60
_lock = threading.RLock()
_history = OrderedDict()


def binding(address, relay):
    """Bind before I/O; an unregistered/ambiguous target has no saved samples."""
    from intelligence import devices
    try:
        rows = [d for d in devices.inventory()["devices"] if d.get("kind") == "smart_device" and
                d.get("vendor", "shelly") == "shelly" and d.get("address") == address and d.get("relay") == relay]
        if len(rows) != 1:
            return None
        return (str(S.DATA_DIR), rows[0]["id"], address, relay)
    except Exception:
        return None  # Observation history must not break the existing status request.


def _number(value, *, minimum=None):
    if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > 1e12:
        return None
    return value if minimum is None or value >= minimum else None


def _prune(now):
    for key, rows in list(_history.items()):
        while rows and now - rows[0]["_tick"] > RETENTION_SECONDS:
            rows.popleft()
        if not rows:
            del _history[key]


def record(target, raw, *, failed=False):
    if target is None or target != binding(target[2], target[3]):
        return
    # Switch:<relay> is the authoritative component. Never borrow relay zero,
    # aggregate readings or numbers embedded in a human-readable summary.
    switch = raw.get(f"switch:{target[3]}") if isinstance(raw, dict) else None
    valid = not failed and isinstance(switch, dict) and not switch.get("errors")
    switch = switch if valid else {}
    on = switch.get("output") if isinstance(switch.get("output"), bool) else None
    energy = switch.get("aenergy") if isinstance(switch.get("aenergy"), dict) else {}
    values = {"watts": _number(switch.get("apower")), "volts": _number(switch.get("voltage"), minimum=0),
              "amps": _number(switch.get("current")), "energy_counter_wh": _number(energy.get("total"), minimum=0)}
    row = {"observed_at": datetime.now(timezone.utc).isoformat(), "on": on,
           "status": "reported" if valid and any(v is not None for v in values.values()) else "unavailable",
           **values, "missing_fields": [key for key, value in values.items() if value is None]}
    tick = time.monotonic()
    with _lock:
        _prune(tick)
        rows = _history.setdefault(target, deque(maxlen=MAX_SAMPLES))
        # Requests can finish out of order; this records reception order and
        # intervals between receptions, not a scheduled measurement cadence.
        row["seconds_since_previous"] = round(max(0, tick - rows[-1]["_tick"]), 2) if rows else None
        rows.append({**row, "_tick": tick})
        _history.move_to_end(target)
        while len(_history) > MAX_TARGETS:
            _history.popitem(last=False)


def view(device):
    result = {"status": "unavailable", "items": [], "sample_count": 0, "watts_samples": 0,
              "retention_seconds": RETENTION_SECONDS, "max_samples": MAX_SAMPLES,
              "target": {key: device.get(key) for key in ("id", "address", "relay")},
              "scope": "Readings received during existing Shelly status checks on this host. No extra polling. "
                       "Up to 512 samples per target for 24 hours, held in memory until TLI restarts. "
                       "Intervals are unobserved; no energy use or savings are estimated. A registered address and relay "
                       "do not verify a physical serial number. Energy is the device's cumulative counter and may reset."}
    if device.get("kind") != "smart_device" or device.get("vendor", "shelly") != "shelly":
        result["reason"] = "This view currently records meter fields reported by the existing Shelly driver."
        return result
    key = (str(S.DATA_DIR), device["id"], device.get("address"), device.get("relay"))
    with _lock:
        _prune(time.monotonic())
        result["items"] = [{k: copy.deepcopy(v) for k, v in row.items() if k != "_tick"} for row in _history.get(key, [])]
    result["sample_count"] = len(result["items"])
    result["watts_samples"] = sum(row["watts"] is not None for row in result["items"])
    result["status"] = "available" if result["items"] else "empty"
    result["reason"] = None if result["items"] else "No status samples for this registered target are retained. Refresh its status in Smart devices to take a reading."
    return result
