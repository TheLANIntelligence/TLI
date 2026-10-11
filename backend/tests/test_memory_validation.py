"""Current readers and read-only recovery checks share persisted note validation."""
import copy
import json
from pathlib import Path

import pytest

import tli_state as S
from intelligence import backups, data_health
from memory_validation import validate_memory_structure


SOURCE = {"conversation_id": "synthetic-chat", "message_index": 0, "revision": "a" * 64, "role": "assistant"}


@pytest.mark.parametrize("source", [
    None, {}, [], {**SOURCE, "message_index": True}, {**SOURCE, "message_index": -1},
    {**SOURCE, "message_index": 1000001}, {**SOURCE, "revision": "wrong"},
    {**SOURCE, "conversation_id": ""}, {**SOURCE, "role": "system"},
    {**SOURCE, "model": ""}, {**SOURCE, "provider": 1}, {**SOURCE, "unknown": "field"},
])
def test_unopenable_saved_chat_source_is_rejected_by_every_reader(source, tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    value = {"facts": [{"id": "synthetic-note", "text": "Synthetic saved preference", "chat_source": source}]}
    path = Path(S.memory_path_for_user("fixture"))
    path.write_text(json.dumps(value))
    before = path.read_bytes(), path.stat().st_mtime_ns
    with pytest.raises(ValueError, match="saved chat source"):
        validate_memory_structure(value)
    with pytest.raises(ValueError, match="saved chat source"):
        data_health._valid(value, "notebook", "fixture")
    with pytest.raises(ValueError, match="saved chat source"):
        backups._validate_data("notebook", value, "fixture")
    with pytest.raises(Exception, match="Notebook"):
        S.load_memory("fixture", strict=True)
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before


@pytest.mark.parametrize("value", [
    {"facts": [], "last_updated": None},
    {"facts": ["Legacy preference", "Legacy fix"], "last_updated": "2025-04-02"},
    {"facts": [{"text": "Minimal existing note"}]},
    {"facts": [{"id": "note", "text": "Retained note", "deleted": True, "device_id": None}]},
    {"facts": [{"text": "Saved answer", "chat_source": SOURCE}]},
    {"facts": [{"text": "Saved answer", "chat_source": {**SOURCE, "created_at": "2026-09-07T00:00:00Z", "model": "fixture", "provider": "bundled"}}]},
])
def test_legacy_and_current_formats_stay_accepted_and_unchanged(value, tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    original = copy.deepcopy(value)
    path = Path(S.memory_path_for_user("fixture"))
    path.write_text(json.dumps(value))
    before = path.read_bytes(), path.stat().st_mtime_ns
    validate_memory_structure(value)
    assert data_health._valid(value, "notebook", "fixture") is bool(value["facts"])
    assert backups._validate_data("notebook", value, "fixture") == len(value["facts"])
    reopened = S.load_memory("fixture", strict=True)
    assert len(reopened["facts"]) == len(value["facts"])
    if value["facts"] and isinstance(value["facts"][0], dict) and "chat_source" in value["facts"][0]:
        assert reopened["facts"][0]["chat_source"] == value["facts"][0]["chat_source"]
    assert value == original and (path.read_bytes(), path.stat().st_mtime_ns) == before
