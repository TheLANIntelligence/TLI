"""Reviewed check scope and duplicate protection; no automatic diagnostics."""
from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from fastapi import HTTPException
import tli_state as S
from intelligence import devices, diagnostics

PROTOCOL = "tli-guided-checks-v1"
_lock = threading.RLock()
_requests = {}
_TTL = 600
_LIMIT = 128


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def scope(kind, target_id=None, internet=False):
    if kind == "peer_system":
        import peer_trust
        if not target_id or internet:
            raise HTTPException(422, "Choose one reviewed TLI peer for its native system observation; internet probes are not included.")
        selected = devices.get(target_id)
        if selected.get("kind") != "computer" or selected.get("source") == "local_node":
            raise HTTPException(422, "Choose an explicitly trusted other TLI computer.")
        raw_id = selected.get("source_id") or selected.get("node_id")
        capability = peer_trust.capability(raw_id) if raw_id else {"available": False}
        if not capability.get("available"):
            raise HTTPException(403, "This computer has no available, reviewed peer-observation capability. No host check was substituted.")
        peer = capability["peer"]
        if peer["id"] != raw_id or raw_id == devices.node()["id"]:
            raise HTTPException(409, "The peer identity changed. Review the computer again; nothing ran.")
        value = {"kind": kind, "host": {key: peer[key] for key in ("id", "name", "identity_fingerprint")},
                 "target": {key: selected.get(key) for key in ("id", "name", "kind", "node_id", "source_id", "source")},
                 "internet": False, "peer_revision": capability["revision"], "requesting_host": devices.node()}
        value["revision"] = _digest(value)
        return value
    if kind not in {"system", "network", "device"}:
        raise HTTPException(422, "Choose an available diagnostic check.")
    if kind != "device" and target_id:
        raise HTTPException(422, "System and network checks measure the TLI host. They cannot target another computer.")
    if internet and kind != "network":
        raise HTTPException(422, "Internet checks belong to the network check only.")
    host = devices.node()
    target = devices.get(target_id) if kind == "device" and target_id else None
    if kind == "device" and (not target or target.get("id") == host.get("id") or target.get("source") == "local_node"):
        raise HTTPException(422, "Choose a registered network device for a reachability check.")
    target_fields = ("id", "name", "kind", "address", "relay", "node_id", "source")
    value = {"kind": kind, "host": {key: host.get(key) for key in ("id", "name", "node_id")},
             "target": {key: target.get(key) for key in target_fields} if target else None,
             "internet": bool(internet)}
    value["revision"] = _digest(value)
    return value


def options(computer_id=None, *, include_peer_observation=False):
    host = devices.node()
    selected = devices.get(computer_id) if computer_id else None
    if selected and selected.get("kind") != "computer":
        raise HTTPException(422, "Choose the computer involved in this problem.")
    # Inventory IDs have a node- prefix; the execution host has its raw node ID.
    local = bool(selected and selected.get("source") == "local_node" and
                 (selected.get("source_id") or selected.get("node_id")) == host.get("id"))
    rows = []
    for kind, title, detail in (
        ("system", "Check host resources", "A short CPU and memory sample, plus accessible drive usage. This does not establish the cause of slowness."),
        ("network", "Check the host's network", "Inspect host interfaces and the default route, and try a gateway ping. The phone's own Wi-Fi is not measured."),
    ):
        reviewed = scope(kind)
        rows.append({"id": kind, "title": title, "detail": detail, "available": local,
                     "reason": "" if local else "Select the TLI host to measure its resources or connection. This is not a remote-computer check.",
                     "kind": kind, "target_id": None, "scope_revision": reviewed["revision"], "internet": False,
                     "execution_host": reviewed["host"], "measured_target": reviewed["host"]})
        if kind == "network":
            rows[-1]["internet_scope_revision"] = scope(kind, internet=True)["revision"]
            rows[-1]["internet_detail"] = "Optional: contact 1.1.1.1:443 and ask the configured DNS resolver for example.com."
    if selected and not local:
        reviewed = scope("device", selected["id"])
        ports = "631 and 9100" if selected.get("kind") == "printer" else "80 and 443"
        rows.append({"id": "device", "title": "Check reachability from this host", "kind": "device",
                     "target_id": selected["id"], "internet": False, "scope_revision": reviewed["revision"],
                     "execution_host": reviewed["host"], "measured_target": reviewed["target"],
                     "available": bool(selected.get("address")), "reason": "" if selected.get("address") else "No network address is registered for this computer.",
                     "detail": f"Try TCP ports {ports} from the TLI host to the registered address. This does not measure remote CPU, apps or successful device operation."})
        if include_peer_observation:
            import peer_trust
            raw_id = selected.get("source_id") or selected.get("node_id")
            capability = peer_trust.capability(raw_id) if raw_id else {"available": False, "reason": "This inventory entry has no native TLI peer identity."}
            available = capability.get("available") is True
            reviewed_peer = scope("peer_system", selected["id"]) if available else None
            peer = (capability.get("peer") or {})
            reason = capability.get("reason")
            if isinstance(reason, dict):
                reason = reason.get("message")
            rows.append({"id": "peer_system", "title": "Observe this TLI peer's resources", "kind": "peer_system",
                         "target_id": selected["id"], "internet": False, "available": available,
                         "scope_revision": reviewed_peer["revision"] if reviewed_peer else _digest({"unavailable_peer": selected["id"]}),
                         "execution_host": reviewed_peer["host"] if reviewed_peer else {"id": raw_id or selected["id"], "name": peer.get("name") or selected["name"]},
                         "measured_target": reviewed_peer["target"] if reviewed_peer else {"id": selected["id"], "name": selected["name"]},
                         "reason": "" if available else str(reason or "Peer observation is unavailable until bilateral identity and read-only access are reviewed.")[:2000],
                         "detail": "One authenticated CPU, RAM and uptime observation measured by the selected TLI peer. No disk, network, process, repair or phone measurements. No local-host fallback."})
    rows.append({"id": "performance", "title": "Observe an application", "kind": "performance", "target_id": None,
                 "available": local, "reason": "" if local else "Application observations run on the TLI host only.",
                 "detail": "Open App performance check, choose a process and explicitly start a 30-second observation.",
                 "execution_host": {key: host.get(key) for key in ("id", "name", "node_id")},
                 "measured_target": {key: host.get(key) for key in ("id", "name", "node_id")}, "internet": False,
                 "panel": "panel-games", "desktop_panel": "panel-performance"})
    return {"ok": True, "protocol": PROTOCOL, "checked_at": S.now_iso(), "host": {key: host.get(key) for key in ("id", "name", "node_id")},
            "computer_id": computer_id, "options": rows, "actions_performed": False}


def run_reviewed(user, kind, target_id=None, internet=False, *, expected_host_id, request_id, expected_scope=None,
                 repeat_of=None, expected_report_revision=None, authorize=None, request_context=None):
    if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 128:
        raise HTTPException(422, "Use a nonempty request identifier for this reviewed check.")
    if authorize:
        authorize()
    reviewed = scope(kind, target_id, internet)
    if kind == "peer_system" and (not expected_scope or repeat_of or expected_report_revision):
        raise HTTPException(422, "Review the peer's current identity and observation scope before each new observation.")
    if reviewed["host"]["id"] != expected_host_id:
        raise HTTPException(409, "The executing TLI host changed. Review the check again; nothing ran.")
    if expected_scope is not None and reviewed["revision"] != expected_scope:
        raise HTTPException(409, "The check's target or scope changed. Review it again; nothing ran.")
    if repeat_of is not None or expected_report_revision is not None:
        if not repeat_of or not expected_report_revision or not expected_scope:
            raise HTTPException(422, "Review the original report and scope before repeating a check.")
        from intelligence.report_review import validate_repeat
        validate_repeat(user, repeat_of, expected_report_revision, kind, target_id, internet)
    key = hashlib.sha256(request_id.encode()).hexdigest()
    identity = (user, key)
    signature = _digest({"scope": reviewed["revision"], "repeat_of": repeat_of, "report_revision": expected_report_revision}) if repeat_of else reviewed["revision"]
    if request_context is not None:
        if not isinstance(request_context, str) or len(request_context) != 64 or any(c not in "0123456789abcdef" for c in request_context):
            raise HTTPException(422, "Invalid reviewed source identity; nothing ran.")
        signature = _digest({"scope": signature, "next_check_selection": request_context})
    with _lock:
        # A completed receipt travels with its encrypted report across restart.
        for report in diagnostics.history(user):
            receipt = report.get("_check_request") or {}
            if receipt.get("key") == key:
                if receipt.get("signature") != signature:
                    raise HTTPException(409, "This request identifier belongs to a different check. Nothing ran.")
                if authorize:
                    authorize()
                return report
        now = time.monotonic()
        for old, entry in list(_requests.items()):
            if entry["state"] != "running" and now - entry["time"] > _TTL:
                del _requests[old]
        if identity in _requests:
            raise HTTPException(409, "This check is running or its result is uncertain. Review diagnostic history before deliberately starting another check.")
        if len(_requests) >= _LIMIT:
            raise HTTPException(429, "The check-request limit was reached. Wait before starting another check.")
        _requests[identity] = {"state": "running", "time": now}
    try:
        receipt = {"key": key, "signature": signature}
        if repeat_of:
            receipt.update(repeat_of=repeat_of, report_revision=expected_report_revision)
        if request_context is not None:
            receipt["next_check_selection"] = request_context
        if authorize:
            authorize()
        if kind == "peer_system":
            return _peer_report(user, reviewed, receipt, authorize)
        return diagnostics.run(user, kind, target_id, internet, _request_receipt=receipt, _reviewed_scope=reviewed)
    finally:
        with _lock:
            _requests[identity] = {"state": "finished", "time": time.monotonic()}


def _peer_report(user, reviewed, receipt, authorize):
    """Exactly one authenticated observation; no local probe or fallback."""
    import peer_trust
    if authorize:
        authorize()
    value = peer_trust.observe(reviewed["host"]["id"], reviewed["peer_revision"])
    if authorize:
        authorize()
    if (value.get("protocol") != "tli-peer-observation-v1" or value.get("peer_revision") != reviewed["peer_revision"]
            or value.get("host") != reviewed["host"]):
        raise HTTPException(502, "The peer response did not match the reviewed host and identity. No host result was substituted.")
    facts = value["facts"]
    fields = (("cpu_percent", "Peer CPU", "percent of the peer's host capacity"),
              ("logical_cpus", "Peer logical CPUs", "logical CPUs"), ("ram_total_bytes", "Peer total RAM", "bytes"),
              ("ram_used_bytes", "Peer used RAM", "bytes"), ("ram_available_bytes", "Peer available RAM", "bytes"),
              ("ram_percent", "Peer RAM use", "percent"), ("uptime_seconds", "Peer uptime", "seconds"))
    checks = [{"id": key, "label": label, "status": "pass" if facts.get(key) is not None else "unavailable",
               "detail": f"Recorded {facts[key]} {unit}." if facts.get(key) is not None else "No usable measurement was supplied by this peer."}
              for key, label, unit in fields]
    report = {"id": str(uuid.uuid4()), "created_at": value["observed_at"], "kind": "system", "host": value["host"],
              "target": reviewed["target"], "checks": checks, "findings": [], "next_steps": [], "internet_checks": False,
              "scope": value["scope"], "peer_observation": value,
              "execution": {"kind": "peer_system", "peer_revision": reviewed["peer_revision"],
                            "identity_fingerprint": reviewed["host"]["identity_fingerprint"], "requesting_host": reviewed["requesting_host"]},
              "received_at": S.now_iso(), "_check_request": receipt}
    if authorize:
        authorize()
    return diagnostics.save_report(user, report)
