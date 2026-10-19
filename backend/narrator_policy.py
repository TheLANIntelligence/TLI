"""Deterministic, in-memory selection for the existing dashboard Narrator."""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import math


def fresh_observation(state, wall_now):
    """A timestamp is evidence only when finite, recent, and not in the future."""
    probed = state.get("probed_ts")
    return (type(probed) in (int, float) and math.isfinite(probed) and probed > 0
            and -5 <= wall_now - probed < 30 and not state.get("probe_error"))


def valid_percent(value):
    """A missing or malformed percentage is unknown, never a zero reading."""
    return (type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 100)


def valid_disks(state):
    """Keep absent/invalid measurements unknown, including bools and NaN."""
    disks = state.get("disk_pct_by_drive")
    if not isinstance(disks, dict):
        return {}
    return {mount: value for mount, value in disks.items()
            if isinstance(mount, str) and mount and len(mount) <= 1024 and "\x00" not in mount
            and valid_percent(value)}


@dataclass
class Pressure:
    active: bool = False
    pending_since: float | None = None

    def update(self, high: bool | None, now: float) -> None:
        if high is None or high == self.active:
            self.pending_since = None
        elif self.pending_since is None:
            self.pending_since = now
        elif now - self.pending_since >= 30:
            self.active = high
            self.pending_since = None


class NarratorPolicy:
    """Caller serializes access. Clock values are supplied for deterministic tests."""

    def __init__(self):
        self.mode = "balanced"
        self.pressure = {key: Pressure() for key in ("cpu_pct", "ram_pct")}
        self.seen: OrderedDict[tuple, float] = OrderedDict()
        self.event: tuple[str, str, float] | None = None
        self.event_started = 0.0
        self.event_rank = 0
        self.pending_events: list[tuple] = []
        self.critical_event: tuple[str, str, float] | None = None
        self.confirmation: tuple[str, float] | None = None
        self.last_sample: float | None = None
        self.check_in: tuple[str, float] | None = None
        self.check_in_index = 0
        self.recovery: tuple[str, float] | None = None
        self.monitoring_lost = False
        self.activity: dict | None = None
        self.activity_expires = 0.0

    def set_mode(self, mode):
        if mode not in {"quiet", "balanced", "detailed"}:
            raise ValueError("Unknown Narrator mode")
        if mode != self.mode:
            self.mode = mode
            self.check_in = None
            if mode == "quiet":
                self.pending_events = [(message, rank) for message, rank in self.pending_events if rank > 0]
                if self.event_rank == 0:
                    self.event = None

    def explanations(self, state, now, wall_now):
        probed = state.get("probed_ts", 0)
        if not fresh_observation(state, wall_now):
            return [{"kind": "monitoring", "why": "A successful current system probe is unavailable or at least 30 seconds old.",
                     "clears_when": "A successful probe supplies a fresh reading. Missing time is not counted toward CPU/RAM warning duration."}]
        result = []
        for drive, value in valid_disks(state).items():
            if value >= 85:
                result.append({"kind": "disk", "why": f"Drive {drive} is {value:.0f}% full. Storage warnings begin at 85%; critical warnings begin at 95% immediately.",
                               "clears_when": "A successful reading falls below 85%. Missing or expired readings withdraw the suggestion without proving recovery. Falling below 95% clears critical status only. No files are removed automatically.",
                               "target": {"kind": "drive", "path": drive}, "observed_at": probed})
        for key, label in (("cpu_pct", "CPU"), ("ram_pct", "RAM")):
            pressure = self.pressure[key]
            if pressure.active or pressure.pending_since is not None:
                result.append({"kind": key, "why": f"{label} warnings require readings at or above 90% for 30 seconds. " + ("That duration was observed." if pressure.active else "The duration is still being checked."),
                               "clears_when": f"{label} readings stay below 90% for 30 seconds. A missing probe does not prove recovery."})
        if self.critical_event and now < self.critical_event[2]:
            result.append({"kind": "recorded_event", "why": "A critical event was received. Recorded events are not fresh health checks.",
                           "clears_when": "Its Narrator message expires after 30 seconds; expiration does not prove the underlying issue is fixed."})
        return result[:12]

    def confirm(self, text: str, now: float) -> None:
        self.confirmation = (text, now + 10)

    def record_activity(self, text: str, now: float, wall_now: float, observed_at=None) -> None:
        """Retain the event's original time independently of headline selection."""
        if (type(observed_at) not in (int, float) or not math.isfinite(observed_at)
                or observed_at <= 0 or observed_at > wall_now + 5):
            observed_at = wall_now
        expires_at = min(observed_at, wall_now) + 30
        self.activity = {"text": text[:500], "observed_at": observed_at, "expires_at": expires_at}
        self.activity_expires = now + max(0, expires_at - wall_now)

    def render(self, state: dict, now: float, wall_now: float,
               event: dict | None = None) -> tuple[str, str]:
        state = {**state, **{key: value if valid_percent(value := state.get(key)) else None
                            for key in self.pressure}}
        probed = state.get("probed_ts", 0)
        stale = not fresh_observation(state, wall_now)
        unavailable = bool(state.get("probe_error"))
        if stale or unavailable:
            self.check_in = None
            self.monitoring_lost = True
            for pressure in self.pressure.values():
                pressure.update(None, now)
            self.last_sample = None
        else:
            if self.monitoring_lost:
                self.recovery = ("System monitoring is responding again. Fresh checks are available.", now + 30)
                self.monitoring_lost = False
            if self.last_sample is not None and now - self.last_sample >= 30:
                for pressure in self.pressure.values():
                    pressure.pending_since = None
            self.last_sample = now
            for key, pressure in self.pressure.items():
                value = state.get(key)
                was_active = pressure.active
                pressure.update(None if value is None else value >= 90, now)
                if was_active and not pressure.active:
                    label = "CPU" if key == "cpu_pct" else "RAM"
                    self.recovery = (f"{label} usage has stayed below the warning threshold for 30 seconds.", now + 30)

        if event and event.get("title") and (self.mode != "quiet" or
                str(event.get("severity") or event.get("level") or "info") in {"warn", "warning", "alert", "critical", "error"}):
            severity = str(event.get("severity") or event.get("level") or "info")
            key = (event.get("category", ""), event.get("node", ""), event["title"], severity)
            while self.seen and now - next(iter(self.seen.values())) >= 300:
                self.seen.popitem(last=False)
            if key not in self.seen:
                self.seen[key] = now
                if len(self.seen) > 512:
                    self.seen.popitem(last=False)
                node = f" ({event['node']})" if event.get("node") else ""
                text = f"{event['title']}{node}. {event.get('body') or ''}".strip(". ")[:240] + "."
                kind = "alert" if severity in {"warn", "warning", "alert", "critical", "error"} else "status"
                rank = 2 if severity == "critical" else 1 if kind == "alert" else 0
                message = (text, kind, now + 30)
                self.record_activity(text, now, wall_now, event.get("ts"))
                spacing = 8 if self.mode != "detailed" else 6
                if not self.event or now >= self.event[2] or rank > self.event_rank or (now - self.event_started >= spacing and not self.pending_events):
                    self.event, self.event_started, self.event_rank = message, now, rank
                else:
                    # Briefly space a burst of useful changes instead of replacing
                    # a just-shown result on the very next event. Never replay old news.
                    self.pending_events.append((message, rank))
                    self.pending_events = self.pending_events[-8:]
                if severity == "critical":
                    self.confirmation = None
                    self.critical_event = message

        self.pending_events = [(message, rank) for message, rank in self.pending_events if now < message[2]]
        if self.pending_events and (not self.event or now >= self.event[2] or now - self.event_started >= (6 if self.mode == "detailed" else 8)):
            message, rank = self.pending_events.pop(0)
            self.event, self.event_started, self.event_rank = message, now, rank

        disks = valid_disks(state)
        worst = max(disks.items(), key=lambda item: item[1], default=None)
        if not stale and not unavailable and worst and worst[1] >= 95:
            self.confirmation = None
            text = f"Drive {worst[0]} is critically full ({worst[1]:.0f}%)."
            # Keep the critical condition visible without silencing all other activity.
            detail = self.event[0] if self.event and now < self.event[2] else "Open Free Space to review large files and folders."
            return f"{text} {detail}", "alert"

        if self.critical_event and now < self.critical_event[2]:
            return self.critical_event[:2]

        if self.confirmation and now < self.confirmation[1]:
            return self.confirmation[0], "confirmation"
        self.confirmation = None

        if unavailable:
            return "System monitoring is unavailable. The latest health could not be checked.", "alert"
        if stale:
            return ("System monitoring is stale. Waiting for a fresh check." if probed else
                    "System monitoring is unavailable. Waiting for the first successful check."), "status"
        if worst and worst[1] >= 85:
            detail = self.event[0] if self.event and now < self.event[2] else "Open Free Space to review what is using storage."
            return f"Drive {worst[0]} is at {worst[1]:.0f}% capacity. {detail}", "alert"
        warnings = []
        for key, label in (("cpu_pct", "CPU"), ("ram_pct", "RAM")):
            if self.pressure[key].active and state.get(key) is not None:
                warnings.append(f"{label} usage has been high (latest reading {state[key]:.0f}%).")
        if warnings:
            detail = self.event[0] if self.event and now < self.event[2] else "Open Diagnostics to investigate resource usage."
            return " ".join([*warnings, detail]), "alert"
        if self.event and now < self.event[2]:
            return self.event[:2]
        if any(state.get(key) is None for key in self.pressure) or not disks:
            return "Some system checks are unavailable. Available checks show no issues.", "status"
        if self.recovery and now < self.recovery[1]:
            return self.recovery[0], "status"
        rising = [label for key, label in (("cpu_pct", "CPU"), ("ram_pct", "RAM"))
                  if state[key] >= 90]
        if rising:
            return f"{' and '.join(rising)} usage is elevated. Checking whether it stays high for 30 seconds.", "status"
        if self.mode == "quiet":
            return "No issues detected in the latest system checks.", "status"
        # Snapshot once a minute: metric jitter must not restart the typewriter every poll.
        if not self.check_in or now >= self.check_in[1]:
            messages = (
                f"Latest checks: CPU {state['cpu_pct']:.0f}%, RAM {state['ram_pct']:.0f}%. No sustained CPU or RAM warnings.",
                f"Storage check: busiest drive {worst[0]} is {worst[1]:.0f}% full. No drive capacity warnings detected.",
                "No issues detected in the latest system checks. I'm watching for changes.",
            )
            self.check_in = (messages[self.check_in_index % len(messages)], now + (30 if self.mode == "detailed" else 60))
            self.check_in_index += 1
        return self.check_in[0], "status"
