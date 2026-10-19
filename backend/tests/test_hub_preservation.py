"""Synthetic Hub lifecycle, strict storage, and interrupted-commit boundaries."""
import io
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import hub_store as store
import script_sources
import tli_state as S
from routers import hub_routes as hub


def package(kind="app", identifier="org.example.fixture", **extra):
    return {"id": identifier, "type": kind, "name": "Fixture package", "version": "1",
            "preview_css": ":root { --accent: blue; }", "system_prompt": "Synthetic prompt",
            "shell": "powershell", "code": "retained review text", "trigger": {}, "actions": [],
            "inline_html": "<!doctype html><p>Original fixture</p>", "permissions": ["mesh.devices"], **extra}


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "log_debug", Mock())
    monkeypatch.setattr(hub, "_REGISTRY_CACHE", {})
    network = Mock(side_effect=AssertionError("No real registry request"))
    monkeypatch.setattr(hub.urllib.request, "build_opener", network)
    packages = [package(kind, "fixture-" + kind) for kind in sorted(store.TYPES)] + [package()]
    monkeypatch.setattr(hub, "_SAMPLE_REGISTRY", {"version": "1", "packages": packages})
    token = S.create_session_token("local")
    app = FastAPI(); app.include_router(hub.router)
    client = TestClient(app, base_url="http://localhost:8000", client=("127.0.0.1", 1234),
                        headers={"Origin": "http://localhost:8000", "Cookie": "tli_session=" + token})
    yield SimpleNamespace(root=tmp_path, client=client, token=token, packages=packages, network=network,
                          revoke=lambda: S.revoke_session_token(token))
    client.close()


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=3), encoding="utf-8")
    return path.read_bytes()


def install(env, identifier="org.example.fixture"):
    return env.client.post("/hub/install", json={"package_id": identifier, "use_sample": True})


def files(root):
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def reject(response, status=503):
    assert response.status_code == status, response.text
    if status not in {401, 403}:  # Captured authority errors propagate unchanged.
        assert response.headers["cache-control"] == "no-store"
    assert "PRIVATE" not in response.text


@pytest.mark.parametrize("route", ["/hub/status", "/hub/installed", "/hub/apps", "/hub/themes", "/hub/presets", "/hub/local-registry"])
def test_missing_readers_do_not_create_files(env, route):
    before = files(env.root)
    assert env.client.get(route).status_code == 200
    assert files(env.root) == before == {}


@pytest.mark.parametrize("kind", sorted(store.TYPES))
def test_install_update_and_exact_uninstall_retain_recovery_and_metadata(env, kind):
    identifier = "fixture-" + kind
    assert install(env, identifier).status_code == 200
    index = env.root / "hub_installed.json"
    rows = json.loads(index.read_text()); rows[0]["custom"] = {"preserve": 1}; put(index, rows)
    targets = store.artifact_paths(identifier, kind)
    if kind != "theme":
        target = targets[-1]
        value = json.loads(target.read_text()); value["extra"] = "keep"; put(target, value)
    before = [target.read_bytes() for target in targets]
    offered = next(p for p in env.packages if p["id"] == identifier)
    offered.update(name="Updated package", version="2", inline_html="<p>Updated fixture</p>", code="updated review text")
    response = install(env, identifier)
    assert response.status_code == 200, response.text
    assert response.json()["package"]["custom"] == {"preserve": 1}
    assert len(json.loads(index.read_text())) == 1
    if kind != "theme":
        assert json.loads(targets[-1].read_text())["extra"] == "keep"
    untouched = targets[0].parent / ("unregistered.txt" if kind == "app" else "other_fixture-app.css")
    untouched.write_text("Retained user artifact")
    current = [target.read_bytes() for target in targets]
    response = env.client.delete("/hub/packages/" + identifier)
    assert response.status_code == 200 and response.json()["removed"] == 1
    assert json.loads(index.read_text()) == []
    assert not any(target.exists() for target in targets)
    assert untouched.read_text() == "Retained user artifact"
    backups = [p.read_bytes() for p in (env.root / "hub_backups").rglob("*") if p.is_file()]
    assert all(raw in backups for raw in before + current)
    assert not (env.root / "hub_pending.json").exists()
    env.network.assert_not_called()


@pytest.mark.parametrize("raw", [b"{broken", b"null", b"[]", b'{"enabled":false,"enabled":true,"hub_url":""}',
    b'{"enabled":false,"hub_url":"","unknown":1e999}', b'{"enabled":"false","hub_url":""}',
    b'{"enabled":false,"hub_url":"file:///private"}', b"x" * (store.SETTINGS_LIMIT + 1)],
    ids=["broken", "null", "shape", "duplicate", "nonfinite", "boolean", "url", "oversize"])
def test_damaged_settings_fail_without_network_or_replacement(env, raw):
    target = env.root / "hub_settings.json"; target.write_bytes(raw)
    before = files(env.root)
    reject(env.client.get("/hub/status"))
    reject(env.client.post("/hub/settings", json={"enabled": True}))
    reject(env.client.get("/hub/registry"))
    assert files(env.root) == before
    env.network.assert_not_called()


@pytest.mark.parametrize("which", ["installed", "registry"])
@pytest.mark.parametrize("damage", ["broken", "duplicate", "nonfinite", "shape", "bad-type", "case-collision", "unsafe-id", "oversize"])
def test_damaged_indexes_preserve_bytes_and_never_start_mutation(env, which, damage):
    rows = [package()]
    if damage == "bad-type": rows[0]["type"] = []
    if damage == "case-collision": rows.append(package(identifier="ORG.EXAMPLE.FIXTURE"))
    if damage == "unsafe-id": rows[0]["id"] = "../escape"
    value = rows if which == "installed" else {"packages": rows, "custom": "keep"}
    raw = json.dumps(value).encode()
    raw = {"broken": b"{broken", "duplicate": b'{"packages":[],"packages":[]}',
           "nonfinite": b'{"packages":[],"private":NaN}', "shape": b"null",
           "oversize": b" " * (store.REGISTRY_LIMIT + 1)}.get(damage, raw)
    target = env.root / ("hub_installed.json" if which == "installed" else "hub_local_registry.json")
    target.write_bytes(raw); before = files(env.root)
    if which == "installed":
        reject(install(env)); reject(env.client.get("/hub/installed")); reject(env.client.delete("/hub/packages/org.example.fixture"))
    else:
        reject(env.client.post("/hub/publish", json=package())); reject(env.client.get("/hub/local-registry"))
        reject(env.client.delete("/hub/local-registry/org.example.fixture"))
    assert files(env.root) == before
    env.network.assert_not_called()


@pytest.mark.parametrize("identifier", ["../escape", "a/b", "a\\b", "*", "a?", "a:stream", ".", "..", "a.",
                                      "a ", "CON", "con.txt", "LPT1", "com0.txt", "NUL.x", "a" * 129])
def test_unsafe_request_ids_are_rejected_before_storage(env, monkeypatch, identifier):
    monkeypatch.setattr(hub, "_load_installed", lambda *_: pytest.fail("Unsafe request read installed state"))
    reject(install(env, identifier), 400)
    reject(env.client.post("/hub/publish", json=package(identifier=identifier)), 400)
    assert files(env.root) == {}


def test_case_aliases_and_orphaned_artifacts_are_preserved(env):
    assert install(env).status_code == 200
    before = files(env.root)
    env.packages.append(package(identifier="ORG.EXAMPLE.FIXTURE"))
    reject(install(env, "ORG.EXAMPLE.FIXTURE"), 409)
    assert files(env.root) == before
    (env.root / "hub_installed.json").unlink()
    before = files(env.root)
    reject(install(env), 409)
    assert files(env.root) == before


def test_settings_and_publication_preserve_unknown_fields(env):
    put(env.root / "hub_settings.json", {"enabled": False, "hub_url": "", "future": {"keep": 1}})
    result = env.client.post("/hub/settings", json={"enabled": True, "hub_url": "http://192.0.2.10/hub/local-registry"})
    assert result.status_code == 200 and result.json()["settings"]["future"] == {"keep": 1}
    put(env.root / "hub_local_registry.json", {"packages": [package(future="keep")], "registry_future": 2})
    response = env.client.post("/hub/publish", json=package(name="Updated"))
    assert response.status_code == 200 and response.json()["package"]["future"] == "keep"
    assert env.client.get("/hub/local-registry").json()["registry_future"] == 2


@pytest.mark.parametrize("mode", ["symlink", "broken-link", "hardlink", "linked-parent", "case-alias"])
def test_linked_or_aliased_destinations_never_follow_or_overwrite(env, mode):
    other = env.root / "outside"; other.mkdir()
    original = other / "private.txt"; original.write_text("PRIVATE outside bytes")
    target = env.root / "apps" / "org.example.fixture" / "index.html"
    if mode == "linked-parent":
        (env.root / "apps").symlink_to(other, target_is_directory=True)
    elif mode == "case-alias":
        target = env.root / "apps" / "ORG.EXAMPLE.FIXTURE" / "index.html"
        target.parent.mkdir(parents=True); target.write_text("Retained alias")
    else:
        target.parent.mkdir(parents=True)
        if mode == "hardlink": os.link(original, target)
        else: target.symlink_to(original if mode == "symlink" else other / "missing")
    reject(install(env))
    assert original.read_text() == "PRIVATE outside bytes"
    assert not (env.root / "hub_installed.json").exists()
    assert not (env.root / "hub_pending.json").exists()


@pytest.mark.parametrize("which", ["settings", "installed", "registry"])
def test_unreadable_existing_store_never_defaults(env, monkeypatch, which):
    name, _limit, _validate, default = store._DOCUMENTS[which]
    target = env.root / name; before = put(target, default)
    original = store.os.open
    def fail(current, *args, **kwargs):
        if Path(current) == target: raise PermissionError("PRIVATE denied")
        return original(current, *args, **kwargs)
    monkeypatch.setattr(store.os, "open", fail)
    with pytest.raises(HTTPException) as result:
        store.load(which)
    assert result.value.status_code == 503
    assert target.read_bytes() == before


@pytest.mark.parametrize("stage", ["stage-fsync", "journal-replace", "before-first-destination", "first-replace-denied"])
def test_known_failure_before_destination_change_leaves_no_pending_journal(env, monkeypatch, stage):
    original_replace, original_fsync = store.os.replace, store.os.fsync
    def replace(source, target):
        target = Path(target)
        if target.name == "hub_pending.json" and stage == "journal-replace":
            original_replace(source, target); raise OSError("Late journal failure")
        if target.name == "index.html" and stage == "first-replace-denied":
            raise PermissionError("No destination effect")
        return original_replace(source, target)
    monkeypatch.setattr(store.os, "replace", replace)
    def fsync(fd):
        if stage == "stage-fsync": raise OSError("Staging failure")
        return original_fsync(fd)
    monkeypatch.setattr(store.os, "fsync", fsync)
    if stage == "before-first-destination":
        original = store._unchanged
        def fail(target, *args, **kwargs):
            if Path(target).name == "index.html" and (env.root / "hub_pending.json").exists():
                raise store.error(503, "Preflight failed")
            return original(target, *args, **kwargs)
        monkeypatch.setattr(store, "_unchanged", fail)
    reject(install(env))
    assert not (env.root / "hub_pending.json").exists()
    assert not (env.root / "hub_installed.json").exists()
    assert not (env.root / "apps" / "org.example.fixture" / "index.html").exists()


@pytest.mark.parametrize("stage", ["late-first-replace", "second-artifact", "index", "late-index-replace"])
def test_partial_or_uncertain_commit_preserves_copies_and_blocks_all_projections(env, monkeypatch, stage):
    assert install(env).status_code == 200
    original_files = files(env.root)
    env.packages[-1]["inline_html"] = "<p>Changed fixture</p>"
    env.packages[-1]["name"] = "Updated name"
    original = store.os.replace
    def fail(source, target):
        target = Path(target)
        hit = ((stage == "late-first-replace" and target.name == "index.html")
               or (stage == "second-artifact" and target.name == "manifest.json")
               or (stage in {"index", "late-index-replace"} and target.name == "hub_installed.json"))
        if hit:
            if stage.startswith("late-"): original(source, target)
            raise OSError("PRIVATE uncertain replacement")
        return original(source, target)
    monkeypatch.setattr(store.os, "replace", fail)
    reject(install(env))
    assert (env.root / "hub_pending.json").exists()
    retained = [p.read_bytes() for p in (env.root / "hub_backups").rglob("*") if p.is_file()]
    assert original_files["apps/org.example.fixture/index.html"] in retained
    before = files(env.root)
    for route in ["/hub/status", "/hub/installed", "/hub/apps", "/hub/themes", "/hub/presets", "/hub/local-registry"]:
        reject(env.client.get(route))
    reject(install(env))
    reject(env.client.delete("/hub/packages/org.example.fixture"))
    with pytest.raises(HTTPException) as result:
        script_sources.read_hub_source("fixture-script", lambda: None)
    assert result.value.status_code == 503
    assert files(env.root) == before


@pytest.mark.parametrize("raw", [b"{broken pending", b"null", b'{"schema":1,"schema":2}', b"x" * (store.INDEX_LIMIT + 1)],
                         ids=["broken", "null", "duplicate", "oversized"])
def test_damaged_or_unrecognized_journal_is_preserved_and_never_replayed(env, raw):
    target = env.root / "hub_pending.json"; target.write_bytes(raw)
    reject(install(env)); reject(env.client.get("/hub/apps"))
    assert files(env.root) == {"hub_pending.json": raw}


@pytest.mark.parametrize("stage", ["after-read", "fsync", "after-artifact", "after-final-index"])
def test_captured_session_rechecked_with_no_further_effect_after_revocation(env, monkeypatch, stage):
    original_read, original_sync, original_replace = store.read_artifact, store.os.fsync, store.os.replace
    def read(target, *args, **kwargs):
        result = original_read(target, *args, **kwargs)
        if stage == "after-read" and Path(target).name == "hub_installed.json": env.revoke()
        return result
    def sync(fd):
        result = original_sync(fd)
        if stage == "fsync": env.revoke()
        return result
    def replace(source, target):
        result = original_replace(source, target)
        if (stage == "after-artifact" and Path(target).name == "index.html"
                or stage == "after-final-index" and Path(target).name == "hub_installed.json"):
            env.revoke()
        return result
    monkeypatch.setattr(store, "read_artifact", read)
    monkeypatch.setattr(store.os, "fsync", sync)
    monkeypatch.setattr(store.os, "replace", replace)
    reject(install(env), 401)
    if stage == "after-artifact":
        assert (env.root / "hub_pending.json").exists()
        assert not (env.root / "hub_installed.json").exists()
        assert not (env.root / "apps" / "org.example.fixture" / "manifest.json").exists()
    elif stage == "after-final-index":
        assert not (env.root / "hub_pending.json").exists()
        assert json.loads((env.root / "hub_installed.json").read_text())[0]["id"] == "org.example.fixture"
    else:
        assert not (env.root / "hub_pending.json").exists()
        assert not (env.root / "hub_installed.json").exists()


def test_external_settings_edit_during_fsync_is_preserved(env, monkeypatch):
    target = env.root / "hub_settings.json"
    put(target, {"enabled": False, "hub_url": "", "unknown": "original"})
    changed = b"{external recoverable damage"
    original = store.os.fsync
    def fsync(fd):
        original(fd); target.write_bytes(changed)
    monkeypatch.setattr(store.os, "fsync", fsync)
    reject(env.client.post("/hub/settings", json={"enabled": True}), 409)
    assert target.read_bytes() == changed
    assert not list(env.root.glob(".hub-*.tmp"))


def remote(env, monkeypatch, raw, *, revoke=None):
    class Response(io.BytesIO):
        def read(self, size=-1):
            assert size == store.REGISTRY_LIMIT + 1
            value = super().read(size)
            if revoke == "read": env.revoke()
            return value
    def open_request(request, timeout):
        assert timeout == 8
        if revoke == "open": env.revoke()
        return Response(raw)
    opener = Mock(); opener.open.side_effect = open_request
    build = Mock(return_value=opener)
    monkeypatch.setattr(hub.urllib.request, "build_opener", build)
    put(env.root / "hub_settings.json", {"enabled": True, "hub_url": "http://192.0.2.10/hub/local-registry"})
    return opener, build


def test_remote_registry_is_bounded_redirect_free_and_cached_by_exact_url(env, monkeypatch):
    opener, build = remote(env, monkeypatch, json.dumps({"packages": [package()], "custom": "keep"}).encode())
    first = env.client.get("/hub/registry")
    assert first.status_code == 200 and first.json()["custom"] == "keep"
    assert env.client.get("/hub/registry").status_code == 200
    assert opener.open.call_count == 1
    assert isinstance(build.call_args.args[0], hub._NoRedirect)
    assert build.call_args.args[0].redirect_request(None, None, 302, None, None, "file:///private") is None
    put(env.root / "hub_settings.json", {"enabled": True, "hub_url": "http://192.0.2.11/hub/local-registry"})
    assert env.client.get("/hub/registry").status_code == 200
    assert opener.open.call_count == 2


@pytest.mark.parametrize("raw", [b"{broken", b'{"packages":[],"packages":[]}', b'{"packages":[],"x":1e999}',
                                  b'{"packages":[{"id":"../x","type":"app","name":"X"}]}',
                                  b"x" * (store.REGISTRY_LIMIT + 1)],
                         ids=["broken", "duplicate", "nonfinite", "unsafe-id", "oversized"])
def test_remote_bad_content_is_not_cached_or_installed(env, monkeypatch, raw):
    remote(env, monkeypatch, raw)
    before = files(env.root)
    reject(env.client.get("/hub/registry"), 502)
    assert hub._REGISTRY_CACHE == {}
    assert files(env.root) == before


@pytest.mark.parametrize("stage", ["open", "read"])
def test_remote_wait_revocation_cannot_publish_cache_or_create_package(env, monkeypatch, stage):
    remote(env, monkeypatch, json.dumps({"packages": [package(identifier="remote-only")]}).encode(), revoke=stage)
    before = files(env.root)
    response = env.client.post("/hub/install", json={"package_id": "remote-only"})
    reject(response, 401)
    assert hub._REGISTRY_CACHE == {}
    assert files(env.root) == before


@pytest.mark.parametrize("url", ["file:///private", "ftp://example.test/x", "https://user:secret@example.test/x", "https://example.test/#fragment"])
def test_invalid_remote_urls_fail_without_network_or_storage(env, url):
    reject(env.client.post("/hub/settings", json={"hub_url": url}), 400)
    assert files(env.root) == {}
    env.network.assert_not_called()


@pytest.mark.parametrize("kind,field", [("script", "code"), ("ai_preset", "system_prompt"), ("automation", "trigger")])
def test_wrong_saved_payload_is_not_replaced_by_reinstall(env, kind, field):
    identifier = "fixture-" + kind
    assert install(env, identifier).status_code == 200
    target = store.artifact_paths(identifier, kind)[0]
    value = json.loads(target.read_text()); value[field] = None; put(target, value)
    before = files(env.root)
    reject(install(env, identifier))
    reject(env.client.delete("/hub/packages/" + identifier))
    assert files(env.root) == before


@pytest.mark.parametrize("kind,route", [("app", "/hub/apps"), ("ai_preset", "/hub/presets")])
def test_revocation_during_artifact_decode_error_retains_original_denial(env, monkeypatch, kind, route):
    identifier = "fixture-" + kind
    assert install(env, identifier).status_code == 200
    original = store.decode_json
    def decode(raw, **kwargs):
        value = original(raw, **kwargs)
        if isinstance(value, dict) and value.get("id") == identifier:
            env.revoke(); raise store.error(503, "PRIVATE invalid artifact")
        return value
    monkeypatch.setattr(store, "decode_json", decode)
    before = files(env.root)
    reject(env.client.get(route), 401)
    assert files(env.root) == before


@pytest.mark.parametrize("stage", ["second-file", "index", "late-move"])
def test_uninstall_interruption_retains_exact_moved_files_and_installed_record(env, monkeypatch, stage):
    assert install(env).status_code == 200
    app = env.root / "apps" / "org.example.fixture"
    extra = app / "unowned.txt"; extra.write_text("Preserve unrelated contents")
    index = env.root / "hub_installed.json"; original_index = index.read_bytes()
    before_html = (app / "index.html").read_bytes()
    original = store.os.replace
    def fail(source, target):
        target = Path(target)
        if stage == "second-file" and target.name == "1.removed": raise OSError("No second move")
        if stage == "index" and target.name == "hub_installed.json": raise OSError("No index commit")
        if stage == "late-move" and target.name == "0.removed":
            original(source, target); raise OSError("Move was not confirmed")
        return original(source, target)
    monkeypatch.setattr(store.os, "replace", fail)
    reject(env.client.delete("/hub/packages/org.example.fixture"))
    assert index.read_bytes() == original_index
    assert (env.root / "hub_pending.json").exists()
    assert extra.read_text() == "Preserve unrelated contents"
    assert before_html in [p.read_bytes() for p in (env.root / "hub_backups").rglob("*") if p.is_file()]
    reject(env.client.get("/hub/apps"))


def test_external_artifact_change_after_replace_is_not_published_as_complete(env, monkeypatch):
    original = store.os.replace
    changed = b"PRIVATE external replacement"
    def replace(source, target):
        result = original(source, target)
        if Path(target).name == "index.html": Path(target).write_bytes(changed)
        return result
    monkeypatch.setattr(store.os, "replace", replace)
    reject(install(env))
    assert (env.root / "apps" / "org.example.fixture" / "index.html").read_bytes() == changed
    assert not (env.root / "hub_installed.json").exists()
    assert (env.root / "hub_pending.json").exists()


def test_journal_cleanup_failure_reports_unconfirmed_complete_change(env, monkeypatch):
    original = Path.unlink
    def unlink(target, *args, **kwargs):
        if target.name == "hub_pending.json": raise PermissionError("Journal remains")
        return original(target, *args, **kwargs)
    monkeypatch.setattr(Path, "unlink", unlink)
    reject(install(env))
    assert (env.root / "hub_pending.json").exists()
    assert json.loads((env.root / "hub_installed.json").read_text())[0]["id"] == "org.example.fixture"
    reject(env.client.get("/hub/apps"))


@pytest.mark.parametrize("kind", ["settings", "registry"])
def test_revocation_at_settings_or_publication_fsync_preserves_original(env, monkeypatch, kind):
    name, _limit, _validate, default = store._DOCUMENTS[kind]
    target = env.root / name; before = put(target, default)
    original = store.os.fsync
    def fsync(fd):
        original(fd); env.revoke()
    monkeypatch.setattr(store.os, "fsync", fsync)
    response = (env.client.post("/hub/settings", json={"enabled": True}) if kind == "settings"
                else env.client.post("/hub/publish", json=package()))
    reject(response, 401)
    assert target.read_bytes() == before
    assert not list(env.root.glob(".hub-*.tmp"))


def test_external_index_damage_during_staging_prevents_every_destination_change(env, monkeypatch):
    target = env.root / "hub_installed.json"; put(target, [])
    changed = b"{external recoverable index"
    original = store.os.fsync
    def fsync(fd):
        original(fd); target.write_bytes(changed)
    monkeypatch.setattr(store.os, "fsync", fsync)
    reject(install(env), 409)
    assert target.read_bytes() == changed
    assert not (env.root / "hub_pending.json").exists()
    assert not (env.root / "apps").exists()


@pytest.mark.parametrize("remove", [False, True])
def test_completed_change_retains_independently_reviewable_recovery_mapping(env, remove):
    assert install(env).status_code == 200
    if remove:
        assert env.client.delete("/hub/packages/org.example.fixture").status_code == 200
    assert not (env.root / "hub_pending.json").exists()
    manifests = list((env.root / "hub_backups").glob("*/recovery.json"))
    assert len(manifests) == (2 if remove else 1)
    for manifest in manifests:
        value = json.loads(manifest.read_text(encoding="utf-8"))
        assert value["backup_id"] == manifest.parent.name
        assert value["package_id"] == "org.example.fixture"
        assert {row["path"] for row in value["files"]} == {
            "apps/org.example.fixture/index.html", "apps/org.example.fixture/manifest.json", "hub_installed.json"}
        for row in value["files"]:
            for phase in ("before", "after"):
                if row[phase + "_file"] is not None:
                    raw = (manifest.parent / row[phase + "_file"]).read_bytes()
                    assert hashlib.sha256(raw).hexdigest() == row[phase + "_sha256"]
            if row["removed_file"] is not None:
                raw = (manifest.parent / row["removed_file"]).read_bytes()
                assert hashlib.sha256(raw).hexdigest() == row["before_sha256"]
