"""Saved model/profile preservation with temporary files and no inference."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
from threading import Event
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

import selection_settings as store
import tli_state as S


MODELS = {"models": {
    "deepseek": {"id": "original", "label": "Original", "future": {"keep": [1, 2]}},
    "qwen": {"id": "coding", "label": "Code", "other": True},
    "llama": {"id": "quick"}}, "default_model_key": "deepseek", "metadata": {"owner_note": "preserve"}}
PROFILE = {"profile": "balanced", "future": {"preserve": [1, None, True]}}


@pytest.fixture
def saved(tmp_path, monkeypatch):
    models, profile = tmp_path / "tli_model_config.json", tmp_path / "tli_system_profile.json"
    models.write_text(json.dumps(MODELS), encoding="utf-8")
    profile.write_text(json.dumps(PROFILE), encoding="utf-8")
    monkeypatch.setattr(S, "MODEL_CONFIG_FILE", models)
    monkeypatch.setattr(S, "SYSTEM_PROFILE_FILE", profile)
    monkeypatch.setattr(S, "MODEL_CONFIG", deepcopy(MODELS["models"]))
    monkeypatch.setattr(S, "DEFAULT_MODEL_KEY", "deepseek")
    monkeypatch.setattr(S, "CURRENT_SYSTEM_PROFILE", "balanced")
    return SimpleNamespace(models=models, profile=profile, root=tmp_path)


def operation(kind, check=None):
    return S.save_default_model("new-model", "New model", check=check) if kind == "models" else S.save_profile("power", check=check)


def reading(kind, check=None):
    return S.read_model_settings(check=check) if kind == "models" else S.read_profile_settings(check=check)


def runtime():
    return deepcopy((S.MODEL_CONFIG, S.DEFAULT_MODEL_KEY, S.CURRENT_SYSTEM_PROFILE))


def denied(status=401):
    raise HTTPException(status, "Access stopped")


@pytest.mark.parametrize("kind", ["models", "profile"])
def test_metadata_preserved_and_confirmed_selection_published(saved, kind):
    original = json.loads(getattr(saved, kind).read_text())
    result = operation(kind)
    after = json.loads(getattr(saved, kind).read_text())
    assert result["ok"] is True
    if kind == "models":
        for key, row in original["models"].items():
            assert after["models"][key] == row
        assert after["metadata"] == original["metadata"]
        assert after["default_key"] == after["default_model_key"] == S.DEFAULT_MODEL_KEY
        assert after["models"][S.DEFAULT_MODEL_KEY]["id"] == "new-model"
        assert S.MODEL_CONFIG["llama"]["label"] == "llama"
    else:
        assert after == {**original, "profile": "power"}
        assert S.CURRENT_SYSTEM_PROFILE == "power"


def test_existing_id_reuses_preset_without_duplicate_and_preserves_metadata(saved):
    result = S.save_default_model("coding", "Revised code label")
    value = json.loads(saved.models.read_text())
    assert result["default_key"] == "qwen"
    assert len(value["models"]) == 3 and value["models"]["qwen"]["other"] is True
    assert value["models"]["qwen"]["label"] == "Revised code label"
    assert value["models"]["deepseek"] == MODELS["models"]["deepseek"]


def test_matching_duplicate_ids_prefer_current_key_without_removing_aliases(saved):
    value = deepcopy(MODELS)
    value["models"]["duplicate"] = {"id": "coding", "label": "Alias", "keep": 1}
    value["default_model_key"] = "duplicate"
    saved.models.write_text(json.dumps(value))
    result = S.save_default_model("coding")
    assert result["default_key"] == "duplicate"
    assert json.loads(saved.models.read_text())["models"] == value["models"]


def test_collision_safe_key_preserves_existing_record(saved):
    value = deepcopy(MODELS)
    base = "model-" + hashlib.sha256(b"new-model").hexdigest()[:12]
    value["models"][base] = {"id": "different", "keep": True}
    saved.models.write_text(json.dumps(value))
    result = S.save_default_model("new-model")
    assert result["default_key"] == base + "-1"
    assert json.loads(saved.models.read_text())["models"][base] == value["models"][base]


def test_full_presets_are_not_evicted_to_add_a_model(saved):
    value = {"models": {f"m{i}": {"id": f"model{i}"} for i in range(store.MAX_MODELS)}, "default_key": "m0"}
    saved.models.write_text(json.dumps(value))
    before, live = saved.models.read_bytes(), runtime()
    with pytest.raises(HTTPException) as caught:
        S.save_default_model("new-model")
    assert caught.value.status_code == 409
    assert saved.models.read_bytes() == before and runtime() == live
    assert S.save_default_model("model1")["default_key"] == "m1"


@pytest.mark.parametrize("kind", ["models", "profile"])
@pytest.mark.parametrize("raw", [b"", b"broken", b"[]", b"null", b"{}", b"\xff",
    b'{"profile":"balanced","profile":"power"}', b'{"metadata":NaN}',
    b'{"metadata":1e999}', b"x" * (store.MAX_BYTES + 1)],
    ids=["empty", "broken", "array", "null", "object", "utf8", "duplicate", "nan", "overflow", "oversized"])
def test_existing_damage_never_becomes_defaults_or_overwritten(saved, kind, raw):
    path = getattr(saved, kind)
    path.write_bytes(raw)
    live = runtime()
    for call in (lambda: reading(kind), lambda: operation(kind)):
        with pytest.raises(HTTPException) as caught:
            call()
        assert caught.value.status_code == 503
        assert caught.value.headers["Cache-Control"] == "no-store"
        assert path.read_bytes() == raw and runtime() == live


@pytest.mark.parametrize("mutation", [
    lambda v: v.update(default_key="qwen"),
    lambda v: v.update(default_model_key="missing"),
    lambda v: v["models"].update(broken={"label": "Missing ID"}),
    lambda v: v["models"].update(broken=None),
    lambda v: v["models"]["qwen"].update(id=""),
    lambda v: v["models"]["qwen"].update(label=[]),
    lambda v: v.update(models={}),
    lambda v: v.update(metadata={"invalid": "\ud800"}),
])
def test_partial_or_ambiguous_model_document_is_preserved(saved, mutation):
    value = deepcopy(MODELS)
    mutation(value)
    saved.models.write_text(json.dumps(value))
    before, live = saved.models.read_bytes(), runtime()
    with pytest.raises(HTTPException) as caught:
        S.save_default_model("new-model")
    assert caught.value.status_code == 503
    assert saved.models.read_bytes() == before and runtime() == live


@pytest.mark.parametrize("kind", ["models", "profile"])
def test_deleted_observed_file_is_not_recreated_or_defaulted(saved, kind):
    reading(kind)
    path = getattr(saved, kind)
    path.unlink()
    live = runtime()
    for call in (lambda: reading(kind), lambda: operation(kind)):
        with pytest.raises(HTTPException) as caught:
            call()
        assert caught.value.status_code == 503 and runtime() == live and not path.exists()


@pytest.mark.parametrize("kind", ["models", "profile"])
@pytest.mark.parametrize("value", ["", " ", "x" * 1025, "x\nsecret", "\ud800", None, 12],
                         ids=["empty", "space", "oversized", "control", "surrogate", "null", "number"])
def test_invalid_input_has_no_saved_or_runtime_effect(saved, kind, value):
    path = getattr(saved, kind)
    before, live = path.read_bytes(), runtime()
    with pytest.raises(HTTPException) as caught:
        (S.save_default_model(value) if kind == "models" else S.save_profile(value))
    assert caught.value.status_code == 400
    assert path.read_bytes() == before and runtime() == live


@pytest.mark.parametrize("kind", ["models", "profile"])
@pytest.mark.parametrize("status", [401, 403, 409, 503])
def test_access_denied_after_staging_does_not_replace_or_publish(saved, monkeypatch, kind, status):
    path = getattr(saved, kind)
    before, live, state = path.read_bytes(), runtime(), {"revoked": False}
    fsync = store.os.fsync
    def revoke(descriptor):
        fsync(descriptor)
        state["revoked"] = True
    monkeypatch.setattr(store.os, "fsync", revoke)
    def check():
        if state["revoked"]:
            denied(status)
    with pytest.raises(HTTPException) as caught:
        operation(kind, check)
    assert caught.value.status_code == status
    assert path.read_bytes() == before and runtime() == live
    assert str(path) not in store._UNCERTAIN
    assert not list(saved.root.glob(".tli-selection-*"))


@pytest.mark.parametrize("kind", ["models", "profile"])
@pytest.mark.parametrize("status", [401, 403, 409, 503])
def test_confirmed_commit_publishes_before_late_denial(saved, monkeypatch, kind, status):
    path, state = getattr(saved, kind), {"revoked": False}
    replace = store.os.replace
    def commit_then_revoke(source, target):
        replace(source, target)
        state["revoked"] = True
    monkeypatch.setattr(store.os, "replace", commit_then_revoke)
    def check():
        if state["revoked"]:
            denied(status)
    with pytest.raises(HTTPException) as caught:
        operation(kind, check)
    assert caught.value.status_code == status
    value = json.loads(path.read_text())
    if kind == "models":
        assert S.DEFAULT_MODEL_KEY == value["default_key"]
        assert S.MODEL_CONFIG[S.DEFAULT_MODEL_KEY]["id"] == "new-model"
    else:
        assert S.CURRENT_SYSTEM_PROFILE == value["profile"] == "power"
    assert str(path) not in store._UNCERTAIN


@pytest.mark.parametrize("kind", ["models", "profile"])
@pytest.mark.parametrize("landed", [False, True])
def test_replace_failure_is_uncertain_and_cannot_be_get_reconciled(saved, monkeypatch, kind, landed):
    path = getattr(saved, kind)
    before, live, replace = path.read_bytes(), runtime(), store.os.replace
    def fail(source, target):
        if landed:
            replace(source, target)
        raise OSError("synthetic replace uncertainty")
    monkeypatch.setattr(store.os, "replace", fail)
    with pytest.raises(HTTPException) as caught:
        operation(kind)
    assert caught.value.status_code == 503 and runtime() == live
    assert (path.read_bytes() != before) is landed
    assert str(path) in store._UNCERTAIN
    monkeypatch.setattr(store.os, "replace", replace)
    for call in (lambda: reading(kind), lambda: operation(kind)):
        with pytest.raises(HTTPException) as blocked:
            call()
        assert blocked.value.status_code == 503 and runtime() == live


@pytest.mark.parametrize("kind", ["models", "profile"])
@pytest.mark.parametrize("fault", ["damage", "gone", "valid-edit", "staged-damage", "fsync"])
def test_changes_and_faults_during_fsync_preserve_original_and_runtime(saved, monkeypatch, kind, fault):
    path = getattr(saved, kind)
    before, live, fsync = path.read_bytes(), runtime(), store.os.fsync
    expected = before
    def fail(descriptor):
        nonlocal expected
        fsync(descriptor)
        if fault == "damage":
            expected = b"damaged external bytes"
            path.write_bytes(expected)
        elif fault == "gone":
            path.unlink()
            expected = None
        elif fault == "valid-edit":
            value = json.loads(before)
            value["external"] = "retained"
            expected = json.dumps(value).encode()
            path.write_bytes(expected)
        elif fault == "staged-damage":
            next(saved.root.glob(".tli-selection-*")).write_bytes(b"same-inode corruption")
        else:
            raise OSError("synthetic fsync failure")
    monkeypatch.setattr(store.os, "fsync", fail)
    with pytest.raises(HTTPException) as caught:
        operation(kind)
    assert caught.value.status_code == (409 if fault == "valid-edit" else 503)
    assert (path.read_bytes() if path.exists() else None) == expected
    assert runtime() == live and str(path) not in store._UNCERTAIN
    assert not list(saved.root.glob(".tli-selection-*"))


@pytest.mark.parametrize("kind", ["models", "profile"])
def test_read_revocation_does_not_publish_changed_snapshot(saved, monkeypatch, kind):
    path = getattr(saved, kind)
    value = deepcopy(MODELS if kind == "models" else PROFILE)
    if kind == "models":
        value["default_model_key"] = "qwen"
    else:
        value["profile"] = "lite"
    path.write_text(json.dumps(value))
    live, original, state = runtime(), store._read_file, {"revoked": False}
    def read_then_revoke(*args):
        result = original(*args)
        state["revoked"] = True
        return result
    monkeypatch.setattr(store, "_read_file", read_then_revoke)
    def check():
        if state["revoked"]:
            denied()
    with pytest.raises(HTTPException) as caught:
        reading(kind, check)
    assert caught.value.status_code == 401 and runtime() == live


@pytest.mark.parametrize("kind", ["models", "profile"])
def test_unreadable_file_preserved(saved, monkeypatch, kind):
    path, live = getattr(saved, kind), runtime()
    before = path.read_bytes()
    monkeypatch.setattr(store, "_read_file", lambda *a: (_ for _ in ()).throw(PermissionError("private path")))
    with pytest.raises(HTTPException) as caught:
        operation(kind)
    assert caught.value.status_code == 503 and "private path" not in caught.value.detail
    assert path.read_bytes() == before and runtime() == live


@pytest.mark.parametrize("kind", ["models", "profile"])
@pytest.mark.parametrize("link", ["hard", "symbolic", "broken"])
def test_linked_leaf_is_never_read_or_replaced(saved, kind, link):
    path = getattr(saved, kind)
    original = path.read_bytes()
    target = saved.root / (kind + "-target")
    path.rename(target)
    try:
        if link == "hard":
            os.link(target, path)
        else:
            path.symlink_to(target if link == "symbolic" else saved.root / "missing")
    except OSError as error:
        pytest.skip(f"Host cannot create test link: {error}")
    for call in (lambda: reading(kind), lambda: operation(kind)):
        with pytest.raises(HTTPException) as caught:
            call()
        assert caught.value.status_code == 503 and target.read_bytes() == original


@pytest.mark.parametrize("where", ["leaf", "parent"])
def test_unknown_filesystem_identity_is_unavailable(saved, monkeypatch, where):
    original = Path.lstat
    target = saved.models if where == "leaf" else saved.root
    def unknown(path, *args, **kwargs):
        info = original(path, *args, **kwargs)
        if path == target:
            attrs = {name: getattr(info, name) for name in dir(info) if name.startswith("st_")}
            attrs["st_ino"] = 0
            return SimpleNamespace(**attrs)
        return info
    monkeypatch.setattr(Path, "lstat", unknown)
    before, live = saved.models.read_bytes(), runtime()
    with pytest.raises(HTTPException) as caught:
        S.save_default_model("new-model")
    assert caught.value.status_code == 503
    assert saved.models.read_bytes() == before and runtime() == live


def test_serialized_concurrent_additions_retain_every_preset(saved):
    choices = [f"new-{i}" for i in range(8)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(S.save_default_model, choices))
    document = json.loads(saved.models.read_text())
    assert len(document["models"]) == 11
    assert set(choices).issubset({row["id"] for row in document["models"].values()})
    assert len({item["default_key"] for item in results}) == 8
    assert S.DEFAULT_MODEL_KEY == document["default_key"]


def test_access_is_rechecked_after_waiting_for_store_lock(saved):
    entered, finished = Event(), Event()
    state = {"revoked": False}
    def check():
        entered.set()
        if state["revoked"]:
            denied()
    def request():
        try:
            return S.save_default_model("new-model", check=check)
        finally:
            finished.set()
    before, live = saved.models.read_bytes(), runtime()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with store.LOCK:
            pending = pool.submit(request)
            assert entered.wait(5) and not finished.is_set()
            state["revoked"] = True
        with pytest.raises(HTTPException) as caught:
            pending.result(timeout=5)
    assert caught.value.status_code == 401
    assert saved.models.read_bytes() == before and runtime() == live


@pytest.mark.parametrize("kind", ["models", "profile"])
def test_temporary_path_swap_after_original_reread_is_not_committed(saved, monkeypatch, kind):
    path = getattr(saved, kind)
    before, live, original, calls = path.read_bytes(), runtime(), store._snapshot, []
    swapped = saved.root / "retained-staging-copy"
    def snapshot(*args, **kwargs):
        result = original(*args, **kwargs)
        calls.append(True)
        if len(calls) == 2:
            temporary = next(saved.root.glob(".tli-selection-*"))
            temporary.rename(swapped)
            temporary.write_bytes(b"untrusted replacement")
        return result
    monkeypatch.setattr(store, "_snapshot", snapshot)
    with pytest.raises(HTTPException) as caught:
        operation(kind)
    assert caught.value.status_code == 503
    assert path.read_bytes() == before and runtime() == live
    assert swapped.exists()
    # Cleanup never deletes a different file that took the staging path.
    assert next(saved.root.glob(".tli-selection-*")).read_bytes() == b"untrusted replacement"


@pytest.mark.parametrize("kind", ["models", "profile"])
def test_storage_error_after_revocation_returns_original_denial(saved, monkeypatch, kind):
    path = getattr(saved, kind)
    before, live, state = path.read_bytes(), runtime(), {"revoked": False}
    def fail(*args):
        state["revoked"] = True
        raise PermissionError("private filesystem failure")
    monkeypatch.setattr(store, "_read_file", fail)
    def check():
        if state["revoked"]:
            denied(401)
    with pytest.raises(HTTPException) as caught:
        operation(kind, check)
    assert caught.value.status_code == 401 and caught.value.detail == "Access stopped"
    assert path.read_bytes() == before and runtime() == live


@pytest.mark.parametrize("kind", ["models", "profile"])
def test_symlinked_parent_is_not_followed(saved, monkeypatch, kind):
    alias = saved.root / "alias"
    real = saved.root / "real"
    real.mkdir()
    target = real / "settings.json"
    target.write_bytes(getattr(saved, kind).read_bytes())
    try:
        alias.symlink_to(real, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"Host cannot create test directory link: {error}")
    monkeypatch.setattr(S, "MODEL_CONFIG_FILE" if kind == "models" else "SYSTEM_PROFILE_FILE", alias / "settings.json")
    before, live = target.read_bytes(), runtime()
    for call in (lambda: reading(kind), lambda: operation(kind)):
        with pytest.raises(HTTPException) as caught:
            call()
        assert caught.value.status_code == 503
        assert target.read_bytes() == before and runtime() == live


@pytest.mark.parametrize("kind", ["models", "profile"])
def test_returned_projection_cannot_mutate_runtime_or_file(saved, kind):
    path = getattr(saved, kind)
    before = path.read_bytes()
    value = reading(kind)
    live = runtime()
    if kind == "models":
        value["models"]["deepseek"]["future"]["keep"].append("outside mutation")
        value["default_key"] = "qwen"
    else:
        value["profiles"]["balanced"]["ui_defaults"]["temp"] = "changed"
        value["limits"]["max_concurrent_jobs"] = 900
    assert runtime() == live and path.read_bytes() == before
    if kind == "profile":
        assert S.SYSTEM_PROFILES["balanced"]["ui_defaults"]["temp"] == "0.7"
        assert S.SYSTEM_PROFILE_LIMITS["balanced"]["max_concurrent_jobs"] == 2


def test_compatibility_writers_preserve_saved_fields(saved):
    S.MODEL_CONFIG = {"qwen": {"id": "coding", "label": "New code label"}}
    S.DEFAULT_MODEL_KEY = "qwen"
    S.save_model_config_to_disk()
    value = json.loads(saved.models.read_text())
    assert set(value["models"]) == set(MODELS["models"])
    assert value["models"]["qwen"]["other"] is True
    assert value["metadata"] == MODELS["metadata"]
    S.CURRENT_SYSTEM_PROFILE = "lite"
    S.save_system_profile_to_disk()
    assert json.loads(saved.profile.read_text()) == {**PROFILE, "profile": "lite"}
