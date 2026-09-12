"""Independent synthetic regression proofs; no host scans or child processes."""
from types import SimpleNamespace
from pathlib import Path
import time

import pytest
from fastapi import HTTPException

import storage_jobs as jobs


@pytest.fixture
def isolated_jobs(monkeypatch):
    monkeypatch.setattr(jobs, "_jobs", {})
    monkeypatch.setattr(jobs, "_requests", {})
    monkeypatch.setattr(jobs, "_active", None)
    import event_bus
    monkeypatch.setattr(event_bus, "emit_event", lambda *args, **kwargs: None)
    queued = []
    class DeferredThread:
        def __init__(self, *, target, args=(), **kwargs):
            self.target, self.args = target, args
        def start(self): queued.append((self.target, self.args))
    monkeypatch.setattr(jobs.threading, "Thread", DeferredThread)
    monkeypatch.setattr(jobs.process, "run", lambda *args, **kwargs: pytest.fail("No worker may start in this proof"))
    return queued


def test_revoked_bearer_cache_entry_cannot_break_another_valid_session(isolated_jobs, monkeypatch):
    import companion_auth
    monkeypatch.setattr(companion_auth, "credential_owner", lambda token: (_ for _ in ()).throw(HTTPException(401, "Revoked")))
    monkeypatch.setattr(jobs.S, "load_pin_config", lambda: {"enabled": False})
    old = jobs.Access("previous-owner", "bearer", "revoked-synthetic-token")
    jobs._jobs["old"] = {"id":"old", "access":old, "expiry":time.time()+1000}
    current = jobs.Access("local", "local", "")
    # _get/_prune is shared by status/start/results. An unrelated old revoked
    # device must be pruned, not return its authentication failure to this user.
    result = jobs.start(current, {"request_id":"new", "operation":"scan", "path":"C:/synthetic", "profile":"quick"})
    assert result["ok"] is True and "old" not in jobs._jobs
    assert len(isolated_jobs) == 1


def test_revocation_while_queued_releases_admission_without_claiming_unstopped_child(isolated_jobs, monkeypatch):
    import companion_auth
    alive = True
    def owner(token):
        if not alive: raise HTTPException(401, "Revoked while queued")
        return "alice"
    monkeypatch.setattr(companion_auth, "credential_owner", owner)
    credential = jobs.Access("alice", "bearer", "synthetic-token")
    result = jobs.start(credential, {"request_id":"queued", "operation":"scan", "path":"C:/synthetic", "profile":"quick"})
    ident = result["job"]["id"]
    alive = False
    fn, args = isolated_jobs.pop(); fn(*args)
    finished = jobs._jobs[ident]
    assert finished["status"] == "cancelled"
    assert finished["worker_stopped"] is True and finished["done"].is_set()
    assert jobs._active is None
    monkeypatch.setattr(jobs.S, "load_pin_config", lambda: {"enabled":False})
    next_job = jobs.start(jobs.Access("local", "local", ""), {"request_id":"next", "operation":"scan", "path":"C:/synthetic", "profile":"quick"})
    assert next_job["ok"] and len(isolated_jobs)==1


@pytest.mark.parametrize("failure", ["file_stat", "folder_scandir", "depth_limit"])
def test_unreadable_and_unvisited_entries_have_unknown_size_not_empty_file_claim(tmp_path, monkeypatch, failure):
    import storage_scan_algorithms as algorithms
    monkeypatch.setattr(algorithms, "CONTROL", None)
    monkeypatch.setattr(algorithms, "is_protected", lambda path: False)
    root = tmp_path / "synthetic-root"; root.mkdir()
    original = algorithms.os.scandir
    if failure == "file_stat":
        item = root / "unreadable.bin"; item.write_bytes(b"synthetic")
        class Entry:
            name = item.name
            path = str(item)
            def is_symlink(self): return False
            def is_dir(self, **kwargs): return False
            def stat(self, **kwargs): raise PermissionError("Synthetic denied stat")
        class Iterator:
            def __iter__(self): return iter([Entry()])
            def close(self): pass
        monkeypatch.setattr(algorithms.os, "scandir", lambda path: Iterator() if Path(path) == root else original(path))
    else:
        item = root / "unreadable-folder"; item.mkdir()
        if failure == "folder_scandir":
            def blocked(path):
                if Path(path) == item: raise PermissionError("Synthetic denied enumeration")
                return original(path)
            monkeypatch.setattr(algorithms.os, "scandir", blocked)
    tree, largest, meta = algorithms._scan_tree(root, max_depth=0 if failure == "depth_limit" else 4)
    assert len(tree["children"]) == 1
    row = tree["children"][0]
    assert row["size"] == 0  # Legacy numeric lower bound remains readable.
    assert row["size_known"] is False and row["size_partial"] is True
    assert row["size_reason"] in {"unreadable", "depth_limit"}
    assert tree["size_partial"] is True and meta["partial"] is True and largest == []
    if failure != "file_stat":
        assert meta["folder_summary"][0]["size_known"] is False
        assert meta["folder_summary"][0]["size_partial"] is True
