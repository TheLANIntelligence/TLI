"""Synthetic TLI answer review. Offline by default; never starts or switches AI.

Use --run-local with an explicit loopback endpoint and model to request answers
from an already available runtime. No TLI APIs, tools, user data or fallback.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import http.client
import ipaddress
import json
from pathlib import Path
import re
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CORPUS = Path(__file__).with_name("fixtures") / "tli_answer_quality.json"
MAX_RESPONSE_BYTES = 128 * 1024
MAX_STREAM_BYTES = 512 * 1024  # SSE envelope overhead is separate from bounded answer text.


def load_cases(additional=()):
    raw = CORPUS.read_bytes()
    data = json.loads(raw)
    cases = data["cases"]
    extensions = CORPUS.with_name('tli_answer_extensions.json')
    if extensions.is_file():
        extra = extensions.read_bytes()
        extension_data = json.loads(extra)
        if extension_data.get('version') != 1:
            raise ValueError('Unsupported evaluation extension')
        cases += extension_data['cases']
        raw += extra
    for extra_path in additional:
        extra = Path(extra_path).read_bytes()
        if len(extra) > 512 * 1024:
            raise ValueError('Additional corpus exceeds the bounded fixture limit')
        more = json.loads(extra)
        if more.get('version') != 1 or not isinstance(more.get('cases'), list):
            raise ValueError('Unsupported additional corpus')
        cases += more['cases']
        raw += extra
    if data.get("version") != 1 or not 1 <= len(cases) <= (64 if additional else 32):
        raise ValueError("Unsupported synthetic corpus")
    seen = set()
    for case in cases:
        ident = case["id"]
        if not re.fullmatch(r"[a-z0-9-]{1,64}", ident) or ident in seen:
            raise ValueError("Invalid or duplicate fixture identity")
        seen.add(ident)
        if "preparation" in case or "document_preparation" in case:
            if not isinstance(case.get("preparation", case.get("document_preparation")), dict) or len(json.dumps(case).encode()) > 48 * 1024:
                raise ValueError("Synthetic preparation fixture is too large")
            continue
        messages = case["messages"]
        if not messages or len(messages) > 16 or len(json.dumps(messages).encode()) > 32 * 1024:
            raise ValueError("Synthetic fixture is too large")
        if any(m.get("role") not in ("system", "user", "assistant") or not isinstance(m.get("content"), str) for m in messages):
            raise ValueError("Invalid synthetic message")
    return cases, hashlib.sha256(raw).hexdigest()


def prepare_cases(cases, max_tokens, context_tokens=None):
    """Prepare synthetic persisted inputs in a fresh, effect-bounded interpreter.

    No application/server import, model metadata request or live data root is
    used. The parent remains a stdlib-only CLI; preparation needs the existing
    backend dependencies in the explicitly invoked Python environment.
    """
    selected = [case for case in cases if "preparation" in case or "document_preparation" in case]
    if not selected:
        return {}
    if getattr(sys, "frozen", False):
        raise RuntimeError("Synthetic preparation requires a source/Python installation")
    trusted = str(Path(__file__).resolve().parent)
    bootstrap = "import sys; sys.path.insert(0, " + repr(trusted) + "); import evaluate_ai_answers as e; e._prepare_child()"
    with tempfile.TemporaryDirectory(prefix="tli-answer-preparation-") as directory:
        # Never inherit persistence, startup, browser, provider or Python import
        # overrides. Windows crypto/stdlib need these ordinary OS locations.
        env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "COMSPEC") if key in os.environ}
        env["TLI_ROOT"] = directory
        result = subprocess.run([sys.executable, "-I", "-B", "-c", bootstrap],
                                input=json.dumps({"cases": selected, "max_tokens": max_tokens, "context_tokens": context_tokens}),
                                capture_output=True, text=True, encoding="utf-8", timeout=30,
                                cwd=directory, env=env,
                                **({"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}))
        if result.returncode or len(result.stdout.encode("utf-8")) > 512 * 1024:
            raise RuntimeError("Isolated synthetic preparation could not complete")
        prepared = json.loads(result.stdout)
        if not isinstance(prepared, dict) or set(prepared) != {c["id"] for c in selected}:
            raise RuntimeError("Unexpected synthetic preparation receipt")
        return prepared


def _prepare_child():
    """Internal child entrypoint, with persistence set before backend imports."""
    import contextlib
    import threading
    from unittest.mock import patch
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    request = json.loads(sys.stdin.read(512 * 1024))
    root = Path(os.environ["TLI_ROOT"]).resolve(strict=True)

    def audit(event, args):
        if event.startswith("socket.") or event in {"subprocess.Popen", "os.system", "os.fork", "os.posix_spawn"}:
            raise RuntimeError("External effects are disabled in synthetic preparation")
        if event == "open" and len(args) >= 3:
            path, mode, flags = args
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
            if writing and not isinstance(path, int):
                Path(path).resolve().relative_to(root)
        if event in {"os.mkdir", "os.remove", "os.rmdir", "os.rename"}:
            for path in args[:2] if event == "os.rename" else args[:1]:
                Path(path).resolve().relative_to(root)

    def disabled(*args, **kwargs):
        raise RuntimeError("Workers are disabled in synthetic preparation")

    sys.addaudithook(audit)
    threading.Thread.start = disabled
    sys.path.insert(0, str(ROOT / "backend"))
    # Keep incidental library output away from the fixed JSON protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import tli_state as state
        from intelligence import chat_continuity, context, memory, store, documents
        from types import SimpleNamespace
        from intelligence.input_budget import TextBudget
        prompt = (ROOT / "backend/ai/prompts/system_default.txt").read_text(encoding="utf-8")
        host = {"id": "fixture-host", "name": "Synthetic Study", "role": "standalone"}
        results = {}
        for case in request["cases"]:
            if 'document_preparation' in case:
                fixture = case['document_preparation']
                try:
                    lines = ['Retained setup journal entry, no measurement recorded.'] * fixture['line_count']
                    for number, text in fixture['lines'].items():
                        lines[int(number)-1] = text
                    before = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
                    prepared = documents.prepare('eval-document', SimpleNamespace(
                        documents=[documents.Document(name=fixture['name'], text='\n'.join(lines))],
                        message=fixture['question'], max_tokens=request['max_tokens'], temperature=0),
                        budget=TextBudget(max_tokens=request['max_tokens'], character_limit=6000,
                            context_tokens=request.get('context_tokens'), provider='bundled' if request.get('context_tokens') else 'unknown',
                            capacity_source='owned_runtime_launch' if request.get('context_tokens') else 'unavailable'))
                    after = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
                    receipt = documents.public_receipt(prepared['document_context'])
                    doc = receipt['documents'][0]
                    checks = {'stores_unchanged': before == after, 'actions_performed': receipt['actions_performed'] is False,
                        'no_private_context': not any(x in json.dumps(prepared['messages']) for x in ['FOREIGN_OWNER_CANARY', 'MEMORY_OFF_CANARY']),
                        'bounded_excerpts': doc['coverage']['mode'] == 'excerpts' and doc['coverage']['omitted_lines'] > 0,
                        'question_preserved': prepared['messages'][-1]['content'] == fixture['question'],
                        'whole_budget': prepared['input_budget']['input_characters'] <= 6000}
                    results[case['id']] = {'status': 'passed' if all(checks.values()) else 'failed', 'checks': checks,
                        'receipts': {'document_context': receipt, 'input_budget': prepared['input_budget']}, 'messages': prepared['messages'],
                        'prompt_sha256': hashlib.sha256(json.dumps(prepared['messages'], sort_keys=True, ensure_ascii=False).encode()).hexdigest()}
                except Exception as exc:
                    results[case['id']] = {'status': 'failed', 'error_type': type(exc).__name__, 'checks': {'preparation_completed': False}}
                continue
            fixture = case["preparation"]
            owner = "eval-" + case["id"]
            conversation_id = "conversation-" + case["id"]
            notes = [{"created_at": "2026-08-01T10:00:00Z", "updated_at": "2026-08-01T10:00:00Z",
                      "category": "general", "source": "user", "device_id": None, "deleted": False, **note}
                     for note in fixture.get("notes", [])]
            state.save_memory(owner, {"facts": notes})
            state.save_memory(owner + "-other", {"facts": [{"id": "foreign-note", "text": "Printer router FOREIGN_OWNER_CANARY", "title": "Printer router"}]})
            before_versions = {note["id"]: memory.revision(note) for note in notes}
            with patch.object(state, "now_iso", return_value="2026-08-02T10:00:00Z"):
                for change in fixture.get("changes", []):
                    memory.change(owner, change["id"], change.get("text"))
            conversations = state.load_conversations()
            conversations[conversation_id] = {"id": conversation_id, "user_id": owner, "messages": fixture.get("history", [])}
            state.save_conversations(conversations)
            store.write_private(owner, "diagnostics", fixture.get("reports", []))
            devices = {device["id"]: device for device in fixture.get("devices", [])}
            def get_device(ident):
                if ident not in devices:
                    from fastapi import HTTPException
                    raise HTTPException(404, "Synthetic device is not registered")
                return devices[ident]
            paths = [p for p in root.rglob("*") if p.is_file()]
            before = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
            try:
                with patch.object(context.devices, "node", return_value=host), patch.object(context.devices, "get", side_effect=get_device):
                    prepared = chat_continuity.prepare(owner, fixture["question"], conversation_id, prompt,
                        target_id=fixture.get("target_id"), diagnostic_id=fixture.get("diagnostic_id"),
                        device_id=fixture.get("client_device_id"), use_saved_memory=fixture.get("use_saved_memory", True),
                        budget=TextBudget(max_tokens=request["max_tokens"], character_limit=fixture.get("character_limit", 12000),
                            context_tokens=request.get('context_tokens'), provider='bundled' if request.get('context_tokens') else 'unknown',
                            capacity_source='owned_runtime_launch' if request.get('context_tokens') else 'unavailable'))
                after = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob("*") if p.is_file()}
                receipt = chat_continuity.receipts(prepared)
                reference = "\n".join(m["content"] for m in prepared["messages"][1:] if m["role"] == "system")
                actual_ids = [note["id"] for note in receipt["memory_context"]["notes"]]
                expected = fixture.get("expect", {})
                checks = {"stores_unchanged": before == after,
                          "question_preserved": prepared["messages"][-1] == {"role": "user", "content": fixture["question"]},
                          "owner_isolation": "FOREIGN_OWNER_CANARY" not in json.dumps(prepared),
                          "selected_notes": (set(actual_ids) == set(expected["note_ids"]) if "note_ids" in expected
                                             else set(actual_ids) <= set(expected.get("allowed_note_ids", []))),
                          "memory_state": receipt["memory_context"]["status"] == expected.get("memory_status", "included" if actual_ids else "none"),
                          "current_revisions": all(n["revision"] == memory.revision(next(f for f in state.load_memory(owner, strict=True)["facts"] if f["id"] == n["id"])) for n in receipt["memory_context"]["notes"]),
                          "corrected_versions": all(before_versions[c["id"]] != memory.revision(next(f for f in state.load_memory(owner, strict=True)["facts"] if f["id"] == c["id"])) for c in fixture.get("changes", []) if c.get("text") is not None),
                          "reference_content": all(text in reference for text in expected.get("reference_contains", [])) and all(text not in reference for text in expected.get("reference_excludes", [])),
                          "whole_budget": receipt["input_budget"]["input_characters"] <= fixture.get("character_limit", 12000)}
                if "minimum_omitted_notes" in expected:
                    checks["note_omissions"] = receipt["memory_context"]["omitted_for_budget"] >= expected["minimum_omitted_notes"]
                if "minimum_history_exchanges" in expected:
                    checks["conversation_continuity"] = receipt["conversation_context"]["included_exchanges"] >= expected["minimum_history_exchanges"]
                if "minimum_omitted_messages" in expected:
                    checks["history_omissions"] = receipt["conversation_context"]["omitted_messages"] >= expected["minimum_omitted_messages"]
                results[case["id"]] = {"status": "passed" if all(checks.values()) else "failed", "checks": checks,
                    "receipts": receipt, "messages": prepared["messages"],
                    "prompt_sha256": hashlib.sha256(json.dumps(prepared["messages"], sort_keys=True, ensure_ascii=False).encode()).hexdigest()}
            except Exception as exc:
                results[case["id"]] = {"status": "failed", "error_type": type(exc).__name__, "checks": {"preparation_completed": False}}
    print(json.dumps(results, ensure_ascii=False))


def local_endpoint(value):
    parsed = urllib.parse.urlsplit(value)
    try:
        loopback = ipaddress.ip_address(parsed.hostname or "").is_loopback
        port = parsed.port
    except ValueError:
        loopback, port = False, None
    if (parsed.scheme not in ("http", "https") or not loopback or not port
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path.rstrip("/") not in ("", "/v1")):
        raise ValueError("Use an explicit loopback IP and port, for example http://127.0.0.1:1234/v1.")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/v1/chat/completions", "", ""))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_answer(endpoint, payload, timeout):
    # Ignore inherited proxies; never redirect synthetic questions elsewhere.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    request = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
    with opener.open(request, timeout=timeout) as response:
        if response.status != 200:
            raise ValueError("The selected endpoint rejected this request")
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("The response exceeded the review limit")
        return json.loads(raw)


def request_answer_stream(endpoint, payload, timeout):
    """Bounded loopback SSE with actual first-text-token timing; no proxies/redirects.

    read1 returns after at most one buffered raw read. Refresh its socket timeout
    against one monotonic deadline, so a dribbling response cannot renew the
    total 90-second allowance indefinitely. A socket deadline also covers slow
    HTTP headers, whose stdlib parser can otherwise keep reading tiny fragments.
    """
    supplied = urllib.parse.urlsplit(endpoint)
    # make_report passes its already canonical completion URL, while direct
    # tooling callers may pass the loopback base. Validate both through the
    # same strict authority/path policy; preserve query/fragment for rejection.
    base = urllib.parse.urlunsplit((supplied.scheme, supplied.netloc, '/v1', supplied.query, supplied.fragment)) if supplied.path == '/v1/chat/completions' else endpoint
    parsed = urllib.parse.urlsplit(local_endpoint(base))
    connection_type = http.client.HTTPSConnection if parsed.scheme == 'https' else http.client.HTTPConnection
    connection = connection_type(parsed.hostname, parsed.port, timeout=min(3, timeout))
    started = time.monotonic(); deadline = started + timeout
    expired = threading.Event(); sock = None
    def expire():
        expired.set()
        active = sock or connection.sock
        if active is not None:
            try:
                active.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
    timer = threading.Timer(timeout, expire); timer.daemon = True; timer.start()
    metrics = {'stream': True, 'first_token_ms': None, 'completion_ms': None,
               'response_bytes': 0, 'reasoning_chunks': 0}
    try:
        body = json.dumps({**payload, 'stream': True}, ensure_ascii=False).encode('utf-8')
        connection.request('POST', parsed.path, body, {'Content-Type': 'application/json'})
        sock = connection.sock
        sock.settimeout(max(.001, deadline - time.monotonic()))
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError('The selected runtime rejected the streaming request')
        buffer = b''; text = []; text_bytes = 0; model = None; finish = None; usage = {}; done = False
        while not done:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('The selected runtime exceeded the total response deadline')
            sock.settimeout(remaining)
            chunk = response.read1(4096)
            if not chunk:
                break
            metrics['response_bytes'] += len(chunk)
            if metrics['response_bytes'] > MAX_STREAM_BYTES:
                raise ValueError('Streaming envelope exceeds the bounded review limit')
            buffer += chunk
            if len(buffer) > 64 * 1024:
                raise ValueError('Streaming frame exceeds its limit')
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                if not line.startswith(b'data:'):
                    continue
                data = line[5:].strip()
                if data == b'[DONE]':
                    done = True; break
                value = json.loads(data.decode('utf-8'))
                if value.get('error'):
                    raise ValueError('Runtime reported a streaming error')
                if isinstance(value.get('model'), str):
                    if model is not None and model != value['model']:
                        raise ValueError('Runtime identity changed during response')
                    model = value['model']
                if isinstance(value.get('usage'), dict):
                    usage = value['usage']
                for choice in value.get('choices', []):
                    delta = choice.get('delta') or {}
                    if delta.get('reasoning_content'):
                        metrics['reasoning_chunks'] += 1
                    content = delta.get('content')
                    if isinstance(content, str) and content:
                        text_bytes += len(content.encode('utf-8'))
                        if text_bytes > MAX_RESPONSE_BYTES:
                            raise ValueError('Streaming answer text exceeds its bounded limit')
                        if metrics['first_token_ms'] is None:
                            metrics['first_token_ms'] = round((time.monotonic() - started) * 1000, 3)
                        text.append(content)
                    if choice.get('finish_reason') is not None:
                        finish = choice['finish_reason']
        if expired.is_set() or time.monotonic() >= deadline:
            raise TimeoutError('The selected runtime exceeded the total response deadline')
        if not done:
            raise ValueError('Runtime stream ended without its completion marker')
        metrics['completion_ms'] = round((time.monotonic() - started) * 1000, 3)
        return {'model': model, 'choices': [{'message': {'content': ''.join(text)}, 'finish_reason': finish}],
                'usage': usage, '_evaluation_metrics': metrics}
    except Exception as error:
        metrics['completion_ms'] = round((time.monotonic() - started) * 1000, 3)
        if expired.is_set() and not isinstance(error, TimeoutError):
            timeout_error = TimeoutError('The selected runtime exceeded the total response deadline')
            timeout_error.evaluation_metrics = metrics
            raise timeout_error from None
        error.evaluation_metrics = metrics
        raise
    finally:
        timer.cancel()
        connection.close()


def review_flags(case, answer):
    """Mechanical hints for human review, deliberately not an accuracy score."""
    folded = answer.casefold()
    flags = []
    for group in case.get("expected_mentions", []):
        if not any(word.casefold() in folded for word in group):
            flags.append("Expected topic not mentioned: " + " / ".join(group))
    for word in case.get("unexpected_mentions", []):
        if word.casefold() in folded:
            flags.append("Review unexpected claim: " + word)
    citations = re.findall(r"\[([^\[\]]+\.(?:txt|md)):L(\d+)(?:-L?(\d+))?\]", answer)
    sources = case.get("source_lines", {})
    for name, start, end in citations:
        if name not in sources or not 1 <= int(start) <= int(end or start) <= sources[name]:
            flags.append("Citation does not match supplied lines: " + name + ":L" + start + ("-L" + end if end else ""))
        elif name in case.get('supplied_ranges', {}) and not all(any(span['start'] <= line <= span['end'] for span in case['supplied_ranges'][name]) for line in range(int(start), int(end or start)+1)):
            flags.append('Citation refers to omitted lines: ' + name + ':L' + start)
    if sources and not citations:
        flags.append("No document line citation found")
    return flags


def source_identity():
    paths = ["scripts/evaluate_ai_answers.py", "scripts/fixtures/tli_answer_quality.json", "scripts/fixtures/tli_answer_extensions.json",
             "backend/intelligence/context.py", "backend/intelligence/input_budget.py", "backend/intelligence/documents.py",
             "backend/intelligence/chat_continuity.py",
             "backend/intelligence/memory.py", "backend/intelligence/observed_answers.py",
             "backend/intelligence/store.py", "backend/intelligence/diagnostics.py", "backend/tli_state.py",
             "backend/ai/prompts/system_default.txt", "backend/ai/preset_launch.py",
             "scripts/evaluate_isolated_model.py", "scripts/evaluation_runtime.py",
             "scripts/fixtures/tli_answer_development.json"]
    files = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
             for path in paths if (ROOT / path).is_file()}
    return {"files": files, "sha256": hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest(),
            "scope": "Listed evaluation and relevant source files; not a release artifact fingerprint."}


def make_report(cases, corpus_hash, *, endpoint=None, model=None, max_tokens=512, timeout=45, transport=request_answer, context_tokens=None, stream=False):
    if not 32 <= max_tokens <= 1024 or not 1 <= timeout <= 90:
        raise ValueError("Use 32–1024 output tokens and a timeout of 1–90 seconds per case")
    target = local_endpoint(endpoint) if endpoint else None
    if target and (not isinstance(model, str) or not model.strip() or len(model) > 256):
        raise ValueError("Specify the exact model identifier")
    try:
        prepared_cases = prepare_cases(cases, max_tokens, context_tokens)
    except Exception as exc:
        prepared_cases = {case["id"]: {"status": "failed", "checks": {"isolated_preparation": False},
                                      "error_type": type(exc).__name__}
                          for case in cases if "preparation" in case or "document_preparation" in case}
    report = {"schema_version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
              "mode": "explicit_local_inference" if target else "offline_review_plan",
              "corpus_sha256": corpus_hash, "source": source_identity(),
              "endpoint": target, "requested_model": model, "runtime_identity": "unverified",
              "limits": {"max_output_tokens": max_tokens, "timeout_seconds_per_case": timeout, "configured_context_tokens": context_tokens,
                         "max_response_bytes": MAX_RESPONSE_BYTES, "max_stream_bytes": MAX_STREAM_BYTES if stream else None, "retries": 0},
              "generation": {"temperature": 0, "stream": stream},
              "quality_verdict": "Not assessed. Mechanical flags and fake-provider tests do not establish useful answers.",
              "preparation_scope": "Current shared ordinary-chat preparation and base production prompt, with synthetic encrypted stores and fake host/registry data. Request routing, real runtime capacity and model answers are not established by offline checks.",
              "cases": []}
    for case in cases:
        result = {"id": case["id"], "purpose": case["purpose"], "rubric": case["rubric"],
                  "fixture_sha256": hashlib.sha256(json.dumps(case, sort_keys=True).encode()).hexdigest(),
                  "status": "not_run", "human_review": {"result": "not_run", "notes": ""},
                  "assessment": {"reviewer": None, "scale": "0 failed; 1 limited; 2 meets rubric; null not assessed",
                    "factual_grounding": None, "useful_next_steps": None, "context_handling": None, "truthful_action_claims": None}}
        prepared = prepared_cases.get(case["id"])
        result["input_source"] = "current_chat_preparation" if prepared is not None else "handwritten_provider_fixture"
        if 'document_preparation' in case:
            result['input_source'] = 'current_document_preparation'
        if prepared is not None:
            result["preparation"] = {key: value for key, value in prepared.items() if key != "messages"}
            if prepared.get("status") != "passed":
                result["status"] = "preparation_failed"
                report["cases"].append(result)
                continue
        messages = prepared["messages"] if prepared is not None else case["messages"]
        if case.get('production_prompt'):
            production = (ROOT / 'backend/ai/prompts/system_default.txt').read_text(encoding='utf-8')
            messages = [{'role': 'system', 'content': production + '\n\nSUPPLIED REQUEST EVIDENCE\n' + messages[0]['content']}, *messages[1:]]
            result['input_source'] = 'production_prompt_with_synthetic_evidence'
        result['request_sha256'] = hashlib.sha256(json.dumps(messages, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if target:
            started = time.monotonic()
            try:
                response = transport(target, {"model": model, "messages": messages,
                                     "max_tokens": max_tokens, "temperature": 0, "stream": stream}, timeout)
                if isinstance(response.get('_evaluation_metrics'), dict):
                    result['timing'] = response['_evaluation_metrics']
                choice = response["choices"][0]
                answer = choice["message"]["content"]
                if not isinstance(answer, str) or not answer.strip() or len(answer.encode("utf-8")) > MAX_RESPONSE_BYTES:
                    raise ValueError("No bounded text answer")
                reported_model = response.get("model")
                review_case = dict(case)
                if prepared and 'document_context' in prepared.get('receipts', {}):
                    review_case['supplied_ranges'] = {doc['name']:doc['coverage']['ranges'] for doc in prepared['receipts']['document_context']['documents']}
                result.update(status="response_received", answer=answer, reported_model=reported_model if isinstance(reported_model, str) else None,
                              finish_reason=choice.get("finish_reason"), flags=review_flags(review_case, answer))
                if reported_model != model:
                    result["flags"].append("Reported model differs from requested identifier; verify runtime aliases before comparing results")
                if choice.get("finish_reason") != "stop":
                    result["flags"].append("Completion was not reported as a normal stop; review for truncated output")
                usage = response.get("usage")
                result["usage"] = {key: usage[key] for key in ("prompt_tokens", "completion_tokens", "total_tokens")
                                   if isinstance(usage, dict) and isinstance(usage.get(key), int)
                                   and not isinstance(usage[key], bool) and usage[key] >= 0}
            except Exception as exc:
                # Provider error bodies may contain unexpected/private server data.
                result.update(status="failed", error_type=type(exc).__name__,
                              error="The selected runtime did not return a usable answer. No retry or fallback was performed.")
                if isinstance(getattr(exc, 'evaluation_metrics', None), dict):
                    result['timing'] = exc.evaluation_metrics
                    if exc.evaluation_metrics.get('request_sent') is False:
                        result['status'] = 'not_run'
            result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
        report["cases"].append(result)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-local", action="store_true", help="Explicitly send synthetic questions to an already available local runtime")
    parser.add_argument("--endpoint")
    parser.add_argument("--model")
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--timeout", type=float, default=45)
    parser.add_argument("--output", type=Path, help="New report file; existing reports cannot be overwritten")
    args = parser.parse_args(argv)
    if args.run_local != bool(args.endpoint and args.model) or (not args.run_local and (args.endpoint or args.model)):
        parser.error("Local evaluation requires --run-local, --endpoint and --model together. Omit all three for an offline review plan.")
    cases, digest = load_cases()
    if args.case:
        unknown = set(args.case) - {c["id"] for c in cases}
        if unknown:
            parser.error("Unknown case: " + ", ".join(sorted(unknown)))
        cases = [c for c in cases if c["id"] in args.case]
    # Fail before inference if a report destination already exists.
    output = args.output.open("x", encoding="utf-8") if args.output else None
    try:
        report = make_report(cases, digest, endpoint=args.endpoint, model=args.model,
                             max_tokens=args.max_tokens, timeout=args.timeout)
        text = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
        if output:
            output.write(text)
        else:
            print(text, end="")
        # A useful offline check must fail CI after preserving its diagnostic
        # report. Provider/human-answer review retains its existing semantics.
        return 1 if any(case.get("status") == "preparation_failed" for case in report["cases"]) else 0
    finally:
        if output:
            output.close()


if __name__ == "__main__":
    raise SystemExit(main())
