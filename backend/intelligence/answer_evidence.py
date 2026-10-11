"""Bounded source identities for the exact supplied input, never proof of truth.

Only metadata is retained. Document contents and historical note bodies must
never enter these receipts. Model output cannot manufacture a source handle.
"""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from intelligence.report_facts import RecordedReport, public_summary


class Strict(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


class Span(Strict):
    start: int = Field(ge=1, le=65537)
    end: int = Field(ge=1, le=65537)


class Source(Strict):
    handle: str = Field(pattern=r"^[NRDOC][1-9][0-9]?$", max_length=3)
    kind: Literal["note", "report", "document", "observation", "case"]
    id: str = Field(min_length=1, max_length=256)
    label: str = Field(min_length=1, max_length=240)
    provenance: str = Field(min_length=1, max_length=64)
    revision: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    saved_at: str | None = Field(default=None, max_length=64)
    observed_at: str | None = Field(default=None, max_length=64)
    host_id: str | None = Field(default=None, max_length=256)
    target_id: str | None = Field(default=None, max_length=256)
    ranges: list[Span] = Field(default_factory=list, max_length=32)

    @model_validator(mode="after")
    def coherent(self):
        if self.handle[0] != {"note": "N", "report": "R", "document": "D", "observation": "O", "case": "C"}[self.kind]:
            raise ValueError("Handle kind mismatch")
        if self.kind in ("note", "document", "case") and not self.revision:
            raise ValueError("Versioned source required")
        end = 0
        for span in self.ranges:
            if not end < span.start <= span.end:
                raise ValueError("Overlapping source ranges")
            end = span.end
        if self.kind != "document" and self.ranges:
            raise ValueError("Only documents have line ranges")
        return self


class Citation(Strict):
    reference: str = Field(min_length=3, max_length=160)
    handle: str = Field(pattern=r"^[NRDOC][1-9][0-9]?$", max_length=3)


class HistoricalNote(Strict):
    # These handles belong to a supplied historical exchange, never to the
    # current answer's source namespace or a request to reopen a saved record.
    exchange_index: int = Field(ge=1, le=32)
    note_id: str = Field(min_length=1, max_length=256)
    title: str = Field(min_length=1, max_length=120)
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    handle: str = Field(pattern=r"^N[1-8]$")
    status: Literal["changed", "unavailable"]


class History(Strict):
    checked: bool = False
    changed: int = Field(default=0, ge=0, le=512)
    unavailable: int = Field(default=0, ge=0, le=512)
    references: list[HistoricalNote] | None = Field(default=None, max_length=256)

    @model_validator(mode="after")
    def coherent(self):
        if "references" in self.model_fields_set:
            if self.references is None or not self.checked:
                raise ValueError("Historical references require an actual check")
            positions = [(r.exchange_index, r.handle) for r in self.references]
            if len(set(positions)) != len(positions) or positions != sorted(positions):
                raise ValueError("Duplicate or unordered historical handles")
            if (sum(r.status == "changed" for r in self.references) != self.changed
                    or sum(r.status == "unavailable" for r in self.references) != self.unavailable):
                raise ValueError("Historical reference counts do not match")
        return self


class Receipt(Strict):
    version: Literal[1]
    interpretation: Literal["ai", "backend"] = "ai"
    sources: list[Source] = Field(max_length=12)
    historical_notes: History = Field(default_factory=History)
    citations_checked: bool = False
    citations: list[Citation] = Field(default_factory=list, max_length=32)
    invalid_citations: int = Field(default=0, ge=0, le=10000)
    recorded_report: RecordedReport | None = None

    @model_validator(mode="after")
    def coherent(self):
        handles = {s.handle for s in self.sources}
        if len(handles) != len(self.sources):
            raise ValueError("Duplicate source handles")
        if self.recorded_report is not None:
            source = next((s for s in self.sources if s.kind == "report" and s.handle == "R1"), None)
            target_id = self.recorded_report.target.id if self.recorded_report.target is not None else None
            if (source is None or source.id != self.recorded_report.report_id or source.host_id != self.recorded_report.host.id
                    or source.target_id != target_id):
                raise ValueError("Recorded facts must belong to the supplied report")
        if not self.citations_checked and (self.citations or self.invalid_citations):
            raise ValueError("Unfinished citations")
        if not self.historical_notes.checked and (self.historical_notes.changed or self.historical_notes.unavailable):
            raise ValueError("Unchecked historical references")
        for cite in self.citations:
            source = next((s for s in self.sources if s.handle == cite.handle), None)
            if source is None or not matches(cite.reference, source.model_dump()):
                raise ValueError("Citation outside supplied source")
        return self


REFERENCE = re.compile(r"\[(?:[NRDOC][0-9]{1,5}|[^\]\n]{1,120}\.(?:txt|md|pdf|docx):L[0-9]{1,6}(?:-L?[0-9]{1,6})?)\]", re.I)


def matches(reference, source):
    if reference == f"[{source['handle']}]":
        return source["kind"] != "document"  # documents require actual supplied lines
    if source["kind"] != "document":
        return False
    match = re.fullmatch(r"\[" + re.escape(source["label"]) + r":L([0-9]+)(?:-L?([0-9]+))?\]", reference)
    if not match:
        return False
    start, end = int(match[1]), int(match[2] or match[1])
    return any(span["start"] <= start <= end <= span["end"] for span in source["ranges"])


def public_receipt(value):
    if not isinstance(value, dict) or type(value.get("version")) is not int:
        return None
    try:
        checked = Receipt.model_validate(value)
        result = checked.model_dump()
        # Preserve aggregate-only historical receipts without inventing checks.
        if "references" not in checked.historical_notes.model_fields_set:
            result["historical_notes"].pop("references", None)
        if result.get("recorded_report") is None:
            result.pop("recorded_report", None)
        return result
    except (ValidationError, ValueError, TypeError):
        return None


def build(*, notes=(), report=None, documents=(), historical_notes=None, observation=None, case=None):
    sources = []
    for index, note in enumerate(notes, 1):
        sources.append({"handle": f"N{index}", "kind": "note", "id": note["id"],
                        "label": note.get("title") or "Untitled note", "revision": note["revision"],
                        "provenance": note.get("source") or "user_memory", "saved_at": note.get("updated_at"),
                        "target_id": note.get("device_id")})
    if report:
        sources.append({"handle": "R1", "kind": "report", "id": report["id"], "label": "Saved diagnostic report",
                        "provenance": "recorded_measurement", "revision": report.get("revision"), "observed_at": report.get("created_at"),
                        "host_id": (report.get("host") or {}).get("id"), "target_id": (report.get("target") or {}).get("id")})
    for index, doc in enumerate(documents, 1):
        coverage = doc.get("coverage")
        ranges = coverage["ranges"] if coverage else [{"start": 1, "end": doc["line_count"]}]
        if not ranges:
            continue
        sources.append({"handle": f"D{index}", "kind": "document", "id": doc["sha256"], "revision": doc["sha256"],
                        "label": doc["name"], "provenance": "selected_document", "ranges": ranges})
    if observation:
        sources.append({"handle": "O1", "kind": "observation", "id": observation["topic"], "label": observation["resource"][:240],
                        "provenance": "host_observation", "observed_at": observation["observed_at"], "host_id": observation["host"]["id"]})
    if case:
        sources.append({"handle": "C1", "kind": "case", "id": case["id"], "label": case["title"], "revision": case["revision"],
                        "provenance": "user_case", "saved_at": case["updated_at"], "target_id": case.get("computer_id")})
    recorded = public_summary(report.get("recorded_facts")) if report else None
    return public_receipt({"version": 1, "interpretation": "backend" if observation else "ai", "sources": sources,
                           "historical_notes": historical_notes or {"checked": False, "changed": 0, "unavailable": 0},
                           **({"recorded_report": recorded} if recorded else {})})


def finalize(value, text):
    receipt = public_receipt(value)
    if receipt is None or not isinstance(text, str):
        return None
    valid, invalid, seen = [], 0, set()
    # Every occurrence is checked; only a bounded unique list is retained.
    for match in REFERENCE.finditer(text[:1_000_000]):
        reference = match[0]
        source = next((s for s in receipt["sources"] if matches(reference, s)), None)
        if source is None:
            invalid = min(10000, invalid + 1)
        elif reference not in seen and len(valid) < 32:
            valid.append({"reference": reference, "handle": source["handle"]})
            seen.add(reference)
    return public_receipt({**receipt, "citations_checked": True, "citations": valid, "invalid_citations": invalid})


def complete(receipts, text):
    """Finalize a server-built preparation receipt after a complete answer only."""
    value = finalize(receipts.get("evidence_context"), text)
    return {**receipts, **({"evidence_context": value} if value else {})}
