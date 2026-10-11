"""Bounded operational history. Only catalogue codes ever reach disk.

The live bus still owns detailed events. This journal deliberately cannot retain
their titles, bodies, nodes, actions, filenames, commands or account identifiers.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import queue
import re
import threading
import time
import uuid

LIMIT = 500
MAX_AGE = 7 * 86400
MAX_BYTES = 256 * 1024
QUEUE_LIMIT = 256
IDLE_CHECK_SECONDS = 60

# code -> fixed category, level, title, detail; never interpolate producer data.
CATALOGUE = {
    "started": ("system", "info", "TLI activity recording started", "This session can record eligible operational events. Time while TLI was stopped was not observed."),
    "stopped": ("system", "info", "TLI shutdown recorded", "TLI reached the activity recorder's normal shutdown step."),
    "unclean": ("system", "warn", "No clean shutdown was recorded", "The previous session has no completed activity shutdown marker. Its final activity may be missing."),
    "switch_started": ("ai", "info", "AI model switch started", "A requested model switch began."),
    "switch_done": ("ai", "ok", "AI model switch completed", "The candidate passed the runtime's checks at that time. This is not current runtime health."),
    "switch_failed": ("ai", "warn", "AI model switch failed", "The candidate was rejected; consult current AI status for recovery."),
    "ai_restored": ("ai", "ok", "Previous AI model restored", "Recovery checks passed at that time."),
    "ai_unavailable": ("ai", "warn", "Local AI was unavailable", "Local AI reported unavailable at that time; check its current status."),
    "ai_timeout": ("ai", "warn", "AI model startup timed out", "The runtime did not become ready within its startup limit."),
    "cleanup_started": ("system", "info", "Reviewed cleanup started", "An explicitly reviewed cleanup began. No private file details are retained here."),
    "cleanup_done": ("system", "ok", "Reviewed cleanup completed", "The cleanup handler reported completion. Review the original receipt for individual outcomes."),
    "cleanup_attention": ("system", "warn", "Reviewed cleanup needs attention", "The cleanup handler reported incomplete or failed outcomes. No retry was performed by this history."),
    "storage_trend": ("system", "warn", "Storage trend needs review", "A configured storage monitor reported a capacity change, threshold or scheduled-scan issue. Open Free Space to review your session's evidence. No private paths or file details are retained here."),
}
for prefix, label in (("scan", "Storage scan"), ("large", "Large-file search"), ("duplicates", "Duplicate search")):
    for suffix, level, title, detail in (
        ("started", "info", "started", "An explicit read-only scan began."),
        ("done", "ok", "finished", "The scan finished at that time. No cleanup is implied."),
        ("partial", "warn", "partially completed", "The scan inspected only part of the requested scope. No cleanup is implied."),
        ("failed", "warn", "failed", "The scan did not finish. No file changes were performed by the scan."),
    ):
        CATALOGUE[f"{prefix}_{suffix}"] = ("system", level, f"{label} {title}", detail)

# Existing producers opt in through these exact known operational titles.
# Dynamic model labels, device names and arbitrary event text never match.
KNOWN = {(category, title): code for code, (category, _, title, _) in CATALOGUE.items()
         if code not in {"started", "stopped", "unclean", "ai_unavailable"}}
KNOWN[("ai", "Local AI is unavailable")] = "ai_unavailable"


def code_for(event):
    return KNOWN.get((event.get("category"), event.get("title")))


class Journal:
    def __init__(self, directory, clock=time.time):
        self.path = Path(directory) / "activity-history.json"
        self.clock = clock
        self.lock = threading.Lock()
        self.queue = queue.Queue(maxsize=QUEUE_LIMIT)
        self.thread = None
        self.status = "unavailable"
        self.accepting = False
        self.dropped = 0
        self.omitted = 0
        self.entries = []
        self.ident = uuid.uuid4().hex
        self.sequence = 0
        self.was_clean = True

    def _load(self):
        try:
            with self.path.open("rb") as handle:
                raw = handle.read(MAX_BYTES + 1)
        except FileNotFoundError:
            return
        if len(raw) > MAX_BYTES:
            raise ValueError("Oversized journal")
        obj = json.loads(raw)
        if (not isinstance(obj, dict) or obj.get("version") != 1 or set(obj) != {"version", "id", "sequence", "clean", "dropped", "omitted", "events"}
                or not re.fullmatch(r"[a-f0-9]{32}", str(obj.get("id", "")))
                or type(obj.get("sequence")) is not int or not 0 <= obj["sequence"] < 2**53
                or type(obj.get("dropped")) is not int or obj["dropped"] < 0
                or type(obj.get("omitted")) is not int or obj["omitted"] < 0
                or type(obj.get("clean")) is not bool or not isinstance(obj.get("events"), list) or len(obj["events"]) > LIMIT):
            raise ValueError("Invalid journal")
        previous = 0
        for row in obj["events"]:
            if (not isinstance(row, dict) or set(row) != {"code", "ts", "sequence", "stream_id", "live_sequence"}
                    or row["code"] not in CATALOGUE or type(row["ts"]) not in (int, float) or not math.isfinite(row["ts"]) or row["ts"] < 0
                    or type(row["sequence"]) is not int or not previous < row["sequence"] <= obj["sequence"]
                    or not re.fullmatch(r"[a-f0-9]{32}", str(row["stream_id"]))
                    or type(row["live_sequence"]) is not int or row["live_sequence"] < 0):
                raise ValueError("Invalid event")
            previous = row["sequence"]
        self.ident, self.sequence = obj["id"], obj["sequence"]
        self.entries, self.dropped, self.was_clean = obj["events"], obj["dropped"], obj["clean"]
        self.omitted = obj["omitted"]

    def _write(self, rows, sequence, clean=False):
        cutoff = self.clock() - MAX_AGE
        retained = [row for row in rows if row["ts"] >= cutoff][-LIMIT:]
        dropped = self.dropped + len(rows) - len(retained)
        payload = json.dumps({"version": 1, "id": self.ident, "sequence": sequence, "clean": clean,
                              "dropped": dropped, "omitted": self.omitted, "events": retained}, separators=(",", ":")).encode()
        if len(payload) > MAX_BYTES:
            raise ValueError("History budget exceeded")
        # Do not create a new installation directory as a side effect of a read.
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + ".tmp-" + uuid.uuid4().hex)
        try:
            with temporary.open("xb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)
        with self.lock:
            self.entries, self.sequence, self.dropped = retained, sequence, dropped

    def start(self):
        try:
            self._load()
            self._write(self.entries, self.sequence, clean=False)
            self.status, self.accepting = "recording", True
            self.thread = threading.Thread(target=self._run, name="tli-activity-history", daemon=True)
            self.thread.start()
        except Exception:
            # Existing malformed/unreadable bytes are never reset or overwritten.
            self.status, self.accepting = "unavailable", False
        return self

    def record(self, event, code=None):
        code = code or code_for(event)
        if code not in CATALOGUE or not self.accepting:
            return
        row = {"code": code, "ts": event["ts"], "stream_id": event["stream_id"], "live_sequence": event["sequence"]}
        try:
            self.queue.put_nowait(row)
        except queue.Full:
            with self.lock:
                self.omitted += 1

    def _run(self):
        try:
            while True:
                try:
                    first = self.queue.get(timeout=IDLE_CHECK_SECONDS)
                except queue.Empty:
                    # Retention also applies while the host has no new events.
                    if any(row["ts"] < self.clock() - MAX_AGE for row in self.entries):
                        self._write(self.entries, self.sequence)
                    continue
                batch, stop = [], first is None
                if first is not None:
                    batch.append(first)
                for _ in range(63):
                    if stop:
                        break
                    try:
                        item = self.queue.get_nowait()
                    except queue.Empty:
                        break
                    if item is None:
                        stop = True
                    else:
                        batch.append(item)
                rows, sequence = list(self.entries), self.sequence
                for row in batch:
                    sequence += 1
                    rows.append({**row, "sequence": sequence})
                self._write(rows, sequence, clean=stop)
                if stop:
                    return
        except Exception:
            with self.lock:
                self.status, self.accepting = "unavailable", False

    def stop(self, timeout=5):
        self.accepting = False
        if self.thread and self.thread.is_alive():
            try:
                self.queue.put(None, timeout=min(timeout, 1))
            except queue.Full:
                self.status = "incomplete"
                return False
            self.thread.join(timeout)
            if self.thread.is_alive():
                self.status = "incomplete"
                return False
        return self.status == "recording"

    def snapshot(self):
        with self.lock:
            rows = [row for row in self.entries if row["ts"] >= self.clock() - MAX_AGE]
            events = []
            for row in rows:
                category, level, title, body = CATALOGUE[row["code"]]
                events.append({"category": category, "level": level, "title": title, "body": body, "node": "",
                               "ts": row["ts"], "sequence": row["live_sequence"], "stream_id": row["stream_id"],
                               "history_sequence": row["sequence"], "retained_generic": True})
            return {"status": self.status, "cursor": {"stream_id": self.ident, "sequence": self.sequence},
                    "events": events, "limit": LIMIT, "days": 7, "dropped": self.dropped + len(self.entries) - len(rows),
                    "queue_omitted": self.omitted, "pending": self.queue.qsize()}
