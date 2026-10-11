"""Bounded activity catch-up. Only the user's reviewed cursor is persisted.

The bus remains an in-memory history. A restart or overflow is a visible gap,
never evidence that nothing happened while TLI was unable to retain events.
"""
from collections import Counter

from fastapi import HTTPException
from event_bus import activity_snapshot
from intelligence.store import LOCK, read_private, write_private

_WARNINGS = {"warn", "warning", "error", "alert", "critical"}


def summarize(snapshot: dict, reviewed: dict | None) -> dict:
    cursor = snapshot["cursor"]
    events = snapshot["events"]
    first = events[0]["sequence"] if events else cursor["sequence"] + 1
    previous = (reviewed or {}).get("cursor")
    if not previous:
        coverage = "first_visit"
    elif previous["stream_id"] != cursor["stream_id"]:
        coverage = "restarted"
    elif previous["sequence"] < first - 1 or previous["sequence"] > cursor["sequence"]:
        coverage = "history_limited"
    else:
        coverage = "complete"
    after = previous["sequence"] if previous and previous["stream_id"] == cursor["stream_id"] else 0
    selected = [e for e in events if e["sequence"] > after]
    groups = {}
    for event in selected:
        key = tuple(str(event.get(k) or "") for k in ("category", "node", "title", "level"))
        group = groups.setdefault(key, {"count": 0, "first_ts": event["ts"]})
        group.update({k: event.get(k) for k in ("category", "node", "title", "level", "body", "ts", "sequence")})
        group["count"] += 1
    ranked = sorted(groups.values(), key=lambda e: (
        e["level"] == "critical", e["level"] in _WARNINGS, e["sequence"]), reverse=True)
    counts = Counter(e.get("category") or "system" for e in selected)
    notes = {
        "first_visit": "Showing retained activity. No previous review has been saved.",
        "restarted": "TLI restarted since your last review. Activity from before this start is unavailable.",
        "history_limited": "Some activity since your last review is no longer retained. This summary is incomplete.",
        "complete": "All activity recorded since your last review is included. Unobserved changes are not covered.",
    }
    result = {"ok": True, "cursor": cursor, "checked_at": snapshot["checked_at"],
            "reviewed_at": (reviewed or {}).get("reviewed_at"), "coverage": coverage,
            "coverage_note": notes[coverage], "retention_limit": snapshot["capacity"],
            "retained_since": events[0]["ts"] if events else snapshot["started_at"],
            "total": len(selected), "warning_count": sum(e.get("level") in _WARNINGS for e in selected),
            "categories": dict(counts), "groups": ranked[:6], "group_count": len(ranked),
            "events": list(reversed(selected)), "retained_events": list(reversed(events))}
    if snapshot.get("history"):
        _include_history(result, snapshot, reviewed)
    return result


def _include_history(result, snapshot, reviewed):
    history = snapshot["history"]
    live = snapshot["events"]
    keys = {(e["stream_id"], e["sequence"]) for e in live}
    retained = [e for e in history["events"] if (e["stream_id"], e["sequence"]) not in keys] + live
    retained.sort(key=lambda e: (e["ts"], e.get("history_sequence", 0), e["sequence"]))
    previous = (reviewed or {}).get("cursor", {})
    older = (reviewed or {}).get("history_cursor", {})
    def new(event):
        if event["stream_id"] == previous.get("stream_id"):
            return event["sequence"] > previous.get("sequence", -1)
        if older.get("stream_id") == history["cursor"]["stream_id"] and "history_sequence" in event:
            return event["history_sequence"] > older.get("sequence", -1)
        return True
    selected = [e for e in retained if new(e)]
    groups = {}
    for event in selected:
        key = tuple(str(event.get(k) or "") for k in ("category", "node", "title", "level"))
        group = groups.setdefault(key, {"count": 0, "first_ts": event["ts"]})
        group.update({k: event.get(k) for k in ("category", "node", "title", "level", "body", "ts", "sequence", "retained_generic")})
        group["count"] += 1
    ranked = sorted(groups.values(), key=lambda e: (e["level"] == "critical", e["level"] in _WARNINGS, e["ts"]), reverse=True)
    note = "Eligible operational events survive restarts as generic summaries. Private event details remain live-only; time while TLI was stopped was not observed."
    gaps = []
    if history["status"] != "recording":
        gaps.append("Retained activity is unavailable or could not be fully saved. Existing history was preserved; the live feed still works.")
    if history["queue_omitted"]:
        gaps.append("Some eligible events could not be retained because the recording queue was full.")
    if older and older.get("stream_id") != history["cursor"]["stream_id"]:
        gaps.append("Earlier retained history is unavailable or was replaced. Continuity with your previous review cannot be established.")
    if history["dropped"]:
        gaps.append("Older retained events were removed by the seven-day or 500-event limit.")
    if previous and previous.get("stream_id") != snapshot["cursor"]["stream_id"]:
        gaps.append("TLI restarted; detailed events from earlier sessions are unavailable. Only eligible generic summaries may remain.")
    if result["coverage"] == "history_limited":
        gaps.append("Some live details have left the 200-event buffer.")
    if history["pending"]:
        gaps.append("Recent eligible events are still waiting to be saved.")
    if not previous:
        gaps.append("No previous review has been saved.")
    result.update(history_cursor=history["cursor"], history={k: v for k, v in history.items() if k not in {"events", "cursor"}},
                  coverage="retained_partial" if gaps else "retained", coverage_note=" ".join([note, *gaps]),
                  total=len(selected), warning_count=sum(e["level"] in _WARNINGS for e in selected),
                  categories=dict(Counter(e.get("category") or "system" for e in selected)),
                  groups=ranked[:6], group_count=len(ranked), events=list(reversed(selected)), retained_events=list(reversed(retained)),
                  retained_since=retained[0]["ts"] if retained else snapshot["started_at"])


def get_summary(user: str) -> dict:
    try:
        with LOCK:
            reviewed = read_private(user, "activity-review", None)
        return summarize(activity_snapshot(), reviewed)
    except Exception as exc:
        raise HTTPException(503, "Activity summary is unavailable. Your review position was not changed.") from exc


def mark_reviewed(user: str, cursor: dict) -> dict:
    # Acknowledge the snapshot the user actually saw, never the newest event.
    with LOCK:
        snapshot = activity_snapshot()
        current = snapshot["cursor"]
        if cursor["stream_id"] != current["stream_id"] or cursor["sequence"] > current["sequence"]:
            raise HTTPException(409, "Activity changed after a restart. Refresh before marking it reviewed.")
        history_cursor = cursor.get("history_cursor")
        if history_cursor:
            actual = snapshot.get("history", {}).get("cursor", {})
            if history_cursor["stream_id"] != actual.get("stream_id") or history_cursor["sequence"] > actual.get("sequence", -1):
                raise HTTPException(409, "Retained activity changed. Refresh before marking it reviewed.")
        try:
            previous = read_private(user, "activity-review", None)
            old = (previous or {}).get("cursor", {})
            old_history = (previous or {}).get("history_cursor", {})
            if old.get("stream_id") == cursor["stream_id"] and old.get("sequence", -1) >= cursor["sequence"] and (
                    not history_cursor or (old_history.get("stream_id") == history_cursor["stream_id"] and old_history.get("sequence", -1) >= history_cursor["sequence"])):
                return {"ok": True, **previous}
            live_cursor = {k: cursor[k] for k in ("stream_id", "sequence")}
            if old.get("stream_id") == live_cursor["stream_id"]:
                live_cursor["sequence"] = max(old.get("sequence", 0), live_cursor["sequence"])
            reviewed = {"cursor": live_cursor, "reviewed_at": snapshot["checked_at"]}
            if history_cursor:
                reviewed["history_cursor"] = dict(history_cursor)
                if old_history.get("stream_id") == history_cursor["stream_id"]:
                    reviewed["history_cursor"]["sequence"] = max(old_history.get("sequence", 0), history_cursor["sequence"])
            elif old_history:
                reviewed["history_cursor"] = old_history
            write_private(user, "activity-review", reviewed)
            return {"ok": True, **reviewed}
        except Exception as exc:
            raise HTTPException(503, "Could not save your review position. Please retry.") from exc
