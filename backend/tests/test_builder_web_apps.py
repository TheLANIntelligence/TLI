"""App generation never starts a real model or executes generated source here."""
import copy
import io
import json
import re
import zipfile
from html.parser import HTMLParser

import pytest

from builder import receipts, web_apps as apps
from builder.llm_client import ModelOffline
from builder.web_preview import render_preview


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(receipts, "BUILDER_DIR", tmp_path / "builder")
    monkeypatch.setattr(receipts, "STATE_PATH", tmp_path / "state.json")
    monkeypatch.setattr(receipts, "RECEIPTS_PATH", tmp_path / "receipts.json")
    return tmp_path


def bundle():
    return {"name": "Counter", "summary": "An incrementing counter", "files": {
        "index.html": '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Counter</title><link rel="stylesheet" href="style.css"></head><body><main><button id="add">Add</button><output id="count">0</output></main><script src="app.js"></script></body></html>',
        "style.css": "body { font-family: system-ui; }",
        "app.js": "let count=0; document.querySelector('#add').addEventListener('click',()=>document.querySelector('#count').textContent=String(++count));",
    }, "checks": [{"name": "Add increments", "steps": [{"action": "click", "selector": "#add"}, {"action": "text", "selector": "#count", "contains": "1"}]}], "manual_checks": ["Click Add twice and check that the count reaches 2."]}


def completion(messages, temperature, max_tokens):
    return json.dumps(bundle()), "fixture-local"


def test_saved_project_roundtrip_repair_versions_and_download(store):
    project = apps.generate_app("Build a counter", owner="alice", complete=completion)
    assert project["status"] == "ready_for_preview"
    assert project["revisions"][0]["validation"]["status"] == "passed"
    assert "script" not in project["revisions"][0]["preview_html"]
    assert "style.css" not in project["revisions"][0]["preview_html"]
    original = copy.deepcopy(project["revisions"][0])
    observed = []
    def revise(messages, *args):
        observed.append(messages)
        result = bundle(); result["files"]["app.js"] += "\n// improved"
        return json.dumps(result), "fixture-local"
    revised = apps.generate_app(app_id=project["id"], feedback="Add clearer labels", expected_revision=1, owner="alice", complete=revise)
    assert revised["revisions"][0] == original
    assert revised["revisions"][1]["feedback"] == "Add clearer labels"
    assert "previous_files" in observed[0][1]["content"]
    assert apps.get_app(project["id"], owner="alice") == revised
    assert apps.list_apps(owner="alice")[0]["id"] == project["id"]
    with zipfile.ZipFile(io.BytesIO(apps.download_app(project["id"], 1, owner="alice"))) as archive:
        assert set(archive.namelist()) == {*apps.FILES, "TLI-README.txt"}
        assert archive.read("app.js").decode() == original["files"]["app.js"]


def test_failure_preserves_brief_previous_version_and_retries_explicitly(store):
    def offline(*args): raise ModelOffline("No model loaded")
    project = apps.generate_app("Counter brief", owner="alice", complete=offline)
    assert project["brief"] == "Counter brief" and project["status"] == "needs_retry"
    assert project["revisions"] == []
    project = apps.generate_app(app_id=project["id"], owner="alice", expected_revision=0, complete=completion)
    previous = copy.deepcopy(project["revisions"])
    failed = apps.generate_app(app_id=project["id"], owner="alice", expected_revision=1, feedback="Fix it", complete=offline)
    assert failed["revisions"] == previous
    assert failed["last_feedback"] == "Fix it"
    assert apps.get_app(project["id"], owner="alice")["last_error"] == "No model loaded"


def test_invalid_model_has_one_bounded_repair_attempt(store):
    calls = []
    def invalid(messages, *_): calls.append(copy.deepcopy(messages)); return "not JSON", "fixture"
    result = apps.generate_app("Counter", owner="alice", complete=invalid)
    assert result["status"] == "needs_retry" and len(calls) == 2
    assert len(calls[1]) == 4
    assert result["revisions"] == []


def test_validation_feedback_can_recover_without_new_request(store):
    replies = iter([("not JSON", "fixture"), (json.dumps(bundle()), "fixture")])
    result = apps.generate_app("Counter", owner="alice", complete=lambda *_: next(replies))
    assert result["status"] == "ready_for_preview"


def test_owner_boundaries_and_stale_revision_never_call_model(store):
    project = apps.generate_app("Private counter", owner="alice", complete=completion)
    assert apps.list_apps(owner="bob") == []
    with pytest.raises(ValueError, match="not found"):
        apps.get_app(project["id"], owner="bob")
    with pytest.raises(ValueError): apps.download_app(project["id"], owner="bob")
    def unexpected(*_): pytest.fail("Model must not run")
    with pytest.raises(apps.AppBusy, match="changed"):
        apps.generate_app(app_id=project["id"], owner="alice", expected_revision=0, complete=unexpected)
    with pytest.raises(ValueError): apps.generate_app(app_id=project["id"], owner="bob", expected_revision=1, complete=unexpected)
    assert apps.get_app(project["id"], owner="alice")["status"] == "ready_for_preview"


@pytest.mark.parametrize("filename,replacement", [
    ("index.html", '<body><script>alert(1)</script></body>'),
    ("index.html", '<body><iframe src="https://example.com"></iframe></body>'),
    ("app.js", "fetch('/api/vault');"),
    ("app.js", "localStorage.setItem('x','x');"),
    ("app.js", "window.location='https://example.com';"),
    ("style.css", "@import 'https://example.com/font.css';"),
    ("style.css", "body { background: url(https://example.com); }"),
])
def test_offline_profile_rejects_external_or_privileged_features(filename, replacement):
    data = bundle(); data["files"][filename] = replacement
    with pytest.raises(ValueError): apps.validate_bundle(data)


@pytest.mark.parametrize("fragment", ['<img src="https://example.com">', '<div onclick="alert(1)">x</div>', '<meta http-equiv="refresh" content="0;url=https://example.com">', '<input type="file">', '<input id="count">'])
def test_html_canonicalization_rejects_unsupported_markup(fragment):
    data = bundle(); data["files"]["index.html"] = data["files"]["index.html"].replace('<main>', '<main>' + fragment)
    with pytest.raises(ValueError): apps.validate_bundle(data)


def test_source_and_check_bounds_and_no_file_traversal():
    data = bundle(); data["files"]["../../secret.py"] = "no"
    with pytest.raises(ValueError): apps.validate_bundle(data)
    data = bundle(); data["files"]["app.js"] = "x" * 96001
    with pytest.raises(ValueError): apps.validate_bundle(data)
    data = bundle(); data["checks"][0]["steps"] = [{"action": "click", "selector": "#add"}]
    with pytest.raises(ValueError, match="assert"): apps.validate_bundle(data)
    data = bundle(); data["checks"][0]["steps"] = [{"action": "execute", "selector": "x"}]
    with pytest.raises(ValueError): apps.validate_bundle(data)


def test_concurrent_generation_refused_and_lock_released(store):
    with apps._LOCK:
        with pytest.raises(apps.AppBusy): apps.generate_app("Counter", owner="alice", complete=completion)
    with pytest.raises(ValueError): apps.generate_app("", owner="alice", complete=completion)
    assert apps.generate_app("Counter", owner="alice", complete=completion)["status"] == "ready_for_preview"


def test_routes_require_session_owner_and_locked_mode(store, authed_client, monkeypatch):
    monkeypatch.setattr(apps.llm_client, "_chat", completion)
    receipts.save_state({"permission_level": "locked"})
    assert authed_client.post('/api/builder/web-apps', json={"brief":"Counter"}).status_code == 403
    receipts.save_state({"permission_level": "ask"})
    response = authed_client.post('/api/builder/web-apps', json={"brief":"Counter"})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    project = response.json()["project"]
    assert authed_client.get('/api/builder/web-apps').json()["projects"][0]["id"] == project["id"]
    assert authed_client.post('/api/builder/web-apps/' + project["id"] + '/revise', json={"feedback":"Better", "expected_revision":0}).status_code == 409
    download = authed_client.get('/api/builder/web-apps/' + project["id"] + '/download')
    assert download.status_code == 200 and download.headers["content-type"] == "application/zip"
    assert download.headers["x-content-type-options"] == "nosniff"


def test_preview_response_has_opaque_sandbox_nonce_and_no_embedded_app_authority(store):
    project = apps.generate_app("Counter", owner="alice", complete=completion)
    html, headers = render_preview(project["id"], owner="alice", revision=1, token="tli" + "a" * 32, check_index=0)
    policy = headers["Content-Security-Policy"]
    assert "sandbox allow-scripts;" in policy and "allow-same-origin" not in policy
    assert "default-src 'none'" in policy and "connect-src 'none'" in policy and "form-action 'none'" in policy
    assert "frame-ancestors 'self'" in policy
    nonce = re.search(r"script-src 'nonce-([a-f0-9]+)'", policy).group(1)
    assert html.count('<script nonce="' + nonce + '">') == 2
    assert "Add increments" in html and "tli" + "a" * 32 in html
    assert "src=\"app.js\"" not in html
    assert headers["Cache-Control"] == "no-store" and headers["Referrer-Policy"] == "no-referrer"
    _, second_headers = render_preview(project["id"], owner="alice", revision=1, token="tli" + "a" * 32)
    assert policy != second_headers["Content-Security-Policy"]


@pytest.mark.parametrize("changes", [{"revision":0}, {"revision":2}, {"check_index":-1}, {"check_index":1}, {"token":"bad\"<script>"}, {"owner":"bob"}])
def test_preview_rejects_wrong_owner_revision_check_and_injected_tokens(store, changes):
    project = apps.generate_app("Counter", owner="alice", complete=completion)
    arguments = {"owner":"alice", "revision":1, "token":"tli" + "a" * 32, **changes}
    with pytest.raises(ValueError): render_preview(project["id"], **arguments)


def test_preview_revalidates_saved_source_and_escapes_script_terminators(store):
    data = bundle(); data["files"]["app.js"] += '\nconst text = "</script><script>bad()</script>";'
    project = apps.generate_app("Counter", owner="alice", complete=lambda *_:(json.dumps(data), "fixture"))
    html, _ = render_preview(project["id"], owner="alice", revision=1, token="tli" + "a" * 32)
    class ScriptCounter(HTMLParser):
        count = 0
        def handle_starttag(self, tag, attrs):
            if tag == "script": self.count += 1
    counter = ScriptCounter(); counter.feed(html)
    assert counter.count == 2
    project["revisions"][0]["files"]["index.html"] = '<script src="https://example.com"></script>'
    apps._save(project, "alice")
    with pytest.raises(ValueError): render_preview(project["id"], owner="alice", revision=1, token="tli" + "a" * 32)


def test_preview_route_preserves_dedicated_csp_through_host_middleware(store, authed_client, monkeypatch):
    monkeypatch.setattr(apps.llm_client, "_chat", completion)
    receipts.save_state({"permission_level":"ask"})
    result = authed_client.post('/api/builder/web-apps', json={"brief":"Counter"}).json()["project"]
    url = '/api/builder/web-apps/' + result["id"] + '/preview'
    response = authed_client.get(url, params={"revision":1,"token":"tli" + "a" * 32,"check_index":0})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "sandbox allow-scripts;" in response.headers["content-security-policy"]
    assert "script-src 'nonce-" in response.headers["content-security-policy"]
    for params in ({"revision":0,"token":"tli" + "a" * 32}, {"revision":1,"token":"invalid"}, {"revision":1,"token":"tli" + "a" * 32,"check_index":99}):
        assert authed_client.get(url, params=params).status_code == 400
    assert authed_client.get(url).status_code == 422
