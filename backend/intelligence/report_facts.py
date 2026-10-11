"""Bounded facts from an already-authorized saved report, without new probes.

These are a projection, never a persisted replacement or an AI health verdict.
Performance means/counts are calculated from the recorded samples. A report's
stored free-text findings cannot manufacture structured measurements here.
"""
from __future__ import annotations

import math
from statistics import fmean
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


class Identity(Strict):
    id: str | None = Field(default=None, min_length=1, max_length=256)
    name: str | None = Field(default=None, min_length=1, max_length=240)


class Process(Strict):
    name: str | None = Field(default=None, max_length=240)
    pid: int | None = Field(default=None, ge=1, le=4294967295)
    create_time: float | int | None = Field(default=None, ge=0, le=253402300799, allow_inf_nan=False)


class Check(Strict):
    id: str | None = Field(default=None, max_length=256)
    label: str = Field(max_length=240)
    status: Literal["pass", "fail", "unavailable", "unknown"]
    detail: str | None = Field(default=None, max_length=1000)
    scope: Literal["host", "host_to_device", "unknown"]


class Measurement(Strict):
    key: str = Field(max_length=64)
    label: str = Field(max_length=100)
    scope: Literal["host", "selected_process"]
    unit: Literal["percent", "bytes"]
    valid_samples: int = Field(ge=0, le=3600)
    mean: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    minimum: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    maximum: float | None = Field(default=None, ge=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def coherent(self):
        expected = METRICS.get(self.key)
        if expected is None or (self.label, self.scope, self.unit) != expected:
            raise ValueError("Measurement key, subject and unit must agree")
        values = (self.minimum, self.mean, self.maximum)
        if self.valid_samples == 0:
            if any(v is not None for v in values):
                raise ValueError("No measured values without samples")
        elif any(v is None for v in values) or not self.minimum <= self.mean <= self.maximum:
            raise ValueError("Inconsistent measured range")
        if self.unit == "percent" and self.maximum is not None and self.maximum > 100:
            raise ValueError("Percentage outside measured scope")
        if self.unit == "bytes" and self.maximum is not None and self.maximum > 9223372036854775807:
            raise ValueError("Byte measurement outside bounded resource range")
        return self


class RecordedReport(Strict):
    version: Literal[1] = 1
    report_id: str = Field(min_length=1, max_length=256)
    kind: Literal["system", "network", "device", "performance", "unknown"]
    basis: Literal["saved_report"] = "saved_report"
    host: Identity
    target: Identity | None = None
    process: Process | None = None
    recorded_at: str | None = Field(default=None, max_length=64)
    started_at: str | None = Field(default=None, max_length=64)
    finished_at: str | None = Field(default=None, max_length=64)
    duration_seconds: float | None = Field(default=None, ge=0, le=86400, allow_inf_nan=False)
    requested_duration_seconds: float | None = Field(default=None, ge=0, le=86400, allow_inf_nan=False)
    status: Literal["completed", "partial", "stopped", "failed", "unknown"]
    status_label: str = Field(max_length=100)
    recorded_samples: int | None = Field(default=None, ge=0, le=3600)
    expected_samples: int | None = Field(default=None, ge=1, le=3600)
    raw_samples_included: Literal[0] = 0
    checks: list[Check] = Field(default_factory=list, max_length=64)
    omitted_checks: int = Field(default=0, ge=0, le=10000)
    measurements: list[Measurement] = Field(default_factory=list, max_length=6)
    limitations: list[str] = Field(max_length=12)

    @model_validator(mode="after")
    def coherent(self):
        if len({m.key for m in self.measurements}) != len(self.measurements):
            raise ValueError("Duplicate measurement")
        if any(len(s) > 300 for s in self.limitations):
            raise ValueError("Unbounded limitation")
        if self.recorded_samples is not None and any(m.valid_samples > self.recorded_samples for m in self.measurements):
            raise ValueError("More usable samples than recorded samples")
        for stamp in (self.recorded_at, self.started_at, self.finished_at):
            if stamp is not None and _date(stamp) is None:
                raise ValueError("Invalid observation time")
        if self.kind != "performance" and (self.process is not None or self.measurements):
            raise ValueError("Process measurements require a performance report")
        if self.status == "completed" and self.kind == "performance":
            if (self.host.id is None or self.process is None or self.process.pid is None or self.process.create_time is None
                    or self.expected_samples is None or self.recorded_samples != self.expected_samples or len(self.measurements) != 6
                    or any(m.valid_samples != self.expected_samples for m in self.measurements)):
                raise ValueError("Complete sampling requires all recorded subjects and samples")
        return self


METRICS = {
    "host_cpu_percent": ("Host CPU", "host", "percent"),
    "host_ram_percent": ("Host RAM", "host", "percent"),
    "host_ram_used_bytes": ("Host RAM used", "host", "bytes"),
    "host_ram_total_bytes": ("Host RAM total", "host", "bytes"),
    "process_cpu_percent": ("Selected process CPU (whole host capacity)", "selected_process", "percent"),
    "process_rss_bytes": ("Selected process resident memory", "selected_process", "bytes"),
}


def _text(value, limit=240):
    return value if isinstance(value, str) and value.strip() and len(value) <= limit else None


def _identity(value):
    value = value if isinstance(value, dict) else {}
    return {"id": _text(value.get("id"), 256), "name": _text(value.get("name"))}


def _date(value):
    if not _text(value, 64):
        return None
    try:
        return value if datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo else None
    except ValueError:
        return None


def _number(value, maximum=None):
    if type(value) not in (int, float):
        return None
    try:
        return float(value) if math.isfinite(value) and value >= 0 and (maximum is None or value <= maximum) else None
    except (ValueError, OverflowError):
        return None


def _count(value, minimum=0):
    return value if type(value) is int and minimum <= value <= 3600 else None


def public_summary(value):
    if not isinstance(value, dict) or type(value.get("version")) is not int:
        return None
    try:
        return RecordedReport.model_validate(value).model_dump()
    except (ValidationError, TypeError, ValueError):
        return None


def build(report):
    if not isinstance(report, dict) or not _text(report.get("id"), 256):
        return None
    kind = report.get("kind") if report.get("kind") in ("system", "network", "device", "performance") else "unknown"
    facts = {"version": 1, "report_id": report["id"], "kind": kind, "host": _identity(report.get("host")),
             "target": _identity(report["target"]) if isinstance(report.get("target"), dict) else None,
             "recorded_at": _date(report.get("created_at")), "status": "unknown", "status_label": "Completion unknown",
             "limitations": ["Saved evidence describes its recorded time, not current computer health.",
                             "Reading this report runs no new check or repair."]}
    if kind == "performance":
        _performance(report, facts)
    else:
        rows = report.get("checks")
        if isinstance(rows, list) and len(rows) <= 10000:
            scope = "host_to_device" if kind == "device" else "host" if kind in ("system", "network") else "unknown"
            checks = []
            for row in rows[:64]:
                row = row if isinstance(row, dict) else {}
                checks.append({"id": _text(row.get("id"), 256), "label": _text(row.get("label")) or "Unnamed check",
                               "status": row.get("status") if row.get("status") in ("pass", "fail", "unavailable") else "unknown",
                               "detail": _text(row.get("detail"), 1000), "scope": scope})
            facts["checks"], facts["omitted_checks"] = checks, max(0, len(rows) - 64)
            if checks and all(c["status"] in ("pass", "fail") for c in checks) and not facts["omitted_checks"]:
                facts.update(status="completed", status_label="Check results recorded")
            elif checks:
                facts.update(status="partial", status_label="Some check results unavailable or unknown")
        facts["limitations"].append("A recorded pass or failure applies only to the named check; it does not establish repair or task completion.")
        if kind == "device":
            facts["limitations"].append("Device reachability is measured from the TLI host toward the target. It does not test physical printing or other device functions.")
        elif kind in ("system", "network"):
            if isinstance(report.get("execution"), dict) and report["execution"].get("kind") == "peer_system":
                facts["limitations"].append("These measurements were reported by the named TLI peer, not measured on the requesting TLI host or phone. Only CPU, RAM and uptime were requested; they do not establish a slowdown's cause.")
            else:
                facts["limitations"].append("These measurements were made on the TLI host, not on the requesting phone or another selected computer.")
        if kind == "network":
            facts["limitations"].append("An external connection and a DNS lookup test different paths; success of one does not establish success of the other.")
    return public_summary(facts)


def _performance(report, facts):
    data = report.get("performance")
    data = data if isinstance(data, dict) else {}
    process = data.get("process")
    process = process if isinstance(process, dict) else {}
    pid = process.get("pid")
    facts.update(process={"name": _text(process.get("name")), "pid": pid if type(pid) is int and 0 < pid <= 4294967295 else None,
                          "create_time": _number(process.get("create_time"), 253402300799)},
                 started_at=_date(data.get("started_at")), finished_at=_date(data.get("finished_at")),
                 duration_seconds=_number(data.get("duration_seconds"), 86400),
                 requested_duration_seconds=_number(data.get("requested_duration_seconds"), 86400))
    rows = data.get("samples")
    rows = rows if isinstance(rows, list) and len(rows) <= 3600 else None
    count, expected = _count(data.get("sample_count")), _count(data.get("expected_samples"), 1)
    facts["recorded_samples"] = len(rows) if rows is not None else None
    facts["expected_samples"] = expected
    inner_host = _identity(data.get("host"))["id"]
    if inner_host is not None and inner_host != facts["host"]["id"]:
        facts.update(process=None, started_at=None, finished_at=None, duration_seconds=None,
                     requested_duration_seconds=None, recorded_samples=None, expected_samples=None)
        facts["limitations"].append("The nested observation names a different host. Its process, interval and measurements cannot be attributed to this report's host.")
        return
    consistent = (type(data.get("schema_version")) is int and data["schema_version"] == 1 and rows is not None
                  and count == len(rows) and expected is not None and count <= expected
                  and facts["host"]["id"] is not None and inner_host in (None, facts["host"]["id"]))
    measurements = []
    for key, (label, scope, unit) in METRICS.items():
        values = []
        if rows is not None:
            for row in rows:
                value = _number(row.get(key), 100 if unit == "percent" else 9223372036854775807) if isinstance(row, dict) else None
                if value is not None:
                    values.append(value)
        measurements.append({"key": key, "label": label, "scope": scope, "unit": unit, "valid_samples": len(values),
                             "mean": fmean(values) if values else None,
                             "minimum": min(values) if values else None, "maximum": max(values) if values else None})
    facts["measurements"] = measurements
    status = data.get("status")
    full = consistent and count == expected and all(m["valid_samples"] == expected for m in measurements) and len(measurements) == 6
    identity_known = facts["process"]["pid"] is not None and facts["process"]["create_time"] is not None
    if consistent and status in ("partial", "stopped", "failed"):
        facts.update(status=status, status_label={"partial": "Observation partially completed", "stopped": "Observation stopped", "failed": "Observation failed"}[status])
    elif full and identity_known and status == "completed":
        facts.update(status="completed", status_label="Planned sampling completed")
    else:
        facts["limitations"].append("Completion metadata is missing or inconsistent; completion cannot be confirmed.")
    facts["limitations"].extend([
        "Sampling completion does not establish that the application's task finished or that a repair worked.",
        "Host CPU and selected-process CPU are different measurements. One process may not represent the whole application.",
        "These samples do not measure FPS, dropped frames or a causal bottleneck.",
    ])
    if not identity_known:
        facts["limitations"].append("The selected process identity is incomplete; no other process was substituted.")


def present(report):
    """Add response-only facts without writing them into encrypted history."""
    facts = build(report)
    return {**report, "recorded_facts": facts} if facts else report
