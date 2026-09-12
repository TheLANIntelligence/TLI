import pytest
from fastapi import HTTPException

from narrator_policy import NarratorPolicy
from routers import dashboard_presence as dp
import narrator_settings as settings
import tli_state as S


def state(t, **kwargs):
    return {"probed_ts": 1000 + t, "cpu_pct": 20, "ram_pct": 40, "disk_pct_by_drive": {"C:\\": 40}, **kwargs}


@pytest.mark.parametrize("mode", ["quiet", "balanced", "detailed"])
def test_modes_preserve_confirmation_critical_alert_and_warning_duration(mode):
    p = NarratorPolicy(); p.set_mode(mode)
    p.confirm("Panel opened.", 0)
    assert p.render(state(9), 9, 1009)[0] == "Panel opened."
    assert p.render(state(10), 10, 1010)[1] != "confirmation"
    for t in range(10, 41, 5):
        result = p.render(state(t, cpu_pct=95), t, 1000 + t)
    assert result[1] == "alert" and "CPU" in result[0]
    assert "30 seconds" in p.explanations(state(40, cpu_pct=95), 40, 1040)[0]["why"]
    p.confirm("Saved", 41)
    result = p.render(state(42, disk_pct_by_drive={"D:\\": 98}), 42, 1042)
    assert result[1] == "alert" and "critically full" in result[0]
    assert p.confirmation is None


def test_quiet_suppresses_informational_changes_but_detailed_changes_checkin_cadence():
    quiet = NarratorPolicy(); quiet.set_mode("quiet")
    event = {"title": "Routine change", "level": "info"}
    first = quiet.render(state(0), 0, 1000, event)
    assert "Routine change" not in first[0]
    assert quiet.render(state(60, cpu_pct=30), 60, 1060) == first
    assert "Failure" in quiet.render(state(61), 61, 1061, {"title": "Failure", "level": "warn"})[0]
    detailed = NarratorPolicy(); detailed.set_mode("detailed")
    first = detailed.render(state(0), 0, 1000)
    assert detailed.render(state(29), 29, 1029) == first
    assert "Storage check" in detailed.render(state(30), 30, 1030)[0]


def test_mode_changes_do_not_reset_pressure_dedup_or_confirmations():
    p = NarratorPolicy()
    for t in (0, 5, 10): p.render(state(t, cpu_pct=95), t, 1000 + t)
    p.confirm("Opened", 11); p.set_mode("quiet")
    assert p.render(state(15, cpu_pct=95), 15, 1015)[0] == "Opened"
    for t in (20, 25, 30): result = p.render(state(t, cpu_pct=95), t, 1000 + t)
    assert result[1] == "alert"
    p.render(state(31), 31, 1031, {"title": "Critical", "level": "critical"})
    p.set_mode("detailed")
    assert p.seen and p.critical_event


def test_warning_explanations_include_clearing_conditions_and_monitoring_gaps():
    p = NarratorPolicy()
    rows = p.explanations(state(0, disk_pct_by_drive={"C:\\": 98}), 0, 1000)
    assert "below 85%" in rows[0]["clears_when"] and "95%" in rows[0]["why"]
    rows = p.explanations(state(0), 30, 1030)
    assert rows[0]["kind"] == "monitoring" and "missing" in rows[0]["clears_when"].lower()


def test_preferences_default_persistence_and_invalid_mode(tmp_path, monkeypatch, authed_client):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(dp, "_narrator_policy", NarratorPolicy())
    assert settings.read() == {"mode": "balanced"}
    assert not (tmp_path / "narrator-settings.json").exists()
    result = authed_client.put("/dashboard/narrator/settings", json={"mode": "quiet"})
    assert result.status_code == 200 and result.json()["scope"] == "host"
    assert dp._narrator_policy.mode == "quiet" and settings.read()["mode"] == "quiet"
    assert authed_client.get("/dashboard/narrator/settings").json()["mode"] == "quiet"
    assert authed_client.put("/dashboard/narrator/settings", json={"mode": "off"}).status_code == 422


def test_preferences_require_authentication(client, monkeypatch):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    assert client.put("/dashboard/narrator/settings", json={"mode": "detailed"}).status_code == 401
    assert client.get("/dashboard/narrator/settings").status_code == 401


def test_failed_preferences_preserve_bytes_and_active_mode(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    settings.save("quiet")
    previous = (tmp_path / "narrator-settings.json").read_bytes()
    monkeypatch.setattr(settings.os, "replace", lambda *args: (_ for _ in ()).throw(OSError("private path")))
    with pytest.raises(HTTPException): settings.save("detailed")
    assert (tmp_path / "narrator-settings.json").read_bytes() == previous
    (tmp_path / "narrator-settings.json").write_bytes(b"broken")
    with pytest.raises(HTTPException): settings.save("detailed")
    assert (tmp_path / "narrator-settings.json").read_bytes() == b"broken"
