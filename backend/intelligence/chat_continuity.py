"""Shared route adapters over existing, owner-scoped saved conversations."""
from fastapi import HTTPException
import tli_state as S
from intelligence import context, memory, answer_evidence, notebook, outcome_answers, case_context
from intelligence.store import LOCK


def recorded_outcome(user, question, *, target_id=None, diagnostic_id=None,
                     use_saved_memory=True, use_conversation_history=True):
    """Explicit saved-report facts before any provider startup or action routing.

    No implicit note/history search: a vague recall question cannot select an
    arbitrary old repair. Existing standalone notes/documents bypass this path.
    The shared context reader still enforces account and target/report binding.
    """
    if outcome_answers.classify(question, selected_report=bool(diagnostic_id)) is None:
        return None
    evidence = context.build(user, question, target_id, diagnostic_id, use_saved_memory=False)
    report = evidence.get("_sections", {}).get("diagnostic_evidence")
    if diagnostic_id and report is None:
        raise HTTPException(422, "The selected report cannot supply a readable recorded outcome. Open the report and select it again.")
    try:
        result = outcome_answers.answer(question, report=report)
    except (ValueError, TypeError, KeyError):
        raise HTTPException(422, "The selected report's outcome metadata is unavailable. Open the original report; no new check or repair ran.") from None
    if result is None:
        return None
    result["memory_context"] = context.public_memory_receipt({"use_saved_memory": use_saved_memory,
        "status": "none" if use_saved_memory else "disabled", "notes": [], "omitted_for_budget": 0})
    result["conversation_context"] = context.public_conversation_receipt({
        "status": "none" if use_conversation_history else "disabled", "included_messages": 0,
        "included_exchanges": 0, "omitted_messages": 0, "character_budget": context.MAX_CHARS,
        "use_conversation_history": use_conversation_history,
        "recall_scope": {"target_id": (evidence.get("_sections", {}).get("device") or {}).get("id"), "standalone_reference": bool(diagnostic_id)}})
    return result


def history(conversation_id, user=None, *, recall_target=None, inspect_notes=False):
    if not conversation_id:
        return {"messages": [], "total": 0}
    # Use the same order as reviewed chat-to-note saves and backup operations.
    with LOCK, S.CONVERSATIONS_LOCK:
        conversation = S.load_conversations().get(conversation_id)
        if not conversation:
            return {"messages": [], "total": 0}
        if user is not None and conversation.get("user_id") not in ({user, "bundled-ai"} if user == "local" else {user}):
            raise HTTPException(404, "Conversation not found.")
        # Invalid/empty positions remain barriers. Removing one before pairing
        # could join an unanswered question to an unrelated orphan assistant.
        turns = [m if isinstance(m, dict) and m.get("role") in ("user", "assistant")
                 and isinstance(m.get("content"), str) and m["content"] else None
                 for m in conversation.get("messages", [])]
        recall = turns[-6:]
        # Standalone selected references have their own sharing contract. They
        # remain historical conversation but cannot seed automatic note recall.
        boundary = 0
        for index, turn in enumerate(recall):
            if turn is None or not turn["content"].strip():
                boundary = index + 1
                continue
            if turn.get("role") == "assistant":
                receipt = context.public_conversation_receipt(turn.get("conversation_context"))
                scope = receipt.get("recall_scope") if receipt else None
                if (any(turn.get(key) is not None for key in ("note_context", "document_context", "screenshot_context", "case_context"))
                        or (scope is None and recall_target is not None)
                        or (scope is not None and (scope["target_id"] != recall_target or scope.get("standalone_reference")))):
                    boundary = index + 1
        recall = recall[boundary:]
        messages, annotations, note_checks = [], [], {}
        changes = {"checked": False, "changed": 0, "unavailable": 0}
        owned = None
        for turn in turns[-64:]:
            if turn is None:
                # Complete-exchange packing removes this; it is never sent.
                messages.append({"role": "assistant", "content": ""})
                continue
            text = turn["content"]
            receipt = context.public_memory_receipt(turn.get("memory_context")) if turn["role"] == "assistant" else None
            if receipt is None and turn["role"] == "assistant":
                receipt = notebook.public_receipt(turn.get("note_context"))
            refs = [(index, n) for index, n in enumerate((receipt or {}).get("notes", []), 1)
                    if not n.get("device_id") or n["device_id"] == recall_target]
            if inspect_notes and user and refs:
                if owned is None:
                    owned = {f["id"]: f for f in S.load_memory(user, strict=True)["facts"] if not f.get("deleted") and not f["id"].startswith("device-")}
                changes["checked"] = True
                changed = unavailable = 0
                references = []
                for index, ref in refs:
                    current = owned.get(ref["id"])
                    if current is None or (current.get("device_id") and current["device_id"] != recall_target):
                        unavailable += 1
                        state = "unavailable"
                    elif memory.revision(current) != ref["revision"]:
                        changed += 1
                        state = "changed"
                    else:
                        continue
                    references.append({"note_id": ref["id"], "title": ref["title"], "revision": ref["revision"],
                                       "handle": f"N{index}", "status": state})
                changes["changed"] += changed
                changes["unavailable"] += unavailable
                note_checks[len(messages)] = {"checked": True, "changed": changed, "unavailable": unavailable,
                                             "references": references}
                if changed or unavailable:
                    text = (f"[Historical assistant answer: {changed} of its saved-note references have changed and {unavailable} are unavailable for this question. "
                            "Do not attribute its old details to a current saved note or treat them as a verified fix.]\n" + text)
                    annotations.append({"content": text, "changed": changed, "unavailable": unavailable})
            messages.append({"role": turn["role"], "content": text})
        # Track whole exchanges by position. Identical answer text does not
        # identify the same turn, and orphan/omitted answers are not supplied.
        paired_checks, pending = [], False
        for index, message in enumerate(messages):
            if not message["content"].strip():
                pending = False
            elif message["role"] == "user":
                pending = True
            elif pending:
                paired_checks.append(note_checks.get(index))
                pending = False
        return {"messages": messages, "historical_notes": changes, "annotations": annotations,
                "pair_note_checks": paired_checks,
                "recall_messages": [{"role": m["role"], "content": m["content"]} for m in recall],
                "total": sum(turn is not None for turn in turns)}


def prepare(user, question, conversation_id, system_prompt, *, target_id=None, diagnostic_id=None,
            device_id=None, use_saved_memory=True, use_conversation_history=True, budget=None):
    # These are bounded local reads/formatting only. A reviewed note mutation
    # cannot land between historical revision inspection and current retrieval.
    # The lock is released before any provider transport or generation starts.
    with LOCK:
        return _prepare(user, question, conversation_id, system_prompt, target_id=target_id,
                        diagnostic_id=diagnostic_id, device_id=device_id,
                        use_saved_memory=use_saved_memory, use_conversation_history=use_conversation_history,
                        budget=budget)


def _prepare(user, question, conversation_id, system_prompt, *, target_id=None, diagnostic_id=None,
             device_id=None, use_saved_memory=True, use_conversation_history=True, budget=None):
    prior = (history(conversation_id, user, recall_target=target_id, inspect_notes=use_saved_memory)
             if use_conversation_history else {"messages": [], "total": 0})
    # History without an explicit matching scope cannot seed a selected target;
    # the history adapter keeps it as conversation but cuts recall at that point.
    query = memory.follow_up_query(question, prior.get("recall_messages", [])) if use_saved_memory and not diagnostic_id else question
    evidence = context.build(user, query, target_id, diagnostic_id, device_id, use_saved_memory=use_saved_memory)
    prepared = context.prepare_messages(system_prompt, question, prior["messages"], evidence,
                                        total_history_messages=prior["total"], budget=budget, use_conversation_history=use_conversation_history)
    # The budgeter retains a suffix of complete exchanges. Use their positions,
    # never answer text or a check performed only for an omitted older turn.
    count = prepared["conversation_context"]["included_exchanges"]
    retained = prior.get("pair_note_checks", [])[-count:] if count else []
    inspected = [item for item in retained if item is not None]
    prepared["evidence_context"]["historical_notes"] = {"checked": bool(inspected),
        "changed": sum(item["changed"] for item in inspected),
        "unavailable": sum(item["unavailable"] for item in inspected)}
    references = [{"exchange_index": index, **reference}
                  for index, item in enumerate(retained, 1) if item is not None
                  for reference in item.get("references", [])]
    if references:
        prepared["evidence_context"]["historical_notes"]["references"] = references
    # Stamp only the current context's validated target. This additive metadata
    # is never an action target or a provider instruction; old readers ignore it.
    selected = evidence.get("_sections", {}).get("device", {})
    prepared["conversation_context"]["recall_scope"] = {"target_id": selected.get("id"),
                                                        "standalone_reference": bool(diagnostic_id)}
    prepared["conversation_context"] = context.public_conversation_receipt(prepared["conversation_context"])
    return prepared


def receipts(prepared):
    result = {}
    case = case_context.public_receipt(prepared.get("case_context"))
    if case is not None:
        result["case_context"] = case
    memory = context.public_memory_receipt(prepared.get("memory_context"))
    history = context.public_conversation_receipt(prepared.get("conversation_context"))
    if memory is not None:
        result["memory_context"] = memory
    if history is not None:
        result["conversation_context"] = history
    from intelligence.input_budget import public_receipt
    budget = public_receipt(prepared.get("input_budget"))
    if budget is not None:
        result["input_budget"] = budget
    from intelligence.observed_answers import public_receipt as public_observation_receipt
    observation = public_observation_receipt(prepared.get("observation_context"))
    if observation is not None:
        result["observation_context"] = observation
    evidence = answer_evidence.public_receipt(prepared.get("evidence_context"))
    if evidence is not None:
        result["evidence_context"] = evidence
    return result


def transport_receipts(result):
    """A provider may update its budget result, never our supplied-source facts."""
    return {key: value for key, value in receipts({"input_budget": result.get("input_budget")}).items() if key == "input_budget"}


def reference_receipts(req, evidence):
    """Standalone references never inherit history, regardless of the checkbox."""
    enabled = getattr(req, "use_conversation_history", True)
    return {**receipts(evidence), "conversation_context": context.public_conversation_receipt({
        "status": "none" if enabled else "disabled", "included_messages": 0, "included_exchanges": 0,
        "omitted_messages": 0, "character_budget": 12000,
        "recall_scope": {"target_id": None, "standalone_reference": True},
        **({"use_conversation_history": False} if not enabled else {})})}


def mesh_receipts():
    # Legacy peers report neither their final prompt nor owner-scoped retrieval.
    # Never forward local private notes/history or display peer note identifiers.
    return {"memory_context": {"use_saved_memory": True, "status": "unknown", "notes": [], "omitted_for_budget": 0},
            "conversation_context": {"status": "unknown", "included_messages": 0, "included_exchanges": 0,
                                     "omitted_messages": 0, "character_budget": 12000}}


def validate_choice(req):
    case_context.validate_choice(req)
    if getattr(req, "use_saved_memory", True) is False and getattr(req, "note_refs", None):
        raise HTTPException(422, "Remove selected Notebook notes before asking without saved memory.")


def source_refs(conversation_id):
    from intelligence.chat_memory import source_refs as sources
    return sources(conversation_id)
