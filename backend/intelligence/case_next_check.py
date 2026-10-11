"""One explicit, rule-based observation from reviewed saved evidence.

This module reads selected stores and capability metadata only. It never runs a
diagnostic, resolves a diagnosis, calls a model or persists a suggestion.
"""
from __future__ import annotations

import hashlib
import json
import re

from fastapi import HTTPException
from pydantic import Field
from typing import Literal

from intelligence import answer_evidence, case_context, cases, diagnostics, diagnostic_workflow
from intelligence.store import LOCK

PROTOCOL = "tli-case-next-check-v1"
MAX_REPLY_BYTES = 131072
_RESOURCES = re.compile(r"\b(?:slow|slowdown|sluggish|stutter\w*|lag\w*|freez\w*|hang\w*|unresponsive|cpu|ram|memory|performance)\b", re.I)
_NETWORK = re.compile(r"\b(?:network|internet|wi[ -]?fi|disconnect\w*|offline|dns|latency|packet|unreachable|connection)\b", re.I)


class RunRef(cases.Strict):
    case_ref: case_context.CaseRef
    selection_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    option_id: Literal["system", "network", "device", "peer_system"]


def _measured(facts, metric):
    """Availability only, never infer a numeric reading or health threshold."""
    if facts["kind"] == "performance":
        matches = [m for m in facts["measurements"] if m["key"] == "host_" + metric + "_percent"]
        return len(matches) == 1 and matches[0]["valid_samples"] > 0
    identifiers = {metric, metric + "_percent", "host_" + metric + "_percent"}
    matches = [c for c in facts["checks"] if c["id"] in identifiers and c["scope"] == "host"]
    return len(matches) == 1 and matches[0]["status"] == "pass" and bool(matches[0]["detail"])


def _unchanged(user, ref):
    # Same established lock order as the source readers. No capability or
    # transport work takes place inside this short consistency check.
    with LOCK:
        if cases.get_case(user, ref.id, resolve=False)["revision"] != ref.revision:
            raise HTTPException(409, "The saved case changed during guidance review. Review the current selection again; nothing ran.")
        for pointer in ref.report_refs:
            if cases.revision(diagnostics.get_report(user, pointer.id)) != pointer.revision:
                raise HTTPException(409, "The selected report changed during guidance review. Review its facts again; nothing ran.")


def review(user, ref, *, authorize=None):
    if authorize is not None:
        authorize()
    receipt, selected, report = case_context.selection(user, ref)
    normalized = ref.model_dump(exclude_none=True)
    selection_hash = hashlib.sha256(json.dumps(normalized, ensure_ascii=False, sort_keys=True,
                                              separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    known = [{"id": "symptom", "label": "User-recorded symptom", "text": selected["symptom"],
              "source": "C1", "recorded_at": selected["updated_at"]}]
    missing = [{"id": "current_observation", "text": "No new observation was taken for this guidance. Saved facts describe their recorded time, not current health or the cause of this symptom."}]
    limitations = ["This is a rule-based choice of one available observation, not an AI diagnosis or a repair.",
                  "Only the selected whole steps and explicitly selected report facts were used. Other linked bodies, notes and earlier chat were not used.",
                  f"Selection coverage: {len(selected['steps'])} steps included, {selected['omitted_step_count']} omitted; {len(selected['evidence_links'])} link descriptions included, {selected['omitted_link_count']} omitted.",
                  "A tried step is a user-recorded attempt. Planned or skipped steps are not recorded as attempted; outcomes do not prove current health."]
    facts = report["recorded_facts"] if report else None
    if facts:
        known.append({"id": "report_scope", "label": "Separately reviewed historical report",
                      "text": f"Host: {facts['host']['name'] or facts['host']['id']}; target: {(facts.get('target') or facts['host'])['id']}. {facts['status_label']}. Exact recorded values, units and limitations are shown with the report facts.",
                      "source": "R1", "recorded_at": facts["recorded_at"]})
        if facts["recorded_samples"] is not None:
            known.append({"id": "sample_coverage", "label": "Recorded sample coverage",
                          "text": f"{facts['recorded_samples']} recorded samples; {facts['expected_samples'] if facts['expected_samples'] is not None else 'unknown'} expected. Individual measurement coverage is shown in the report facts.",
                          "source": "R1", "recorded_at": facts["recorded_at"]})
        for metric, label in (("cpu", "CPU"), ("ram", "RAM")):
            if not _measured(facts, metric):
                missing.append({"id": metric, "text": f"The reviewed report does not supply an unambiguous usable host {label} result. Missing or unavailable values are unknown, not zero."})
    else:
        missing.append({"id": "report_facts", "text": "No report facts were selected. An evidence-link title is not a measurement. You may explicitly review one current linked report, or choose an observation using the recorded symptom alone."})
    if not selected["steps"]:
        missing.append({"id": "selected_steps", "text": "No steps were selected, so this review cannot say which attempts or outcomes were already recorded."})
    elif any(s["status"] == "tried" and not s["outcome"].strip() for s in selected["steps"]):
        missing.append({"id": "attempt_outcome", "text": "At least one selected tried step has no recorded outcome. An attempt alone does not establish whether it helped."})
    options = diagnostic_workflow.options(receipt["computer_id"], include_peer_observation=True) if receipt["computer_id"] else None
    suggestion = None
    resources, network = bool(_RESOURCES.search(selected["symptom"])), bool(_NETWORK.search(selected["symptom"]))
    candidate = None
    if not options:
        missing.append({"id": "computer", "text": "Choose and save the affected computer before requesting a supported observation. The TLI host was not substituted."})
    elif selected["archived"] or selected["status"] == "resolved":
        limitations.append("This case is archived or user-marked resolved. No further check is suggested automatically; review its current status before investigating a continuing symptom.")
    elif any(s["status"] == "tried" and not s["outcome"].strip() for s in selected["steps"]):
        limitations.append("Record or review the missing outcome of the selected attempt first. This guidance does not assume that it failed or suggest repeating it.")
    elif resources and not network:
        rows = {o["id"]: o for o in options["options"]}
        if rows.get("peer_system", {}).get("available"):
            candidate = rows["peer_system"]
        elif rows.get("system", {}).get("available"):
            candidate = rows["system"]
        gaps = [label for metric, label in (("cpu", "CPU"), ("ram", "RAM")) if facts and not _measured(facts, metric)]
        if gaps:
            reason = "The reviewed report has no usable " + " and ".join(gaps) + " result. A new resource observation can fill that specific gap while the recorded responsiveness symptom recurs. Unknown values are not zero, and the observation cannot establish the cause."
        elif facts:
            reason = "The reviewed report already contains host CPU and RAM results, but only for its recorded time. A new observation on the same computer would add a current comparison while the symptom recurs, not repeat or verify a repair. The historical readings alone do not identify a bottleneck."
        else:
            reason = "No recorded report facts were selected. A resource observation can add CPU and RAM evidence for the saved responsiveness symptom; link titles and attempted repairs do not supply those readings. It cannot establish the cause."
        rule = "resource_observation"
    elif network and not resources:
        rows = {o["id"]: o for o in options["options"]}
        candidate = next((rows[k] for k in ("network", "device") if rows.get(k, {}).get("available")), None)
        reason = (("The selected report supplies only historical observations. A new check can add a current comparison within the stated connection scope. " if facts else "No report facts were selected, so this check can add connection observations that the case's step records cannot supply. ") +
                  "A host-to-peer reachability result does not measure the peer's Wi-Fi, CPU or applications; internet probes remain off.")
        rule = "connection_observation"
    else:
        missing.append({"id": "check_scope", "text": "The recorded symptom does not select one supported resource or connection observation unambiguously. Clarify the symptom or review the available check scopes yourself; no diagnosis was inferred."})
    if candidate and candidate.get("available") is True:
        tried = [s for s in selected["steps"] if s["status"] == "tried" and s["outcome"].strip()]
        if tried:
            step = tried[0]
            if len(step["text"]) <= 120 and len(step["outcome"]) <= 240:
                reason += f" The user-recorded outcome for '{step['text']}' is '{step['outcome']}'. This adds evidence without changing that recorded outcome."
            else:
                reason += " Selected attempts already have user-recorded outcomes shown above. This observation adds evidence without replacing those outcomes or treating planned/skipped steps as attempted."
        suggestion = {"option_id": candidate["id"], "rule_id": rule, "rationale": reason}
    elif options and (resources != network) and not selected["archived"] and selected["status"] != "resolved" and not any(s["status"] == "tried" and not s["outcome"].strip() for s in selected["steps"]):
        missing.append({"id": "available_check", "text": "No matching observation is currently available for this chosen computer. Review its capability and trust status. No check on another host was substituted."})
    _unchanged(user, ref)
    if authorize is not None:
        authorize()
    evidence = answer_evidence.build(case=receipt, report=report)
    evidence["interpretation"] = "backend"
    result = {"next_check_protocol": PROTOCOL, "case_context": receipt,
              "evidence_context": evidence,
              "guidance": {"version": 1, "status": "suggested" if suggestion else "unavailable",
                           "selection": normalized, "selection_sha256": selection_hash,
                           "known": known, "missing": missing, "steps": selected["steps"],
                           "limitations": limitations, "check_options": options, "suggestion": suggestion}}
    if len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode()) > MAX_REPLY_BYTES:
        raise HTTPException(422, "The whole guidance review exceeds its bounded size. Select fewer whole steps or links; nothing was omitted or run.")
    return result


def execution_guard(user, binding, *, kind, target_id, internet, expected_host_id, expected_scope, authorize):
    """Re-derive the selected suggestion before entering the existing runner."""
    checked = review(user, binding.case_ref, authorize=authorize)["guidance"]
    suggestion = checked["suggestion"]
    if (checked["selection_sha256"] != binding.selection_sha256 or not suggestion
            or suggestion["option_id"] != binding.option_id or kind != binding.option_id or internet):
        raise HTTPException(409, "This run no longer matches the reviewed next-check suggestion. Review the selected evidence again; nothing ran.")
    option = next((o for o in checked["check_options"]["options"] if o["id"] == binding.option_id), None)
    if (not option or option["available"] is not True or option.get("target_id") != target_id
            or option["execution_host"]["id"] != expected_host_id or option.get("scope_revision") != expected_scope):
        raise HTTPException(409, "The suggested check's computer or scope changed. Review the evidence and check again; nothing ran.")
    def guard():
        authorize()
        _unchanged(user, binding.case_ref)
    return guard
