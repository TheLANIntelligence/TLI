"""PIN admission, persistent guessing limits and rotation use isolated real routes."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import inspect
import json
from pathlib import Path
from threading import Event, RLock, get_ident
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import companion_auth as companion
import pin_security as security
import security_state as persistence
import tli_state as S
from routers import system_routes as routes


LOCAL = "http://localhost:8000"
REMOTE = "https://tli.test:8000"
PIN = "2468"
NEW_PIN = "3579"
SALT = "b" * 64
REAL_HASH = security.hash_pin
MUTATIONS = ("verify", "set", "remove", "lock", "emergency-reset")


def fast_hash(pin, salt):
    return hashlib.sha256((salt + "\0" + pin).encode()).hexdigest()


@pytest.fixture
def surface(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "tli_pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "_PIN_CONFIG_LOCK", RLock())
    monkeypatch.setattr(S, "TLS_ENABLED", True)
    monkeypatch.setattr(S, "_discard_optional_session_state", lambda *args: None)
    logs = []
    monkeypatch.setattr(S, "log_debug", lambda *args, **kwargs: logs.append((args, kwargs)))
    monkeypatch.setattr(security, "hash_pin", fast_hash)
    monkeypatch.setattr(security, "_cooldown_cache", None)
    clock = SimpleNamespace(wall=1_700_000_000.0, monotonic=1000.0)
    monkeypatch.setattr(security, "_now", lambda: clock.wall)
    monkeypatch.setattr(security, "_monotonic", lambda: clock.monotonic)
    S.save_pin_config(fast_hash(PIN, SALT), SALT)
    app = FastAPI()
    app.middleware("http")(companion.validate_authorization)
    app.include_router(routes.router)
    assert not app.dependency_overrides
    return SimpleNamespace(app=app, clock=clock, path=S.PIN_CONFIG_FILE, logs=logs)


def payload(operation, *, pin=PIN):
    if operation == "set":
        return {"pin": NEW_PIN, "current_pin": pin}
    if operation in ("verify", "remove"):
        return {"pin": pin}
    return {}


def request(surface, operation, body=None, *, base=LOCAL, peer="127.0.0.1",
            token=None, headers=None, origin=True):
    supplied = [("Origin", base)] if origin else []
    if token is not None:
        supplied.append(("Cookie", "tli_session=" + token))
    supplied.extend(headers.items() if isinstance(headers, dict) else headers or [])
    with TestClient(surface.app, base_url=base, client=(peer, 40000), raise_server_exceptions=False) as client:
        return client.post("/system/pin/" + operation,
                           json=payload(operation) if body is None else body, headers=supplied)


def wrong(surface, operation="verify", **kwargs):
    return request(surface, operation, payload(operation, pin="wrong"), **kwargs)


def lockout(surface):
    for index in range(security.FAILURE_LIMIT):
        result = wrong(surface)
        assert result.status_code == (403 if index < security.FAILURE_LIMIT - 1 else 429)
    result = wrong(surface)
    assert result.status_code == 429
    assert int(result.headers["Retry-After"]) == security.BASE_COOLDOWN
    return result


def advance(surface, seconds):
    surface.clock.wall += seconds
    surface.clock.monotonic += seconds


def paired():
    invitation, _ = companion.create_pairing("local", REMOTE, "f" * 64)
    return companion.redeem_pairing(invitation, REMOTE, "f" * 64, "Synthetic phone", "ios")


@pytest.mark.parametrize("operation", MUTATIONS)
@pytest.mark.parametrize("mode", ("missing_origin", "foreign_origin", "cross_site", "proxy", "peer"))
def test_pin_mutations_reject_untrusted_transport_before_state_or_hash(surface, monkeypatch, operation, mode):
    token = S.create_session_token("local")
    before = surface.path.read_bytes()
    def no_hash(*args):
        pytest.fail("Rejected transport must not reach PIN hashing")
    monkeypatch.setattr(security, "hash_pin", no_hash)
    headers = {}
    origin = mode != "missing_origin"
    if mode == "foreign_origin":
        origin = False
        headers["Origin"] = "https://other.test"
    elif mode == "cross_site":
        headers["Sec-Fetch-Site"] = "cross-site"
    elif mode == "proxy":
        headers["X-Forwarded-For"] = "127.0.0.1"
    elif mode == "peer":
        headers["X-TLI-Peer-Id"] = "synthetic-peer"
    response = request(surface, operation, token=token, headers=headers, origin=origin)
    assert response.status_code == 403
    assert surface.path.read_bytes() == before
    assert S.validate_session_token(token)
    assert not surface.logs


@pytest.mark.parametrize("operation", MUTATIONS)
def test_valid_companion_with_browser_cookie_cannot_mutate_pin(surface, operation):
    phone = paired()
    token = S.create_session_token("local")
    before = surface.path.read_bytes()
    response = request(surface, operation, base=REMOTE, peer="192.168.1.8", token=token,
                       headers={"Authorization": "Bearer " + phone["credential"]})
    assert response.status_code == 403
    assert surface.path.read_bytes() == before
    assert S.validate_session_token(token)
    assert companion.credential_owner(phone["credential"]) == "local"


@pytest.mark.parametrize("operation", ("verify", "set", "remove"))
def test_pin_proofs_are_never_accepted_over_remote_plain_http(surface, operation):
    before = surface.path.read_bytes()
    response = request(surface, operation, base="http://tli.test:8000", peer="192.168.1.8")
    assert response.status_code == 403
    assert surface.path.read_bytes() == before
    assert not S._active_sessions


@pytest.mark.parametrize("headers", [
    [("Origin", LOCAL), ("Origin", LOCAL)],
    [("Origin", LOCAL), ("Sec-Fetch-Site", "same-site")],
    [("Origin", LOCAL), ("Forwarded", "for=127.0.0.1")],
])
def test_pin_transport_rejects_duplicate_origin_and_same_site_shortcuts(surface, headers):
    before = surface.path.read_bytes()
    response = request(surface, "verify", origin=False, headers=headers)
    assert response.status_code == 403
    assert surface.path.read_bytes() == before
    assert not S._active_sessions


@pytest.mark.parametrize("operation", ("verify", "set", "remove"))
def test_pin_off_entry_is_direct_loopback_only(surface, operation):
    S.clear_pin_config()
    before = surface.path.read_bytes()
    response = request(surface, operation, base=REMOTE, peer="192.168.1.8")
    assert response.status_code == 403
    assert surface.path.read_bytes() == before
    assert not S._active_sessions


def test_initial_local_set_revokes_old_browser_tokens_and_requires_unlock(surface):
    S.clear_pin_config()
    old = S.create_session_token("local")
    response = request(surface, "set", {"pin": PIN}, token=old)
    assert response.status_code == 200
    assert response.json() == {"ok": True, "locked": True}
    assert "Max-Age=0" in response.headers["Set-Cookie"]
    assert response.headers["Cache-Control"] == "no-store"
    assert not S.validate_session_token(old)
    cfg = S.load_pin_config()
    assert cfg["enabled"] and cfg["hash"] == fast_hash(PIN, cfg["salt"])
    assert not S._active_sessions


def test_legacy_pbkdf_pin_unlock_rotation_and_new_unlock(surface, monkeypatch):
    monkeypatch.setattr(security, "hash_pin", REAL_HASH)
    S.save_pin_config(REAL_HASH(PIN, SALT), SALT)
    assert "attempts" not in json.loads(surface.path.read_text())
    unlocked = request(surface, "verify", base=REMOTE, peer="192.168.1.8", token="expired-cookie")
    assert unlocked.status_code == 200, unlocked.text
    token = unlocked.cookies.get("tli_session")
    assert token and S.validate_session_token(token) and S.get_session_user_id(token) == "local"
    assert all(flag in unlocked.headers["Set-Cookie"] for flag in ("HttpOnly", "SameSite=strict", "Secure"))
    assert unlocked.headers["Cache-Control"] == "no-store"
    changed = request(surface, "set", base=REMOTE, peer="192.168.1.8")
    assert changed.status_code == 200 and changed.json()["locked"] is True
    assert not S.validate_session_token(token)
    assert request(surface, "verify", {"pin": PIN}).status_code == 403
    assert request(surface, "verify", {"pin": NEW_PIN}).status_code == 200


@pytest.mark.parametrize("operation", ("set", "remove"))
def test_current_pin_proof_mutations_revoke_all_browsers_but_preserve_paired_phone(surface, operation):
    first, second = S.create_session_token("local"), S.create_session_token("another-owner")
    phone = paired()
    phone_before = companion._path().read_bytes()
    response = request(surface, operation, base=REMOTE, peer="192.168.1.8")
    assert response.status_code == 200, response.text
    assert "Max-Age=0" in response.headers["Set-Cookie"]
    assert not S.validate_session_token(first) and not S.validate_session_token(second)
    assert companion._path().read_bytes() == phone_before
    assert companion.credential_owner(phone["credential"]) == "local"
    assert S.load_pin_config()["enabled"] is (operation == "set")


def test_pin_off_local_verify_clears_stale_cookie_without_minting_token(surface):
    S.clear_pin_config()
    before = surface.path.read_bytes()
    response = request(surface, "verify", token="stale-browser")
    assert response.status_code == 200 and response.json()["ok"] is True
    assert "Max-Age=0" in response.headers["Set-Cookie"]
    assert not S._active_sessions and surface.path.read_bytes() == before


def test_all_guessing_routes_and_direct_peers_share_persisted_budget(surface, monkeypatch):
    calls = []
    def count_hash(pin, salt):
        calls.append(pin)
        return fast_hash(pin, salt)
    monkeypatch.setattr(security, "hash_pin", count_hash)
    for index, operation in enumerate(("verify", "set", "remove", "verify", "set")):
        result = wrong(surface, operation, base=REMOTE, peer=f"192.168.1.{index + 10}")
        assert result.status_code in (403, 429)
    assert len(calls) == security.FAILURE_LIMIT
    cfg = S.load_pin_config()
    assert cfg["hash"] == fast_hash(PIN, SALT) and cfg["salt"] == SALT
    assert cfg["attempts"]["failures"] == security.FAILURE_LIMIT
    assert cfg["attempts"]["blocked_until"] == surface.clock.wall + security.BASE_COOLDOWN
    before = surface.path.read_bytes()
    for operation in ("verify", "set", "remove"):
        result = request(surface, operation)
        assert result.status_code == 429 and int(result.headers["Retry-After"]) == security.BASE_COOLDOWN
    assert len(calls) == security.FAILURE_LIMIT
    assert surface.path.read_bytes() == before and not S._active_sessions


def test_blocked_requests_do_not_hash_write_or_extend_deadline(surface, monkeypatch):
    lockout(surface)
    before = surface.path.read_bytes()
    monkeypatch.setattr(security, "hash_pin", lambda *args: pytest.fail("Cooldown must precede KDF"))
    monkeypatch.setattr(S, "record_pin_attempts", lambda *args, **kwargs: pytest.fail("Blocked requests must not write"))
    advance(surface, 17)
    for _ in range(3):
        response = request(surface, "verify")
        assert response.status_code == 429
        assert int(response.headers["Retry-After"]) == security.BASE_COOLDOWN - 17
    assert surface.path.read_bytes() == before


def test_correct_fifth_proof_clears_reserved_cooldown_before_unlock(surface, monkeypatch):
    for _ in range(security.FAILURE_LIMIT - 1):
        assert wrong(surface).status_code == 403
    original = S.record_pin_attempts
    writes = []
    def record(failures, blocked_until):
        original(failures, blocked_until)
        writes.append((failures, blocked_until))
    monkeypatch.setattr(S, "record_pin_attempts", record)
    response = request(surface, "verify")
    assert response.status_code == 200
    assert writes == [(security.FAILURE_LIMIT, surface.clock.wall + security.BASE_COOLDOWN), (0, 0)]
    assert S.validate_session_token(response.cookies.get("tli_session"))
    assert S.load_pin_config()["attempts"] == {"failures": 0, "blocked_until": 0}


def test_cooldown_survives_cache_restart_then_backoff_caps_and_success_resets(surface, monkeypatch):
    lockout(surface)
    monkeypatch.setattr(security, "_cooldown_cache", None)
    assert int(request(surface, "verify").headers["Retry-After"]) == security.BASE_COOLDOWN
    wait = security.BASE_COOLDOWN
    for expected in (120, 240, 480, 900, 900):
        advance(surface, wait + 1)
        response = wrong(surface)
        assert response.status_code in (403, 429)
        blocked = request(surface, "verify")
        assert blocked.status_code == 429
        assert int(blocked.headers["Retry-After"]) == expected
        wait = expected
    advance(surface, wait + 1)
    response = request(surface, "verify")
    assert response.status_code == 200
    assert S.validate_session_token(response.cookies.get("tli_session"))
    assert S.load_pin_config().get("attempts", {"failures": 0})["failures"] == 0
    assert wrong(surface).status_code == 403
    assert S.load_pin_config()["attempts"]["failures"] == 1


def test_clock_rollback_does_not_extend_live_cooldown(surface):
    lockout(surface)
    surface.clock.wall -= 86400
    surface.clock.monotonic += 10
    response = request(surface, "verify")
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) == security.BASE_COOLDOWN - 10
    surface.clock.monotonic += security.BASE_COOLDOWN
    assert request(surface, "verify").status_code == 200


def test_restart_after_clock_rollback_has_bounded_recovery(surface, monkeypatch):
    lockout(surface)
    surface.clock.wall -= 86400
    monkeypatch.setattr(security, "_cooldown_cache", None)
    response = request(surface, "verify")
    assert response.status_code == 429
    assert 1 <= int(response.headers["Retry-After"]) <= security.MAX_COOLDOWN
    surface.clock.monotonic += security.MAX_COOLDOWN + 1
    assert request(surface, "verify").status_code == 200


def test_authenticated_browser_can_recover_during_cooldown(surface):
    token = S.create_session_token("local")
    lockout(surface)
    assert request(surface, "emergency-reset").status_code == 401
    assert request(surface, "emergency-reset", token="expired").status_code == 401
    response = request(surface, "emergency-reset", token=token)
    assert response.status_code == 200
    assert S.load_pin_config() == {"enabled": False}
    assert not S.validate_session_token(token)
    assert "Max-Age=0" in response.headers["Set-Cookie"]


@pytest.mark.parametrize("attempts", [
    None, {"failures": True, "blocked_until": 0},
    {"failures": -1, "blocked_until": 0},
    {"failures": 5, "blocked_until": float("nan")},
    {"failures": 5, "blocked_until": float("inf")},
    {"failures": 5},
])
@pytest.mark.parametrize("operation", ("verify", "set", "remove", "emergency-reset"))
def test_corrupt_attempt_metadata_fails_closed_without_recovery_overwrite(surface, operation, attempts):
    token = S.create_session_token("local")
    raw = {"hash": fast_hash(PIN, SALT), "salt": SALT, "attempts": attempts}
    surface.path.write_text(json.dumps(raw))
    before = surface.path.read_bytes()
    response = request(surface, operation, token=token)
    assert response.status_code == 503
    assert surface.path.read_bytes() == before
    assert S.validate_session_token(token)
    assert not surface.logs


@pytest.mark.parametrize("duplicate", ("hash", "attempts", "failures", "blocked_until"))
@pytest.mark.parametrize("operation", ("verify", "set", "remove", "emergency-reset"))
def test_duplicate_pin_json_keys_fail_closed_and_preserve_original_bytes(surface, operation, duplicate):
    token = S.create_session_token("local")
    prefix = json.dumps({"hash": fast_hash(PIN, SALT), "salt": SALT})[:-1]
    suffixes = {
        "hash": '"hash": ' + json.dumps(fast_hash(PIN, SALT)),
        "attempts": '"attempts": {"failures": 0, "blocked_until": 0}, "attempts": {"failures": 0, "blocked_until": 0}',
        "failures": '"attempts": {"failures": 5, "failures": 0, "blocked_until": 0}',
        "blocked_until": '"attempts": {"failures": 0, "blocked_until": 999, "blocked_until": 0}',
    }
    surface.path.write_text(prefix + ", " + suffixes[duplicate] + "}")
    before = surface.path.read_bytes()
    response = request(surface, operation, token=token)
    assert response.status_code == 503
    assert surface.path.read_bytes() == before
    assert S.validate_session_token(token)
    assert not surface.logs


@pytest.mark.parametrize("correct", (False, True))
@pytest.mark.parametrize("late", (False, True))
def test_attempt_journal_failure_never_mints_a_token(surface, monkeypatch, correct, late):
    assert wrong(surface).status_code == 403
    token = S.create_session_token("local")
    before = surface.path.read_bytes()
    monkeypatch.setattr(security, "hash_pin", lambda *args: pytest.fail("A failed reservation must precede KDF"))
    original = persistence.os.replace
    def fail(source, destination):
        if Path(destination) == surface.path:
            if late:
                original(source, destination)
            raise OSError("Synthetic private persistence failure")
        return original(source, destination)
    monkeypatch.setattr(persistence.os, "replace", fail)
    response = request(surface, "verify", {"pin": PIN if correct else "wrong"})
    assert response.status_code == 503
    assert set(S._active_sessions) == {token}
    assert S.validate_session_token(token)
    assert not response.cookies.get("tli_session")
    assert "Synthetic private persistence failure" not in response.text
    if not late:
        assert surface.path.read_bytes() == before
    assert not list(surface.path.parent.glob(".tli-security-*.tmp"))


@pytest.mark.parametrize("late", (False, True))
def test_successful_proof_cannot_mint_until_reset_is_durable(surface, monkeypatch, late):
    original = persistence.os.replace
    calls = []
    def fail_reset(source, destination):
        if Path(destination) == surface.path:
            record = json.loads(Path(source).read_text())
            calls.append(record["attempts"]["failures"])
            if record["attempts"]["failures"] == 0:
                if late:
                    original(source, destination)
                raise OSError("Synthetic reset journal failure")
        return original(source, destination)
    monkeypatch.setattr(persistence.os, "replace", fail_reset)
    response = request(surface, "verify")
    assert response.status_code == 503
    assert calls == [1, 0]
    assert not S._active_sessions and not response.cookies.get("tli_session")
    assert S.load_pin_config()["hash"] == fast_hash(PIN, SALT)
    assert S.load_pin_config()["attempts"]["failures"] == (0 if late else 1)
    assert not list(surface.path.parent.glob(".tli-security-*.tmp"))


@pytest.mark.parametrize("operation", ("set", "remove", "emergency-reset"))
@pytest.mark.parametrize("late", (False, True))
def test_pin_change_persistence_errors_preserve_evidence_and_revoke_uncertain_old_sessions(surface, monkeypatch, operation, late):
    token = S.create_session_token("local")
    before = surface.path.read_bytes()
    original = persistence.os.replace
    attempted = []
    def fail(source, destination):
        if Path(destination) == surface.path:
            record = json.loads(Path(source).read_text())
            if record.get("enabled") is False or record.get("hash") != fast_hash(PIN, SALT):
                attempted.append(surface.path.read_bytes())
                if late:
                    original(source, destination)
                raise OSError("Synthetic private persistence failure")
        return original(source, destination)
    monkeypatch.setattr(persistence.os, "replace", fail)
    response = request(surface, operation, token=token)
    assert response.status_code == 503
    assert len(attempted) == 1
    assert "Synthetic private persistence failure" not in response.text
    assert not S.validate_session_token(token)
    if late:
        assert surface.path.read_bytes() != before
    else:
        assert surface.path.read_bytes() == attempted[0]
        assert S.load_pin_config()["hash"] == fast_hash(PIN, SALT)
    assert not list(surface.path.parent.glob(".tli-security-*.tmp"))


@pytest.mark.parametrize("stage", ("service_read", "clear_read"))
def test_reset_revoked_during_pin_read_does_not_disable_protection(surface, monkeypatch, stage):
    token = S.create_session_token("local")
    before = surface.path.read_bytes()
    revoked = []
    original_load, original_read = S.load_pin_config, S.read_pin_config
    def load():
        value = original_load()
        caller = inspect.currentframe().f_back
        if stage == "service_read" and caller.f_code.co_name == "reset" and caller.f_globals.get("__name__") == security.__name__:
            S.revoke_session_token(token)
            revoked.append(True)
        return value
    def read():
        value = original_read()
        if stage == "clear_read" and inspect.currentframe().f_back.f_code.co_name == "clear_pin_config":
            S.revoke_session_token(token)
            revoked.append(True)
        return value
    monkeypatch.setattr(S, "load_pin_config", load)
    monkeypatch.setattr(S, "read_pin_config", read)
    response = request(surface, "emergency-reset", token=token)
    assert revoked
    assert response.status_code == 401
    assert surface.path.read_bytes() == before
    assert not surface.logs


def test_reset_revoked_during_temp_fsync_cannot_replace_pin_file(surface, monkeypatch):
    token = S.create_session_token("local")
    before = surface.path.read_bytes()
    original = persistence.os.fsync
    revoked = []
    def fsync(descriptor):
        original(descriptor)
        S.revoke_session_token(token)
        revoked.append(True)
    monkeypatch.setattr(persistence.os, "fsync", fsync)
    response = request(surface, "emergency-reset", token=token)
    assert revoked == [True]
    assert response.status_code == 401
    assert surface.path.read_bytes() == before
    assert not list(surface.path.parent.glob(".tli-security-*.tmp"))
    assert not surface.logs


class ObservedLock:
    """Expose a real contender reaching the transaction lock, without sleeps."""
    def __init__(self):
        self.lock = RLock()
        self.owner = None
        self.depth = 0
        self.contender = Event()

    def __enter__(self):
        if self.owner is not None and self.owner != get_ident():
            self.contender.set()
        self.lock.acquire()
        self.owner = get_ident()
        self.depth += 1
        return self

    def __exit__(self, *args):
        self.depth -= 1
        if not self.depth:
            self.owner = None
        self.lock.release()


@pytest.mark.parametrize("first,second", [("verify", "set"), ("verify", "remove"),
                                         ("set", "verify"), ("set", "remove"), ("set", "set")])
def test_old_pin_work_cannot_finish_across_a_completed_change(surface, monkeypatch, first, second):
    guard = ObservedLock()
    monkeypatch.setattr(S, "_PIN_CONFIG_LOCK", guard)
    entered, release = Event(), Event()
    paused = []
    def hash_pin(pin, salt):
        if not paused:
            paused.append(True)
            entered.set()
            assert release.wait(5)
        return fast_hash(pin, salt)
    monkeypatch.setattr(security, "hash_pin", hash_pin)
    with ThreadPoolExecutor(2) as pool:
        earlier = pool.submit(request, surface, first)
        try:
            assert entered.wait(3)
            later = pool.submit(request, surface, second)
            assert guard.contender.wait(3), "The competing PIN operation did not wait for the transaction"
            assert not later.done()
        finally:
            release.set()
        one, two = earlier.result(timeout=5), later.result(timeout=5)
    assert one.status_code == 200, one.text
    if first == "verify":
        assert two.status_code == 200, two.text
        assert not S.validate_session_token(one.cookies.get("tli_session"))
        assert not S._active_sessions
    else:
        assert two.status_code == 403, two.text
        assert not two.cookies.get("tli_session")
        cfg = S.load_pin_config()
        assert cfg["enabled"] and cfg["hash"] == fast_hash(NEW_PIN, cfg["salt"])


def test_reset_waiting_for_transaction_cannot_use_a_cookie_revoked_by_rotation(surface, monkeypatch):
    token = S.create_session_token("local")
    guard = ObservedLock()
    monkeypatch.setattr(S, "_PIN_CONFIG_LOCK", guard)
    with ThreadPoolExecutor(1) as pool:
        with guard:
            pending = pool.submit(request, surface, "emergency-reset", token=token)
            assert guard.contender.wait(3)
            S.save_pin_config(fast_hash(NEW_PIN, SALT), SALT)
            S.revoke_all_sessions()
            before = surface.path.read_bytes()
        response = pending.result(timeout=5)
    assert response.status_code == 401
    assert surface.path.read_bytes() == before
    assert S.load_pin_config()["enabled"]
