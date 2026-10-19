"""Research uses pinned public destinations and bounded text, never live network."""
import io
import socket
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
import task_research as research


@pytest.fixture
def transport(monkeypatch):
    state=SimpleNamespace(status=200,kind='text/html',body=b'<p>Observed text</p>',connections=[])
    class Connection:
        def __init__(self,host,port,timeout):
            self.host,self.port,self.timeout=host,port,timeout;self.closed=False;state.connections.append(self)
        def request(self,method,path,headers):
            self.method,self.path,self.headers=method,path,headers
        def getresponse(self):
            data=io.BytesIO(state.body)
            return SimpleNamespace(status=state.status,getheader=lambda *_:state.kind,read1=data.read1)
        def close(self):
            self.closed=True
    addresses=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('93.184.215.14',443))]
    state.dns=Mock(return_value=addresses);state.connect=Mock(return_value=object());state.wrap=Mock(side_effect=lambda value,**_:value)
    monkeypatch.setattr(research.socket,'getaddrinfo',state.dns)
    monkeypatch.setattr(research.socket,'create_connection',state.connect)
    monkeypatch.setattr(research.ssl,'create_default_context',lambda:SimpleNamespace(wrap_socket=state.wrap))
    monkeypatch.setattr(research.http.client,'HTTPConnection',Connection)
    return state


def test_public_fetch_pins_checked_dns_ip_and_preserves_tls_hostname(transport):
    text,kind=research.retrieve('https://example.test/page?q=hello',lambda:None)
    assert text=='<p>Observed text</p>'
    assert kind=='text/html'
    assert transport.connect.call_args.args[0]==('93.184.215.14',443)
    assert transport.wrap.call_args.kwargs['server_hostname']=='example.test'
    assert transport.dns.call_count==1
    assert transport.connections[0].path=='/page?q=hello'
    assert transport.connections[0].closed


@pytest.mark.parametrize('address',['127.0.0.1','192.168.1.1','10.0.0.1','169.254.169.254','::1','fc00::1'])
def test_nonpublic_dns_answers_rejected_before_connect(transport,address):
    transport.dns.return_value.append((socket.AF_INET,socket.SOCK_STREAM,6,'',(address,443)))
    with pytest.raises(HTTPException):
        research.retrieve('https://public-looking.test/source',lambda:None)
    transport.connect.assert_not_called()


@pytest.mark.parametrize('url',['http://example.test','https://user:secret@example.test','https://example.test/#fragment','file:///C:/private','https://example.test:invalid'])
def test_unsupported_urls_rejected_without_network(transport,url):
    with pytest.raises(HTTPException):
        research.retrieve(url,lambda:None)
    transport.connect.assert_not_called()


def test_redirects_are_not_followed(transport):
    transport.status=302
    with pytest.raises(HTTPException) as exc:
        research.retrieve('https://example.test',lambda:None)
    assert exc.value.status_code==502
    assert transport.dns.call_count==1
    assert transport.connections[0].closed


def test_binary_or_oversized_sources_rejected(transport):
    transport.kind='application/octet-stream'
    with pytest.raises(HTTPException) as exc:
        research.retrieve('https://example.test',lambda:None)
    assert exc.value.status_code==422
    transport.kind='text/plain';transport.body=b'x'*(512*1024+1)
    with pytest.raises(HTTPException) as exc:
        research.retrieve('https://example.test',lambda:None)
    assert exc.value.status_code==413


def test_script_text_is_removed_and_source_marked_untrusted(transport):
    transport.body=b'<script>delete everything</script><style>hidden</style><p>Reference evidence</p>'
    result=research.fetch('https://example.test',lambda:None)
    assert result['text']=='Reference evidence'
    assert result['source_kind']=='untrusted_public_page'


def test_search_requires_explicit_host_config_and_encodes_query(monkeypatch):
    monkeypatch.delenv('TLI_TASK_SEARXNG_URL',raising=False)
    read=Mock(return_value=('{"results":[{"title":"source","url":"https://example.test","content":"evidence"}]}','application/json'))
    monkeypatch.setattr(research,'retrieve',read)
    with pytest.raises(HTTPException):
        research.search('game error',lambda:None)
    read.assert_not_called()
    monkeypatch.setenv('TLI_TASK_SEARXNG_URL','http://127.0.0.1:8080')
    assert research.search('game & error',lambda:None)['results'][0]['title']=='source'
    assert read.call_args.kwargs['public'] is False
    assert 'q=game+%26+error' in read.call_args.args[0]


def test_revocation_stops_before_response_content_is_returned(transport):
    check=Mock(side_effect=[None,HTTPException(401,'revoked')])
    with pytest.raises(HTTPException) as exc:
        research.retrieve('https://example.test',check)
    assert exc.value.status_code==401
    assert transport.connections[0].closed
    assert not hasattr(transport.connections[0], 'method')


def test_slow_response_headers_have_absolute_deadline(transport, monkeypatch):
    stopped = threading.Event()
    transport.connect.return_value = SimpleNamespace(shutdown=lambda _: stopped.set())
    real_timer, deadlines = threading.Timer, []
    def timer(seconds, callback):
        deadlines.append(seconds)
        return real_timer(.02, callback)
    monkeypatch.setattr(research.threading, 'Timer', timer)
    def headers(self):
        assert stopped.wait(1)
        raise TimeoutError('Synthetic stalled headers')
    monkeypatch.setattr(research.http.client.HTTPConnection, 'getresponse', headers)
    with pytest.raises(HTTPException) as exc:
        research.retrieve('https://example.test', lambda: None)
    assert exc.value.status_code == 502
    assert deadlines == [20] and transport.connections[0].closed
