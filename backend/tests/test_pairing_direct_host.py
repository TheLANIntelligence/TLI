"""Raw Host admission precedes pairing decisions, without network or devices."""
import builtins

import pytest
from fastapi import HTTPException, Response
from starlette.requests import Request

import peer_pairing as peer
import tli_state as S
from routers import companion_routes as companion


def raw_request(hosts, *, browser=False, scheme="https", client="127.0.0.1", server="127.0.0.1"):
    headers = [(b"host", value.encode("ascii")) for value in hosts]
    headers.append((b"cookie", b"tli_session=valid-browser") if browser else
                   (b"authorization", b"Bearer existing-phone-credential"))
    return Request({"type": "http", "method": "POST", "scheme": scheme,
                    "server": (server, 8443), "client": (client, 12345),
                    "path": "/", "root_path": "", "query_string": b"", "headers": headers})


MALFORMED = [[], [""], ["localhost", "localhost"], ["localhost:bad"],
             ["localhost:"], ["localhost:65536"], ["localhost/ignored"],
             ["localhost?ignored"], ["localhost#ignored"], ["user@localhost"],
             ["localhost,localhost"], ["localhost\t"], ["[::1"]]


@pytest.mark.parametrize("hosts", MALFORMED)
def test_peer_browser_rejects_raw_host_before_pin_or_cookie_admission(monkeypatch, hosts):
    monkeypatch.setattr(peer, "_NODE_PAIRING", None)
    monkeypatch.setattr(S, "load_pin_config", lambda: pytest.fail("Malformed Host reached PIN fallback"))
    monkeypatch.setattr(S, "validate_session_token", lambda token: pytest.fail("Malformed Host reached cookie admission"))
    for browser in (False, True):
        request = raw_request(hosts, browser=browser)
        if not browser:
            request.scope["headers"] = [(key, value) for key, value in request.scope["headers"] if key != b"authorization"]
        with pytest.raises(HTTPException) as error:
            peer.browser_owner(request)
        assert error.value.status_code == 403
        assert error.value.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("hostname", ["localhost", "127.0.0.1:8443", "[::1]:8443"])
def test_valid_direct_loopback_and_browser_cookie_keep_existing_peer_admission(monkeypatch, hostname):
    monkeypatch.setattr(peer, "_NODE_PAIRING", None)
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    request = raw_request([hostname])
    request.scope["headers"] = [(key, value) for key, value in request.scope["headers"] if key != b"authorization"]
    assert peer.browser_owner(request) == "local"
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "validate_session_token", lambda token: token == "valid-browser")
    monkeypatch.setattr(S, "get_session_user_id", lambda token: "existing-owner")
    assert peer.browser_owner(raw_request([hostname], browser=True)) == "existing-owner"


def test_node_browser_denial_precedes_any_browser_authority_import(monkeypatch):
    monkeypatch.setattr(peer, "_NODE_PAIRING", object())
    original = builtins.__import__

    def guarded(name, *args, **kwargs):
        assert name != "browser_authority", "Node browser denial imported host browser authority"
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded)
    with pytest.raises(HTTPException) as error:
        peer.browser_owner(raw_request(["localhost"], browser=True))
    assert error.value.status_code == 403
    assert error.value.detail["code"] == "pairing_console_required"


def invoke_companion(kind, request):
    if kind == "landing":
        return companion.pairing_landing(request)
    if kind == "redeem":
        return companion.redeem(companion.RedeemRequest(token="t" * 43, name="Fixture phone", platform="android"), request, Response())
    return companion.upgrade_pairing(companion.UpgradeRequest(token="t" * 43, device_id="fixture-phone"), request, Response(), owner="existing-owner")


@pytest.mark.parametrize("kind", ["landing", "redeem", "upgrade"])
@pytest.mark.parametrize("hosts", [[host.replace("localhost", "192.168.1.20") for host in hosts] for hosts in MALFORMED] + [["tli-home.local:bad"]])
def test_companion_rejects_raw_host_before_supported_host_certificate_or_credentials(monkeypatch, kind, hosts):
    monkeypatch.setattr(S, "TLS_ENABLED", True)
    monkeypatch.setattr(companion, "_supported_host", lambda host: pytest.fail("Malformed Host reached supported-host decision"))
    monkeypatch.setattr(companion, "_certificate", lambda host: pytest.fail("Malformed Host read a certificate"))
    monkeypatch.setattr(companion.auth, "resolve_user", lambda request: pytest.fail("Malformed Host used a credential"))
    monkeypatch.setattr(companion.auth, "redeem_pairing", lambda *args: pytest.fail("Malformed Host redeemed an invitation"))
    monkeypatch.setattr(companion.auth, "upgrade_pairing", lambda *args: pytest.fail("Malformed Host upgraded a pairing"))
    with pytest.raises(HTTPException) as error:
        invoke_companion(kind, raw_request(hosts, server="192.168.1.20"))
    assert error.value.status_code == 403
    assert error.value.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("hostname,expected_host,expected_origin", [
    ("192.168.1.20:8443", "192.168.1.20", "https://192.168.1.20:8443"),
    ("tli-home.local", "tli-home.local", "https://tli-home.local:443"),
])
@pytest.mark.parametrize("kind", ["landing", "redeem", "upgrade"])
def test_valid_companion_lan_requests_keep_reviewed_origin_and_certificate(monkeypatch, hostname, expected_host, expected_origin, kind):
    monkeypatch.setattr(S, "TLS_ENABLED", True)
    monkeypatch.setattr(companion.tls_cert, "stable_lan_origins", lambda port: ["https://tli-home.local:443"])
    seen, effects = [], []
    monkeypatch.setattr(companion, "_certificate", lambda host: seen.append(host) or {"fingerprint": "f" * 64})
    monkeypatch.setattr(companion, "_node", lambda: {"id": "fixture-host"})
    monkeypatch.setattr(companion.auth, "resolve_user", lambda request: "existing-owner")
    monkeypatch.setattr(companion.auth, "redeem_pairing", lambda *args: effects.append(args) or {"device_id": "fixture-phone"})
    monkeypatch.setattr(companion.auth, "upgrade_pairing", lambda *args: effects.append(args))
    result = invoke_companion(kind, raw_request([hostname]))
    if kind == "landing":
        assert result.status_code == 200 and result.headers["cache-control"] == "no-store"
        assert seen == effects == []
    else:
        assert seen == [expected_host] and len(effects) == 1
        assert effects[0][1 if kind == "redeem" else 4] == expected_origin
        assert effects[0][2 if kind == "redeem" else 5] == "f" * 64
        assert result["node"] == {"id": "fixture-host"}
