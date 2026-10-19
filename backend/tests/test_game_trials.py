"""Game trial planning uses supplied values, real browser access and no AI/I/O."""
import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import tli_state as S
import private_client_authority as authority
from game_configs import registry
from intelligence import game_plans, read_only_inference
from routers import games as G
from routers.system_routes import require_session


@pytest.fixture
def planner(monkeypatch):
    app = FastAPI()
    app.include_router(G.games_router)
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "_active_sessions", {})
    token = S.create_session_token("game-owner")
    def forbidden(*args, **kwargs):
        pytest.fail("Planning must not read settings, sample the host, persist or call AI")
    for name in ("prepare", "stream", "bind"):
        monkeypatch.setattr(read_only_inference, name, forbidden)
    monkeypatch.setattr(registry, "read_game_config", forbidden)
    monkeypatch.setattr(G, "_scan_running_games", forbidden)
    monkeypatch.setattr(G, "_proc_metrics", forbidden)
    monkeypatch.setattr(S, "save_conversations", forbidden)
    monkeypatch.setattr(S, "load_conversations", forbidden)
    with TestClient(app, base_url="https://testserver", headers={"Origin": "https://testserver"},
                    cookies={"tli_session": token}) as client:
        yield SimpleNamespace(client=client, app=app, token=token)


def prepare(planner, **values):
    return planner.client.post("/games/plan", json={"game_name": "Cyberpunk 2077", **values})


@pytest.mark.parametrize("game,control", [("Cyberpunk 2077", "crowd_density"),
    ("the witcher 3", "foliage_quality"), ("RDR2", "volumetrics_quality")])
def test_known_game_catalogue_is_available_without_hardware_provider_or_config_read(planner, game, control):
    response = prepare(planner, game_name=game)
    assert response.status_code == 200
    data = response.json()
    assert data["protocol"] == "tli-game-plan-v1" and data["source"] == "setting-trials"
    assert data["mode"] == "reader-vocabulary" and data["applied"] is False
    assert data["settings_plan"] == []
    assert control in [row["key"] for row in data["controls"]]
    assert data["needs_current"] == [{"key": row["key"], "label": row["label"]} for row in data["controls"]]
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("goal,current,expected", [("stable_60", "Ultra", "High"),
    ("high_fps", "High", "Medium"), ("max_visual", "Low", "Medium")])
def test_trials_change_one_quality_step_and_preserve_current_provenance(planner, goal, current, expected):
    data = prepare(planner, preset=goal, config_game_name="Cyberpunk 2077",
                   current_settings=[{"key": "shadow_quality", "value": current}]).json()
    trial, = data["settings_plan"]
    assert trial["current"] == current and trial["suggested"] == expected
    assert trial["current_source"] == "read" and trial["scope"] == "installed reader vocabulary"
    assert "confirm each suggested option exists" in data["text"]
    assert len(data["comparison_steps"]) == 3 and "same scene" in data["comparison_steps"][1]


def test_manual_override_takes_precedence_and_wrong_game_settings_are_not_current(planner):
    data = prepare(planner, config_game_name="Another game", current_settings=[{"key": "shadow_quality", "value": "Ultra"}],
                   manual_values={"shadow_quality": "High"}).json()
    assert [(item["current"], item["suggested"], item["current_source"]) for item in data["settings_plan"]] == [("High", "Medium", "user")]
    empty = prepare(planner, config_game_name="Another game", current_settings=[{"key": "shadow_quality", "value": "Ultra"}]).json()
    assert empty["settings_plan"] == []


def test_clearing_current_does_not_guess_a_baseline(planner):
    data = prepare(planner, config_game_name="Cyberpunk 2077", current_settings=[{"key": "shadow_quality", "value": "High"}],
                   manual_values={"shadow_quality": ""}).json()
    assert not data["settings_plan"] and {"key": "shadow_quality", "label": "Shadow Quality"} in data["needs_current"]


@pytest.mark.parametrize("goal,current", [("stable_60", "Low"), ("high_fps", "Low"), ("max_visual", "Ultra")])
def test_end_of_range_does_not_offer_noop_or_wrong_direction(planner, goal, current):
    values = {item["key"]: current for item in game_plans.schema("Cyberpunk 2077")}
    data = prepare(planner, preset=goal, manual_values=values).json()
    assert data["settings_plan"] == [] and data["needs_current"] == []
    assert "end of the listed quality range" in data["text"]


def test_at_most_three_trials_and_explicit_avoid_list(planner):
    values = {item["key"]: "High" for item in game_plans.schema("Cyberpunk 2077")}
    first = prepare(planner, manual_values=values).json()["settings_plan"]
    assert len(first) == 3
    second = prepare(planner, manual_values=values, avoid_settings=[item["key"] for item in first]).json()["settings_plan"]
    assert len(second) == 2 and not {item["key"] for item in first} & {item["key"] for item in second}


@pytest.mark.parametrize("count", [1, 2, 3])
def test_explicit_trials_take_priority_over_a_full_automatic_plan(planner, count):
    values = {item["key"]: "High" for item in game_plans.schema("Cyberpunk 2077")}
    explicit = [{"label": f"Exact menu option {index}", "current": "Enabled", "suggested": "Disabled"}
                for index in range(count)]
    response = prepare(planner, manual_values=values, custom_trials=explicit)
    assert response.status_code == 200
    plan = response.json()["settings_plan"]
    assert len(plan) == 3
    assert [{field: row[field] for field in ("label", "current", "suggested")} for row in plan[:count]] == explicit
    assert all(row["current_source"] == "user" and row["scope"] == "user-named; options unverified" for row in plan[:count])
    assert all(row["scope"] == "installed reader vocabulary" for row in plan[count:])


@pytest.mark.parametrize("label,key", [("shadow_quality", "shadow_quality"), ("SHADOW Quality", "shadow_quality"),
    ("Shadows", "shadow_quality"), ("Textures", "texture_quality"), ("Pedestrian Density", "crowd_density")])
def test_exact_known_setting_trial_replaces_automatic_suggestion_and_read_provenance(planner, label, key):
    values = [{"key": item["key"], "value": "High"} for item in game_plans.schema("Cyberpunk 2077")]
    data = prepare(planner, config_game_name="Cyberpunk 2077", current_settings=values,
                   custom_trials=[{"label": label, "current": "Custom current", "suggested": "Custom trial"}]).json()
    explicit = data["settings_plan"][0]
    assert (explicit["label"], explicit["current"], explicit["suggested"], explicit["current_source"]) == (
        label, "Custom current", "Custom trial", "user")
    assert explicit["scope"] == "user-named; options unverified" and "not verified" in explicit["reason"]
    assert key not in {row["key"] for row in data["settings_plan"]}
    assert all(row["current_source"] == "read" for row in data["settings_plan"][1:])


def test_exact_known_setting_trial_supplies_its_own_current_value(planner):
    data = prepare(planner, custom_trials=[{"label": "Shadows", "current": "Off", "suggested": "On"}]).json()
    assert len(data["settings_plan"]) == 1
    assert "shadow_quality" not in {row["key"] for row in data["needs_current"]}
    assert len(data["needs_current"]) == 4


@pytest.mark.parametrize("goal,current,trial", [("stable_60", "Low", "Off"), ("max_visual", "Ultra", "Custom")])
def test_explicit_trial_remains_available_at_quality_boundary(planner, goal, current, trial):
    values = {item["key"]: current for item in game_plans.schema("Cyberpunk 2077")}
    data = prepare(planner, preset=goal, manual_values=values,
                   custom_trials=[{"label": "Shadow Quality", "current": current, "suggested": trial}]).json()
    explicit, = data["settings_plan"]
    assert (explicit["current"], explicit["suggested"], explicit["current_source"]) == (current, trial, "user")
    assert data["needs_current"] == [] and "not verified" in explicit["reason"]


@pytest.mark.parametrize("excluded", ["shadow_quality", "custom_0"])
def test_excluding_explicit_known_trial_does_not_restore_automatic_suggestion(planner, excluded):
    data = prepare(planner, manual_values={"shadow_quality": "High"}, avoid_settings=[excluded],
                   custom_trials=[{"label": "Shadows", "current": "High", "suggested": "Low"}]).json()
    assert data["settings_plan"] == []
    assert "shadow_quality" not in {row["key"] for row in data["needs_current"]}


@pytest.mark.parametrize("labels", [("shadow_quality", "Shadow Quality"), ("Shadows", "shadow-quality"),
    ("Crowd Density", "pedestrian_density"), ("Menu option", " Menu   OPTION ")])
def test_duplicate_explicit_settings_are_rejected_after_name_resolution(planner, labels):
    response = prepare(planner, custom_trials=[{"label": label, "current": "On", "suggested": "Off"} for label in labels])
    assert response.status_code == 422 and response.headers["Cache-Control"] == "no-store"
    assert "distinct setting name" in response.json()["detail"]


@pytest.mark.parametrize("game", ["Cyberpunk 2077", "Unknown game"])
def test_four_explicit_trials_are_rejected_instead_of_silently_dropping_one(planner, game):
    response = prepare(planner, game_name=game,
                       custom_trials=[{"label": f"Option {index}", "current": "On", "suggested": "Off"} for index in range(4)])
    assert response.status_code == 422 and response.headers["Cache-Control"] == "no-store"
    assert "settings_plan" not in response.json()


def test_unsupported_game_has_manual_mode_without_invented_menu_options(planner):
    data = prepare(planner, game_name="Unknown game").json()
    assert data["mode"] == "manual" and data["controls"] == [] and data["settings_plan"] == []
    assert "exactly as shown" in data["text"]
    old = prepare(planner, game_name="Unknown game", custom_settings=[{"label": "Shadow detail", "current": "High"}]).json()
    assert old["settings_plan"] == []  # legacy current alone does not grant a guessed menu target


def test_explicit_manual_values_support_switches_and_numbers_without_fabricating_effects(planner):
    data = prepare(planner, game_name="Unknown game", custom_trials=[
        {"label": "A menu switch", "current": "On", "suggested": "Off"},
        {"label": "Render percentage", "current": "100%", "suggested": "90%"}]).json()
    assert [(item["current"], item["suggested"]) for item in data["settings_plan"]] == [("On", "Off"), ("100%", "90%")]
    assert all(item["current_source"] == "user" and item["scope"] == "user-named; options unverified" for item in data["settings_plan"])
    assert "not verified" in data["settings_plan"][0]["reason"] and data["applied"] is False


@pytest.mark.parametrize("patch", [
    {"game_name": " "}, {"game_name": "a" * 121}, {"preset": "overclock"},
    {"manual_values": {"shadow_quality": "Extreme"}}, {"manual_values": {"fake_setting": "High"}},
    {"current_settings": [{"value": "x" * 241}]}, {"avoid_settings": ["x" * 101]},
    {"custom_trials": [{"label": "Switch", "current": "On", "suggested": "on"}]},
    {"custom_trials": [{"label": " ", "current": "On", "suggested": "Off"}]},
    {"custom_trials": [{"label": "Switch", "current": " ", "suggested": "Off"}]},
    {"custom_trials": [{"label": "Switch", "current": "On", "suggested": "x" * 81}]},
    {"custom_trials": [{"label": "Switch", "current": "On", "suggested": "Off"}] * 2},
    {"custom_trials": [{"label": str(index), "current": "On", "suggested": "Off"} for index in range(7)]},
])
def test_bad_or_unbounded_settings_are_rejected_before_planning(planner, patch):
    response = prepare(planner, **patch)
    assert response.status_code == 422 and response.headers["Cache-Control"] == "no-store"


def test_owner_override_does_not_grant_browser_access(planner):
    planner.app.dependency_overrides[require_session] = lambda: "game-owner"
    planner.client.cookies.clear()
    response = prepare(planner, manual_values={"shadow_quality": "High"})
    assert response.status_code == 401 and "settings_plan" not in response.text


def test_native_credentials_do_not_grant_game_plan_browser_access(planner):
    planner.app.dependency_overrides[require_session] = lambda: "game-owner"
    response = planner.client.post("/games/plan", json={"game_name": "Game"}, headers={"Authorization": "Bearer tlic_fixture"})
    assert response.status_code == 403 and response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("boundary", ["catalogue", "encoding"])
def test_revocation_during_plan_or_encoding_withholds_private_values(planner, monkeypatch, boundary):
    if boundary == "catalogue":
        original = game_plans.schema
        def revoke(name):
            result = original(name)
            S._active_sessions.clear()
            return result
        monkeypatch.setattr(game_plans, "schema", revoke)
    else:
        original = authority.JSONResponse
        def revoke(*args, **kwargs):
            result = original(*args, **kwargs)
            S._active_sessions.clear()
            return result
        monkeypatch.setattr(authority, "JSONResponse", revoke)
    response = prepare(planner, game_name="PRIVATE GAME", custom_trials=[{"label": "PRIVATE SETTING", "current": "On", "suggested": "Off"}])
    assert response.status_code == 401 and "PRIVATE" not in response.text
    assert response.headers["Cache-Control"] == "no-store"


def test_unavailable_security_during_planning_remains_denied(planner, monkeypatch):
    original = game_plans.schema
    def fail(name):
        result = original(name)
        monkeypatch.setattr(S, "load_pin_config", lambda: (_ for _ in ()).throw(OSError("private security path")))
        return result
    monkeypatch.setattr(game_plans, "schema", fail)
    response = prepare(planner)
    assert response.status_code == 503 and "private security path" not in response.text
    assert "settings_plan" not in response.text
