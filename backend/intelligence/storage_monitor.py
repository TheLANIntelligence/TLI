"""Bounded capacity trends and opt-in, session-bound scan schedules.

Reuse ambient capacity samples and the existing one-worker admission gate. No
extra disk traversal runs during a sample. Credentials are never persisted.
"""
from __future__ import annotations

from collections import deque
import copy
import secrets
import threading
import time

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from intelligence import store
import storage_jobs


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: StrictBool = False
    sample_interval_seconds: int = Field(default=120, ge=60, le=3600, strict=True)
    warn_percent: int = Field(default=85, ge=50, le=98, strict=True)
    critical_percent: int = Field(default=95, ge=51, le=99, strict=True)
    sudden_bytes: int = Field(default=5 * 1024**3, ge=1024**2, le=1024**5, strict=True)
    window_hours: int = Field(default=12, ge=1, le=168, strict=True)
    cooldown_hours: int = Field(default=6, ge=1, le=168, strict=True)
    schedule_enabled: StrictBool = False
    scan_interval_hours: int = Field(default=24, ge=6, le=168, strict=True)
    job_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")

    @model_validator(mode="after")
    def ordered(self):
        if self.critical_percent <= self.warn_percent:
            raise ValueError("Critical threshold must exceed the warning threshold")
        if self.schedule_enabled and not self.enabled:
            raise ValueError("Enable monitoring before scheduling snapshots")
        return self


_lock = threading.RLock()
_active = {}  # At most 16 live owner sessions; each has <=16 volumes * 256 samples.


def _settings(owner):
    path = store.private_path(owner, "storage_monitor", create=False)
    if path.exists() and path.stat().st_size > 32 * 1024:
        raise HTTPException(503, "Storage monitor settings exceed the bounded read limit.")
    try:
        return Settings(**store.read_private(owner, "storage_monitor", {})).model_dump(exclude={"job_id"})
    except ValueError:
        raise HTTPException(503, "Storage monitor settings are unavailable. Existing data was preserved.") from None


def _prune():
    for owner, row in list(_active.items()):
        if not row["access"].valid():
            if row.get("pending"):
                # The job supervisor also observes revocation independently.
                with storage_jobs._lock:
                    job = storage_jobs._jobs.get(row["pending"])
                    if job: job["cancel"].set()
            del _active[owner]


def status(credential):
    if not credential.valid(): raise HTTPException(401, "Unlock to view monitoring.")
    settings = _settings(credential.owner)
    with _lock:
        _prune()
        row = _active.get(credential.owner)
        if row and row["access"].key != credential.key:
            row = None
        return {"ok": True, "settings": settings, "active": bool(row),
                "schedule_scope": row.get("path") if row else None,
                "samples": {mount: list(samples) for mount, samples in row["samples"].items()} if row else {},
                "findings": copy.deepcopy(list(row["findings"])) if row else [],
                "detail": "Monitoring and scan schedules pause when their session expires, locks, or the host restarts. Reapply settings to resume. Samples run on the existing ambient-check cadence; at most 256 samples per drive are retained, so the observed window can be shorter than configured. Capacity samples identify mount points, not disk identities: replacing a disk may look like a capacity change."}


def configure(credential, values):
    cfg = Settings(**values)
    if not credential.valid(): raise HTTPException(401, "Unlock to configure monitoring.")
    path = None
    if cfg.schedule_enabled:
        if not cfg.job_id:
            raise HTTPException(422, "Select a finished scan to authorize the scheduled scope.")
        envelope = storage_jobs.results(credential, cfg.job_id)
        if envelope["job"]["operation"] != "scan" or not envelope["job"]["result_available"]:
            raise HTTPException(422, "Scheduled scope requires a finished folder scan.")
        path = envelope["result"]["meta"]["root"]
    settings = cfg.model_dump(exclude={"job_id"})
    with _lock:
        _prune()
        if cfg.enabled and credential.owner not in _active and len(_active) >= 16:
            raise HTTPException(429, "The host's active monitor limit has been reached.")
        _settings(credential.owner)
        store.write_private(credential.owner, "storage_monitor", settings)
        if _settings(credential.owner) != settings:
            raise HTTPException(503, "Monitor settings could not be confirmed.")
        previous = _active.pop(credential.owner, None)
        if previous and previous.get("pending"):
            try: storage_jobs.cancel(previous["access"], previous["pending"])
            except HTTPException: pass
        if cfg.enabled:
            _active[credential.owner] = {"access": credential, "settings": settings, "path": path,
                "samples": {}, "findings": deque(maxlen=32), "notified": {}, "pending": None,
                "next_scan": time.time() + cfg.scan_interval_hours * 3600}
    return status(credential)


def _finding(row, key, message, now, **details):
    if now - row["notified"].get(key, -float("inf")) < row["settings"]["cooldown_hours"] * 3600:
        return
    if len(row["notified"]) >= 64:
        del row["notified"][min(row["notified"], key=row["notified"].get)]
    row["notified"][key] = now
    row["findings"].append({"at": now, "kind": key.split(":", 1)[0], "message": message, **details})
    # The event bus is host-wide. Never put owner paths, sizes or file names in it.
    from event_bus import emit_event
    emit_event("system", "warn", "Storage trend needs review", "A configured storage monitor detected a capacity change or threshold. Open Free Space to review your session's measured evidence. No files were changed.")


def sample(mount, total, used, free, *, now=None):
    """Consume one existing OS capacity observation; no filesystem reads here."""
    now = time.time() if now is None else now
    if any(type(x) is not int or x < 0 for x in (total, used, free)) or total <= 0 or used > total or free > total:
        return
    with _lock:
        _prune()
        for row in _active.values():
            cfg = row["settings"]
            samples = row["samples"].get(mount)
            if samples is None:
                if len(row["samples"]) >= 16: continue
                samples = row["samples"][mount] = deque(maxlen=256)
            if samples and (total != samples[-1]["total"] or now < samples[-1]["at"]): samples.clear()
            if samples and now - samples[-1]["at"] < cfg["sample_interval_seconds"]: continue
            cutoff = now - cfg["window_hours"] * 3600
            while samples and samples[0]["at"] < cutoff: samples.popleft()
            samples.append({"at": now, "total": total, "used": used, "free": free})
            pct = used * 100 / total
            if pct >= cfg["warn_percent"]:
                critical = pct >= cfg["critical_percent"]
                _finding(row, ("critical:" if critical else "capacity:") + mount, f"{mount}: {pct:.1f}% used, {free:,} bytes available. Review storage before cleanup.", now, mount=mount, critical=critical)
            if len(samples) >= 2:
                loss = samples[0]["free"] - free
                elapsed = now - samples[0]["at"]
                if loss >= cfg["sudden_bytes"]:
                    _finding(row, "growth:" + mount, f"{mount} lost {loss:,} bytes of free space over {elapsed / 3600:.2f} hours. A scan is recommended to identify contributors; capacity alone cannot identify files.", now, mount=mount, free_loss_bytes=loss, elapsed_seconds=elapsed)
            if len(samples) >= 4:
                recent = list(samples)[-4:]
                if all(a["free"] > b["free"] for a, b in zip(recent, recent[1:])) and recent[0]["free"] - free >= cfg["sudden_bytes"]:
                    _finding(row, "sustained:" + mount, f"{mount}: free space fell across four consecutive observations. Compare snapshots for file evidence.", now, mount=mount)


def tick(*, now=None):
    """Called by ambient checks. Launch only explicitly armed bounded Quick scans."""
    now = time.time() if now is None else now
    with _lock:
        _prune()
        for row in _active.values():
            credential = row["access"]
            if row["pending"]:
                job = None
                try:
                    job = storage_jobs.status(credential, row["pending"])["job"]
                    if job["status"] not in storage_jobs.TERMINAL: continue
                    if job["result_available"]:
                        result = storage_jobs.results(credential, job["id"])["result"]
                        receipt = result.get("meta", {}).get("saved_scan", {})
                        if receipt.get("available"):
                            from intelligence.storage_history import save, history, compare
                            with store.LOCK:
                                earlier = history(credential.owner)["snapshots"]
                                prior = next((s for s in earlier if s["root"] == row["path"]), None)
                                difference = compare(credential.owner, prior["id"], receipt["scan_id"]) if prior else None
                                if not credential.valid():
                                    raise HTTPException(401, "The scheduled scan session ended.")
                                saved = save(credential.owner, receipt["scan_id"])
                            if prior:
                                evidence = {"scan_id": receipt["scan_id"], "baseline_id": prior["id"],
                                            "baseline_retained": prior["id"] not in saved.get("removed_ids", []),
                                            "logical_delta_bytes": (difference.get("totals") or {}).get("delta_bytes")}
                                if difference.get("comparable") and (difference.get("totals") or {}).get("delta_bytes", 0) >= row["settings"]["sudden_bytes"]:
                                    _finding(row, "scan_growth:" + row["path"], "Scheduled snapshots measured significant logical file growth. Review history for retained evidence; retention may remove the earlier baseline.", now, **evidence)
                                if difference.get("comparable") and any(f.get("status") == "added" and (f.get("after_bytes") or 0) >= row["settings"]["sudden_bytes"] for f in difference.get("files", [])):
                                    _finding(row, "large_file:" + row["path"], "A large file path appeared between complete snapshots. A rename or move may also explain it; retention may remove the earlier baseline.", now, **evidence)
                            if job["status"] != "completed":
                                _finding(row, "schedule_partial", "A scheduled scan retained incomplete coverage. Review its history before drawing storage-growth conclusions.", now, scan_id=receipt["scan_id"])
                        else:
                            _finding(row, "schedule_unavailable", "A scheduled scan did not provide a usable snapshot receipt. Review Free Space before retrying.", now)
                    else:
                        _finding(row, "schedule_failed", "A scheduled storage scan stopped without usable results. Review Free Space; no files were changed.", now)
                except HTTPException:
                    _finding(row, "schedule_unavailable", "A scheduled scan or its history could not be retained. Check scan coverage and history retention; no files were changed.", now)
                finally:
                    # A running job must remain owned; do not discard its receipt.
                    if job and job.get("status") not in storage_jobs.TERMINAL:
                        pass
                    else: row["pending"] = None
            if not row["settings"]["schedule_enabled"] or row["pending"] or now < row["next_scan"]: continue
            try:
                envelope = storage_jobs.start(credential, {"operation": "scan", "path": row["path"], "profile": "quick", "include_excluded": False, "request_id": "monitor-" + secrets.token_hex(12)}, internal=True)
                row["pending"] = envelope["job"]["id"]
                row["next_scan"] = now + row["settings"]["scan_interval_hours"] * 3600
            except HTTPException as exc:
                row["next_scan"] = now + (120 if exc.status_code == 409 else 3600)
                if exc.status_code not in (401, 409):
                    _finding(row, "schedule_unavailable", "The scheduled storage scan could not start. Check Free Space before retrying.", now)
