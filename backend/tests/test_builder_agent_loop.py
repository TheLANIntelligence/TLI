from __future__ import annotations

from pathlib import Path

import pytest

import tli_state as S
import builder.receipts as receipts
import builder.tasks as tasks
from builder.diff_generator import generate_find_replace_diff
from builder.llm_client import ModelOffline
from builder.receipts import add_patch_proposal, save_state
from builder.tasks import advance_task, create_task, load_tasks


@pytest.fixture()
def isolated_builder(tmp_path, monkeypatch):
    data_dir = tmp_path / "builder-data"
    data_dir.mkdir()
    monkeypatch.setattr(receipts, "BUILDER_DIR", data_dir)
    monkeypatch.setattr(receipts, "STATE_PATH", data_dir / "builder_state.json")
    monkeypatch.setattr(receipts, "RECEIPTS_PATH", data_dir / "receipts.json")
    monkeypatch.setattr(receipts, "PROPOSALS_PATH", data_dir / "patch_proposals.json")
    monkeypatch.setattr(tasks, "BUILDER_DIR", data_dir)
    monkeypatch.setattr(tasks, "TASKS_PATH", data_dir / "tasks.json")
    return data_dir


def _project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    (root / "app.py").write_text("VALUE = 'old'\n", encoding="utf-8")
    return root


def _project_map() -> dict:
    return {
        "project_name": "project",
        "files": [
            {
                "path": "app.py",
                "ext": ".py",
                "size": 14,
                "language": "python",
                "summary": "Stores VALUE.",
            }
        ],
        "important_files": ["app.py"],
        "entry_points": ["app.py"],
        "frontend_modules": [],
        "languages": {"python": 1},
        "frameworks": [],
    }


def _run_to_target(task: dict, root: Path, project_map: dict) -> dict:
    current = task
    while current["next_agent_index"] < current["target_agent_index"]:
        current = advance_task(current["id"], root, project_map)
        if current["status"] in {"blocked", "cancelled", "completed"}:
            break
    return current


def test_builder_task_intent_metadata_persists(tmp_path, isolated_builder):
    root = _project(tmp_path)

    task = create_task("plan the value change", root, "ask", True, intent="plan")

    assert task["intent"] == "plan"
    assert task["target_agent_index"] == 2
    assert load_tasks()[0]["intent"] == "plan"


def test_inspect_and_plan_stop_before_patch_when_model_is_offline(tmp_path, isolated_builder, monkeypatch):
    root = _project(tmp_path)
    project_map = _project_map()

    def offline(_prompt):
        raise ModelOffline("offline for test")

    monkeypatch.setattr(tasks, "complete_patch_json", offline)

    inspect = create_task("inspect app value", root, "ask", True, intent="inspect")
    inspect = _run_to_target(inspect, root, project_map)
    assert inspect["next_agent_index"] == 1
    assert inspect["active_agent"] == "planner"
    assert inspect["status"] == "paused"

    plan = create_task("plan app value change", root, "ask", True, intent="plan")
    plan = _run_to_target(plan, root, project_map)
    assert plan["next_agent_index"] == 2
    assert plan["active_agent"] == "patch"
    assert plan["status"] == "paused"

    build = create_task("change app value", root, "ask", True, intent="build")
    build = _run_to_target(build, root, project_map)
    assert build["status"] == "blocked"
    assert "Model offline" in build["blocked_reason"]


def test_apply_patch_with_task_id_updates_task_artifacts(tmp_path, isolated_builder, authed_client):
    root = _project(tmp_path)
    proposal = generate_find_replace_diff(root, "app.py", "'old'", "'new'", task="change value")
    add_patch_proposal(proposal)
    task = create_task("change value", root, "ask", True, intent="build")

    stored = S.load_json_file(tasks.TASKS_PATH, [])
    stored[-1]["next_agent_index"] = 3
    stored[-1]["active_agent"] = "test"
    stored[-1]["status"] = "paused"
    stored[-1]["artifacts"]["patch_proposal"] = proposal
    S.save_json_file(tasks.TASKS_PATH, stored)
    save_state({"selected_project": str(root), "permission_level": "ask", "golden_build_guard": True})

    res = authed_client.post(
        "/api/builder/apply-patch",
        json={"patch_id": proposal["id"], "task_id": task["id"], "approved": True},
    )

    assert res.status_code == 200
    payload = res.json()
    applied = payload["task"]["artifacts"]["patch_proposal"]
    assert applied["applied"] is True
    assert applied["snapshot_id"] == payload["result"]["snapshot"]["id"]
    assert payload["task"]["artifacts"]["last_snapshot_id"] == payload["result"]["snapshot"]["id"]
    assert (root / "app.py").read_text(encoding="utf-8") == "VALUE = 'new'\n"


def test_locked_mode_blocks_apply_and_command(tmp_path, isolated_builder, authed_client):
    root = _project(tmp_path)
    save_state({"selected_project": str(root), "permission_level": "locked", "golden_build_guard": True})

    apply_res = authed_client.post("/api/builder/apply-patch", json={"approved": True})
    command_res = authed_client.post(
        "/api/builder/run-command",
        json={"command": "python --version", "approved": True},
    )

    assert apply_res.status_code == 403
    assert command_res.status_code == 403
