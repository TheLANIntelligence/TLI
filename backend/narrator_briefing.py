"""Bounded, read-only Narrator facts from the already observed host state.

This projection performs no probes, file access, model calls or actions. The
headline policy remains responsible for timing, suppression and confirmations.
"""
from __future__ import annotations

import math
import ntpath
import posixpath

from narrator_policy import fresh_observation, valid_disks, valid_percent


MAX_DISK_ITEMS = 6


def _label(value, fallback="", limit=160):
    if not isinstance(value, str):
        return fallback
    return " ".join(value.split())[:limit] or fallback


def _timestamp(value, wall_now):
    return value if (type(value) in (int, float) and math.isfinite(value)
                     and 0 < value <= wall_now + 5) else None


def _drive_action(path):
    # Navigation only, with a literal absolute path. Never resolve a target here.
    if (ntpath.isabs(path) and ntpath.splitdrive(path)[0]) or posixpath.isabs(path):
        return {"kind": "storage", "label": "Review in Free Space", "path": path}
    return {"kind": "storage", "label": "Open Free Space"}


def build_briefing(state, policy, now, wall_now):
    """Read a serialized policy snapshot without advancing its timers."""
    observed_at = _timestamp(state.get("probed_ts"), wall_now)
    current = fresh_observation(state, wall_now)
    freshness = "current" if current else "unavailable" if state.get("probe_error") or observed_at is None else "stale"
    raw_host = state.get("host")
    host = _label(raw_host.get("name") if isinstance(raw_host, dict) else None, "This computer")
    items = []
    attention_count = 0
    summary = "Waiting for current system checks."

    if not current:
        detail = ("The last system readings are at least 30 seconds old or have an invalid time."
                  if freshness == "stale" else "A successful current system check is unavailable.")
        items.append({"id": "monitoring", "kind": "monitoring", "severity": "warning",
                      "title": "System checks need a fresh reading", "detail": detail,
                      "source": "Host monitoring", "observed_at": observed_at,
                      "action": {"kind": "diagnostics", "label": "Open Diagnostics"}})
        summary = "System checks are stale." if freshness == "stale" else "System monitoring is unavailable."
        attention_count = 1
    else:
        disks = valid_disks(state)
        disk_warnings = sorted(((path, pct) for path, pct in disks.items() if pct >= 85),
                               key=lambda row: (-row[1], row[0].casefold(), row[0]))
        attention_count += len(disk_warnings)
        for path, pct in disk_warnings[:MAX_DISK_ITEMS]:
            critical = pct >= 95
            items.append({"id": "disk:" + path, "kind": "disk",
                          "severity": "critical" if critical else "warning",
                          "title": f"{_label(path)} · {pct:.0f}% used",
                          "detail": "Critically full. Review large files and folders." if critical else "Storage is filling up. Review what is using space.",
                          "source": "Host storage reading", "observed_at": observed_at,
                          "target": {"kind": "drive", "path": path}, "action": _drive_action(path)})

        missing = []
        resource_count = 0
        elevated = []
        for key, label in (("cpu_pct", "CPU"), ("ram_pct", "RAM")):
            value = state.get(key)
            if not valid_percent(value):
                missing.append(label)
                continue
            pressure = policy.pressure[key]
            if pressure.active:
                resource_count += 1
                detail = (f"Usage stayed at or above 90% for 30 seconds. Latest reading: {value:.0f}%."
                          if value >= 90 else f"Latest reading: {value:.0f}%. Waiting for 30 seconds below 90% before clearing this warning.")
                items.append({"id": key, "kind": key, "severity": "warning",
                              "title": f"{label} pressure", "detail": detail,
                              "source": "Host resource readings", "observed_at": observed_at,
                              "action": {"kind": "diagnostics", "label": "Open Diagnostics"}})
            elif value >= 90:
                elevated.append(label)
        attention_count += resource_count
        raw_disks = state.get("disk_pct_by_drive")
        if not disks or not isinstance(raw_disks, dict) or len(disks) != len(raw_disks):
            missing.append("storage")
        if missing:
            items.append({"id": "coverage", "kind": "monitoring", "severity": "info",
                          "title": "Some checks are unavailable", "detail": f"Missing or invalid readings: {', '.join(missing)}. These checks cannot establish current health.",
                          "source": "Host monitoring", "observed_at": observed_at})

        if attention_count:
            if resource_count == 0:
                summary = f"{attention_count} storage {'warning needs' if attention_count == 1 else 'warnings need'} your attention."
            else:
                summary = f"{attention_count} system {'warning needs' if attention_count == 1 else 'warnings need'} your attention."
        elif missing:
            summary = "Some system checks are unavailable."
        elif elevated:
            summary = f"{' and '.join(elevated)} usage is elevated; checking whether it stays high."
        else:
            summary = "Your latest system checks are within range."

    # The existing policy decides when critical events and confirmations may
    # interrupt routine observations; recorded events never become probe facts.
    if policy.critical_event and now < policy.critical_event[2] and not any(item["severity"] == "critical" for item in items):
        summary = policy.critical_event[0]
    elif policy.confirmation and now < policy.confirmation[1]:
        summary = _label(policy.confirmation[0], summary, 500)
    elif (attention_count == 0 and policy.event and policy.event[1] == "alert"
          and now < policy.event[2]):
        # Healthy resource readings do not turn a current failed action or
        # warning into a healthy headline. Measured warnings keep their own
        # summary, with the operation outcome retained in independent activity.
        summary = policy.event[0]

    result = {"version": 1, "generated_at": wall_now, "observed_at": observed_at,
              "freshness": freshness, "host": host, "summary": summary,
              "attention_count": attention_count, "items": items}
    activity = policy.activity
    if activity and now < policy.activity_expires and wall_now < activity["expires_at"]:
        result["activity"] = dict(activity)
    return result
