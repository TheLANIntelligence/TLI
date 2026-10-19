"""Pi-hole session, review, receipt and revocation tests; no live lab access."""
import copy
import json
import ipaddress
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import pihole_bridge as H
import tli_state as S


CLIENT = {"id": 4, "client": "192.168.4.22", "comment": None, "groups": [0, 2], "date_added": 100, "date_modified": 200}
GROUPS = [{"id": 0, "name": "Default", "enabled": True, "comment": None, "date_added": 1, "date_modified": 2},
          {"id": 2, "name": "Work", "enabled": True, "comment": "Work devices", "date_added": 3, "date_modified": 4}]


@pytest.fixture
def lab(monkeypatch):
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "_session_revocation_epoch", object())
    pin = {"enabled": True}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    H.revoke_all_connections()
    H.BUSY.clear()
    H.TARGETS.clear()
    now = [100000.0]
    monkeypatch.setattr(H.time, "monotonic", lambda: now[0])
    remote = SimpleNamespace(clients=[copy.deepcopy(CLIENT)], groups=copy.deepcopy(GROUPS), calls=[],
                             sid="syntheticSID", validity=600, before=None, after=None, mutate=True, put_reply=None)
    records = {}
    store = SimpleNamespace(before_reserve=None, after_reserve=None, before_finish=None)
    def reserve(owner, record, check):
        check()
        if store.before_reserve:
            store.before_reserve()
        check()
        ident = "receipt-" + str(len(records) + 1)
        value = {"id": ident, **copy.deepcopy(record), "outcome": {"outcome": "prepared"}, "created_at": H._stamp()}
        records[ident] = (owner, value)
        if store.after_reserve:
            store.after_reserve()
        return copy.deepcopy(value)
    def get(owner, ident, check):
        check()
        if ident not in records or records[ident][0] != owner:
            raise HTTPException(404, "Receipt unavailable")
        return copy.deepcopy(records[ident][1])
    def finish(owner, ident, outcome):
        if store.before_finish:
            store.before_finish()
        saved_owner, value = records[ident]
        assert saved_owner == owner
        value["outcome"] = copy.deepcopy(outcome)
        return copy.deepcopy(value)
    def listing(owner, check):
        check()
        return [copy.deepcopy(value) for saved_owner, value in records.values() if owner == saved_owner]
    store.reserve, store.get, store.finish, store.list_receipts = reserve, get, finish, listing
    monkeypatch.setitem(sys.modules, "pihole_receipts", store)
    def exchange(config, method, path, check, *, sid=None, body=None, on_attempt=None):
        check()
        if remote.before:
            remote.before(method, path)
        check()
        if on_attempt:
            on_attempt()
        remote.calls.append((method, path, copy.deepcopy(body)))
        if path == "/api/auth":
            result = {"session": {"valid": True, "sid": remote.sid, "validity": remote.validity}}
        elif method == "PUT":
            assert records or getattr(store, "real_receipts", False), "Durable receipt must exist before any PUT"
            if remote.mutate:
                remote.clients[0]["groups"] = list(body["groups"])
                remote.clients[0]["comment"] = body["comment"]
                remote.clients[0]["date_modified"] += 1
            result = remote.put_reply if remote.put_reply is not None else {"processed": {"success": [{"item": CLIENT["client"]}], "errors": []}, "clients": copy.deepcopy(remote.clients)}
        elif path == "/api/clients":
            result = {"clients": copy.deepcopy(remote.clients)}
        elif path == "/api/groups":
            result = {"groups": copy.deepcopy(remote.groups)}
        else:
            assert path.startswith("/api/queries?")
            query = parse_qs(urlsplit(path).query)
            result = {"queries": [{"time": int(query["until"][0]) - 1, "domain": "example.test", "type": "A", "status": "GRAVITY",
                                    "client": {"ip": str(ipaddress.ip_address(remote.clients[0]["client"])), "name": "Desk"}}], "recordsFiltered": 1, "cursor": 3}
        if remote.after:
            remote.after(method, path)
        check()
        return result
    monkeypatch.setattr(H.transport, "exchange", exchange)
    def browser(owner="owner"):
        token = S.create_session_token(owner)
        request = Request({"type": "http", "method": "POST", "scheme": "https", "server": ("tli.test", 8000),
                           "path": "/api/homelab/pihole/connect", "query_string": b"", "client": ("192.168.4.3", 3333),
                           "headers": [(b"host", b"tli.test:8000"), (b"cookie", ("tli_session=" + token).encode())]})
        revoked = [False]
        def check():
            if revoked[0]:
                raise HTTPException(401, "synthetic revoked")
        return SimpleNamespace(request=request, token=token, owner=owner, check=check, revoked=revoked)
    first = browser()
    yield SimpleNamespace(browser=browser, first=first, remote=remote, records=records, store=store, pin=pin, now=now)
    H.revoke_all_connections()
    H.BUSY.clear()
    H.TARGETS.clear()


def connected(lab, browser=None):
    browser = browser or lab.first
    return H.connect(browser.request, {"origin": "https://192.168.4.2", "password": "PRIVATE-password", "certificate_sha256": ""}, browser.check)["connection"]


def reviewed(lab, connection, *, action="pause", groups=None, receipt_id=None, browser=None):
    browser = browser or lab.first
    return H.review(browser.request, {"connection_id": connection["id"], "client": CLIENT["client"], "action": action,
                                    "groups": groups or [], "receipt_id": receipt_id}, browser.check)


def execute(lab, connection, review, browser=None):
    browser = browser or lab.first
    return H.execute(browser.request, {"connection_id": connection["id"], "review_id": review["review_id"], "reviewed": True}, browser.check)


def puts(lab):
    return [row for row in lab.remote.calls if row[0] == "PUT"]


def test_connect_retains_sid_only_and_bounded_expiry(lab):
    payload = {"origin": "https://192.168.4.2", "password": "PRIVATE-password", "certificate_sha256": ""}
    connection = H.connect(lab.first.request, payload, lab.first.check)["connection"]
    assert payload["password"] == ""
    stored = H.CONNECTIONS[connection["id"]]
    assert stored["sid"] == "syntheticSID"
    assert stored["deadline"] == lab.now[0] + 600
    assert "password" not in stored and "password" not in stored["config"]
    assert "PRIVATE-password" not in repr(stored)
    assert lab.remote.calls == [("POST", "/api/auth", {"password": "PRIVATE-password"})]
    assert "sid" not in connection


def test_replacement_and_status_do_not_read_remote_inventory(lab):
    a = connected(lab)
    b = connected(lab)
    assert list(H.CONNECTIONS) == [b["id"]]
    status = H.status(lab.first.request, lab.first.check)
    assert status["connections"] == [b] and status["receipts"] == []
    assert a["id"] != b["id"] and len(lab.remote.calls) == 2


def test_failed_candidate_preserves_existing_connection(lab):
    first = connected(lab)
    lab.remote.sid = "malformed sid"
    with pytest.raises(HTTPException):
        connected(lab)
    assert first["id"] in H.CONNECTIONS


def test_disconnect_pending_candidate_discards_late_auth(lab):
    def after(method, path):
        H.disconnect(lab.first.request, {"connection_id": "not-connected"}, lab.first.check)
    lab.remote.after = after
    with pytest.raises(HTTPException, match="409"):
        connected(lab)
    assert not H.CONNECTIONS


@pytest.mark.parametrize("change", ["revoke", "epoch", "pin", "owner", "expiry"])
def test_original_connection_authority_cannot_revive(lab, change):
    connection = connected(lab)
    if change == "revoke":
        S.revoke_session_token(lab.first.token)
    elif change == "epoch":
        S._session_revocation_epoch = object()
    elif change == "pin":
        lab.pin["enabled"] = False
    elif change == "owner":
        S._active_sessions[lab.first.token]["user_id"] = "different"
    else:
        lab.now[0] += 601
    before = len(lab.remote.calls)
    with pytest.raises(HTTPException):
        H.inventory(lab.first.request, {"connection_id": connection["id"]}, lab.first.check)
    assert len(lab.remote.calls) == before


def test_other_browser_cannot_adopt_connection(lab):
    connection = connected(lab)
    other = lab.browser()
    with pytest.raises(HTTPException):
        H.inventory(other.request, {"connection_id": connection["id"]}, other.check)
    with pytest.raises(HTTPException):
        H.disconnect(other.request, {"connection_id": connection["id"]}, other.check)
    assert connection["id"] in H.CONNECTIONS


def test_inventory_is_detached_and_activity_uses_exact_bounded_filter(lab):
    connection = connected(lab)
    result = H.inventory(lab.first.request, {"connection_id": connection["id"]}, lab.first.check)
    result["clients"][0]["groups"].clear()
    assert lab.remote.clients[0]["groups"] == [0, 2]
    output = H.activity(lab.first.request, {"connection_id": connection["id"], "client": CLIENT["client"]}, lab.first.check)
    query = parse_qs(urlsplit(lab.remote.calls[-1][1]).query)
    assert query["client_ip"] == [CLIENT["client"]] and query["length"] == ["100"] and query["disk"] == ["false"]
    assert int(query["until"][0]) - int(query["from"][0]) == 900
    assert output["items"][0]["domain"] == "example.test" and not puts(lab)


def test_pause_review_has_no_effect_and_execute_has_private_receipt(lab):
    connection = connected(lab)
    review = reviewed(lab, connection)
    assert review["before_groups"] == [0, 2] and review["after_groups"] == []
    assert not puts(lab) and not lab.records
    response = execute(lab, connection, review)
    receipt = response["receipt"]
    assert receipt["before"]["clientrecord"]["groups"] == [0, 2]
    assert receipt["outcome"]["outcome"] == "confirmed" and receipt["outcome"]["membership_verified"]
    assert puts(lab) == [("PUT", "/api/clients/192.168.4.22", {"groups": [], "comment": None})]
    assert not any(secret in json.dumps(receipt) for secret in ("PRIVATE-password", "syntheticSID"))
    repeated = execute(lab, connection, review)
    assert repeated == response and len(puts(lab)) == 1


@pytest.mark.parametrize("change", ["client-comment", "client-date", "group-name", "group-enabled", "client-deleted"])
def test_changed_preflight_never_puts(lab, change):
    connection = connected(lab)
    review = reviewed(lab, connection)
    if change == "client-comment":
        lab.remote.clients[0]["comment"] = "external edit"
    elif change == "client-date":
        lab.remote.clients[0]["date_added"] += 1
    elif change == "group-name":
        lab.remote.groups[0]["name"] = "changed"
    elif change == "group-enabled":
        lab.remote.groups[0]["enabled"] = False
    else:
        lab.remote.clients.clear()
    with pytest.raises(HTTPException):
        execute(lab, connection, review)
    assert not puts(lab) and not lab.records


@pytest.mark.parametrize("selector", ["desktop", "aa:bb:cc:dd:ee:ff", "192.168.4.0/24"])
def test_non_exact_ip_client_cannot_be_edited(lab, selector):
    connection = connected(lab)
    lab.remote.clients[0]["client"] = selector
    with pytest.raises(HTTPException):
        H.review(lab.first.request, {"connection_id": connection["id"], "client": selector,
                                   "action": "pause", "groups": [], "receipt_id": None}, lab.first.check)
    assert not puts(lab)


@pytest.mark.parametrize("groups", [[], [False], [0, 0], [999]])
def test_group_assignment_requires_existing_unique_nonempty_integer_ids(lab, groups):
    connection = connected(lab)
    with pytest.raises(HTTPException):
        reviewed(lab, connection, action="groups", groups=groups)
    assert not puts(lab)


def test_groups_and_manual_restore_preserve_original_memberships(lab):
    connection = connected(lab)
    changed = execute(lab, connection, reviewed(lab, connection, action="groups", groups=[2]))["receipt"]
    assert lab.remote.clients[0]["groups"] == [2]
    restoration = reviewed(lab, connection, action="restore", receipt_id=changed["id"])
    assert restoration["after_groups"] == [0, 2]
    restored = execute(lab, connection, restoration)["receipt"]
    assert restored["outcome"]["membership_verified"] and lab.remote.clients[0]["groups"] == [0, 2]
    assert len(puts(lab)) == 2


@pytest.mark.parametrize("change", ["client-id", "memberships", "group", "origin", "pin"])
def test_restore_rejects_changed_identity_policy_or_transport(lab, change):
    connection = connected(lab)
    receipt = execute(lab, connection, reviewed(lab, connection))["receipt"]
    if change == "client-id":
        lab.remote.clients[0]["id"] = 99
    elif change == "memberships":
        lab.remote.clients[0]["groups"] = [2]
    elif change == "group":
        lab.remote.groups[0]["name"] = "changed externally"
    elif change == "origin":
        lab.records[receipt["id"]][1]["origin"] = "https://192.168.4.9:443"
    else:
        lab.records[receipt["id"]][1]["pin"] = "a" * 64
    with pytest.raises(HTTPException):
        reviewed(lab, connection, action="restore", receipt_id=receipt["id"])
    assert len(puts(lab)) == 1


def test_authority_loss_after_put_retains_unknown_receipt_but_discloses_nothing(lab):
    connection = connected(lab)
    review = reviewed(lab, connection)
    def after(method, path):
        if method == "PUT":
            lab.first.revoked[0] = True
    lab.remote.after = after
    with pytest.raises(HTTPException) as error:
        execute(lab, connection, review)
    assert error.value.status_code == 401
    saved = next(iter(lab.records.values()))[1]
    assert saved["outcome"]["outcome"] == "unknown" and saved["outcome"]["attempted"]
    assert lab.remote.calls[-1][0] == "PUT" and len(puts(lab)) == 1


def test_revocation_after_receipt_reservation_stops_put_and_retains_no_attempt(lab):
    connection = connected(lab)
    review = reviewed(lab, connection)
    lab.store.after_reserve = lambda: lab.first.revoked.__setitem__(0, True)
    with pytest.raises(HTTPException):
        execute(lab, connection, review)
    assert not puts(lab)
    assert next(iter(lab.records.values()))[1]["outcome"]["outcome"] == "not_attempted"


def test_receipt_reservation_failure_prevents_wire_effect(lab):
    connection = connected(lab)
    review = reviewed(lab, connection)
    def fail():
        raise HTTPException(503, "uncertain receipt store")
    lab.store.before_reserve = fail
    with pytest.raises(HTTPException):
        execute(lab, connection, review)
    assert not puts(lab)


@pytest.mark.parametrize("failure,expected", [("after-put", "unknown"), ("readback", "accepted"), ("different-state", "mismatch")])
def test_uncertain_and_mismatched_outcomes_never_retry(lab, failure, expected):
    connection = connected(lab)
    review = reviewed(lab, connection)
    def after(method, path):
        if failure == "after-put" and method == "PUT":
            raise HTTPException(504, "lost response")
    def before(method, path):
        if failure == "readback" and path == "/api/clients" and puts(lab):
            raise HTTPException(502, "unavailable readback")
    lab.remote.after, lab.remote.before = after, before
    if failure == "different-state":
        lab.remote.mutate = False
    response = execute(lab, connection, review)
    assert response["receipt"]["outcome"]["outcome"] == expected
    assert execute(lab, connection, review) == response and len(puts(lab)) == 1


def test_revocation_stops_next_probe_and_disclosure_on_error(lab):
    connection = connected(lab)
    def after(method, path):
        if path == "/api/clients":
            lab.first.revoked[0] = True
            raise HTTPException(502, "private upstream detail")
    lab.remote.after = after
    with pytest.raises(HTTPException) as error:
        H.inventory(lab.first.request, {"connection_id": connection["id"]}, lab.first.check)
    assert error.value.status_code == 401
    assert lab.remote.calls[-1][1] == "/api/clients"


def test_revoke_and_disconnect_never_contact_pihole(lab):
    connection = connected(lab)
    held = H.CONNECTIONS[connection["id"]]
    H.revoke_browser_session(lab.first.token)
    assert not held.get("sid") and not H.CONNECTIONS and len(lab.remote.calls) == 1
    connection = connected(lab)
    H.disconnect(lab.first.request, {"connection_id": connection["id"]}, lab.first.check)
    assert not H.CONNECTIONS and len(lab.remote.calls) == 2


def test_cross_browser_target_lock_prevents_second_put(lab):
    first_connection = connected(lab)
    first_review = reviewed(lab, first_connection)
    other = lab.browser()
    second_connection = connected(lab, other)
    second_review = reviewed(lab, second_connection, browser=other)
    observations = []
    def before(method, path):
        if method == "PUT":
            with pytest.raises(HTTPException) as error:
                execute(lab, second_connection, second_review, browser=other)
            observations.append(error.value.status_code)
    lab.remote.before = before
    execute(lab, first_connection, first_review)
    assert observations == [409] and len(puts(lab)) == 1


def test_original_captured_check_failure_remains_latched(lab):
    connection = connected(lab)
    lab.first.revoked[0] = True
    with pytest.raises(HTTPException):
        H.inventory(lab.first.request, {"connection_id": connection["id"]}, lambda: None)
    lab.first.revoked[0] = False
    with pytest.raises(HTTPException):
        H.inventory(lab.first.request, {"connection_id": connection["id"]}, lambda: None)
    assert len(lab.remote.calls) == 1


def test_confirmed_outcome_retained_when_disclosure_loses_authority(lab):
    connection = connected(lab)
    review = reviewed(lab, connection)
    lab.store.before_finish = lambda: lab.first.revoked.__setitem__(0, True)
    with pytest.raises(HTTPException) as error:
        execute(lab, connection, review)
    assert error.value.status_code == 401
    assert next(iter(lab.records.values()))[1]["outcome"]["outcome"] == "confirmed"


def test_readback_failure_after_per_item_error_remains_unknown(lab):
    connection = connected(lab)
    review = reviewed(lab, connection)
    lab.remote.put_reply = {"processed": {"success": [], "errors": [{"item": CLIENT["client"], "error": "failed"}]}}
    def before(method, path):
        if path == "/api/clients" and puts(lab):
            raise HTTPException(502, "unavailable readback")
    lab.remote.before = before
    receipt = execute(lab, connection, review)["receipt"]
    assert receipt["outcome"]["outcome"] == "unknown" and receipt["outcome"]["acknowledged"] is False


def test_expired_or_unconfirmed_review_never_reserves_or_puts(lab):
    connection = connected(lab)
    review = reviewed(lab, connection)
    with pytest.raises(HTTPException):
        H.execute(lab.first.request, {"connection_id": connection["id"], "review_id": review["review_id"], "reviewed": False}, lab.first.check)
    lab.now[0] += 121
    with pytest.raises(HTTPException):
        execute(lab, connection, review)
    assert not lab.records and not puts(lab)


def test_upstream_session_cannot_extend_tli_maximum(lab):
    lab.remote.validity = 86400
    connection = connected(lab)
    assert H.CONNECTIONS[connection["id"]]["deadline"] == lab.now[0] + 900


def test_real_receipt_store_survives_connection_reset_and_supports_restore(lab, monkeypatch, tmp_path):
    spec = importlib.util.spec_from_file_location("isolated_pihole_receipts", Path(H.__file__).with_name("pihole_receipts.py"))
    real = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(real)
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(H, "_store", lambda: real)
    lab.store.real_receipts = True
    def verify_before_wire(method, path):
        if method == "PUT":
            assert len(real.list_receipts(lab.first.owner, lab.first.check)) >= 1
    lab.remote.before = verify_before_wire
    connection = connected(lab)
    receipt = execute(lab, connection, reviewed(lab, connection))["receipt"]
    assert receipt["outcome"]["outcome"] == "confirmed"
    H.revoke_all_connections()
    assert real.get(lab.first.owner, receipt["id"], lab.first.check) == receipt
    connection = connected(lab)
    restore = reviewed(lab, connection, action="restore", receipt_id=receipt["id"])
    final = execute(lab, connection, restore)["receipt"]
    assert final["outcome"]["outcome"] == "confirmed" and lab.remote.clients[0]["groups"] == [0, 2]
    contents = "".join(path.read_text(encoding="utf-8") for path in tmp_path.rglob("*.json"))
    assert "PRIVATE-password" not in contents and "syntheticSID" not in contents


@pytest.mark.parametrize("phase", ["preflight", "reserved", "submitted"])
def test_review_deadline_cannot_authorize_late_put_but_keeps_completed_receipt(lab, phase):
    connection = connected(lab)
    review = reviewed(lab, connection)
    def after(method, path):
        if phase == "preflight" and path == "/api/groups" or phase == "submitted" and method == "PUT":
            lab.now[0] += 121
    lab.remote.after = after
    if phase == "reserved":
        lab.store.after_reserve = lambda: lab.now.__setitem__(0, lab.now[0] + 121)
    if phase == "preflight":
        with pytest.raises(HTTPException):
            execute(lab, connection, review)
        assert not lab.records and not puts(lab)
    else:
        receipt = execute(lab, connection, review)["receipt"]
        assert receipt["outcome"]["outcome"] == ("not_attempted" if phase == "reserved" else "confirmed")
        assert len(puts(lab)) == (0 if phase == "reserved" else 1)


def test_duplicate_replay_does_not_invert_connection_and_receipt_locks(lab):
    connection = connected(lab)
    review = reviewed(lab, connection)
    saved = execute(lab, connection, review)
    original_get = lab.store.get
    def checked_get(owner, ident, check):
        assert not H.LOCK._is_owned(), "Receipt callbacks may acquire the connection lock; inverse ordering can deadlock"
        return original_get(owner, ident, check)
    lab.store.get = checked_get
    assert execute(lab, connection, review) == saved and len(puts(lab)) == 1


def test_activity_canonicalizes_ipv6_filter_but_preserves_selected_wire_identity(lab):
    connection = connected(lab)
    lab.remote.clients[0]["client"] = "fd00:0:0::1"
    response = H.activity(lab.first.request, {"connection_id": connection["id"], "client": "fd00:0:0::1"}, lab.first.check)
    query = parse_qs(urlsplit(lab.remote.calls[-1][1]).query)
    assert query["client_ip"] == ["fd00::1"]
    assert response["client"] == "fd00:0:0::1" and response["items"][0]["client"]["ip"] == "fd00::1"
