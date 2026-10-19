"""Bounded model observations with fake transport and no installed host state."""
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

from fastapi import HTTPException
import pytest
import requests

import model_probe as probe


@pytest.fixture
def transport(monkeypatch):
    response = SimpleNamespace(status_code=200, headers={"server": "fixture"},
        iter_content=Mock(return_value=iter([b'{"data": [{"id": "fixture-model"}]}'])), close=Mock())
    session = MagicMock()
    session.__enter__.return_value = session
    session.__exit__.return_value = False
    session.get.return_value = response
    session.post.return_value = response
    factory = Mock(return_value=session)
    monkeypatch.setattr(probe.requests, "Session", factory)
    return SimpleNamespace(response=response, session=session, factory=factory, check=Mock())


@pytest.mark.parametrize("payload", [None, {"model": "fixture", "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1}])
def test_model_probe_explicit_method_and_isolated_session(transport, payload):
    f = transport
    value = probe.probe_json("http://127.0.0.1:1234/v1/models", check=f.check, payload=payload)
    assert value["data"] == {"data": [{"id": "fixture-model"}]}
    assert value["status_code"] == 200 and value["server_header"] == "fixture"
    assert value["latency_ms"] >= 0 and f.session.trust_env is False
    called, unused = (f.session.get, f.session.post) if payload is None else (f.session.post, f.session.get)
    unused.assert_not_called()
    assert called.call_args.kwargs["allow_redirects"] is False
    assert called.call_args.kwargs["stream"] is True
    assert called.call_args.kwargs["headers"] == {"Accept": "application/json"}
    assert called.call_args.kwargs.get("json") == payload
    f.response.close.assert_called_once()
    f.session.__exit__.assert_called_once()


@pytest.mark.parametrize("status", [201, 204, 400, 401, 403, 404, 500, 503])
def test_model_probe_non_success_never_loads_error_body(transport, status):
    transport.response.status_code = status
    result = probe.probe_json("http://model.invalid/models", check=transport.check)
    assert result["status_code"] == status and result["data"] is None
    transport.response.iter_content.assert_not_called()
    transport.response.close.assert_called_once()


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_model_probe_refuses_redirect_without_second_destination(transport, status):
    transport.response.status_code = status
    with pytest.raises(probe.ModelProbeError) as caught:
        probe.probe_json("http://model.invalid/models", check=transport.check)
    assert caught.value.code == "redirected"
    transport.response.iter_content.assert_not_called()
    transport.session.get.assert_called_once()
    transport.response.close.assert_called_once()


@pytest.mark.parametrize("body,code", [(b'{', "invalid_response"), (b'\xff', "invalid_response"),
    (b'[' * 2000, "invalid_response"), (b'a' * (probe.MAX_RESPONSE_BYTES + 1), "too_large")],
    ids=["broken-json", "invalid-utf8", "deep-json", "oversized"])
def test_model_probe_bounds_and_decodes_body(transport, body, code):
    transport.response.iter_content.return_value = iter([body])
    with pytest.raises(probe.ModelProbeError) as caught:
        probe.probe_json("http://model.invalid/models", check=transport.check)
    assert caught.value.code == code
    transport.response.close.assert_called_once()


@pytest.mark.parametrize("error,code", [(requests.Timeout("PRIVATE URL"), "timed_out"),
    (requests.ConnectionError("PRIVATE URL"), "unavailable"), (RuntimeError("PRIVATE BODY"), "unavailable")])
@pytest.mark.parametrize("phase", ["request", "body", "close"])
def test_model_probe_redacts_upstream_errors_and_closes(transport, error, code, phase):
    f = transport
    if phase == "request":
        f.session.get.side_effect = error
    elif phase == "body":
        f.response.iter_content.side_effect = error
    else:
        f.response.close.side_effect = error
    with pytest.raises(probe.ModelProbeError) as caught:
        probe.probe_json("http://model.invalid/models", check=f.check)
    assert caught.value.code == code and "PRIVATE" not in str(caught.value)
    f.session.__exit__.assert_called_once()
    if phase != "request":
        f.response.close.assert_called_once()


@pytest.mark.parametrize("status", [401, 403, 503])
@pytest.mark.parametrize("phase", ["before", "request", "body", "close", "session-close"])
def test_model_probe_authority_loss_prevents_disclosure(transport, phase, status):
    f = transport
    denial = HTTPException(status, "Access ended")
    def lose(*args, **kwargs):
        f.check.side_effect = denial
        return f.response
    if phase == "before":
        f.check.side_effect = denial
    elif phase == "request":
        f.session.get.side_effect = lose
    elif phase == "body":
        def chunks(**kwargs):
            lose()
            yield b'{"data": []}'
        f.response.iter_content.side_effect = chunks
    elif phase == "close":
        f.response.close.side_effect = lose
    else:
        f.session.__exit__.side_effect = lambda *args: (lose(), False)[1]
    with pytest.raises(HTTPException) as caught:
        probe.probe_json("http://model.invalid/models", check=f.check)
    assert caught.value is denial
    if phase == "before":
        f.factory.assert_not_called()
    else:
        f.response.close.assert_called_once()


def test_cleanup_failure_cannot_replace_original_authority_denial(transport):
    denial = HTTPException(401, "Original session ended")
    def arrived(*args, **kwargs):
        transport.check.side_effect = denial
        return transport.response
    transport.session.get.side_effect = arrived
    transport.response.close.side_effect = RuntimeError("PRIVATE cleanup")
    with pytest.raises(HTTPException) as caught:
        probe.probe_json("http://model.invalid/models", check=transport.check)
    assert caught.value is denial


@pytest.mark.parametrize("phase", ["request", "body", "close"])
def test_model_probe_cooperative_deadline(transport, monkeypatch, phase):
    now = [0.0]
    monkeypatch.setattr(probe.time, "monotonic", lambda: now[0])
    def elapsed(*args, **kwargs):
        now[0] = 13
        return transport.response
    if phase == "request":
        transport.session.get.side_effect = elapsed
    elif phase == "body":
        def chunks(**kwargs):
            yield b'{"data":'
            elapsed()
            yield b'[]}'
        transport.response.iter_content.side_effect = chunks
    else:
        transport.response.close.side_effect = elapsed
    with pytest.raises(probe.ModelProbeError) as caught:
        probe.probe_json("http://model.invalid/models", check=transport.check)
    assert caught.value.code == "timed_out"
    transport.response.close.assert_called_once()


def test_revocation_precedes_cooperative_timeout(transport, monkeypatch):
    now = [0]
    monkeypatch.setattr(probe.time, "monotonic", lambda: now[0])
    denial = HTTPException(401, "Access ended")
    def arrived(*args, **kwargs):
        now[0] = 13
        transport.check.side_effect = denial
        return transport.response
    transport.session.get.side_effect = arrived
    with pytest.raises(HTTPException) as caught:
        probe.probe_json("http://model.invalid/models", check=transport.check)
    assert caught.value is denial
