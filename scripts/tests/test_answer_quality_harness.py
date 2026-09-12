"""Developer-only answer-review tooling stays offline unless explicitly invoked."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("answer_review", Path(__file__).resolve().parents[2] / "scripts/evaluate_ai_answers.py")
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


def test_offline_plan_has_no_inference_or_quality_claim():
    cases, digest = review.load_cases()
    report = review.make_report(cases, digest, transport=lambda *args: pytest.fail("Offline plan cannot call a model"))
    assert len(report["cases"]) == 23
    assert report["mode"] == "offline_review_plan"
    assert all(case["status"] == case["human_review"]["result"] == "not_run" for case in report["cases"])
    assert report["quality_verdict"].startswith("Not assessed")
    assert report["corpus_sha256"] == digest
    pipeline = [case for case in report["cases"] if case["input_source"] == "current_chat_preparation"]
    assert len(pipeline) == 9
    assert all(case["preparation"]["status"] == "passed" and all(case["preparation"]["checks"].values()) for case in pipeline)
    assert all("messages" not in case["preparation"] for case in pipeline)


@pytest.mark.parametrize("endpoint", ["https://example.com", "http://localhost:1234", "http://192.168.1.2:1234", "http://127.0.0.1", "http://user:pass@127.0.0.1:1234", "http://127.0.0.1:1234/other", "http://127.0.0.1:1234?key=x", "file:///etc/passwd"])
def test_only_explicit_loopback_endpoint_allowed(endpoint):
    with pytest.raises(ValueError):
        review.local_endpoint(endpoint)


def test_fake_responses_capture_identity_limits_and_manual_review_without_accuracy_score():
    cases, digest = review.load_cases()
    calls = []
    def fake(endpoint, payload, timeout):
        calls.append((endpoint, payload, timeout))
        return {"model": "fake-alias", "choices": [{"message": {"content": "The workshop uses Letter [setup.txt:L2-L99]."}, "finish_reason": "length"}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120, "unexpected": "private"}}
    report = review.make_report([cases[4]], digest, endpoint="http://127.0.0.1:1234/v1", model="fake-model", max_tokens=64, transport=fake)
    assert len(calls) == 1 and set(calls[0][1]) == {"model", "messages", "max_tokens", "temperature", "stream"}
    result = report["cases"][0]
    assert result["status"] == "response_received" and result["human_review"]["result"] == "not_run"
    assert result["reported_model"] == "fake-alias"
    assert len(result["flags"]) == 3  # invalid line range, model alias, interrupted output
    assert result["usage"] == {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}
    assert "accuracy" not in result


def test_failure_is_not_retried_and_raw_error_body_is_not_recorded():
    cases, digest = review.load_cases()
    calls = []
    def failed(*args):
        calls.append(args)
        raise RuntimeError("Unexpected provider private data")
    report = review.make_report(cases[:1], digest, endpoint="http://[::1]:1234", model="fake", transport=failed)
    assert len(calls) == 1 and report["cases"][0]["status"] == "failed"
    assert "Unexpected provider private data" not in str(report)


def test_existing_report_blocks_all_inference(tmp_path, monkeypatch):
    path = tmp_path / "report.json"
    path.write_text("existing result")
    monkeypatch.setattr(review, "make_report", lambda *args, **kw: pytest.fail("Do not infer before checking destination"))
    with pytest.raises(FileExistsError):
        review.main(["--run-local", "--endpoint", "http://127.0.0.1:1234", "--model", "fake", "--output", str(path)])
    assert path.read_text() == "existing result"


@pytest.mark.parametrize("args", [["--endpoint", "http://127.0.0.1:1234"], ["--run-local"], ["--model", "fake"], ["--endpoint", "http://127.0.0.1:1234", "--model", "fake"]])
def test_cli_requires_all_explicit_run_arguments(args):
    with pytest.raises(SystemExit):
        review.main(args)


def test_pipeline_prepares_current_notes_before_fake_transport_and_keeps_truthful_receipts():
    cases, digest = review.load_cases()
    selected = [case for case in cases if case["id"] == "prepared-corrected-note"]
    calls = []
    def fake(endpoint, payload, timeout):
        calls.append(payload)
        return {"model": "fixture-model", "choices": [{"message": {"content": "The current Printer paper note says Letter."}, "finish_reason": "stop"}]}
    report = review.make_report(selected, digest, endpoint="http://127.0.0.1:19997", model="fixture-model", transport=fake)
    assert len(calls) == 1
    messages = calls[0]["messages"]
    assert messages[0]["content"].startswith("You are TLI")
    assert messages[-1] == {"role": "user", "content": "What about that?"}
    reference = "\n".join(m["content"] for m in messages[1:] if m["role"] == "system")
    assert "now uses Letter" in reference and "uses A4" not in reference
    # Historical answers remain intact even when current references follow them.
    assert any("A4" in m["content"] for m in messages if m["role"] == "assistant")
    case = report["cases"][0]
    assert case["preparation"]["status"] == "passed"
    assert case["preparation"]["receipts"]["memory_context"]["notes"][0]["id"] == "paper"
    assert case["status"] == "response_received" and case["human_review"]["result"] == "not_run"


def test_failed_preparation_expectation_blocks_inference():
    from copy import deepcopy
    cases, digest = review.load_cases()
    broken = deepcopy(next(case for case in cases if case["id"] == "prepared-past-fix"))
    broken["preparation"]["expect"]["note_ids"] = ["a-note-that-must-not-be-invented"]
    report = review.make_report([broken], digest, endpoint="http://127.0.0.1:19997", model="fixture-model",
                               transport=lambda *a: pytest.fail("Failed pipeline cannot request an answer"))
    case = report["cases"][0]
    assert case["status"] == "preparation_failed"
    assert case["preparation"]["checks"]["selected_notes"] is False
    assert case["human_review"]["result"] == "not_run"


def test_configured_runtime_capacity_survives_public_receipt_validation():
    cases, digest = review.load_cases()
    report = review.make_report([c for c in cases if 'preparation' in c], digest, max_tokens=384, context_tokens=4096)
    assert all(c['status'] == 'not_run' for c in report['cases']), report
    for case in report['cases']:
        receipt = case['preparation']['receipts']['input_budget']
        assert receipt['context_tokens'] == 4096
        assert receipt['capacity_source'] == 'owned_runtime_launch'


def test_real_document_preparation_keeps_key_lines_and_omits_repetitive_filler():
    cases, _ = review.load_cases()
    case = next(c for c in cases if c['id'] == 'prepared-long-document')
    prepared = review.prepare_cases([case], 384, 4096)[case['id']]
    assert prepared['status'] == 'passed'
    text = '\n'.join(m['content'] for m in prepared['messages'])
    assert 'Use Letter paper.' in text and 'USB cable replacement' in text
    assert text.count('Retained setup journal entry, no measurement recorded.') == 1
    receipt = prepared['receipts']['document_context']['documents'][0]
    assert receipt['coverage']['omitted_lines'] > 790
    assert receipt['line_count'] == 800


def test_unicode_fixture_is_utf8_and_citations_cannot_reference_omitted_lines():
    cases, _ = review.load_cases()
    fixture = next(c for c in cases if c['id'] == 'production-unicode-path')
    assert 'C:\\Caf\u00e9\\\u97f3\u697d' in fixture['messages'][-1]['content']
    flags = review.review_flags({'source_lines':{'setup.txt':800}, 'supplied_ranges':{'setup.txt':[{'start':1,'end':4},{'start':799,'end':800}]}}, '[setup.txt:L42]')
    assert flags == ['Citation refers to omitted lines: setup.txt:L42']


def test_child_isolates_inherited_data_root_and_overrides_before_imports(tmp_path, monkeypatch):
    live = tmp_path / "untouched-installation"
    live.mkdir()
    sentinel = live / "private.txt"
    sentinel.write_bytes(b"untouched private content")
    monkeypatch.setenv("TLI_ROOT", str(live))
    monkeypatch.setenv("TLI_AUTOSTART", "1")
    monkeypatch.setenv("TLI_MODEL_PATH", str(sentinel))
    monkeypatch.setenv("PYTHONPATH", str(live))
    cases, digest = review.load_cases()
    result = review.make_report([next(case for case in cases if case["id"] == "prepared-report-scope")], digest)
    assert result["cases"][0]["preparation"]["status"] == "passed"
    assert list(live.iterdir()) == [sentinel]
    assert sentinel.read_bytes() == b"untouched private content"
    assert "untouched private content" not in str(result)


def test_frozen_interpreter_refuses_preparation_before_spawn(monkeypatch):
    cases, _ = review.load_cases()
    monkeypatch.setattr(review.sys, "frozen", True, raising=False)
    monkeypatch.setattr(review.subprocess, "run", lambda *a, **kw: pytest.fail("Never invoke frozen app as Python"))
    with pytest.raises(RuntimeError, match="source/Python"):
        review.prepare_cases(cases, 512)


def test_cli_writes_preparation_failure_report_then_returns_failure(tmp_path, monkeypatch):
    import json
    report = {"cases": [{"id": "synthetic", "status": "preparation_failed"}]}
    monkeypatch.setattr(review, "make_report", lambda *a, **kw: report)
    path = tmp_path / "review.json"
    assert review.main(["--output", str(path)]) == 1
    assert json.loads(path.read_text(encoding="utf-8")) == report


def test_cli_does_not_change_legacy_provider_review_exit_semantics(capsys, monkeypatch):
    monkeypatch.setattr(review, "make_report", lambda *a, **kw: {"cases": [{"id": "synthetic", "status": "failed"}]})
    assert review.main([]) == 0
    assert '"status": "failed"' in capsys.readouterr().out
