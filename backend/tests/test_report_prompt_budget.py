"""Public performance-report regressions through actual JSON/SSE preparation.

These synthetic records derive from public development cases 01/03/04. The
test has no evaluation-corpus, model-file, network or household-data dependency.
"""
import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import tli_state as S
from ai import ai_routes as ai
from ai.ai_manager import MODEL_PRESETS
from intelligence import context, diagnostics, input_budget, models, report_facts
from intelligence.store import read_private, write_private
from tests.test_input_budget_routes import isolated_provider
from tests.test_outcome_chat_routes import result


REAL_BUILD_PROMPT = ai._build_system_prompt
HOST = {"id": "node-elm", "name": "Elm workstation", "role": "standalone"}
METRICS = {
    "host_cpu_percent": 72, "host_ram_percent": 43,
    "host_ram_used_bytes": 7387343749, "host_ram_total_bytes": 17179869184,
    "process_cpu_percent": 11, "process_rss_bytes": 402653184,
}


def performance_report(state):
    count = 9 if state == "partial" else 30
    metrics = dict(METRICS)
    if state == "missing":
        metrics["process_cpu_percent"] = None
    started = datetime(2026, 8, 29, 14, 19, 30, tzinfo=timezone.utc)
    samples = [{"elapsed_seconds": index + 1,
                "observed_at": (started + timedelta(seconds=index + 1)).isoformat().replace("+00:00", "Z"),
                "raw_sample_marker": "NOT_FOR_PROVIDER_OR_RECEIPTS", **metrics}
               for index in range(count)]
    return {
        "id": "elm-report", "created_at": "2026-08-29T14:20:00Z", "kind": "performance",
        "host": copy.deepcopy(HOST), "target": None, "checks": [], "findings": [], "next_steps": [],
        "scope": "Elm workstation and selected Mosaic process only. CPU percentages are normalized to whole-host logical CPU capacity. No FPS, GPU, temperatures or repairs.",
        "verified_fix": None,
        "performance": {
            "schema_version": 1, "observation_id": "elm-observation",
            "process": {"pid": 742, "create_time": 1788010000.5, "name": "Mosaic", "exe": "C:\\Apps\\Mosaic\\mosaic.exe"},
            "status": "partial" if state == "partial" else "completed",
            "reason": "Process exited after nine samples" if state == "partial" else "Thirty samples recorded",
            "started_at": "2026-08-29T14:19:30Z",
            "finished_at": "2026-08-29T14:19:39Z" if state == "partial" else "2026-08-29T14:20:00Z",
            "duration_seconds": count, "expected_samples": 30, "sample_count": count,
            "samples": samples,
            "summary": {key: {"min": value, "max": value, "mean": value, "samples": count}
                        for key, value in metrics.items()},
        },
    }


@pytest.fixture
def production_provider(isolated_provider, monkeypatch):
    # Restore the real file-based production prompt, replacing only observed
    # capability inputs. The shared fixture's shortened prompt cannot prove fit.
    monkeypatch.setattr(ai, "AI_DIR", Path(ai.__file__).resolve().parent)
    monkeypatch.setattr(ai, "_build_system_prompt", REAL_BUILD_PROMPT)
    monkeypatch.setattr(context.devices, "node", lambda: copy.deepcopy(HOST))
    monkeypatch.setattr(context.devices, "inventory", lambda: {"node": copy.deepcopy(HOST), "devices": []})
    monkeypatch.setattr(models, "bundled_capabilities", lambda: {
        "provider": "bundled", "selected": "standard", "name": MODEL_PRESETS["standard"]["name"],
        "running": True, "installation_complete": True, "vision": False,
        "capability_source": "synthetic preset and runtime health",
    })
    def forbidden(*args, **kwargs):
        pytest.fail("A selected saved report must not execute a diagnostic, device action or model fallback")
    monkeypatch.setattr(diagnostics, "run", forbidden)
    monkeypatch.setattr(ai, "execute_action", forbidden)
    monkeypatch.setattr(S.lm_provider, "complete", forbidden)
    monkeypatch.setattr(S, "load_memory", forbidden)
    return isolated_provider


@pytest.mark.parametrize("path", ["/api/ai/chat", "/api/ai/chat/stream"])
@pytest.mark.parametrize("state", ["full", "partial", "missing"])
def test_prior_model_report_format_fits_and_recorded_facts_remain_in_receipts(path, state, client, production_provider):
    saved = performance_report(state)
    write_private("local", "diagnostics", [saved])
    before = copy.deepcopy(read_private("local", "diagnostics", []))
    expected = report_facts.build(saved)
    question = ("Separate the host and selected process observations in this report."
                if state == "full" else "Did this observation finish?")
    response = client.post(path, json={"message": question, "diagnostic_id": saved["id"],
                                     "max_tokens": 512, "temperature": 0, "use_saved_memory": False})
    data = result(response)
    assert data.get("handled_by") != "recorded_outcome", "Exercise actual model-bound preparation"
    assert len(production_provider.calls) == 1
    _, payload = production_provider.calls[0]
    assert payload["max_tokens"] == 512
    messages = payload["messages"]
    production_prompt = (Path(ai.__file__).resolve().parent / "prompts/system_default.txt").read_text(encoding="utf-8").strip()
    assert messages[0]["content"].startswith(production_prompt)
    assert messages[-1] == {"role": "user", "content": question}
    budget = input_budget.for_provider("bundled", manager=production_provider.manager, max_tokens=512).validate(messages)
    assert budget["context_tokens"] == 4096 and budget["character_limit"] == 12000
    assert budget["capacity_status"] == "configured" and budget["estimation"] == "heuristic"
    assert budget["estimated_input_tokens"] + budget["reserved_output_tokens"] <= 4096

    references = [json.loads(line.removeprefix("diagnostic_evidence: "))
                  for message in messages for line in message["content"].splitlines()
                  if line.startswith("diagnostic_evidence: ")]
    assert len(references) == 1 and references[0]["source_handle"] == "R1"
    # The rejected model-format candidate must not leak back into provider
    # input through additive API/receipt facts. Keep the established report
    # summary and coverage, with its exact host/process/time distinction.
    reference = references[0]
    assert "recorded_facts" not in reference
    assert reference["host"] == saved["host"]
    assert reference["created_at"] == saved["created_at"]
    assert reference["scope"] == saved["scope"]
    supplied = reference["performance"]
    assert supplied["process"] == saved["performance"]["process"]
    for key in ("status", "started_at", "finished_at", "duration_seconds", "sample_count", "expected_samples", "summary"):
        assert supplied[key] == saved["performance"][key]
    assert supplied["coverage"]["raw_samples_included"] == 0
    assert supplied["coverage"]["raw_samples_omitted"] == len(saved["performance"]["samples"])
    assert supplied["coverage"]["metric_samples"]["process_cpu_percent"] == (0 if state == "missing" else len(saved["performance"]["samples"]))
    assert any("Host CPU is not process CPU." in message["content"] for message in messages)
    assert expected["status"] == {"full": "completed", "partial": "partial", "missing": "unknown"}[state]
    assert expected["recorded_samples"] == (9 if state == "partial" else 30)
    assert expected["expected_samples"] == 30 and expected["raw_samples_included"] == 0
    metric = next(row for row in expected["measurements"] if row["key"] == "process_cpu_percent")
    assert metric["mean"] is None if state == "missing" else metric["mean"] == 11
    assert data["evidence_context"]["recorded_report"] == expected
    assert isinstance(data["evidence_context"]["recorded_report"]["measurements"], list)
    assert data["input_budget"]["context_tokens"] == 4096
    assert data["input_budget"]["reserved_output_tokens"] == 512
    retained = [turn for row in S.load_conversations().values() for turn in row["messages"] if turn["role"] == "assistant"][-1]
    assert retained["evidence_context"] == data["evidence_context"]
    assert "NOT_FOR_PROVIDER_OR_RECEIPTS" not in json.dumps([messages, data, retained])
    assert "samples" not in supplied
    assert '"samples":' not in json.dumps([data["evidence_context"], retained["evidence_context"]])
    assert '"elapsed_seconds"' not in json.dumps([messages, data, retained])
    assert read_private("local", "diagnostics", []) == before
    assert client.get("/api/intelligence/diagnostics/elm-report").json()["recorded_facts"] == expected
