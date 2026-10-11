"""Reviewed, inert copies of one saved troubleshooting record. Never writes stores."""
from __future__ import annotations

from collections import OrderedDict
import copy
import hashlib
import html
import json
import re
import secrets
import threading
import time
from typing import Annotated, Literal

from fastapi import HTTPException
from pydantic import Field, field_validator, model_validator
import tli_state as S
from intelligence import cases, chat_memory, diagnostics, memory
from intelligence.store import LOCK

PROTOCOL = "tli-case-export-v1"
MAX_BYTES = 512 * 1024
MAX_SOURCE_BYTES = 256 * 1024
TTL = 600
MAX_REVIEWS = 64
_reviews = OrderedDict()
_review_lock = threading.RLock()
WARNING = "Automatic redaction cannot find every secret. Review the entire preview before downloading or sharing. This export is unencrypted and is not a backup."
SCOPE = "Historical saved records, not current health. User statements and AI interpretations are not independently verified. No checks, repairs or AI requests ran for this export."


class Selection(cases.EvidenceRef):
    include_content: bool = False


class Redactions(cases.Strict):
    identifiers: bool = True
    terms: list[Annotated[str, Field(min_length=1, max_length=256)]] = Field(default_factory=list, max_length=40)


class Preview(cases.Strict):
    case_id: str = Field(pattern=r"^case-[a-f0-9]{32}$")
    expected_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    evidence: list[Selection] = Field(default_factory=list, max_length=32)
    redactions: Redactions = Field(default_factory=Redactions)
    format: Literal["html", "text", "json"] = "html"

    @model_validator(mode="after")
    def selected_once(self):
        keys = []
        for item in self.evidence:
            if (item.kind == "chat") != (item.message_index is not None):
                raise ValueError("Only chat evidence requires a message index")
            keys.append((item.kind, item.id, item.message_index))
        if len(set(keys)) != len(keys):
            raise ValueError("Choose each evidence item once")
        if any(not term.strip() for term in self.redactions.terms):
            raise ValueError("Redaction terms must contain text")
        return self


class Download(cases.Strict):
    selection: Preview
    review_token: str = Field(pattern=r"^[a-f0-9]{64}$")
    preview_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    reviewed: Literal[True]

    @field_validator("reviewed", mode="before")
    @classmethod
    def explicit_review(cls, value):
        if value is not True:
            raise ValueError("Explicitly review the export before downloading")
        return value


def _limited(value, limit=MAX_SOURCE_BYTES):
    try:
        raw = cases.encoded(value)
    except (ValueError, TypeError, RecursionError):
        raise HTTPException(422, "A selected record contains unsupported values. Nothing was exported.") from None
    if len(raw) > limit:
        raise HTTPException(413, "The selected export exceeds its supported size. Choose fewer evidence items; no content was silently omitted.")
    return raw


def _object(value, keys):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise HTTPException(422, "Selected evidence contains an unsupported structure.")
    return {key: copy.deepcopy(value[key]) for key in keys if key in value}


def _report(row):
    _limited(row)
    result = _object(row, ("kind", "created_at", "scope", "internet_checks"))
    result["host"] = _object(row.get("host"), ("id", "name", "node_id"))
    result["target"] = _object(row.get("target"), ("id", "name", "node_id", "address", "ip", "host", "port", "kind"))
    for original, dest, keys in (("checks", "recorded_checks", ("label", "status", "detail", "duration_ms")),
                                 ("findings", "recorded_interpretations", ("certainty", "text"))):
        values = row.get(original, [])
        if not isinstance(values, list) or len(values) > 200:
            raise HTTPException(422, "Selected evidence has an unsupported result list.")
        result[dest] = [_object(value, keys) for value in values]
        if any(v is None or any(not isinstance(part, (str, int, float, bool)) and part is not None for part in v.values()) for v in result[dest]):
            raise HTTPException(422, "Selected evidence contains unsupported check values.")
    result["suggested_next_steps_not_actions"] = copy.deepcopy(row.get("next_steps", []))
    if not isinstance(result["suggested_next_steps_not_actions"], list) or not all(isinstance(v, str) for v in result["suggested_next_steps_not_actions"]):
        raise HTTPException(422, "Selected evidence has unsupported suggestions.")
    result["recorded_user_confirmation"] = _object(row.get("verified_fix"), ("text", "confirmed_at", "source"))
    if row.get("performance") is not None:
        perf = row["performance"]
        result["recorded_performance"] = _object(perf, ("started_at", "finished_at", "status", "sample_count", "expected_samples", "scope"))
        summary = perf.get("summary", {})
        if not isinstance(summary, dict):
            raise HTTPException(422, "Selected performance evidence contains an unsupported summary.")
        result["recorded_performance"]["summary"] = {key: _object(summary[key], ("min", "max", "mean", "samples"))
            for key in ("host_cpu_percent", "host_ram_percent", "host_ram_used_bytes", "host_ram_total_bytes", "process_cpu_percent", "process_rss_bytes") if key in summary}
        result["recorded_performance"]["process"] = _object(perf.get("process"), ("name", "pid", "create_time", "exe"))
    return result


def _snapshot(user, selection):
    """Unselected source stores are never consulted; historic pointers stay pointers."""
    with LOCK, S.CONVERSATIONS_LOCK:
        row = next((r for r in cases.read_all(user)["cases"] if r["id"] == selection.case_id), None)
        if row is None:
            raise HTTPException(404, "This saved problem is unavailable to this account.")
        if cases.revision(row) != selection.expected_revision:
            raise HTTPException(409, "The problem changed. Reopen its saved version and review a new export.")
        case = _object(row, ("title", "symptom", "status", "archived", "computer", "steps", "resolution", "created_at", "updated_at"))
        for step in case["steps"]:
            step.pop("id", None)
        document = {"schema_version": 1, "kind": "tli-reviewed-troubleshooting-export", "scope": SCOPE,
                    "privacy": WARNING, "problem_record_scope": "The symptom, steps, status and resolution are the user's saved account of events, not independent measurements or proof of current health.",
                    "problem_user_record": case, "selected_evidence": []}
        known = [selection.case_id]
        if row.get("computer"):
            known.extend(v for v in row["computer"].values() if isinstance(v, str))
        for index, item in enumerate(selection.evidence):
            linked = next((e for e in row["evidence"] if cases._pointer(e) == cases._pointer(item.model_dump())), None)
            if linked is None:
                raise HTTPException(409, "Only evidence linked at this saved revision can be exported. Review and save the problem first.")
            known.append(item.id)
            evidence = {"handle": f"E{index + 1}", "kind": item.kind, "label": linked["label"], "linked_at": linked["linked_at"],
                        "classification": "historical_pointer_only", "content_included": item.include_content}
            if item.include_content:
                try:
                    current = cases.review_evidence(user, item.kind, item.id, item.message_index)
                except HTTPException as exc:
                    if exc.status_code in (404, 409, 422):
                        raise HTTPException(409, "Selected evidence is unavailable or no longer matches. Keep it as a historical pointer, or review and save the latest source first.") from None
                    raise
                if current["revision"] != item.revision:
                    raise HTTPException(409, "Selected evidence changed since linking. Its earlier body was not reconstructed; review the latest source first.")
                if item.kind == "note":
                    source = next(n for n in memory.list_facts(user) if n["id"] == item.id)
                    evidence.update(classification="historical_saved_note", content=_object(source, ("title", "text", "category", "source", "created_at", "updated_at")))
                elif item.kind == "chat":
                    source = chat_memory._owned(item.id, user)["messages"][item.message_index]
                    evidence.update(classification="ai_interpretation" if source["role"] == "assistant" else "user_statement",
                                    content=_object(source, ("role", "content", "ts")))
                else:
                    source = diagnostics.get_report(user, item.id)
                    evidence.update(classification="historical_observation", content=_report(source))
                    evidence["export_scope"] = "Selected report summary: recorded checks, interpretations, suggested next steps and any recorded user confirmation. Performance summaries include recorded process creation time when available; a PID alone is not a stable process identity. Raw samples, full device inventory, internal receipts, attachments and other reports are excluded."
                    for target in (source.get("host"), source.get("target")):
                        if isinstance(target, dict):
                            known.extend(v for k, v in target.items() if k in ("id", "name", "node_id", "address", "host", "ip", "mac") and isinstance(v, str))
                _limited(evidence)
            else:
                evidence["scope"] = "Historical link only. Source content and current availability were not checked or included."
            document["selected_evidence"].append(evidence)
        _limited(document)
        return document, known


def _redact(document, options, known):
    substitutions = 0
    terms = sorted(set(options.terms + ([v for v in known if v] if options.identifiers else [])), key=len, reverse=True)
    # These bounded patterns are conveniences, never a complete secret detector.
    patterns = [re.compile(re.escape(term), re.IGNORECASE) for term in terms]
    if options.identifiers:
        patterns += [re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
                     re.compile(r"\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b", re.I),
                     re.compile(r"\b[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+\b"),
                     re.compile(r"(?i)\b[A-Z]:[\\/][^\r\n\t\"<>]*"),
                     re.compile(r"\\\\[^\s<>]+"),
                     re.compile(r"(?<!\w)/(?:home|Users|mnt|media)/[^\r\n\t\"<>]*")]
    def scrub(value, key=None):
        nonlocal substitutions
        if options.identifiers and key in ("id", "name", "node_id", "address", "host", "ip", "mac", "exe", "pid") and not isinstance(value, (dict, list)) and value is not None:
            substitutions += 1
            return "[identifier redacted]"
        if isinstance(value, str):
            for pattern in patterns:
                value, count = pattern.subn("[redacted]", value)
                substitutions += count
            return value
        if isinstance(value, dict):
            return {k: scrub(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [scrub(v) for v in value]
        return value
    # Structural source classifications and warnings must survive even when a
    # user's literal redaction term happens to match an ordinary metadata word.
    result = copy.deepcopy(document)
    result["problem_user_record"] = scrub(document["problem_user_record"])
    result["selected_evidence"] = []
    for item in document["selected_evidence"]:
        cleaned = copy.deepcopy(item)
        cleaned["label"] = scrub(item["label"])
        if "content" in item:
            cleaned["content"] = scrub(item["content"])
        result["selected_evidence"].append(cleaned)
    result["redaction_review"] = {"identifiers_enabled": options.identifiers, "literal_terms_count": len(options.terms),
                                  "replacement_count": substitutions, "scope": WARNING}
    return result


def _text(document):
    """Readable hierarchy, with source classifications kept visible in every format."""
    lines = ["TLI · Reviewed troubleshooting export", "", SCOPE, "", WARNING, ""]
    def walk(value, depth=0):
        if isinstance(value, dict):
            for key, part in value.items():
                lines.append("  " * depth + key.replace("_", " ") + ":")
                walk(part, depth + 1)
        elif isinstance(value, list):
            if not value:
                lines.append("  " * depth + "(none)")
            for item in value:
                walk(item, depth + 1)
                lines.append("")
        else:
            lines.extend("  " * depth + line for line in str(value if value is not None else "Not recorded").splitlines())
    walk({k: v for k, v in document.items() if k not in ("schema_version", "kind", "scope", "privacy")})
    return "\n".join(lines) + "\n"


def render(document, format):
    if format == "json":
        text = json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        media = "application/json"
    elif format == "text":
        text, media = _text(document), "text/plain"
    else:
        body = html.escape(_text(document), quote=True)
        text = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>TLI troubleshooting export</title><style>body{margin:0;background:#f4f6f5;color:#18342b;font:16px/1.6 system-ui,sans-serif}main{max-width:72rem;margin:auto;padding:clamp(1rem,4vw,3rem)}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;background:white;border:1px solid #cad8d0;border-radius:16px;padding:clamp(1rem,3vw,2rem)}</style></head><body><main><pre>' + body + '</pre></main></body></html>'
        media = "text/html"
    raw = text.encode("utf-8")
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "The rendered export is too large. Choose fewer evidence items; no content was silently omitted.")
    return raw, media


def prepare(user, selection):
    document, known = _snapshot(user, selection)
    document = _redact(document, selection.redactions, known)
    raw, media = render(document, selection.format)
    return document, raw, media


def preview(user, selection):
    document, raw, media = prepare(user, selection)
    now = time.monotonic()
    token = secrets.token_hex(32)
    entry = {"owner": user, "request_sha256": cases.revision(selection.model_dump()), "sha256": hashlib.sha256(raw).hexdigest(), "expires": now + TTL}
    with _review_lock:
        for key in list(_reviews):
            if _reviews[key]["expires"] <= now:
                _reviews.pop(key)
        mine = [key for key in _reviews if _reviews[key]["owner"] == user]
        if len(mine) >= 4:
            _reviews.pop(mine[0])
        if len(_reviews) >= MAX_REVIEWS:
            raise HTTPException(429, "Export review capacity is busy. Keep your selection and retry later.")
        _reviews[token] = entry
    return {"review_token": token, "preview_sha256": entry["sha256"], "expires_in_seconds": TTL,
            "document": document, "preview": raw.decode("utf-8"), "media_type": media, "bytes": len(raw), "format": selection.format,
            "filename": "tli-troubleshooting." + {"text": "txt", "json": "json", "html": "html"}[selection.format]}


def download(user, request):
    with _review_lock:
        entry = copy.deepcopy(_reviews.get(request.review_token))
    if not entry or entry["owner"] != user or entry["expires"] <= time.monotonic():
        raise HTTPException(409, "This export review expired or belongs to another session account. Preview it again.")
    if entry["request_sha256"] != cases.revision(request.selection.model_dump()) or entry["sha256"] != request.preview_sha256:
        raise HTTPException(409, "The export selection or redactions changed. Review a fresh preview before downloading.")
    _, raw, media = prepare(user, request.selection)
    if hashlib.sha256(raw).hexdigest() != entry["sha256"]:
        raise HTTPException(409, "The reviewed export changed. A new preview is required.")
    if entry["expires"] <= time.monotonic():
        raise HTTPException(409, "This review expired while checking the export. Preview it again.")
    return raw, media
