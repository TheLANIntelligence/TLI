"""Recorded outcomes, without inference, retrieval, probes or action execution.

Callers supply an explicitly selected, owner-validated report. Historical chat
and automatically recalled notes are intentionally not evidence of completion.
"""
from __future__ import annotations

import copy
import html
import math
import re
from datetime import datetime

from intelligence import answer_evidence, report_facts


PERFORMANCE_METRICS = ("host_cpu_percent", "host_ram_percent", "host_ram_used_bytes",
                       "host_ram_total_bytes", "process_cpu_percent", "process_rss_bytes")
_SUBJECT = r"(?:it|this|that|you|we|the (?:check|checks|scan|observation|measurement|diagnostic|diagnostics|test|run|repair|fix|task|job|app|application|printer)(?: [\w .'-]{1,60})?)"
_PAST = r"(?:last time|before|previously|earlier)"
_UNRELATED = re.compile(r"\b(?:code|coding|python|javascript|function|regex|sql|fiction|story|translate|translation|write|generate|explain)\b", re.I)


def classify(question, *, selected_report=False):
    """Whole-question grammar; no substring interception of instructions."""
    if not isinstance(question, str) or len(question) > 240 or "\n" in question:
        return None
    query = question.strip().casefold().rstrip("?.! ")
    if selected_report and any(re.fullmatch(pattern, query) for pattern in (
        r"(?:summari[sz]e|show|review) (?:this|that|the|the selected|the saved) (?:report|diagnostic report|observation|check results)",
        r"(?:what (?:does|did) (?:this|that|the selected|the saved) (?:report|observation|check) (?:show|record|measure)|what (?:was|were) (?:measured|recorded) in (?:this|the selected|the saved) report)",
        r"explain what (?:this|the selected|the saved) report (?:shows|recorded)",
    )):
        return "summary"
    if not query or _UNRELATED.search(query) or any(c in query for c in '`";:!?'):
        return None
    fix = r"(?:is|was|has) (?:it|this|that|the (?:problem|issue|printer|app|application))(?: been)? (?:fixed|resolved|repaired)"
    recall = (
        rf"what (?:fixed|solved|resolved) {_SUBJECT}(?: {_PAST})?",
        rf"(?:how did (?:we|you)|what did (?:we|you) do to) (?:fix|solve|resolve) {_SUBJECT}(?: {_PAST})?",
        rf"what (?:was|is) the (?:last |previous |recorded |confirmed )?fix(?: for {_SUBJECT})?(?: {_PAST})?",
    )
    if any(re.fullmatch(pattern, query) for pattern in recall):
        return "recall"
    if re.fullmatch(fix, query):
        return "fix"
    both = re.search(r",? and (?:is|was) it (?:fixed|resolved|repaired)$", query)
    completion = query[:both.start()] if both else query
    patterns = [
        rf"(?:did|has|have) {_SUBJECT} (?:finish|finished|complete|completed|succeed|succeeded)(?: its (?:task|job))?(?: successfully)?",
        rf"(?:is|was|are|were) {_SUBJECT} (?:done|complete|completed|finished|successful)",
        rf"did (?:you|we) (?:finish|complete) (?:the )?(?:check|checks|scan|measurement|observation|diagnostics|test|run|repair|fix|task|job)",
        r"did (?:you|we) finish (?:measuring|observing) [\w .'-]{1,60}",
        r"did (?:it|the printer|the test|the test page|the print job) print(?: successfully)?",
        r"did (?:you|we) (?:restart|reboot|repair|fix) (?:it|the router|the computer|the printer|the app)",
    ]
    if selected_report:
        # A named process can be discussed only with an explicit report. The
        # answer always names the recorded process and never retargets it.
        patterns.append(r"did [\w .'-]{1,60} (?:finish|complete)(?: its (?:task|job))?(?: successfully)?")
    if any(re.fullmatch(pattern, completion) for pattern in patterns):
        return "completion_and_fix" if both else "completion"
    return None


def _number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value) and value >= 0
    except (ValueError, OverflowError):
        return False


def project_report(report):
    """Whole bounded summary, explicitly excluding raw performance samples.

    Existing report facts remain whole. The caller's ordinary text/token budget
    still rejects an oversized report instead of silently truncating its facts.
    """
    result = {k: copy.deepcopy(report[k]) for k in
              ("id", "created_at", "kind", "host", "target", "checks", "verified_fix", "scope") if k in report}
    # Calculate this from the original report before raw samples are omitted.
    # Never accept a stored/user-supplied summary as fresh measurements.
    facts = report_facts.build(report)
    if facts is not None:
        result["recorded_facts"] = facts
    if report.get("kind") != "performance":
        return result
    performance = report.get("performance")
    if not isinstance(performance, dict):
        result["performance"] = {"coverage": {"status": "unavailable", "raw_samples_included": 0}}
        return result
    projected = {k: copy.deepcopy(performance[k]) for k in
                 ("schema_version", "observation_id", "host", "status", "reason", "started_at", "finished_at",
                  "duration_seconds", "requested_duration_seconds", "expected_samples", "sample_count", "scope") if k in performance}
    process = performance.get("process")
    projected["process"] = ({k: copy.deepcopy(process[k]) for k in ("pid", "create_time", "name", "exe") if k in process}
                            if isinstance(process, dict) else None)
    summary = performance.get("summary")
    projected["summary"] = ({k: {field: copy.deepcopy(value[field]) for field in ("min", "max", "mean", "samples") if field in value}
                              for k, value in summary.items() if k in PERFORMANCE_METRICS and isinstance(value, dict)}
                             if isinstance(summary, dict) else {})
    samples = performance.get("samples")
    rows = samples if isinstance(samples, list) and len(samples) <= 3600 else None
    projected["coverage"] = {"status": "recorded" if rows is not None else "unavailable",
                             "raw_samples_included": 0, "raw_samples_omitted": len(rows) if rows is not None else None,
                             "metric_samples": {key: sum(isinstance(row, dict) and _number(row.get(key)) and
                                                         (not key.endswith("percent") or row[key] <= 100) for row in rows)
                                                for key in PERFORMANCE_METRICS} if rows is not None else {}}
    result["performance"] = projected
    return result


def _plain(value, fallback="not recorded", limit=240):
    if not isinstance(value, str) or not value.strip():
        return fallback
    value = " ".join(value.split())
    if len(value) > limit:
        return fallback
    return _escaped(value)


def _escaped(value):
    # Keep stored strings inert even when they contain links, HTML or handles.
    # Quoted confirmation bodies retain their exact internal spaces and lines.
    value = html.escape(value, quote=False).replace("[", "&#91;").replace("]", "&#93;")
    return re.sub(r"([\\`*{}()_#!|])", r"\\\1", value)


def _date(value):
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value if parsed.tzinfo is not None else None
    except ValueError:
        return None


def _fix(report):
    fix = report.get("verified_fix")
    if not isinstance(fix, dict) or fix.get("source") != "user_confirmation" or not _date(fix.get("confirmed_at")):
        return "This selected report has no admissible user-confirmed repair outcome. A suggested step or an earlier AI answer does not establish what fixed the problem. [R1]"
    text = fix.get("text")
    if not isinstance(text, str) or not text.strip():
        return "This selected report has no readable user-confirmed repair outcome. [R1]"
    if len(text) > 2000:
        return (f"A user confirmation is recorded at {_plain(fix['confirmed_at'])}, but its text is too long for this factual summary. "
                "Open the selected report to read the complete confirmation. [R1]")
    quote = "\n".join("> " + _escaped(line) for line in text.splitlines())
    return f"The user recorded this confirmation at {_plain(fix['confirmed_at'])}: [R1]\n\n{quote}\n\nThis records what the user confirmed; it is not an independent test or evidence that the problem is still fixed now."


def _completion(report):
    if report.get("kind") == "performance":
        performance = report.get("performance") or {}
        coverage = performance.get("coverage") or {}
        count, expected = performance.get("sample_count"), performance.get("expected_samples")
        valid = (type(count) is int and type(expected) is int and 0 <= count <= expected <= 3600 and expected > 0
                 and coverage.get("status") == "recorded" and coverage.get("raw_samples_omitted") == count
                 and performance.get("schema_version") == 1 and type(performance.get("schema_version")) is int)
        status = performance.get("status")
        valid = valid and status in ("completed", "partial", "stopped", "failed")
        full = valid and count == expected and all(coverage.get("metric_samples", {}).get(key) == expected for key in PERFORMANCE_METRICS)
        if status == "completed" and not full:
            valid = False
        process = performance.get("process") or {}
        facts = report_facts.public_summary(report.get("recorded_facts"))
        if facts is not None:
            # The visible report and deterministic answer share the same
            # recorded completion decision, including identity inconsistencies.
            status = facts["status"]
            valid = status != "unknown"
            count, expected = facts["recorded_samples"], facts["expected_samples"]
            process = facts.get("process") or {}
        name = _plain(process.get("name"), "unnamed process")
        pid, created = process.get("pid"), process.get("create_time")
        identity = f"{name} (PID {pid}, process start {created})" if type(pid) is int and pid > 0 and _number(created) else f"{name} (process identity incomplete)"
        if not valid:
            result = f"The saved observation for {identity} has incomplete or inconsistent completion metadata; completion cannot be confirmed. [R1]"
        else:
            label = "completed its planned sampling" if status == "completed" else f"ended with status **{status}**"
            result = (f"The observation for {identity} {label}: **{count} of {expected} planned samples** recorded. "
                      f"Observation ended: {_plain(performance.get('finished_at'))}. [R1]")
            if status != "completed":
                result += " This must not be treated as a complete observation."
        return result + "\n\nSampling records host/process resource use. It does not record whether the application's own task finished, whether a repair worked, or the cause of a slowdown. No new observation or repair ran for this answer."
    checks = report.get("checks")
    if not isinstance(checks, list) or not checks:
        return "This selected report contains no recorded check outcomes from which to confirm completion. It does not establish that a repair or task finished. [R1]"
    counts = {status: sum(isinstance(row, dict) and row.get("status") == status for row in checks)
              for status in ("pass", "fail", "unavailable")}
    unknown = len(checks) - sum(counts.values())
    text = (f"The selected saved report records **{len(checks)} check outcomes**: {counts['pass']} passed, "
            f"{counts['fail']} failed, {counts['unavailable']} unavailable" + (f", {unknown} with an unrecognized outcome" if unknown else "") + ". [R1]")
    text += "\n\nThese are the recorded check results, not proof that a repair succeeded or every function is healthy."
    if report.get("kind") == "device":
        text += " A TCP reachability check does not establish that a print job was submitted, physically printed, or that the device works correctly."
    else:
        text += " They do not record whether an application task, print job, restart or other action completed."
    return text + " No new check or repair ran for this answer."


def answer(question, *, report=None):
    intent = classify(question, selected_report=report is not None)
    if intent is None:
        return None
    if classify(question) is None and intent != "summary":
        # The broad first pass only authorizes reading an explicitly supplied
        # report. Named completion questions must match its recorded process.
        process = (report.get("performance") or {}).get("process") or {}
        name = process.get("name")
        query = question.strip().casefold().rstrip("?.! ")
        query = re.sub(r",? and (?:is|was) it (?:fixed|resolved|repaired)$", "", query)
        if not isinstance(name, str) or not re.fullmatch(r"did " + re.escape(name.casefold()) + r" (?:finish|complete)(?: its (?:task|job))?(?: successfully)?", query):
            return None
    receipt = answer_evidence.build(report=report)
    if receipt is None:
        raise ValueError("Unreadable report source metadata")
    if report is None:
        text = ("No recorded completion or confirmed repair outcome was supplied for this question. "
                "I cannot establish what finished or what fixed the problem from a previous AI answer. "
                "Select the relevant saved diagnostic report, or explicitly select the saved fix note to ask about its contents. "
                "No new check, repair or memory search ran.")
    else:
        host, target = report.get("host") or {}, report.get("target") or {}
        text = (f"**Selected report** — {_plain(host.get('name'), 'unnamed host')} (host ID {_plain(host.get('id'))})"
                + (f" → {_plain(target.get('name'), 'unnamed target')} (target ID {_plain(target.get('id'))})" if target else " · host scope")
                + f". Recorded: {_plain(report.get('created_at'))}. [R1]\n\n")
        if intent in ("completion", "completion_and_fix"):
            text += _completion(report)
        if intent == "summary":
            text += _summary(report)
        if intent in ("recall", "fix", "completion_and_fix"):
            text += ("\n\n" if intent == "completion_and_fix" else "") + _fix(report)
        text += "\n\nThis answer uses only the selected report, not other saved notes or historical chat."
    receipt["interpretation"] = "backend"
    return {"text": text, "evidence_context": answer_evidence.finalize(receipt, text)}


def _summary(report):
    facts = report_facts.public_summary(report.get("recorded_facts"))
    if facts is None:
        return "The selected report does not supply a readable structured summary. Open its saved details; completion and current health cannot be confirmed. [R1]"
    lines = ["**Recorded observations**", facts["status_label"] + ". [R1]"]
    if facts["kind"] == "performance":
        process = facts.get("process") or {}
        lines.append(f"Selected process: {_plain(process.get('name'), 'name unavailable')}; PID {process.get('pid') or 'unavailable'}; process start {process.get('create_time') if process.get('create_time') is not None else 'unavailable'}. [R1]")
        lines.append(f"Observation interval: {_plain(facts.get('started_at'))} to {_plain(facts.get('finished_at'))}. [R1]")
        count, expected = facts.get("recorded_samples"), facts.get("expected_samples")
        lines.append(f"Samples: {count if count is not None else 'unknown'} recorded of {expected if expected is not None else 'unknown'} planned. [R1]")
        for metric in facts["measurements"]:
            if not metric["valid_samples"]:
                lines.append(f"- {metric['label']}: unavailable; no usable recorded samples. [R1]")
            else:
                scale, unit = (1, "%") if metric["unit"] == "percent" else (1048576, " MiB")
                lines.append(f"- {metric['label']}: mean {metric['mean'] / scale:.1f}{unit}, range {metric['minimum'] / scale:.1f}–{metric['maximum'] / scale:.1f}{unit}; {metric['valid_samples']} valid samples. [R1]")
    else:
        for check in facts["checks"]:
            lines.append(f"- {_plain(check['label'])}: **{check['status']}** — {_plain(check['detail'], 'detail unavailable', 1000)}. [R1]")
        if facts["omitted_checks"]:
            lines.append(f"{facts['omitted_checks']} additional check records are not shown in this bounded summary. Open the full report. [R1]")
    lines.extend(["**What this establishes**", *facts["limitations"], "**Suggested next step**",
                  "Review this saved report in Troubleshooting. If a current comparison would help, review and explicitly run an available check on its stated host and target."])
    return "\n\n".join(lines)


def _case_intent(question, selection, report):
    """Narrow factual questions about an explicit case, never general Chat."""
    intent = classify(question, selected_report=bool(report))
    if intent is not None:
        return intent
    if not isinstance(question, str) or len(question) > 240 or "\n" in question:
        return None
    query = " ".join(question.strip().casefold().replace("’", "'").rstrip("?.! ").split())
    if re.fullmatch(r"(?:what|which steps) (?:did (?:we|you|i) (?:already )?(?:try|attempt)|have (?:we|you|i) (?:already )?(?:tried|attempted))(?:,? and did (?:it|that|they) (?:work|help))?", query):
        return "case_steps"
    if re.fullmatch(r"(?:what|which) (?:steps|attempts) (?:were|are) (?:already )?(?:tried|recorded)(?:,? and did (?:they|it) (?:work|help))?", query):
        return "case_steps"
    if re.fullmatch(r"compare (?:the )?(?:recorded|saved) (?:readings|measurements|results) with (?:now|current readings)(?:\. what changed)?", query):
        return "case_comparison"
    computer = selection.get("computer") or {}
    names = {str(computer.get(k) or "").casefold().replace("’", "'") for k in ("name", "id")} - {""}
    owner = r"(?:the |this computer's |" + "|".join(re.escape(name) + r"'s " for name in sorted(names)) + r")?" if names else r"(?:the )?"
    metric = r"(?:cpu(?: usage)?|ram(?: use| usage)?|memory(?: use| usage)?|uptime)"
    metrics = metric + r"(?:,? (?:and )?" + metric + r"){0,2}"
    if re.fullmatch(r"what (?:are|were|is|was) " + owner + r"(?:(?:recorded|saved|current|latest) )?" + metrics + r"(?: readings| values| measurements| results)?", query):
        return "case_current_values" if re.search(r"\b(?:current|latest)\b", query) else "case_values"
    if re.fullmatch(r"(?:what|which) (?:numerical )?(?:measurements|readings|values) (?:can you quote|are (?:available|recorded)|were (?:measured|recorded))(?: (?:from|in) (?:this|the selected|the saved) (?:case|report))?", query):
        return "case_values"
    return None


def answer_case(question, selection, *, report=None):
    """Only selected case fields; never infer results from linked-source titles."""
    intent = _case_intent(question, selection, report)
    if intent is None:
        return None
    computer = selection.get("computer") or {}
    lines = [f"**Selected case: {_plain(selection['title'])}** — last saved {_plain(selection['updated_at'])}. "
             f"Computer: {_plain(computer.get('name'), 'not selected')} ({_plain(computer.get('id'))}). [C1]"]
    steps = selection["steps"]
    if intent in ("completion", "completion_and_fix", "case_steps"):
        if not steps:
            lines.append("No step records were selected. The case selection cannot establish which actions were tried or finished. [C1]")
        for step in steps:
            lines.append(f"Recorded step — **{step['status']}**: [C1]\n\n> {_escaped(step['text']).replace(chr(10), chr(10) + '> ')}")
            if step["status"] != "tried":
                lines.append("This step is not recorded as tried. Any attached outcome text does not establish execution or success.")
            elif step["outcome"].strip():
                lines.append("User-recorded outcome (not an independent check):\n\n> " + _escaped(step["outcome"]).replace("\n", "\n> "))
            else:
                lines.append("An attempt was recorded, but no outcome was recorded for this step; completion or success cannot be confirmed.")
    if intent in ("recall", "fix", "completion_and_fix", "case_steps"):
        if selection["status"] == "resolved" and selection["resolution_included"] and selection.get("resolution", "").strip():
            lines.append("The user marked this case resolved and recorded this improvement: [C1]\n\n> " + _escaped(selection["resolution"]).replace("\n", "\n> "))
            lines.append("This is the user's saved account of improvement, not an independent test or proof that the problem is still fixed now.")
        elif selection["status"] == "resolved":
            lines.append("The case is marked resolved by the user, but its resolution text was not selected. This selection cannot identify what fixed the problem. [C1]")
        else:
            lines.append("The selected case remains open. It does not record a resolved outcome; a proposed or tried step is not proof of a successful repair. [C1]")
    lines.append(f"Selection coverage: {len(steps)} steps supplied, {selection['omitted_step_count']} omitted; "
                 f"{len(selection['evidence_links'])} evidence-link descriptions supplied, {selection['omitted_link_count']} omitted. "
                 "Linked note, report and chat bodies were not supplied. Their labels do not establish their contents.")
    if intent in ("case_current_values", "case_comparison"):
        lines.append("No current measurements were supplied. A saved reading cannot establish a current value or what changed; a new explicitly reviewed observation on the same host and target is needed for that comparison. No new observation was taken for this answer.")
    if not report and intent in ("case_values", "case_current_values", "case_comparison"):
        lines.append("No report facts were selected, so this selection supplies no numerical measurements to quote. A report link or its title does not disclose its readings. You may explicitly review and select the report's recorded facts; nothing will be fetched automatically. [C1]")
    if report and intent != "case_steps":
        lines.append("**Separately selected report facts** — these recorded measurements are distinct from the case's user-recorded steps and outcomes. [R1]")
        facts = report["recorded_facts"]
        lines.append(f"Recorded host: {_plain(facts['host'].get('name'))} ({_plain(facts['host'].get('id'))}); "
                     f"target: {_plain((facts.get('target') or facts['host']).get('id'))}; recorded {_plain(facts.get('recorded_at'))}. [R1]")
        lines.append(_summary(report))
    lines.append("No new check, repair, device action or AI inference ran for this answer. The case date is a save time, not a new measurement.")
    text = "\n\n".join(lines)
    receipt = answer_evidence.build(case=selection, report=report)
    receipt["interpretation"] = "backend"
    return {"text": text, "evidence_context": answer_evidence.finalize(receipt, text)}
