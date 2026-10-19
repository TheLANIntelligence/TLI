"""Saved selection startup/consumer compatibility using temporary state only."""
import copy
import json

import pytest
from fastapi import HTTPException

import tli_state as S
from routers.chat_routes import choose_model


@pytest.fixture
def saved(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "MODEL_CONFIG_FILE", tmp_path / "tli_model_config.json")
    monkeypatch.setattr(S, "SYSTEM_PROFILE_FILE", tmp_path / "tli_system_profile.json")
    monkeypatch.setattr(S, "MODEL_CONFIG", {"sentinel": {"id": "last-confirmed", "label": "Last confirmed"}})
    monkeypatch.setattr(S, "DEFAULT_MODEL_KEY", "sentinel")
    monkeypatch.setattr(S, "CURRENT_SYSTEM_PROFILE", "lite")
    monkeypatch.setattr(S, "log_debug", lambda *args, **kwargs: None)
    return tmp_path


def test_genuinely_missing_startup_uses_builtin_defaults_without_creating_files(saved):
    S.load_model_config_from_disk()
    S.load_system_profile_from_disk()
    assert S.DEFAULT_MODEL_KEY == "deepseek"
    assert S.MODEL_CONFIG["deepseek"]["id"] == "deepseek-r1-distill-llama-8b"
    assert S.CURRENT_SYSTEM_PROFILE == "balanced"
    assert list(saved.iterdir()) == []


@pytest.mark.parametrize("raw", [b"{broken", b"{}", b"[]", b'{"models":{},"default_key":"x"}',
    b'{"models":{"x":{"id":"model"}},"default_key":"absent"}',
    b'{"models":{"x":{"id":"model"}},"default_key":"x","default_key":"x"}'],
    ids=["broken", "empty", "list", "empty-catalog", "unknown-default", "duplicate-key"])
def test_damaged_model_startup_preserves_file_and_last_confirmed_runtime(saved, raw):
    S.MODEL_CONFIG_FILE.write_bytes(raw)
    before = S.MODEL_CONFIG
    with pytest.raises(HTTPException) as caught:
        S.load_model_config_from_disk()
    assert caught.value.status_code == 503
    assert "Saved model or performance-profile settings are unavailable" in caught.value.detail
    assert S.MODEL_CONFIG_FILE.read_bytes() == raw
    assert S.MODEL_CONFIG is before and S.DEFAULT_MODEL_KEY == "sentinel"


@pytest.mark.parametrize("raw", [b"{broken", b"{}", b"[]", b'{"profile":"future"}',
                               b'{"profile":"power","profile":"lite"}'],
                         ids=["broken", "empty", "list", "unknown", "duplicate-key"])
def test_damaged_profile_startup_preserves_file_and_last_confirmed_runtime(saved, raw):
    S.SYSTEM_PROFILE_FILE.write_bytes(raw)
    with pytest.raises(HTTPException) as caught:
        S.load_system_profile_from_disk()
    assert caught.value.status_code == 503
    assert "Saved model or performance-profile settings are unavailable" in caught.value.detail
    assert S.SYSTEM_PROFILE_FILE.read_bytes() == raw
    assert S.CURRENT_SYSTEM_PROFILE == "lite"


def test_legacy_selection_alias_and_missing_labels_remain_usable_without_rewriting(saved):
    document = {"default_model_key": "custom", "future": {"retain": True}, "models": {
        "deepseek": {"id": "reasoning-model", "label": "Reasoning", "extra": {"retain": 1}},
        "qwen": {"id": "coding-model", "label": None},
        "custom": {"id": "chosen-model"},
    }}
    raw = json.dumps(document).encode()
    S.MODEL_CONFIG_FILE.write_bytes(raw)
    S.load_model_config_from_disk()
    assert S.DEFAULT_MODEL_KEY == "custom"
    assert choose_model("custom", "Hello")["id"] == "chosen-model"
    assert choose_model("QWEN", "Write code")["id"] == "coding-model"
    assert choose_model("reasoning", "Think carefully")["id"] == "reasoning-model"
    assert choose_model(None, "Hello")["id"] == "chosen-model"
    assert all(isinstance(record["label"], str) and record["label"] for record in S.MODEL_CONFIG.values())
    assert S.MODEL_CONFIG_FILE.read_bytes() == raw


def test_confirmed_saved_selection_survives_fresh_runtime_loading(saved, monkeypatch):
    S.load_model_config_from_disk()
    initial = copy.deepcopy(S.MODEL_CONFIG)
    result = S.save_default_model("new-model", "New model")
    S.save_profile("power")
    before_model, before_profile = S.MODEL_CONFIG_FILE.read_bytes(), S.SYSTEM_PROFILE_FILE.read_bytes()
    monkeypatch.setattr(S, "MODEL_CONFIG", {"other": {"id": "other", "label": "Other"}})
    monkeypatch.setattr(S, "DEFAULT_MODEL_KEY", "other")
    monkeypatch.setattr(S, "CURRENT_SYSTEM_PROFILE", "lite")
    S.load_model_config_from_disk()
    S.load_system_profile_from_disk()
    assert S.DEFAULT_MODEL_KEY == result["default_key"]
    assert choose_model(S.DEFAULT_MODEL_KEY, "Hello")["id"] == "new-model"
    assert S.MODEL_CONFIG["deepseek"] == initial["deepseek"]
    assert S.CURRENT_SYSTEM_PROFILE == "power"
    assert S.get_active_system_limits() == S.SYSTEM_PROFILE_LIMITS["power"]
    assert S.MODEL_CONFIG_FILE.read_bytes() == before_model
    assert S.SYSTEM_PROFILE_FILE.read_bytes() == before_profile


def test_private_selection_projection_is_detached_from_running_and_saved_settings(saved):
    S.save_default_model("chosen-model", "Chosen")
    selection = S.read_model_settings()
    before = S.MODEL_CONFIG_FILE.read_bytes()
    selection["models"][selection["default_key"]]["id"] = "tampered-view"
    assert S.MODEL_CONFIG[S.DEFAULT_MODEL_KEY]["id"] == "chosen-model"
    assert S.MODEL_CONFIG_FILE.read_bytes() == before


def test_profile_projection_is_detached_from_builtin_profiles_and_limits(saved):
    S.save_profile("power")
    value = S.read_profile_settings()
    value["profiles"]["power"]["label"] = "tampered-view"
    value["limits"]["max_concurrent_jobs"] = 999
    assert S.SYSTEM_PROFILES["power"]["label"] == "Power (big hardware)"
    assert S.get_active_system_limits()["max_concurrent_jobs"] == 4
