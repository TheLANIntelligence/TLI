"""Explicit peer observations through real routes with synthetic peer transport."""
import copy
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import peer_trust
import tli_state as S
from intelligence import diagnostics as D, diagnostic_workflow as W, report_facts, report_review
from routers.intelligence_routes import router
from routers.system_routes import require_session
from tests.test_guided_diagnostics import isolated, HOST, OTHER

PEER = {"id": OTHER["node_id"], "name": "Verified other computer", "identity_fingerprint": "a" * 64}


@pytest.fixture
def peer(monkeypatch):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    monkeypatch.setattr(D, "run", lambda *a, **kw: pytest.fail("Never replace a peer observation with a local check"))
    capability = {"available": True, "reason": None, "peer": {**PEER, "origin": "https://192.0.2.5:8000"},
                  "revision": "b" * 64, "capabilities": ["system_observation_v1"]}
    calls = []
    monkeypatch.setattr(peer_trust, "capability", lambda ident: copy.deepcopy(capability))
    def observe(ident, revision):
        calls.append((ident, revision))
        return {"protocol": "tli-peer-observation-v1", "host": copy.deepcopy(PEER), "observed_at": "2026-09-09T10:00:00Z",
                "scope": "Measurements made on this named TLI peer, not the requesting computer.",
                "facts": {"cpu_percent": 0, "logical_cpus": 8, "ram_total_bytes": 16000, "ram_used_bytes": 4000,
                          "ram_available_bytes": 12000, "ram_percent": 25, "uptime_seconds": 900},
                "limitations": ["No app cause or repair was measured."], "peer_revision": revision}
    monkeypatch.setattr(peer_trust, "observe", observe)
    return capability, calls, observe


def body():
    option = next(o for o in W.options("peer", include_peer_observation=True)["options"] if o["kind"] == "peer_system")
    return {"kind": "peer_system", "target_id": "peer", "internet": False, "expected_host_id": option["execution_host"]["id"],
            "expected_scope": option["scope_revision"], "request_id": "reviewed-native-peer"}


def run(values, **kw):
    return W.run_reviewed("owner", **values, **kw)


def test_options_are_metadata_only_and_native_report_saved_once_with_original_timestamp(peer, monkeypatch):
    capability, calls, _ = peer
    assert all(o["kind"] != "peer_system" for o in W.options("peer")["options"])
    options = W.options("peer", include_peer_observation=True); native = next(o for o in options["options"] if o["kind"] == "peer_system")
    assert not calls and options["host"]["id"] == "host"
    assert native["execution_host"]["id"] == PEER["id"] and native["measured_target"]["id"] == "peer"
    monkeypatch.setattr(S, "validate_session_token", lambda value: value == "fixture-browser-session")
    monkeypatch.setattr(S, "get_session_user_id", lambda value: "owner")
    app = FastAPI(); app.include_router(router)
    with TestClient(app) as api:
        api.cookies.set("tli_session", "fixture-browser-session")
        values = body(); response = api.post('/api/intelligence/diagnostics', json=values)
        assert response.status_code == 200, response.text
        report = response.json()
        assert report["kind"] == "system" and report["host"] == PEER and report["target"]["id"] == "peer"
        assert report["created_at"] == "2026-09-09T10:00:00Z" and report["execution"]["requesting_host"]["id"] == HOST["id"]
        assert report["checks"][0]["detail"] == "Recorded 0 percent of the peer's host capacity."
        assert "named TLI peer" in " ".join(report["recorded_facts"]["limitations"])
        W._requests.clear()
        assert api.post('/api/intelligence/diagnostics', json=values).json()["id"] == report["id"]
        assert calls == [(PEER["id"], capability["revision"])]
        stored = D.get_report("owner", report["id"])
        assert "recorded_facts" not in stored and report_facts.build(stored) == report["recorded_facts"]
        assert not report_review.repeat_review("owner", report["id"])["available"]


@pytest.mark.parametrize("change", ["trust", "revision", "name", "host", "internet"])
def test_changed_review_rejects_before_any_peer_or_local_measurement(peer, change):
    capability, calls, _ = peer
    values = body()
    if change == "trust": capability["available"] = False
    if change == "revision": capability["revision"] = "c" * 64
    if change == "name": capability["peer"]["name"] = "Changed"
    if change == "host": values["expected_host_id"] = HOST["id"]
    if change == "internet": values["internet"] = True
    with pytest.raises(HTTPException): run(values)
    assert not calls and D.history("owner") == []


@pytest.mark.parametrize("failure", ["timeout", "wrong_identity", "revoked"])
def test_uncertain_or_revoked_observation_never_saves_or_replays(peer, monkeypatch, failure):
    _, calls, observe = peer
    values = body(); access = [True]
    def transport(ident, revision):
        if failure == "timeout":
            calls.append((ident, revision)); raise HTTPException(504, "Synthetic timeout")
        value = observe(ident, revision)
        if failure == "wrong_identity": value["host"]["id"] = "other"
        if failure == "revoked": access[0] = False
        return value
    monkeypatch.setattr(peer_trust, "observe", transport)
    def authorize():
        if not access[0]: raise HTTPException(401, "Synthetic session revoked")
    with pytest.raises(HTTPException): run(values, authorize=authorize)
    assert D.history("owner") == [] and len(calls) == 1
    with pytest.raises(HTTPException): run(values)
    assert len(calls) == 1


def test_duplicate_concurrent_peer_run_has_one_transport_and_preserves_identity(peer, monkeypatch):
    _, calls, observe = peer
    entered, release = threading.Event(), threading.Event()
    def transport(*args):
        entered.set(); assert release.wait(3); return observe(*args)
    monkeypatch.setattr(peer_trust, "observe", transport)
    values = body()
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(run, values); assert entered.wait(3)
        with pytest.raises(HTTPException) as error: run(values)
        assert error.value.status_code == 409
        release.set(); saved = first.result(3)
    assert len(calls) == 1 and saved["host"]["id"] == PEER["id"]


def test_peer_comparison_never_combines_changed_trust_identity(peer):
    saved = run(body()); later = copy.deepcopy(saved); later["id"] = "another-report"
    assert report_review.compare(saved, later)["comparable"]
    later["host"]["identity_fingerprint"] = "c" * 64
    assert not report_review.compare(saved, later)["comparable"]


@pytest.mark.parametrize("all_missing", [False, True])
def test_nullable_peer_metrics_stay_unavailable_and_preserve_coverage(peer, monkeypatch, all_missing):
    _, calls, observe = peer
    def transport(ident, revision):
        value = observe(ident, revision)
        for key in value["facts"]:
            if all_missing or key != "cpu_percent":
                value["facts"][key] = None
        value["coverage"] = {"complete": False, "known_metrics": 0 if all_missing else 1, "total_metrics": 7}
        value["limitations"].append("Some measurements were unavailable on this peer.")
        return value
    monkeypatch.setattr(peer_trust, "observe", transport)
    saved = run(body())
    assert len(calls) == 1 and len(saved["checks"]) == 7
    unavailable = [row for row in saved["checks"] if row["status"] == "unavailable"]
    assert len(unavailable) == (7 if all_missing else 6)
    assert all("No usable measurement" in row["detail"] and "Recorded 0" not in row["detail"] for row in unavailable)
    if not all_missing:
        assert saved["checks"][0]["detail"].startswith("Recorded 0 percent")
    stored = D.get_report("owner", saved["id"])
    assert stored["peer_observation"]["coverage"] == {"complete": False, "known_metrics": 0 if all_missing else 1, "total_metrics": 7}
    facts = report_facts.build(stored)
    assert facts["status"] == "partial" and all(row["status"] == "unavailable" for row in facts["checks"] if all_missing or row["id"] != "cpu_percent")
