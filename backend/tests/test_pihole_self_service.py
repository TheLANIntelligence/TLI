"""Device-scoped Pi-hole broker checks; all network/store evidence is synthetic."""
import copy
from contextlib import contextmanager
import threading
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import pihole_bridge as private
import pihole_self_service as H
import tli_state as S


CLIENT = {"id": 4, "client": "192.168.4.22", "comment": None, "groups": [0, 2], "date_added": 100, "date_modified": 200}
GROUPS = [{"id": 0, "name": "Default", "enabled": True, "comment": None, "date_added": 1, "date_modified": 2},
          {"id": 2, "name": "Games", "enabled": True, "comment": "Games devices", "date_added": 3, "date_modified": 4}]


def request(*, ip="192.168.4.22", cookie=None, owner=None, scheme="https", extra=()):
    headers = [(b"host", b"192.168.4.3:8000"), (b"origin", b"https://192.168.4.3:8000")]
    if cookie:
        headers.append((b"cookie", (H.COOKIE + "=" + cookie).encode()))
    if owner:
        headers.append((b"cookie", ("tli_session=" + owner).encode()))
    headers.extend(extra)
    return Request({"type": "http", "method": "POST", "scheme": scheme, "server": ("192.168.4.3", 8000),
                    "path": "/api/pihole-access/status", "query_string": b"", "client": (ip, 3333), "headers": headers})


@pytest.fixture
def lab(monkeypatch):
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "_session_revocation_epoch", object())
    pin = {"enabled": True, "hash": "a" * 64, "salt": "b" * 64}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    H.revoke_all_connections()
    H.BUSY.clear()
    private.TARGETS.clear()
    now = [100000.0]
    monkeypatch.setattr(H.time, "monotonic", lambda: now[0])
    remote = SimpleNamespace(clients=[copy.deepcopy(CLIENT)], groups=copy.deepcopy(GROUPS), calls=[], before=None, after=None,
                             mutate=True, acknowledge=True, readback_fail=False, put_seen=False)
    grants, commands = {}, {}
    store = SimpleNamespace(before=None, after=None)
    def checkpoint(check):
        check()
        if store.before:
            store.before()
        check()
    def create(record, check):
        checkpoint(check)
        if record["id"] in grants:
            raise HTTPException(409, "Already exists")
        value = {**copy.deepcopy(record), "revoked": False, "revoked_at": None}
        grants[value["id"]] = value
        if store.after:
            store.after()
        check()
        return copy.deepcopy(value)
    def get(ident, check):
        checkpoint(check)
        if ident not in grants:
            raise HTTPException(404, "Missing grant")
        return copy.deepcopy(grants[ident])
    def find(digest, check):
        checkpoint(check)
        return next((copy.deepcopy(row) for row in grants.values() if row["token_hash"] == digest), None)
    def listing(owner, check):
        checkpoint(check)
        return [copy.deepcopy(row) for row in grants.values() if row["owner"] == owner]
    def revoke(owner, ident, check):
        checkpoint(check)
        value = grants[ident]
        if value["owner"] != owner:
            raise HTTPException(404, "Missing grant")
        value.update(revoked=True, revoked_at=H._stamp())
        check()
        return copy.deepcopy(value)
    def command(grant, operation, check):
        checkpoint(check)
        return copy.deepcopy(commands.get((grant, operation)))
    def command_list(grant, check):
        checkpoint(check)
        return [copy.deepcopy(row) for (g, _), row in commands.items() if g == grant]
    def reserve(grant, operation, record, check):
        checkpoint(check)
        if (grant, operation) in commands:
            raise HTTPException(409, "Already reserved")
        value = {"operation_id": operation, "receipt_id": "r" + str(len(commands)), "uncertain": False,
                 "receipt": {"id": "r" + str(len(commands)), "record": copy.deepcopy(record), "created_at": H._stamp(),
                             "outcome": {"outcome": "prepared", "attempted": False}}}
        commands[grant, operation] = value
        if store.after:
            store.after()
        check()
        return copy.deepcopy(value)
    def finish(grant, operation, outcome):
        value = commands[grant, operation]
        value["receipt"]["outcome"] = copy.deepcopy(outcome)
        return copy.deepcopy(value)
    store.create, store.get, store.find_token, store.list_grants, store.revoke = create, get, find, listing, revoke
    store.command, store.list_commands, store.reserve_command, store.finish_command = command, command_list, reserve, finish
    monkeypatch.setattr(H, "_store", lambda: store)
    def exchange(config, method, path, check, *, sid=None, body=None, on_attempt=None):
        check()
        if remote.before:
            remote.before(method, path)
        check()
        if on_attempt:
            on_attempt()
        remote.calls.append((method, path, copy.deepcopy(body)))
        if path == "/api/auth":
            output = {} if method == "DELETE" else {"session": {"valid": True, "sid": "sessionSID", "validity": 300}}
        elif method == "PUT":
            assert (getattr(store, "real_commands", False) or
                    any(row["receipt"]["outcome"]["outcome"] == "prepared" for row in commands.values())), "reserve before PUT"
            remote.put_seen = True
            if remote.mutate:
                remote.clients[0]["groups"] = list(body["groups"])
                remote.clients[0]["date_modified"] += 1
                remote.clients[0]["comment"] = body["comment"]
            output = {"processed": {"success": [{"item": CLIENT["client"]}] if remote.acknowledge else [], "errors": []}}
        elif path == "/api/clients":
            if remote.put_seen and remote.readback_fail:
                raise HTTPException(503, "Synthetic readback failure")
            output = {"clients": copy.deepcopy(remote.clients)}
        elif path == "/api/groups":
            output = {"groups": copy.deepcopy(remote.groups)}
        else:
            raise AssertionError("Unexpected remote path: " + path)
        if remote.after:
            remote.after(method, path)
        check()
        return output
    monkeypatch.setattr(H.transport, "exchange", exchange)
    token = S.create_session_token("owner")
    owner = request(ip="192.168.4.3", owner=token)
    denied = [False]
    def check():
        if denied[0]:
            raise HTTPException(401, "Synthetic browser access ended")
    yield SimpleNamespace(owner=owner, token=token, check=check, denied=denied, pin=pin, now=now,
                          remote=remote, store=store, grants=grants, commands=commands)
    H.revoke_all_connections()
    H.BUSY.clear()
    private.TARGETS.clear()


def enable(lab):
    return H.enable(lab.owner, {"origin": "https://192.168.4.2", "password": "PRIVATE-pihole-password",
                               "certificate_sha256": ""}, lab.check)


def pending(lab, ip=CLIENT["client"]):
    value = H.request_access(request(ip=ip), {"name": "Game phone"}, lambda: None)
    return request(ip=ip, cookie=value["_credential"]), value


def approved(lab):
    enable(lab)
    guest, waiting = pending(lab)
    ident = waiting["_credential"].split(".")[0]
    H.approve(lab.owner, {"request_id": ident, "client": CLIENT["client"], "reviewed": True}, lab.check)
    return guest, ident


def toggle(guest, enabled, operation=None):
    return H.filtering(guest, {"enabled": enabled, "operation_id": operation or str(uuid.uuid4())}, lambda: None)


def puts(lab):
    return [row for row in lab.remote.calls if row[0] == "PUT"]


def test_enable_retains_password_only_memory_and_never_sid(lab):
    data = {"origin": "https://192.168.4.2", "password": "PRIVATE-pihole-password", "certificate_sha256": ""}
    result = H.enable(lab.owner, data, lab.check)
    assert result["enabled"] and data["password"] == ""
    assert H.SERVICE["password"] == "PRIVATE-pihole-password" and "sid" not in H.SERVICE
    assert "PRIVATE-pihole-password" not in repr(result)
    assert [method for method, _, _ in lab.remote.calls] == ["POST", "DELETE"]
    assert not lab.grants and not lab.commands


def test_ordinary_owner_lock_does_not_revoke_explicit_device_grant(lab):
    guest, ident = approved(lab)
    S.revoke_session_token(lab.token)
    assert H.guest_status(guest, lambda: None)["state"] == "on"
    assert toggle(guest, False)["state"] == "off"
    assert not lab.grants[ident]["revoked"]


@pytest.mark.parametrize("change", ["epoch", "pin_hash", "pin_off", "disable", "restart"])
def test_service_protection_change_stops_effects(lab, change):
    guest, _ = approved(lab)
    if change == "epoch":
        S._session_revocation_epoch = object()
    elif change == "pin_hash":
        lab.pin["hash"] = "c" * 64
    elif change == "pin_off":
        lab.pin["enabled"] = False
    elif change == "disable":
        H.disable(lab.owner, {}, lab.check)
    else:
        H.revoke_all_connections()
    before = len(lab.remote.calls)
    with pytest.raises(HTTPException):
        toggle(guest, False)
    assert len(lab.remote.calls) == before and not puts(lab)


def test_pending_request_does_not_need_owner_cookie_and_can_be_refreshed(lab):
    enable(lab)
    guest, waiting = pending(lab)
    result = H.request_access(guest, {"name": "Changed name"}, lambda: None)
    assert result["state"] == "pending" and "_credential" not in result
    assert H.guest_status(guest, lambda: None)["name"] == "Game phone"
    assert len(H.PENDING) == 1
    assert waiting["_credential"] not in repr(H.PENDING)


def test_pending_limits_expiry_and_source_matching(lab):
    enable(lab)
    guest, value = pending(lab)
    with pytest.raises(HTTPException) as denied:
        pending(lab)
    assert denied.value.status_code == 429
    wrong = request(ip="192.168.4.23", cookie=value["_credential"])
    with pytest.raises(HTTPException):
        H.guest_status(wrong, lambda: None)
    lab.now[0] += 601
    with pytest.raises(HTTPException):
        H.approve(lab.owner, {"request_id": value["_credential"].split(".")[0], "client": CLIENT["client"], "reviewed": True}, lab.check)
    assert not lab.grants


@pytest.mark.parametrize("field,value", [("client", "192.168.4.23"), ("reviewed", False)])
def test_owner_approval_requires_exact_explicit_target(lab, field, value):
    enable(lab)
    _, waiting = pending(lab)
    data = {"request_id": waiting["_credential"].split(".")[0], "client": CLIENT["client"], "reviewed": True, field: value}
    with pytest.raises(HTTPException):
        H.approve(lab.owner, data, lab.check)
    assert not lab.grants and not puts(lab)


def test_owner_approval_requires_matching_request_ip_and_nonempty_baseline(lab):
    enable(lab)
    _, waiting = pending(lab, "192.168.4.23")
    with pytest.raises(HTTPException):
        H.approve(lab.owner, {"request_id": waiting["_credential"].split(".")[0], "client": CLIENT["client"], "reviewed": True}, lab.check)
    lab.remote.clients[0]["groups"] = []
    _, waiting = pending(lab)
    with pytest.raises(HTTPException):
        H.approve(lab.owner, {"request_id": waiting["_credential"].split(".")[0], "client": CLIENT["client"], "reviewed": True}, lab.check)


def test_pause_restore_preserve_baseline_and_hide_admin_receipts(lab):
    guest, ident = approved(lab)
    off = toggle(guest, False)
    assert off["state"] == "off" and off["outcome"]["membership_verified"]
    assert H.guest_status(guest, lambda: None)["state"] == "off"
    on = toggle(guest, True)
    assert on["state"] == "on" and lab.remote.clients[0]["groups"] == [0, 2]
    assert [row[2]["groups"] for row in puts(lab)] == [[], [0, 2]]
    assert len(lab.commands) == 2
    assert not any(key in off for key in ("receipt", "groups", "origin", "sid", "password", "token_hash"))
    assert all(row["record"]["client"] == CLIENT["client"] for row in (value["receipt"] for value in lab.commands.values()))


def test_restoration_rejects_unowned_pause(lab):
    guest, _ = approved(lab)
    lab.remote.clients[0]["groups"] = []
    assert H.guest_status(guest, lambda: None)["state"] == "changed"
    assert toggle(guest, True)["state"] == "changed"
    assert not puts(lab)


@pytest.mark.parametrize("change", ["id", "date_added", "group_name", "groups", "baseline_deleted"])
def test_external_policy_changes_need_owner_review(lab, change):
    guest, _ = approved(lab)
    if change in ("id", "date_added"):
        lab.remote.clients[0][change] += 1
    elif change == "group_name":
        lab.remote.groups[0]["name"] = "Changed"
    elif change == "groups":
        lab.remote.clients[0]["groups"] = [0]
    else:
        lab.remote.groups.pop()
    assert toggle(guest, False)["state"] == "changed"
    assert not puts(lab)


def test_repeated_operation_id_never_authenticates_or_writes_again(lab):
    guest, _ = approved(lab)
    operation = str(uuid.uuid4())
    toggle(guest, False, operation)
    count = len(lab.remote.calls)
    output = toggle(guest, False, operation)
    assert output["outcome"]["outcome"] == "confirmed" and output["state"] == "changed"
    assert len(lab.remote.calls) == count and len(puts(lab)) == 1
    with pytest.raises(HTTPException):
        toggle(guest, True, operation)
    assert len(lab.remote.calls) == count


def test_guest_revocation_before_network_prevents_authentication(lab):
    guest, ident = approved(lab)
    H.revoke(lab.owner, {"grant_id": ident}, lab.check)
    before = len(lab.remote.calls)
    with pytest.raises(HTTPException):
        toggle(guest, False)
    assert len(lab.remote.calls) == before


@pytest.mark.parametrize("boundary", ["POST", "GET", "PUT"])
def test_revocation_after_exchange_stops_next_effect_and_disclosure(lab, boundary):
    guest, ident = approved(lab)
    lab.remote.calls.clear()
    def after(method, path):
        if method == boundary:
            lab.grants[ident]["revoked"] = True
    lab.remote.after = after
    with pytest.raises(HTTPException):
        toggle(guest, False)
    assert lab.remote.calls[-1][0] == boundary
    if boundary == "PUT":
        outcome = next(iter(lab.commands.values()))["receipt"]["outcome"]
        assert outcome["attempted"] and outcome["outcome"] == "unknown"
    else:
        assert not puts(lab)


def test_retained_check_denies_later_serialization_after_revoke(lab):
    guest, ident = approved(lab)
    result = H.guest_status(guest, lambda: None)
    lab.grants[ident]["revoked"] = True
    with pytest.raises(HTTPException):
        result["_access_check"]()


def test_unconfirmed_put_records_unknown_without_retry(lab):
    guest, _ = approved(lab)
    lab.remote.readback_fail = True
    lab.remote.acknowledge = False
    result = toggle(guest, False)
    assert result["state"] == "changed" and result["outcome"]["outcome"] == "unknown"
    assert result["outcome"]["attempted"] and len(puts(lab)) == 1


def test_owner_target_lock_also_excludes_guest(lab):
    guest, _ = approved(lab)
    key = (H.SERVICE["config"]["origin"], CLIENT["client"])
    private.TARGETS.add(key)
    before = len(lab.remote.calls)
    with pytest.raises(HTTPException):
        toggle(guest, False)
    assert len(lab.remote.calls) == before


def test_fresh_preflight_detects_concurrent_external_change(lab):
    guest, _ = approved(lab)
    client_reads = [0]
    def after(method, path):
        if path == "/api/clients":
            client_reads[0] += 1
            if client_reads[0] == 1:
                lab.remote.clients[0]["comment"] = "Changed after first snapshot"
    lab.remote.after = after
    assert toggle(guest, False)["state"] == "changed"
    assert not puts(lab) and not lab.commands


@pytest.mark.parametrize("kind", ["http", "forwarded", "bearer", "source", "no_cookie"])
def test_guest_admission_cannot_select_or_impersonate_other_clients(lab, kind):
    guest, _ = approved(lab)
    raw = guest.cookies[H.COOKIE]
    altered = request(cookie=None if kind == "no_cookie" else raw,
                      ip="192.168.4.23" if kind == "source" else CLIENT["client"],
                      scheme="http" if kind == "http" else "https",
                      extra=[(b"forwarded", b"for=192.168.4.22")] if kind == "forwarded" else
                      [(b"authorization", b"Bearer private-owner-token")] if kind == "bearer" else [])
    before = len(lab.remote.calls)
    with pytest.raises(HTTPException):
        toggle(altered, False)
    assert len(lab.remote.calls) == before


def test_forget_revokes_only_own_access_and_does_not_restore_pause(lab):
    guest, ident = approved(lab)
    toggle(guest, False)
    H.revoke_all_connections()
    before = len(lab.remote.calls)
    result = H.forget(guest, {}, lambda: None)
    assert result["forgotten"] and lab.grants[ident]["revoked"]
    assert lab.remote.clients[0]["groups"] == [] and len(lab.remote.calls) == before
    result["_access_check"]()


def test_reenable_same_configuration_reuses_grant_but_changed_pin_does_not(lab):
    guest, _ = approved(lab)
    H.disable(lab.owner, {}, lab.check)
    enable(lab)
    assert H.guest_status(guest, lambda: None)["state"] == "on"
    lab.pin["hash"] = "c" * 64
    enable(lab)
    with pytest.raises(HTTPException):
        H.guest_status(guest, lambda: None)


def test_transport_error_does_not_publish_false_success_or_expose_password(lab):
    def before(method, path):
        raise HTTPException(503, "Synthetic upstream unavailable")
    lab.remote.before = before
    with pytest.raises(HTTPException):
        enable(lab)
    assert H.SERVICE is None


def test_unknown_or_incomplete_command_blocks_new_write(lab):
    guest, ident = approved(lab)
    lab.commands[ident, uuid.uuid4().hex] = {"operation_id": uuid.uuid4().hex, "receipt_id": None, "receipt": None, "uncertain": True}
    assert toggle(guest, False)["state"] == "changed"
    assert not puts(lab)


def test_guest_status_never_requests_dns_activity_or_global_toggle(lab):
    guest, _ = approved(lab)
    lab.remote.calls.clear()
    H.guest_status(guest, lambda: None)
    assert [path for _, path, _ in lab.remote.calls] == ["/api/auth", "/api/clients", "/api/groups", "/api/auth"]
    assert not puts(lab)


def test_expanded_uppercase_ipv6_selector_preserved_for_owner_and_put(lab):
    wire = "FD12:3456:0000:0000:0000:0000:0000:0022"
    source = "fd12:3456::22"
    lab.remote.clients[0]["client"] = wire
    enable(lab)
    guest, waiting = pending(lab, source)
    ident = waiting["_credential"].split(".")[0]
    H.approve(lab.owner, {"request_id": ident, "client": wire, "reviewed": True}, lab.check)
    result = toggle(guest, False)
    assert result["state"] == "off" and result["client"] == wire
    assert puts(lab)[0][1] == "/api/clients/" + wire.replace(":", "%3A")


def test_unrelated_group_definition_change_does_not_invalidate_approved_baseline(lab):
    guest, _ = approved(lab)
    lab.remote.groups.append({"id": 9, "name": "Other", "enabled": True, "comment": None, "date_added": 9, "date_modified": 9})
    assert toggle(guest, False)["state"] == "off"
    lab.remote.groups[-1]["name"] = "Unrelated renamed group"
    assert toggle(guest, True)["state"] == "on"


def test_second_active_browser_for_same_client_needs_explicit_revocation(lab):
    guest, _ = approved(lab)
    lab.now[0] += 31
    second, waiting = pending(lab)
    with pytest.raises(HTTPException) as denied:
        H.approve(lab.owner, {"request_id": waiting["_credential"].split(".")[0],
                             "client": CLIENT["client"], "reviewed": True}, lab.check)
    assert denied.value.status_code == 409 and len(lab.grants) == 1
    assert H.guest_status(guest, lambda: None)["state"] == "on"


def test_real_store_grants_and_pause_restore_survive_broker_restart(lab, monkeypatch, tmp_path):
    import pihole_access_store as saved
    import pihole_receipts as receipts
    monkeypatch.setattr(S, "DATA_DIR", tmp_path)
    for module in (saved, receipts):
        monkeypatch.setattr(module, "_SEEN", {})
        monkeypatch.setattr(module, "_UNCERTAIN", set())
    lab.store.real_commands = True
    monkeypatch.setattr(H, "_store", lambda: saved)
    guest, ident = approved(lab)
    assert toggle(guest, False)["state"] == "off"
    S.revoke_session_token(lab.token)
    assert H.guest_status(guest, lambda: None)["state"] == "off"
    assert toggle(guest, False)["state"] == "off" and len(puts(lab)) == 1
    H.revoke_all_connections()
    S._session_revocation_epoch = object()
    for module in (saved, receipts):
        monkeypatch.setattr(module, "_SEEN", {})
        monkeypatch.setattr(module, "_UNCERTAIN", set())
    lab.token = S.create_session_token("owner")
    lab.owner = request(ip="192.168.4.3", owner=lab.token)
    assert H.guest_status(guest, lambda: None)["state"] == "offline"
    enable(lab)
    assert H.guest_status(guest, lambda: None)["state"] == "off"
    assert toggle(guest, True)["state"] == "on"
    assert len(saved.list_commands(ident, lambda: None)) == 3
    H.revoke(lab.owner, {"grant_id": ident}, lab.check)
    before = len(lab.remote.calls)
    with pytest.raises(HTTPException):
        toggle(guest, False)
    assert len(lab.remote.calls) == before
    raw = b"".join(path.read_bytes() for path in tmp_path.rglob("*") if path.is_file())
    assert b"PRIVATE-pihole-password" not in raw and guest.cookies[H.COOKIE].encode() not in raw
    assert b"sessionSID" not in raw


def test_real_store_revocation_after_put_still_retains_outcome(lab, monkeypatch, tmp_path):
    import pihole_access_store as saved
    import pihole_receipts as receipts
    monkeypatch.setattr(S, "DATA_DIR", tmp_path)
    for module in (saved, receipts):
        monkeypatch.setattr(module, "_SEEN", {})
        monkeypatch.setattr(module, "_UNCERTAIN", set())
    lab.store.real_commands = True
    monkeypatch.setattr(H, "_store", lambda: saved)
    guest, ident = approved(lab)
    operation = uuid.uuid4()
    def after(method, path):
        if method == "PUT":
            saved.revoke("owner", ident, lambda: None)
    lab.remote.after = after
    with pytest.raises(HTTPException):
        toggle(guest, False, str(operation))
    output = saved.command(ident, operation.hex, lambda: None)
    assert output["receipt"]["outcome"]["outcome"] == "unknown"
    assert output["receipt"]["outcome"]["attempted"]


@pytest.mark.parametrize("initial", [True, False])
def test_acknowledged_noop_is_consumed_and_cannot_reverse_later_change(lab, initial):
    guest, _ = approved(lab)
    if not initial:
        toggle(guest, False)
    noop = str(uuid.uuid4())
    result = toggle(guest, initial, noop)
    assert result["outcome"]["outcome"] == "not_attempted"
    toggle(guest, not initial)
    count = len(lab.remote.calls)
    previous = list(lab.remote.clients[0]["groups"])
    result = toggle(guest, initial, noop)
    assert result["outcome"]["outcome"] == "not_attempted"
    assert lab.remote.clients[0]["groups"] == previous and len(lab.remote.calls) == count


def test_forgotten_pending_requests_cannot_grow_rate_table_without_bound(lab, monkeypatch):
    enable(lab)
    monkeypatch.setattr(H, "MAX_RATE_ENTRIES", 2)
    first, _ = pending(lab, "192.168.4.22")
    H.forget(first, {}, lambda: None)
    second, _ = pending(lab, "192.168.4.23")
    H.forget(second, {}, lambda: None)
    with pytest.raises(HTTPException) as denied:
        pending(lab, "192.168.4.24")
    assert denied.value.status_code == 429 and len(H.RATES) == 2
    lab.now[0] += 31
    assert pending(lab, "192.168.4.24")[1]["state"] == "pending"


def test_post_write_group_definition_change_is_not_confirmed(lab):
    guest, _ = approved(lab)
    def after(method, path):
        if method == "PUT":
            lab.remote.groups[0]["name"] = "Changed while submitting"
    lab.remote.after = after
    result = toggle(guest, False)
    assert result["state"] == "changed"
    assert result["outcome"]["outcome"] == "mismatch" and not result["outcome"]["membership_verified"]


class PublicationGate:
    """Hold a chosen lock acquisition while the test revokes its caller."""
    def __init__(self):
        self.lock = threading.RLock()
        self.waiting = threading.Event()
        self.release = threading.Event()
        self.remaining = 0

    def __enter__(self):
        if self.remaining:
            self.remaining -= 1
            if not self.remaining:
                self.waiting.set()
                assert self.release.wait(5), "Test did not release the publication lock"
        self.lock.acquire()
        return self

    def __exit__(self, *args):
        self.lock.release()


def test_enable_rechecks_original_owner_after_publication_lock_wait(lab, monkeypatch):
    gate = PublicationGate()
    monkeypatch.setattr(H, "LOCK", gate)
    original_session = H._session
    @contextmanager
    def session(*args, **kwargs):
        with original_session(*args, **kwargs) as sid:
            yield sid
        # First acquisition is candidate()'s generation check; the next is
        # the final publication block after the successful remote login.
        gate.remaining = 2
    monkeypatch.setattr(H, "_session", session)
    errors = []
    def worker():
        try:
            enable(lab)
        except Exception as error:
            errors.append(error)
    thread = threading.Thread(target=worker)
    thread.start()
    try:
        assert gate.waiting.wait(5)
        S.revoke_session_token(lab.token)
    finally:
        gate.release.set()
        thread.join(5)
    assert not thread.is_alive()
    assert len(errors) == 1 and isinstance(errors[0], HTTPException)
    assert H.SERVICE is None, "A revoked owner must not publish its retained password"


def test_disable_rechecks_original_owner_after_lock_wait(lab, monkeypatch):
    enable(lab)
    gate = PublicationGate()
    gate.remaining = 1
    monkeypatch.setattr(H, "LOCK", gate)
    errors = []
    def worker():
        try:
            H.disable(lab.owner, {}, lab.check)
        except Exception as error:
            errors.append(error)
    thread = threading.Thread(target=worker)
    thread.start()
    try:
        assert gate.waiting.wait(5)
        S.revoke_session_token(lab.token)
        newer = {**H.SERVICE, "id": "newer-service", "password": "newer-password"}
        H.SERVICE = newer
    finally:
        gate.release.set()
        thread.join(5)
    assert not thread.is_alive()
    assert len(errors) == 1 and isinstance(errors[0], HTTPException)
    assert H.SERVICE is newer and newer["password"] == "newer-password"
