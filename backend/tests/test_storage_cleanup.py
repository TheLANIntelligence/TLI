from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading

import pytest
from fastapi import HTTPException
import tli_state as S
import storage_cleanup as cleanup
from intelligence.store import private_path
from routers import file_routes


@pytest.fixture(autouse=True)
def isolated_cleanup(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(S, "BASE_DIR", str(tmp_path / "install"))
    monkeypatch.setattr(S, "DATA_DIR", str(data))
    monkeypatch.setattr(file_routes, "_safe_delete_roots", lambda: [home])
    monkeypatch.setattr(cleanup, "_plans", {})
    calls = []
    trash = tmp_path / "fake-trash"
    trash.mkdir()
    def fake_trash(raw):
        path = Path(raw).resolve()
        assert path.is_relative_to(home.resolve())
        calls.append(path)
        # Only test-created files move, entirely within this disposable test root.
        target = (trash / f"{len(calls)}-{path.name}").resolve()
        assert target.is_relative_to(tmp_path.resolve())
        path.rename(target)
    monkeypatch.setattr(file_routes, "send2trash", fake_trash)
    return home, calls


def create(home, name, content=b"example contents"):
    path = home / name
    path.write_bytes(content)
    return str(path)


def plan(paths, user="alice", keep=None):
    return cleanup.preview(user, [{"path": path, "keep_path": keep} for path in paths])


def test_review_is_read_only_and_execute_replay_moves_once(isolated_cleanup):
    home, calls = isolated_cleanup
    paths = [create(home, "one"), create(home, "two")]
    review = plan(paths)
    assert review["can_execute"] and len(review["items"]) == 2 and not calls
    result = cleanup.execute("alice", review["preview_id"])
    assert result["ok"] and result["moved"] == 2 and result["freed_bytes"] is None
    assert all(r["status"] == "trashed" for r in result["results"])
    assert cleanup.execute("alice", review["preview_id"]) == result
    assert len(calls) == 2
    assert paths[0] not in private_path("alice", "cleanup-receipts").read_text()


@pytest.mark.parametrize("invalid", ["folder", "outside", "install", "missing", "traversal", "relative"])
def test_later_invalid_file_rejects_entire_batch(isolated_cleanup, tmp_path, invalid):
    home, calls = isolated_cleanup
    valid = create(home, "keep-me")
    if invalid == "folder":
        target = home / "folder"; target.mkdir()
    elif invalid == "install":
        target = Path(S.BASE_DIR) / "application.py"; target.parent.mkdir(); target.write_text("protected")
    elif invalid == "outside":
        target = tmp_path / "outside"; target.write_text("restricted")
    elif invalid == "traversal": target = home / ".." / "home" / "keep-me"
    elif invalid == "relative": target = Path("keep-me")
    else: target = home / "missing"
    review = plan([valid, str(target)])
    assert not review["can_execute"] and not review["items"][1]["eligible"]
    result = cleanup.execute("alice", review["preview_id"])
    assert not result["ok"] and not calls and Path(valid).exists()


def test_unavailable_trash_and_protected_path_are_blocked(isolated_cleanup, monkeypatch):
    home, calls = isolated_cleanup
    path = create(home, "file")
    monkeypatch.setattr(file_routes, "send2trash", None)
    assert "Trash is unavailable" in plan([path])["items"][0]["reason"]
    monkeypatch.setattr(file_routes, "_is_protected_path", lambda p: "Protected application file")
    assert "Protected" in plan([path])["items"][0]["reason"]
    assert not calls


def test_changed_later_file_aborts_before_any_moves(isolated_cleanup):
    home, calls = isolated_cleanup
    paths = [create(home, "one"), create(home, "two")]
    review = plan(paths)
    Path(paths[1]).write_bytes(b"changed contents after preview")
    result = cleanup.execute("alice", review["preview_id"])
    assert not calls and result["moved"] == 0
    assert "changed" in result["results"][1]["reason"]


def test_duplicate_keep_copy_is_verified_and_never_selected(isolated_cleanup):
    home, calls = isolated_cleanup
    a, b, c = [create(home, name, b"same" * 4096) for name in ("a", "b", "c")]
    review = plan([a, b], keep=c)
    assert review["can_execute"]
    result = cleanup.execute("alice", review["preview_id"])
    assert result["ok"] and Path(c).exists() and len(calls) == 2


@pytest.mark.parametrize("problem", ["selected", "different", "missing", "changed_after_review"])
def test_duplicate_failures_never_move_any_file(isolated_cleanup, problem):
    home, calls = isolated_cleanup
    a, b = create(home, "a"), create(home, "b")
    if problem == "different": Path(b).write_bytes(b"different bytes!")
    if problem == "missing": Path(b).unlink()
    review = plan([a, b] if problem == "selected" else [a], keep=b)
    if problem == "changed_after_review": Path(b).write_bytes(b"modified after review")
    result = cleanup.execute("alice", review["preview_id"])
    assert not result["ok"] and not calls and Path(a).exists()


def test_hash_timeout_never_allows_unverified_duplicates(isolated_cleanup, monkeypatch):
    home, calls = isolated_cleanup
    a, b = create(home, "a"), create(home, "b")
    monkeypatch.setattr(cleanup, "_hash_duplicate_file", lambda *args: (_ for _ in ()).throw(TimeoutError("Verification time limit")))
    review = plan([a], keep=b)
    assert not review["can_execute"] and not calls


def test_hardlinks_and_link_ancestors_are_not_trash_candidates(isolated_cleanup, monkeypatch):
    home, _ = isolated_cleanup
    path = create(home, "one")
    (home / "two").hardlink_to(path)
    assert "Hard-linked" in plan([path])["items"][0]["reason"]
    from types import SimpleNamespace
    original = Path.lstat
    def reparse(p):
        if p == home:
            return SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
        return original(p)
    monkeypatch.setattr(Path, "lstat", reparse)
    assert "junctions" in plan([path])["items"][0]["reason"]


def test_unexpected_failure_reports_partial_and_stops(isolated_cleanup, monkeypatch):
    home, calls = isolated_cleanup
    paths = [create(home, str(n)) for n in range(3)]
    move = file_routes.send2trash
    def fail_second(path):
        if path == paths[1]: raise PermissionError("File is in use")
        move(path)
    monkeypatch.setattr(file_routes, "send2trash", fail_second)
    review = plan(paths)
    result = cleanup.execute("alice", review["preview_id"])
    assert result["status"] == "partial" and result["moved"] == 1 and not result["ok"]
    assert [r["status"] for r in result["results"]] == ["trashed", "failed", "not_attempted"]
    assert len(calls) == 1 and Path(paths[2]).exists()


def test_keeper_changed_during_earlier_move_stops_duplicates(isolated_cleanup, monkeypatch):
    home, calls = isolated_cleanup
    a, b, keep = [create(home, name) for name in ("a", "b", "keep")]
    move = file_routes.send2trash
    def mutate(path):
        move(path)
        Path(keep).write_bytes(b"changed during move")
    monkeypatch.setattr(file_routes, "send2trash", mutate)
    result = cleanup.execute("alice", plan([a, b], keep=keep)["preview_id"])
    assert result["moved"] == 1 and result["status"] == "partial" and Path(b).exists()


def test_trash_exception_after_move_is_unknown_not_false_success(isolated_cleanup, monkeypatch):
    home, calls = isolated_cleanup
    path = create(home, "file")
    move = file_routes.send2trash
    def uncertain(path): move(path); raise OSError("Lost operation result")
    monkeypatch.setattr(file_routes, "send2trash", uncertain)
    result = cleanup.execute("alice", plan([path])["preview_id"])
    assert not result["ok"] and result["results"][0]["status"] == "unknown" and len(calls) == 1
    assert "unconfirmed" in result["summary"]


def test_replacement_at_original_path_after_move_is_not_offered_as_failed_original(isolated_cleanup, monkeypatch):
    home, calls = isolated_cleanup
    path = create(home, "file")
    move = file_routes.send2trash
    def replaced(path):
        move(path)
        Path(path).write_bytes(b"new unrelated file")
    monkeypatch.setattr(file_routes, "send2trash", replaced)
    result = cleanup.execute("alice", plan([path])["preview_id"])
    assert result["results"][0]["status"] == "unknown" and len(calls) == 1


def test_receipt_must_be_writable_before_trash(isolated_cleanup, monkeypatch):
    home, calls = isolated_cleanup
    monkeypatch.setattr(cleanup, "_persist", lambda *args: (_ for _ in ()).throw(OSError("disk full")))
    result = cleanup.execute("alice", plan([create(home, "file")])["preview_id"])
    assert not result["ok"] and result["receipt_warning"] and not calls


def test_duplicate_requests_and_overlapping_plans_are_serialized(isolated_cleanup, monkeypatch):
    home, calls = isolated_cleanup
    p1, p2 = [plan([create(home, name)]) for name in ("one", "two")]
    entered, release = threading.Event(), threading.Event()
    move = file_routes.send2trash
    monkeypatch.setattr(file_routes, "send2trash", lambda p: entered.set() or release.wait(3) and move(p))
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(cleanup.execute, "alice", p1["preview_id"])
        assert entered.wait(2)
        try:
            for ident in (p1["preview_id"], p2["preview_id"]):
                with pytest.raises(HTTPException) as error: cleanup.execute("alice", ident)
                assert error.value.status_code == 409
        finally: release.set()
        assert future.result()["ok"]
    assert len(calls) == 1


def test_expired_and_other_user_reviews_never_execute(isolated_cleanup, monkeypatch):
    home, calls = isolated_cleanup
    review = plan([create(home, "file")])
    with pytest.raises(HTTPException) as error: cleanup.execute("bob", review["preview_id"])
    assert error.value.status_code == 404
    monkeypatch.setattr(cleanup.time, "time", lambda: review["expires_at"] + 1)
    with pytest.raises(HTTPException) as error: cleanup.execute("alice", review["preview_id"])
    assert error.value.status_code == 410 and not calls


def test_restart_replay_returns_receipt_without_another_move(isolated_cleanup, monkeypatch):
    home, calls = isolated_cleanup
    review = plan([create(home, "file")])
    result = cleanup.execute("alice", review["preview_id"])
    monkeypatch.setattr(cleanup, "_plans", {})
    assert cleanup.execute("alice", review["preview_id"]) == result and len(calls) == 1
    assert cleanup.history("bob") == []


def test_interrupted_receipt_marks_unfinished_outcomes_unknown():
    cleanup._persist("alice", {"id":"x", "status":"running", "ok":False, "results":[{"status":"pending"}]})
    result = cleanup.receipt("alice", "x")
    assert result["status"] == "interrupted" and result["results"][0]["status"] == "unknown"


def test_api_auth_limits_and_no_permanent_option(client, authed_client, isolated_cleanup, monkeypatch):
    home, calls = isolated_cleanup
    path = create(home, "file")
    import companion_auth
    monkeypatch.setattr(companion_auth, 'resolve_user', lambda *args, **kwargs: 'test-user')
    assert authed_client.post('/visualizer/cleanup/preview', json={"files":[{"path":path}], "permanent":True}).status_code == 422
    assert authed_client.post('/visualizer/cleanup/preview', json={"files":[{"path":path}]*101}).status_code == 422
    assert authed_client.post('/visualizer/cleanup/preview', json={"files":[]}).status_code == 422
    result = authed_client.post('/visualizer/cleanup/preview', json={"files":[{"path":path}]}).json()
    assert result['can_execute'] and not calls


def test_every_cleanup_endpoint_requires_session(client, monkeypatch):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled":True})
    for method, url, body in [('post','preview',{"files":[{"path":"C:\\test"}]}),
                             ('post','execute',{"preview_id":"a"*32}), ('get','receipts',None), ('get','receipt/'+'a'*32,None)]:
        response = getattr(client, method)('/visualizer/cleanup/'+url, **({'json':body} if body else {}))
        assert response.status_code == 401


@pytest.mark.parametrize('stage', ['preflight', 'journal', 'after_first_move'])
def test_revocation_stops_subsequent_dispatch_with_truthful_journal(isolated_cleanup, monkeypatch, stage):
    home, calls = isolated_cleanup
    paths = [create(home, 'session-one'), create(home, 'session-two')]
    alive = True
    def access():
        if not alive:
            raise HTTPException(401, 'Reviewed session locked')
    review = cleanup.preview('alice', [{'path': p} for p in paths], access_check=access, session_key='browser-a')
    persist, inspect, move = cleanup._persist, cleanup._inspect, file_routes.send2trash
    saved = []
    def journal(user, result):
        nonlocal alive
        saved.append(__import__('copy').deepcopy(result))
        persist(user, result)
        if stage == 'journal' and any(r['status'] == 'attempting' for r in result['results']):
            alive = False
    def inspect_then_lock(raw, **kw):
        nonlocal alive
        result = inspect(raw, **kw)
        if stage == 'preflight': alive = False
        return result
    def move_then_lock(raw):
        nonlocal alive
        assert saved[-1]['results'][0]['status'] == 'attempting'
        move(raw)
        if stage == 'after_first_move': alive = False
    monkeypatch.setattr(cleanup, '_persist', journal)
    monkeypatch.setattr(cleanup, '_inspect', inspect_then_lock)
    monkeypatch.setattr(file_routes, 'send2trash', move_then_lock)
    result = cleanup.execute('alice', review['preview_id'], access_check=access, session_key='browser-a')
    expected = ['trashed', 'not_attempted'] if stage == 'after_first_move' else ['not_attempted', 'not_attempted']
    assert [r['status'] for r in result['results']] == expected
    assert len(calls) == (1 if stage == 'after_first_move' else 0)
    assert result['freed_bytes'] is None and Path(paths[1]).exists()
    assert cleanup.receipt('alice', review['preview_id']) == result


def test_review_bound_to_original_browser_even_for_same_owner(isolated_cleanup):
    home, calls = isolated_cleanup
    review = cleanup.preview('alice', [{'path': create(home, 'same-owner')}], session_key='browser-a')
    with pytest.raises(HTTPException) as error:
        cleanup.execute('alice', review['preview_id'], session_key='browser-b')
    assert error.value.status_code == 409 and not calls


def test_recorded_unknown_path_cannot_be_reviewed_or_replayed_after_restart(isolated_cleanup, monkeypatch):
    home, calls = isolated_cleanup
    path = create(home, 'unknown-original')
    # A historical uncertain attempt can coexist with a now-present path. Its
    # content/identity does not prove whether the prior operation succeeded.
    cleanup._persist('alice', {'id':'old', 'status':'failed', 'results':[{'path':path,'status':'unknown'}]})
    review = plan([path])
    assert not review['can_execute'] and 'unconfirmed' in review['items'][0]['reason']
    result = cleanup.execute('alice', review['preview_id'])
    assert result['results'][0]['status'] == 'not_attempted' and not calls
    other = plan([create(home, 'unrelated')])
    assert other['can_execute']
    assert plan([path], user='bob')['can_execute']  # Receipt ownership remains separate.


def test_new_journal_distinguishes_unstarted_from_uncertain_without_rewriting_bytes():
    cleanup._persist('alice', {'id':'journal', 'status':'running', 'journal_version':2, 'results':[
        {'path':'first', 'status':'attempting'}, {'path':'second','status':'pending'}]})
    source = private_path('alice','cleanup-receipts'); before = source.read_bytes()
    result = cleanup.receipt('alice','journal')
    assert [r['status'] for r in result['results']] == ['unknown','not_attempted']
    assert source.read_bytes() == before


def test_history_bound_keeps_unresolved_attempts_when_recent_receipts_rotate():
    cleanup._persist('alice', {'id':'uncertain','status':'failed','results':[{'path':'a','status':'unknown'}]})
    for index in range(23):
        cleanup._persist('alice', {'id':str(index),'status':'completed','results':[]})
    results = cleanup.history('alice')
    assert len(results) == 20 and any(r['id']=='uncertain' for r in results)


def test_real_request_callback_rejects_revocation_even_when_pin_is_disabled(monkeypatch):
    from starlette.requests import Request
    from routers.visualizer import _cleanup_access
    monkeypatch.setattr(S, '_active_sessions', {})
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled':False})
    token = S.create_session_token('alice')
    request = Request({'type':'http','method':'POST','scheme':'https','path':'/visualizer/cleanup/execute',
                       'headers':[(b'cookie',f'tli_session={token}'.encode())], 'server':('testserver',443)})
    check, key = _cleanup_access(request,'alice')
    check()
    S._active_sessions.pop(token)
    with pytest.raises(HTTPException) as error: check()
    assert error.value.status_code == 401 and len(key)==64 and token not in key


def test_legacy_endpoints_never_probe_move_or_scan(authed_client, monkeypatch):
    from routers import cleanup_routes
    from cleanup import executor
    monkeypatch.setattr(file_routes, 'send2trash', lambda *a: pytest.fail('No Trash operation'))
    monkeypatch.setattr(file_routes, '_is_protected_path', lambda *a: pytest.fail('No path probe'))
    monkeypatch.setattr(executor, 'execute_clean_safe', lambda *a, **k: pytest.fail('No quarantine operation'))
    for url, body in [('/visualizer/delete', {'path':'C:\\private-file','permanent':True}),('/cleanup/clean_safe',{})]:
        response = authed_client.post(url, json=body)
        assert response.status_code == 409 and response.json()['detail']['code']=='review_required'
    monkeypatch.setattr(cleanup_routes.threading, 'Thread', lambda *a, **k: pytest.fail('No scan thread'))
    monkeypatch.setattr(cleanup_routes.threading, 'Timer', lambda *a, **k: pytest.fail('No scan timer'))
    for fn in (cleanup_routes.start_cleanup_scanner,cleanup_routes.trigger_scan_async,cleanup_routes._tick,cleanup_routes._do_scan): fn()
    assert authed_client.get('/cleanup/scan').json()['scanning'] is False


def test_legacy_quarantine_receipt_is_read_only_and_space_claim_unverified(authed_client, tmp_path):
    import json
    folder=Path(S.DATA_DIR)/'cleanup_quarantine'/'saved';folder.mkdir(parents=True)
    source=folder/'receipt.json';source.write_text(json.dumps({'session':'saved','gb_reclaimed':3,'files_moved':2}))
    before=source.read_bytes()
    result=authed_client.get('/cleanup/receipts').json()['sessions'][0]
    assert result['gb_reclaimed']==3 and result['freed_bytes'] is None and result['verified'] is False
    assert 'not verified' in result['space_note'] and source.read_bytes()==before


def test_saved_storage_history_blocks_missing_memory_key_recreation(tmp_path, monkeypatch):
    from data_protection import KeyUnavailableError
    data=Path(S.DATA_DIR);store=data/'intelligence'/'storage_history-test.json';store.parent.mkdir(parents=True,exist_ok=True)
    store.write_text('enc:unreadable-old-ciphertext');before=store.read_bytes()
    monkeypatch.setattr(S, 'MEMORY_FILE', str(data/'memory_local.json'), raising=False)
    assert not S._may_create_store_key('memory_key.bin')
    with pytest.raises((KeyUnavailableError,HTTPException)):
        S._store_key('memory_key.bin',create=True)
    assert not (data/'memory_key.bin').exists() and store.read_bytes()==before


def test_legacy_cleanup_intent_never_calls_scanner_devices_or_executor(monkeypatch):
    from ai import intent_engine
    monkeypatch.setattr(intent_engine.requests, 'get', lambda *args, **kwargs: pytest.fail('No background scan or device probe'))
    monkeypatch.setattr(intent_engine.requests, 'post', lambda *args, **kwargs: pytest.fail('No direct cleanup'))
    result = intent_engine._exec_cleanup_run('http://unused/', {}, intent_engine.time.time())
    assert result.success is True
    assert result.data['review_required'] is True and result.data['navigate_to']=='panel-visualizer'
    assert 'No scan was started' in result.message and 'nothing was moved' in result.message


def test_session_revocation_clears_loaded_scan_cache_without_importing_optional_modules(monkeypatch):
    import sys
    from types import SimpleNamespace
    calls=[]
    monkeypatch.setitem(sys.modules,'storage_jobs',SimpleNamespace(revoke_browser_session=lambda token:calls.append(('one',token)),revoke_all_sessions=lambda:calls.append(('all',))))
    monkeypatch.setattr(S,'_active_sessions',{})
    S.revoke_session_token('synthetic-browser');S.revoke_all_sessions()
    assert calls==[('one','synthetic-browser'),('all',)]
