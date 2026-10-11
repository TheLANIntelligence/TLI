from __future__ import annotations

import tli_state as S
from routers import dashboard_presence as dp


def _base_snapshot() -> dict:
    return {
        "alerts": [],
        "storage": {
            "ok": True,
            "system": {"drive": "C:", "mount": "C:\\", "pct": 40},
        },
        "ai": {"ready": True, "bundled": {"model_exists": True}},
        "vault": {"initialized": True, "unlocked": True},
        "smart_home": {"count": 1},
        "mesh": {"status": "approved", "peer_count": 1},
    }


def test_command_center_endpoint_returns_aggregate(authed_client, monkeypatch):
    monkeypatch.setattr(dp, '_read_state', lambda: {'cpu_pct':None,'ram_pct':None,'probed_ts':1000,'probe_error':'Probe unavailable'})
    monkeypatch.setattr(dp, "_node_snapshot", lambda: {
        "id": "node-1",
        "name": "Test Node",
        "role": "standalone",
        "mesh_status": "unpaired",
    })
    monkeypatch.setattr(dp, "_ai_snapshot", lambda: {
        "bundled": {"ok": False, "healthy": False, "model_exists": False},
        "bundled_ok": False,
        "lmstudio_online": False,
        "ready": False,
    })
    monkeypatch.setattr(dp, "_vault_snapshot", lambda user_id: {
        "initialized": True,
        "unlocked": False,
        "locked_until": None,
        "failed_attempts": 0,
    })
    monkeypatch.setattr(dp, "_disk_snapshot", lambda: {
        "ok": True,
        "system": {"drive": "C:", "mount": "C:\\", "pct": 88, "used_gb": 88, "total_gb": 100},
        "drives": [{"mount": "C:\\", "pct": 88}],
        "pct": 88,
    })
    monkeypatch.setattr(dp, "_smart_home_snapshot", lambda: {
        "count": 0,
        "names": [],
        "devices": [],
    })
    monkeypatch.setattr(dp, "_mesh_snapshot", lambda node: {
        "role": "standalone",
        "status": "unpaired",
        "peer_count": 0,
        "online_peer_count": 0,
    })
    monkeypatch.setattr(dp, "_active_alerts", lambda: [])
    monkeypatch.setattr(dp, "get_top_action", lambda: None)

    res = authed_client.get("/dashboard/command-center")

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["node"]["name"] == "Test Node"
    assert body["aiOk"] is False
    assert body["devCount"] == 0
    assert body["diskData"]["system"]["pct"] == 88
    assert body['state']['probed_ts'] == 1000
    assert body['state']['probe_error'] == 'Probe unavailable'
    assert body['state']['cpu_pct'] is None
    assert "suggestions" in body
    assert {"node", "ai", "vault", "storage", "smart_home", "mesh", "narrator", "health", "recent_receipts"} <= set(body)
    assert isinstance(body["health"]["score"], int)
    assert body["suggestions"][0]["reason"]


def test_command_center_suggestions_prioritize_storage_pressure():
    snap = _base_snapshot()
    snap["storage"]["system"]["pct"] = 96

    suggestions = dp._build_suggestions(snap)

    assert suggestions[0]["id"] == "storage_review"
    assert suggestions[0]["severity"] == "critical"


def test_command_center_suggestions_cover_daily_use_gaps():
    snap = _base_snapshot()
    snap["ai"] = {"ready": False, "bundled": {"model_exists": False}}
    snap["vault"] = {"initialized": True, "unlocked": False}
    snap["smart_home"] = {"count": 0}
    snap["mesh"] = {"status": "unpaired", "peer_count": 0}

    ids = {s["id"] for s in dp._build_suggestions(snap)}

    assert {"ai_start", "vault_unlock", "home_add_device", "mesh_connect_peer"} <= ids


def test_command_center_health_score_reflects_attention_needed():
    snap = _base_snapshot()
    snap["storage"]["system"]["pct"] = 99
    snap["ai"] = {"ready": False, "bundled": {"model_exists": False}}
    snap["alerts"] = [{"severity": "critical", "message": "Critical"}]

    health = dp._health_snapshot(snap)

    assert health["score"] < 75
    assert health["level"] in {"warning", "critical"}
    assert health["factors"]


def test_command_center_requires_session_when_pin_enabled(client, monkeypatch):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})

    res = client.get("/dashboard/command-center")

    assert res.status_code == 401


def test_action_mutations_require_session_when_pin_enabled(client, monkeypatch):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})

    approve = client.post("/actions/approve", json={"name": "Test", "steps": []})
    run = client.post("/actions/run/act_missing")

    assert approve.status_code == 401
    assert run.status_code == 401
