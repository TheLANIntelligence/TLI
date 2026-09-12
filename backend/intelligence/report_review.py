"""Pure saved-report comparisons and explicit repeat-check preparation."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from fastapi import HTTPException
import tli_state as S
from intelligence import diagnostics

PROTOCOL = "tli-report-review-v1"
KINDS = {"system", "network", "device"}
STATUSES = {"pass", "fail", "unavailable"}


def revision(report):
    try:
        raw = json.dumps(report, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    except (ValueError, TypeError):
        raise HTTPException(409, "The saved report contains invalid values. It was preserved.") from None
    return hashlib.sha256(raw).hexdigest()


def _identity(report):
    host = report.get("host") or {}
    target = report.get("target")
    if not isinstance(host, dict) or not isinstance(host.get("id"), str) or not host["id"]:
        raise ValueError("The recorded host identity is unavailable.")
    if report.get("kind") not in KINDS:
        raise ValueError("Use Performance & apps for process observations; these controls compare system, network and reachability checks.")
    if type(report.get("internet_checks")) is not bool:
        raise ValueError("The report does not record whether internet checks were included.")
    execution = report.get("execution")
    if isinstance(execution, dict) and execution.get("kind") == "peer_system":
        observed = report.get("peer_observation") or {}
        fingerprint = execution.get("identity_fingerprint")
        if (report["kind"] != "system" or report["internet_checks"] or not isinstance(target, dict) or not target.get("id")
                or not isinstance(fingerprint, str) or not fingerprint or observed.get("host") != host
                or host.get("identity_fingerprint") != fingerprint):
            raise ValueError("The peer observation does not supply a consistent native host identity.")
        return host["id"], "peer_system", (target["id"], fingerprint), False
    if report["kind"] == "device":
        if not isinstance(target, dict) or not target.get("id"):
            raise ValueError("The recorded device identity is unavailable.")
        binding = tuple(target.get(key) for key in ("id", "address", "kind", "relay", "node_id", "source"))
    elif target is not None:
        raise ValueError("This older report does not unambiguously identify a host-only check.")
    else:
        binding = None
    return host["id"], report["kind"], binding, report["internet_checks"]


def _checks(report):
    rows = report.get("checks")
    if not isinstance(rows, list) or not rows or len(rows) > 64:
        raise ValueError("The report has no complete, bounded check list.")
    result = {}
    for row in rows:
        if (not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]
                or row["id"] in result or row.get("status") not in STATUSES
                or not isinstance(row.get("label"), str) or not isinstance(row.get("detail"), str)):
            raise ValueError("The report contains incomplete or duplicate check records.")
        result[row["id"]] = row
    return result


def summary(report):
    return {key: report.get(key) for key in ("id", "created_at", "kind", "host", "target", "scope")}


def compare(before, after):
    value = {"report_id": before.get("id"), "before": summary(before), "after": summary(after),
             "comparable": False, "changes": [], "checks": [], "reason": "",
             "scope": "Recorded check statuses only. Different workloads and observation times can affect results; a changed status does not prove a repair or its cause."}
    try:
        if _identity(before) != _identity(after):
            raise ValueError("The reports differ in host, target/address, check type or internet scope.")
        old, new = _checks(before), _checks(after)
        for report in (before, after):
            date = datetime.fromisoformat(str(report.get("created_at", "")).replace("Z", "+00:00"))
            if date.tzinfo is None:
                raise ValueError("A report observation time has no timezone.")
        if before.get("id") == after.get("id"):
            raise ValueError("Choose two different saved reports.")
        for ident in list(old) + [key for key in new if key not in old]:
            a, b = old.get(ident), new.get(ident)
            row = {"check": ident, "label": (b or a)["label"],
                   "before": a["status"] if a else "not_recorded", "after": b["status"] if b else "not_recorded",
                   "before_detail": a["detail"] if a else None, "after_detail": b["detail"] if b else None}
            value["checks"].append(row)
            if row["before"] != row["after"]:
                value["changes"].append(row)
        value["comparable"] = True
    except (ValueError, TypeError) as error:
        value["reason"] = str(error)
    return value


def repeat_review(user, ident):
    from intelligence import diagnostic_workflow as W
    report = diagnostics.get_report(user, ident)
    result = {"ok": True, "protocol": PROTOCOL, "checked_at": S.now_iso(), "actions_performed": False,
              "source": summary(report), "source_revision": revision(report), "available": False, "reason": "", "request": None}
    try:
        if isinstance(report.get("execution"), dict) and report["execution"].get("kind") == "peer_system":
            raise ValueError("Review available checks for this computer in Troubleshooting to request a new peer observation with its current trust and scope. No host check was substituted.")
        expected = _identity(report)
        _checks(report)
        current = W.scope(report["kind"], (report.get("target") or {}).get("id"), report["internet_checks"])
        candidate = {"kind": current["kind"], "host": current["host"], "target": current["target"], "internet_checks": current["internet"]}
        if _identity(candidate) != expected:
            raise ValueError("The host or registered target/address changed. Review a new check instead; the old report remains unchanged.")
        result.update(available=True, scope=current, request={"kind": current["kind"], "target_id": (current["target"] or {}).get("id"),
                      "internet": current["internet"], "expected_host_id": current["host"]["id"], "expected_scope": current["revision"],
                      "repeat_of": report["id"], "expected_report_revision": result["source_revision"]})
    except (ValueError, TypeError, HTTPException) as error:
        result["reason"] = str(error.detail) if isinstance(error, HTTPException) else str(error)
    return result


def validate_repeat(user, ident, expected_revision, kind, target_id, internet):
    reviewed = repeat_review(user, ident)
    if reviewed["source_revision"] != expected_revision:
        raise HTTPException(409, "The original report changed. Review the repeat check again; nothing ran.")
    if not reviewed["available"]:
        raise HTTPException(409, reviewed["reason"])
    body = reviewed["request"]
    if (body["kind"], body["target_id"], body["internet"]) != (kind, target_id, internet):
        raise HTTPException(409, "The repeated check must use the reviewed report's exact target and scope. Nothing ran.")
    return reviewed
