"""Evidence-only storage answers. Never reads file contents or calls a provider.

This is the storage adapter for TLI's deterministic intent/answer layer. All
metadata comes from a credential-bound completed scanner result.
"""
from __future__ import annotations

import copy
import re
from pathlib import PurePosixPath, PureWindowsPath

from fastapi import HTTPException
import storage_jobs
from intelligence.observed_answers import _markdown
from storage_scan_algorithms import _bytes_human, is_protected

PROTOCOL = "storage-investigation-v1"
MAX_SELECTION_NODES = 25_000
_QUESTIONS = tuple(re.compile(p) for p in (
    r"why (?:is (?:my |the )?(?:[a-z]: ?)?(?:drive|disk|storage) (?:always |so )?full|does (?:my |the )?(?:[a-z]: ?)?(?:drive|disk|storage) keep filling up)",
    r"(?:my |the )?(?:[a-z]: ?)?(?:drive|disk|storage) keeps filling up(?: and i don't know why)?",
    r"what (?:is taking up (?:the )?most (?:space|storage)|grew overnight|grew since (?:yesterday|the last scan))",
    r"(?:find|show|list)(?: me)? (?:my |the )?largest (?:files|folders)",
    r"is lm studio taking (?:up )?too much (?:storage|space)",
    r"can i safely delete these files",
    r"what can i clean without breaking windows",
))


def classify(text):
    if not isinstance(text, str) or len(text) > 500:
        return False
    q = re.sub(r"\s+", " ", text.casefold().replace("’", "'")).strip().rstrip("?!. ")
    q = re.sub(r"^(?:please |can you |could you )", "", q)
    return any(p.fullmatch(q) for p in _QUESTIONS)


def recommendation(row):
    """Classification is review guidance, never authorization to delete."""
    path = str(row.get("path", ""))
    lower = path.replace("\\", "/").casefold()
    parts = set(lower.split("/"))
    suffix = PureWindowsPath(lower).suffix
    protected = (is_protected(path) or bool(parts & {"windows", "boot", "recovery", "system volume information", "program files", "program files (x86)", "programdata", "node_modules", ".git", ".venv", "venv"})
                 or suffix in {".sys", ".dll", ".db", ".sqlite", ".sqlite3", ".mdb", ".reg", ".dat"}
                 or row.get("protected") or row.get("hardlink_duplicate") or row.get("synthetic") or row.get("size_known") is False)
    risk, reason, consequence, action = "protected", "Unknown criticality; no safe cleanup rule is established.", "Removing this file could break an application or lose data.", "blocked"
    if "$recycle.bin" in parts or "winsxs" in parts or "softwaredistribution" in parts:
        reason = "System-managed storage requires Windows' supported cleanup review."
        consequence = "Review Storage settings or Disk Cleanup; emptying Recycle Bin permanently removes its contents."
        action = "windows_storage_settings"
    elif protected:
        reason = "System, dependency, database, linked or unverified data is protected from recommendations."
    elif "/appdata/local/temp/" in lower or ("cache" in parts and bool(parts & {"chrome", "edge", "firefox"})):
        risk, action = "generally_safe_to_review", "review"
        reason = "Observed user temporary or browser cache file. Close its application and review before removal."
        consequence = "In-use files can still matter; cached content may need downloading again."
    elif ("downloads" in parts or suffix in {".msi", ".exe", ".iso", ".zip", ".7z", ".bak", ".backup", ".gguf", ".safetensors", ".pt", ".vhd", ".vhdx"}
          or bool(parts & {"models", "backups", ".lmstudio", ".cache"})):
        risk, action = "requires_review", "review"
        reason = "Downloads, installers, backups, models and application data require a personal retention decision."
        consequence = "You may lose a backup, installed model or data that cannot be downloaded again."
    return {"path": path, "size_bytes": row.get("size", 0), "classification": risk,
            "reason": reason, "consequence": consequence, "action": action}


def _path_key(value):
    """Compare recorded path spellings without resolving or reading a path."""
    if not isinstance(value, str) or not 1 <= len(value) <= 4096 or "\x00" in value:
        raise HTTPException(422, "Choose a retained file or folder path.")
    windows = bool(re.match(r"^[a-zA-Z]:[\\/]", value) or value.startswith("\\\\"))
    path = PureWindowsPath(value) if windows else PurePosixPath(value)
    if not path.is_absolute() or ".." in path.parts:
        raise HTTPException(422, "Choose an absolute retained file or folder path.")
    # Match the explorer's lowercase path key. Full Unicode case folding would
    # merge distinct retained names such as Straße.txt and STRASSE.txt.
    return str(path).lower() if windows else str(path)


def _retained_nodes(tree):
    """Walk only the bounded authenticated result, including aggregate markers."""
    pending, visited = [tree], set()
    while pending:
        row = pending.pop()
        if not isinstance(row, dict) or id(row) in visited or len(visited) >= MAX_SELECTION_NODES:
            raise HTTPException(409, "The retained tree cannot support this selection.")
        visited.add(id(row))
        children = row.get("children", [])
        if not isinstance(children, list) or len(children) + len(pending) + len(visited) > MAX_SELECTION_NODES:
            raise HTTPException(409, "The retained tree exceeds its selection limit.")
        yield row
        pending.extend(children)


def _selected_evidence(tree, meta, selected_path):
    key, selected = _path_key(selected_path), None
    for row in _retained_nodes(tree):
        if _path_key(row.get("path")) == key:
            if selected is not None:
                raise HTTPException(409, "The retained path is ambiguous.")
            selected = row
    if selected is None:
        raise HTTPException(404, "This path is not retained in this scan. Select a recorded file or folder.")
    if selected.get("synthetic") or selected.get("kind") == "aggregate":
        raise HTTPException(422, "Grouped bytes have no individual file or folder to explain.")
    directory = isinstance(selected.get("children"), list) or selected.get("kind") == "directory"
    rows = list(_retained_nodes(selected))
    omitted_entries = sum(row.get("omitted_entries", 0) + row.get("collapsed_entries", 0) for row in rows)
    omitted_bytes = sum(row.get("omitted_bytes", 0) + (row.get("size", 0) if row.get("synthetic") or row.get("kind") == "aggregate" else 0) for row in rows)
    known = selected.get("size_known") is not False and selected.get("size_unavailable") is not True
    counted = selected.get("size") if known else None
    selection = {"path": selected["path"], "name": selected.get("name", ""), "kind": "directory" if directory else "file",
                 "logical_bytes": (counted if directory else selected.get("logical_size", counted)) if known else None,
                 "counted_logical_bytes": counted, "allocated_bytes": None if selected.get("allocated_partial") else selected.get("allocated_size"),
                 "allocated_known_bytes": selected.get("allocated_known_bytes"),
                 "allocated_partial": selected.get("allocated_partial") is True or selected.get("allocated_size") is None,
                 "file_count": selected.get("files") if directory else 1, "size_known": known,
                 "modified_at": selected.get("modified_at"), "size_reason": selected.get("size_reason"),
                 "partial": selected.get("size_partial") is True or not known,
                 "scan_partial": meta.get("partial") is True, "hardlink_duplicate": selected.get("hardlink_duplicate") is True,
                 "representation_limited": bool(omitted_entries or omitted_bytes or any(row.get("synthetic") or row.get("kind") == "aggregate" for row in rows)),
                 "omitted_entries": omitted_entries, "omitted_bytes": omitted_bytes,
                 "retained_children": sum(not row.get("synthetic") and row.get("kind") != "aggregate" for row in selected.get("children", []))}
    return selected, selection


def _selection_answer(row, selection, recorded_at):
    directory = selection["kind"] == "directory"
    lines = [f"Selected {'folder' if directory else 'file'}: {_markdown(selection['path'])}, recorded {_markdown(recorded_at or 'time unknown')}."]
    if selection["modified_at"]:
        lines.append(f"Recorded modified time: {_markdown(selection['modified_at'])}. This alone does not establish when storage grew.")
    logical, counted = selection["logical_bytes"], selection["counted_logical_bytes"]
    if logical is None:
        lines.append("Its logical size was not available; zero bytes must not be inferred.")
    elif selection["hardlink_duplicate"]:
        lines.append(f"The file has {_bytes_human(logical)} of logical content. This is an additional hard-link name; its bytes were counted elsewhere in this scan. Removing one name does not establish that its disk allocation will be released.")
    else:
        lines.append(f"The observation records {_bytes_human(counted)} of counted logical {'file sizes in this folder' if directory else 'file size'}.")
    allocated = selection["allocated_bytes"]
    if selection["hardlink_duplicate"]:
        lines.append("Allocation is counted elsewhere; the recorded zero contribution does not mean this file has no disk allocation.")
    elif allocated is None:
        known_allocation = selection["allocated_known_bytes"]
        lines.append("Complete allocated size is unknown." + (f" The measured subset contributes {_bytes_human(known_allocation)}; it is not the full allocation." if known_allocation is not None else ""))
    else:
        lines.append(f"Recorded allocated size: {_bytes_human(allocated)}. This is not a promise of recoverable space.")
    if directory:
        count = selection["file_count"]
        lines.append(f"Observed descendant file names: {count:,}." if count is not None else "The recursive file count was not retained.")
    if selection["partial"]:
        lines.append("This selection has incomplete coverage. Excluded, unreadable or unvisited contents may add to its total.")
        if selection["size_reason"]:
            lines.append("Recorded coverage reason: " + _markdown(str(selection["size_reason"]).replace("_", " ")) + ".")
    elif selection["scan_partial"]:
        lines.append("The overall scan has incomplete coverage; this selection did not report an additional coverage gap.")
    if selection["representation_limited"]:
        lines.append(f"Some inspected paths within this selection were grouped or omitted from the retained tree ({_bytes_human(selection['omitted_bytes'])} of recorded bytes). Expanding this observation cannot recover their individual paths.")
    if directory:
        guidance = {"path": row["path"], "size_bytes": counted, "classification": "protected", "action": "blocked",
                    "reason": "A folder summary cannot authorize removal of its contents.",
                    "consequence": "Removing a folder can also remove files that were excluded or not retained. Review individual files and their owning applications first."}
    else:
        guidance = recommendation(row)
        if guidance["classification"] == "generally_safe_to_review":
            guidance.update(classification="requires_review",
                            reason="The path suggests temporary or cache data, but ownership, whether it is in use, and removal safety are unverified.")
        # A recommendation card must not display the scanner's zero placeholder
        # as an unreadable file's size, or an alias's zero counted contribution.
        guidance["size_bytes"] = selection["logical_bytes"]
    lines.append(guidance["reason"] + " " + guidance["consequence"])
    return lines, [guidance]


def investigate(credential, job_id, question="", baseline_id=None, selected_path=None):
    envelope = storage_jobs.results(credential, job_id)
    job, result = envelope["job"], envelope["result"]
    if job["operation"] != "scan" or job["status"] not in storage_jobs.TERMINAL:
        raise HTTPException(409, "Choose a finished storage scan before investigating.")
    meta, tree = result["meta"], result["tree"]
    selected, selection = _selected_evidence(tree, meta, selected_path) if selected_path is not None else (None, None)
    files = sorted((r for r in result.get("largest", []) if not r.get("hardlink_duplicate")), key=lambda r: r.get("size", 0), reverse=True)[:12]
    folders = sorted(meta.get("folder_summary", []), key=lambda r: r.get("bytes", 0), reverse=True)[:12]
    comparison = None
    scan_id = meta.get("saved_scan", {}).get("scan_id")
    if baseline_id:
        if not scan_id:
            raise HTTPException(409, "This scan has no comparable history receipt.")
        from intelligence.storage_history import compare
        comparison = compare(credential.owner, baseline_id, scan_id)
    recommendations = [recommendation(row) for row in files]
    evidence = {"job_id": job_id, "root": meta["root"], "scanned_at": job["finished_at"],
                "host": job.get("host"), "coverage": {k: meta.get(k) for k in ("partial", "denied", "skipped", "time_limited", "entry_limited", "depth_limited", "identity_unknown")},
                "logical_bytes": tree["size"], "allocated_bytes": tree.get("allocated_size"),
                "largest_files": copy.deepcopy(files), "largest_folders": copy.deepcopy(folders),
                "categories": copy.deepcopy(meta.get("categories", [])), "capacity": copy.deepcopy(meta.get("capacity")), "comparison": comparison}
    if selection is not None:
        evidence.update(selected_path=selection["path"], selection=selection)
        lines, recommendations = _selection_answer(selected, selection, job.get("finished_at"))
    else:
        lines = [f"Scan evidence for {_markdown(meta['root'])}, recorded {_markdown(job.get('finished_at') or 'time unknown')}: {_bytes_human(tree['size'])} of counted logical file sizes."]
    if meta.get("partial") and selection is None:
        lines.append("Coverage is incomplete. Inaccessible, excluded or unvisited storage may contain larger consumers.")
    lines.append("This is a recorded observation, not a live filesystem guarantee. Allocated space, logical file sizes and volume free space are different measurements.")
    if selection is None and "lm studio" in question.casefold():
        files = [row for row in files if any(p in row.get("path", "").casefold() for p in ("lmstudio", "lm studio", ".gguf", ".safetensors"))]
        lines.append("Model-like paths below are review leads; filenames alone do not establish which application owns them or whether they are expendable.")
    if selection is None and folders:
        lines.append("Largest observed folders: " + "; ".join(f"{_markdown(r['name'])} ({_bytes_human(r['bytes'])})" for r in folders[:5]) + ".")
    if selection is None and files:
        lines.append("Largest retained file observations:\n" + "\n".join(f"- {_markdown(r['path'])}: {_bytes_human(r['size'])}" for r in files[:8]))
    elif selection is None:
        lines.append("No matching individual file evidence is retained in this result; this does not prove that none exist.")
    if selection is not None and comparison:
        lines.append("The following comparison covers the original scan scope; it does not establish growth for this selected path.")
    if comparison and comparison.get("comparable"):
        totals = comparison.get("totals") or {}
        lines.append(f"Compared scan logical-size change: {totals.get('delta_bytes', 0):+,} bytes. Compare the capacity and file-change evidence separately; logical growth is not guaranteed physical disk consumption.")
    elif comparison:
        lines.append("These scans cannot establish complete folder or whole-tree growth: " + "; ".join(comparison.get("reasons", [])))
    else:
        lines.append("One scan cannot establish what grew overnight or why free space keeps disappearing. Save this scan and compare a later scan of the same scope and policy.")
    if comparison and comparison.get("file_comparison", {}).get("available"):
        changes = comparison.get("files", [])[:6]
        if changes:
            lines.append("Observed file changes:\n" + "\n".join(f"- {_markdown(r['path'])}: {r['status'].replace('_', ' ')}" + (f", {r['delta_bytes']:+,} logical bytes" if r.get("delta_bytes") is not None else "") for r in changes))
        lines.append(comparison["file_comparison"].get("reason", ""))
    if comparison and comparison.get("folder_comparison", {}).get("reason"):
        lines.append(comparison["folder_comparison"]["reason"])
    capacity = (comparison or {}).get("capacity") or {}
    if capacity.get("available"):
        lines.append(f"Volume free-space change: {capacity['free_delta_bytes']:+,} bytes. " + capacity["explanation"])
        if capacity.get("unexplained_delta_bytes") is not None:
            lines.append(f"Difference not accounted for by measured allocated growth: {capacity['unexplained_delta_bytes']:+,} bytes; no specific cause is established.")
    lines.append("Cleanup guidance is conservative: review temporary/cache files, personally review downloads/backups/models, and leave protected or unknown critical files alone. Use Windows Storage settings for system-managed cleanup. Every Trash action requires its own exact-file review; moving to Trash may not free space.")
    if not credential.valid():
        raise HTTPException(401, "The scan session ended. Unlock again.")
    reply = "\n\n".join(lines)
    return {"ok": True, "protocol": PROTOCOL, "local_only": True, "reply": reply, "answer": reply,
            "evidence": evidence, "recommendations": recommendations}


def answer(request, owner, text):
    if not classify(text):
        return None
    credential = storage_jobs.access(request, owner)
    drive = re.search(r"\b([a-z]):", text, re.I)
    with storage_jobs._lock:
        storage_jobs._prune()
        candidates = [job for job in storage_jobs._jobs.values() if job["access"].key == credential.key
                      and job["operation"] == "scan" and job["status"] in storage_jobs.TERMINAL and job["result_available"]
                      and (not drive or str(job.get("path", "")).casefold().startswith(drive[1].casefold() + ":"))]
        selected = max(candidates, key=lambda job: job["created"], default=None)
        ident = selected["id"] if selected else None
        selected_receipt = copy.deepcopy(selected["result"].get("meta", {}).get("saved_scan", {})) if selected else {}
    if not ident:
        return "I don't have a finished storage scan for this session and location. Open Free Space, choose the drive or folder, and Scan. I can then identify measured consumers; save scans to investigate later growth. No scan, provider request or cleanup was performed."
    baseline = None
    try:
        from intelligence.storage_history import history
        saved = history(owner)["snapshots"]
        current = selected_receipt.get("summary", {})
        matches = [s for s in saved if s["id"] != selected_receipt.get("scan_id") and s["root"] == current.get("root") and s["scanned_at"] < current.get("scanned_at", "")]
        if matches: baseline = max(matches, key=lambda s: s["scanned_at"])["id"]
    except HTTPException:
        pass  # Present the valid current scan without claiming a history read.
    return investigate(credential, ident, text, baseline)["reply"]
