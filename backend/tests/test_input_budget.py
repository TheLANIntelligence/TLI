"""Synthetic final-input budgets and read-only launch metadata; no model runs."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from ai import ai_manager as am
from intelligence import context, documents, input_budget as ib, memory, notebook
from providers.lmstudio import LMStudioProvider


def messages(text="A useful question"):
    return [{"role": "system", "content": "Keep the supplied facts whole."}, {"role": "user", "content": text}]


def capacity(tokens=4096, **extra):
    return {"status": "configured", "context_tokens": tokens, "source": "owned_runtime_launch", "model": "fixture-model", **extra}


def policy(tokens=4096, output=1024, **kwargs):
    return ib.for_provider("bundled", manager=SimpleNamespace(text_capacity=lambda: capacity(tokens)), max_tokens=output, **kwargs)


def raises_422(fn):
    with pytest.raises(HTTPException) as exc:
        fn()
    assert exc.value.status_code == 422


def test_ascii_punctuation_unicode_and_formatting_estimates_are_explicit():
    assert ib.estimate_text("abcdef") == 2
    assert ib.estimate_text("{}[]!?") == 6
    assert ib.estimate_text("你☕é") == len("你☕é".encode("utf-8"))
    same_text = [{"role": "user", "content": "abc"}]
    split_text = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "bc"}]
    assert ib.text_usage(split_text)["formatting_allowance_tokens"] > ib.text_usage(same_text)["formatting_allowance_tokens"]
    report = policy().validate(messages())
    assert report["capacity_status"] == "configured" and report["fit"] == "estimated"
    assert report["estimation"] == "heuristic" and report["reserved_output_tokens"] == 1024
    assert report["estimated_input_tokens"] >= report["formatting_allowance_tokens"]
    assert "exact" not in report and "healthy" not in report


def test_configured_token_boundary_reserves_output_without_changing_request():
    original = messages("abc " * 70)
    size = ib.text_usage(original)["estimated_input_tokens"]
    before = json.dumps(original)
    assert policy(size + 300, 300).fits(original)
    assert not policy(size + 299, 300).fits(original)
    raises_422(lambda: policy(size + 299, 300).validate(original))
    raises_422(lambda: policy(4096, 4096).validate(messages()))
    assert json.dumps(original) == before


@pytest.mark.parametrize("value", [True, False, 0, -2, "512", 0.5, 1_000_001])
def test_output_limit_validation_never_silently_clamps(value):
    raises_422(lambda: ib.for_provider("bundled", max_tokens=value))


@pytest.mark.parametrize("bad", ["\ud800", [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}}], None])
def test_invalid_utf8_and_images_cannot_receive_text_fit_claims(bad):
    raises_422(lambda: policy().validate([{"role": "user", "content": bad}]))


@pytest.mark.parametrize("value", [None, {}, {"status": "verified", "context_tokens": 99999}, capacity(True), capacity(0), capacity(-1), capacity("4096"), capacity(1_000_001), capacity(source="advertised_model")])
def test_missing_or_untrusted_capacity_remains_unknown(value):
    mgr = SimpleNamespace(text_capacity=lambda: value, cfg=SimpleNamespace(ctx_size=99999))
    report = ib.for_provider("bundled", manager=mgr).validate(messages())
    assert report["capacity_status"] == "unknown" and report["context_tokens"] is None and report["fit"] == "unknown"


def test_unknown_capacity_uses_old_ceiling_and_does_not_invent_token_fit():
    p = ib.for_provider("lmstudio", provider=object(), model_id="named-model")
    accepted = [{"role": "user", "content": "x" * 12000}]
    report = p.validate(accepted)
    assert report["model"] == "named-model" and report["context_tokens"] is None
    assert report["input_characters"] == 12000
    raises_422(lambda: p.validate([{**accepted[0], "content": "x" * 12001}]))
    assert ib.for_provider("bundled", manager=SimpleNamespace(cfg=SimpleNamespace(ctx_size=4096))).context_tokens is None


def test_large_configured_models_still_keep_old_character_ceiling():
    raises_422(lambda: policy(100000).validate(messages("a" * 12000)))


def test_bundled_capacity_records_actual_owned_launch_arguments(tmp_path, monkeypatch):
    runtime, model = tmp_path / "fake-runtime", tmp_path / "fake.gguf"
    runtime.write_bytes(b"never executed"); model.write_bytes(b"synthetic")
    mgr = am.BundledAIManager(am.BundledAIConfig(tmp_path, runtime, model, ctx_size=8192))
    mgr._active_preset = "standard"
    launches = []
    process = SimpleNamespace(pid=7654, poll=lambda: None)
    def fake_process(args, **kwargs):
        launches.append(args); return process
    # Preflight is tested separately; record only the owned model launch here.
    monkeypatch.setattr(am, "check_windows_runtime", lambda _path: None)
    monkeypatch.setattr(am.subprocess, "Popen", fake_process)
    monkeypatch.setattr(am, "_assign_to_win32_job", lambda pid: None)
    monkeypatch.setattr(am, "_is_port_open", lambda *a: False)
    monkeypatch.setattr(mgr, "preset", lambda ident: {"ctx_size": 2048})
    monkeypatch.setattr(mgr, "is_healthy", lambda: True)
    mgr._transition = True
    assert mgr._start_runtime()
    mgr._transition = False
    assert launches[0][launches[0].index("--ctx-size") + 1] == "2048"
    monkeypatch.setattr(mgr, "is_healthy", lambda: pytest.fail("capacity is read-only"))
    assert mgr.text_capacity() == {"status":"configured", "context_tokens":2048, "source":"owned_runtime_launch", "model":"standard"}
    mgr.cfg.ctx_size = 32000
    assert mgr.text_capacity()["context_tokens"] == 2048
    mgr._proc = SimpleNamespace(poll=lambda: None)
    assert mgr.text_capacity()["status"] == "unknown"
    mgr._proc = process; mgr._active_preset = "power"
    assert mgr.text_capacity()["status"] == "unknown"
    mgr._active_preset = "standard"; process.poll = lambda: 1
    assert mgr.text_capacity()["status"] == "unknown"


def test_readonly_lmstudio_capacity_does_not_probe_load_or_list_models(monkeypatch):
    provider = LMStudioProvider("http://fixture.invalid/chat", "http://fixture.invalid/models")
    monkeypatch.setattr(provider, "health_check", lambda: pytest.fail("no readiness inference"))
    monkeypatch.setattr(provider, "list_models", lambda: pytest.fail("no discovery"))
    assert ib.for_provider("lmstudio", provider=provider, model_id="fixture").context_tokens is None


def test_lmstudio_final_validation_precedes_discovery_and_records_real_output_limit(monkeypatch):
    provider = LMStudioProvider("http://fixture.invalid/chat", "http://fixture.invalid/models")
    monkeypatch.setattr(provider, "list_models", lambda: pytest.fail("invalid input cannot cause discovery"))
    raises_422(lambda: provider.complete(messages=messages("x" * 12000), model_id="", max_tokens=1024, enforce_text_budget=True))
    sent = []
    def post(url, **kwargs):
        sent.append(kwargs)
        return SimpleNamespace(status_code=200, content=b"synthetic", json=lambda: {"model":"fixture", "choices":[{"message":{"content":"ok"}}]})
    monkeypatch.setattr("providers.lmstudio.requests.post", post)
    result = provider.complete(messages=messages(), model_id="fixture", allow_redirects=False, enforce_text_budget=True)
    assert sent[0]["json"]["max_tokens"] == result["input_budget"]["reserved_output_tokens"] == 1024
    assert sent[0]["allow_redirects"] is False and result["raw"]["choices"]


@pytest.mark.parametrize("allow_redirects", [False, True])
def test_generic_lmstudio_completion_preserves_large_inputs_and_provider_defaults(monkeypatch, allow_redirects):
    provider = LMStudioProvider("http://fixture.invalid/chat", "http://fixture.invalid/models")
    sent = []
    def post(url, **kwargs):
        sent.append(kwargs)
        return SimpleNamespace(status_code=200, content=b"synthetic", json=lambda: {"choices":[{"message":{"content":"ok"}}]})
    monkeypatch.setattr("providers.lmstudio.requests.post", post)
    large = messages("Builder source context " * 1000)
    result = provider.complete(messages=large, model_id="fixture", allow_redirects=allow_redirects)
    assert set(result) == {"text", "model", "raw"}
    assert sent[0]["json"]["messages"] == large
    assert "max_tokens" not in sent[0]["json"]


def test_capacity_shrink_requires_final_revalidation():
    request = messages("meaningful detail " * 180)
    report = policy(4096, 1024).validate(request)
    assert report["context_tokens"] == 4096
    raises_422(lambda: policy(2048, 1024).validate(request))


def test_current_notes_and_whole_history_are_budgeted_with_matching_receipts(monkeypatch):
    monkeypatch.setattr(context.devices, "node", lambda: {"id":"fixture", "name":"Study"})
    for index in range(6):
        memory.save_fact("budget-owner", "Printer " + "你" * 180, title=f"Printer {index}")
    history = [message for index in range(5) for message in (
        {"role":"user", "content":f"Printer question {index}" + "?" * 100},
        {"role":"assistant", "content":f"Printer answer {index}" + "é" * 90})]
    evidence = context.build("budget-owner", "printer")
    result = context.prepare_messages("Primary instructions.", "Printer?", history, evidence, budget=policy(4096, 1024))
    receipt = result["input_budget"]
    assert receipt["estimated_input_tokens"] + receipt["reserved_output_tokens"] <= 4096
    assert result["conversation_context"]["included_exchanges"] >= 1
    received_history = [message for message in result["messages"][:-1] if message["role"] != "system"]
    assert received_history == history[-len(received_history):]
    reference = next(message["content"] for message in result["messages"][1:] if message["role"] == "system")
    line = next((line for line in reference.splitlines() if line.startswith("memory: ")), None)
    received_notes = json.loads(line[len("memory: "):]) if line else []
    assert [n["id"] for n in received_notes] == [n["id"] for n in result["memory_context"]["notes"]]
    assert result["memory_context"]["omitted_for_budget"] == 6 - len(received_notes)
    assert all(n["text"] == "Printer " + "你" * 180 for n in received_notes)


def test_mandatory_unicode_oversize_fails_without_truncating_or_using_other_data():
    evidence = {"text":"Required report: " + "你" * 300, "categories":["diagnostic_evidence"]}
    raises_422(lambda: context.prepare_messages("rules", "question", [], evidence, budget=policy(1500, 1024)))
    assert evidence["text"].endswith("你" * 300)


def test_unknown_policy_preserves_existing_whole_record_selection(monkeypatch):
    monkeypatch.setattr(context.devices, "node", lambda: {"id":"fixture", "name":"Study"})
    for index in range(5):
        memory.save_fact("unchanged-owner", "Printer note " + "a" * 1100, title=f"Printer {index}")
    history = [message for index in range(10) for message in (
        {"role":"user", "content":f"Question {index}" + "q" * 280},
        {"role":"assistant", "content":f"Answer {index}" + "你" * 310})]
    evidence = context.build("unchanged-owner", "printer")
    previous = context.prepare_messages("rules", "question", history, evidence)
    current = context.prepare_messages("rules", "question", history, evidence, budget=ib.for_provider("lmstudio"))
    assert current.pop("input_budget")["fit"] == "unknown"
    assert current == previous


def test_existing_bundled_prompt_has_room_for_an_ordinary_question(monkeypatch):
    monkeypatch.setattr(context.devices, "node", lambda: {"id":"fixture", "name":"Study"})
    prompt = (Path(__file__).parents[1] / "ai" / "prompts" / "system_default.txt").read_text(encoding="utf-8")
    result = context.prepare_messages(prompt, "What can you help me with?", [], context.build(None, "question"), budget=policy())
    assert result["input_budget"]["context_tokens"] == 4096
    assert result["messages"][0]["content"] == prompt


def test_custom_character_ceiling_still_applies_alongside_provider_policy():
    history = [{"role":"user", "content":"Q" * 1000}, {"role":"assistant", "content":"A" * 1000}]
    result = context.prepare_messages("rules", "question", history, {"text":"required"}, max_chars=1000, budget=policy(100000))
    assert sum(len(m["content"]) for m in result["messages"]) < 1000
    assert result["conversation_context"]["included_exchanges"] == 0


def test_selected_notes_default_answer_reserve_and_final_formatted_input(monkeypatch):
    note = memory.save_fact("note-budget-owner", "Please preserve this setup detail.", title="Setup")
    req = SimpleNamespace(note_refs=[SimpleNamespace(id=note["id"], revision=memory.revision(note))], message="What is saved?")
    result = notebook.prepare("note-budget-owner", req, budget=policy())
    assert result["input_budget"]["reserved_output_tokens"] == 1024
    assert result["note_context"]["notes"][0]["id"] == note["id"]
    raises_422(lambda: notebook.prepare("note-budget-owner", req, budget=policy(1100)))


def test_document_line_numbering_and_json_expansion_are_part_of_budget():
    req = SimpleNamespace(documents=[SimpleNamespace(name="lines.txt", text="a\n" * 3000)], message="Summarize.", max_tokens=1024, temperature=0.2)
    unbudgeted = documents.prepare("document-budget-owner", req)
    assert len(req.documents[0].text.encode()) < 12000
    assert sum(len(m["content"]) for m in unbudgeted["messages"]) > 12000
    excerpted = documents.prepare("document-budget-owner", req, budget=ib.for_provider("unknown"))
    assert excerpted["input_budget"]["input_characters"] <= 12000
    assert excerpted["document_context"]["documents"][0]["coverage"]["mode"] == "excerpts"
    assert req.documents[0].text == "a\n" * 3000


def test_document_receipt_keeps_whole_reference_and_no_optional_context():
    req = SimpleNamespace(documents=[SimpleNamespace(name="setup.txt", text="Use the rear socket.\nCheck the label first.")], message="Which socket?", max_tokens=300, temperature=0.2)
    result = documents.prepare("doc-owner", req, budget=policy(output=300))
    assert "L1: Use the rear socket.\nL2: Check the label first." in json.loads(result["messages"][1]["content"].split("\n",1)[1])[0]["numbered_text"]
    assert result["document_context"]["actions_performed"] is False
    assert result["input_budget"]["input_characters"] == sum(len(m["content"]) for m in result["messages"])


def test_public_budget_receipts_strip_private_text_and_reject_false_fit():
    report = policy().validate(messages())
    assert ib.public_receipt({**report, "messages":messages("secret"), "raw_model_data":"secret"}) == report
    for change in ({"estimation":"exact"}, {"fit":"verified"}, {"context_tokens":True}, {"input_characters":12001}, {"reserved_output_tokens":4096}, {"checked_at":"missing"}, {"input_utf8_bytes":900000}, {"formatting_allowance_tokens":1}):
        assert ib.public_receipt({**report, **change}) is None
