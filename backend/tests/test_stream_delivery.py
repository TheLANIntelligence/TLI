"""Real loopback SSE transport, with a synthetic server gated by the consumer.

No model, TLI server, discovery or household service is started. The test-only
transport can send only to the exact ephemeral loopback server it owns.
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread

import pytest
import requests
from ai import ai_routes


@pytest.mark.parametrize('terminated', [True, False])
def test_small_utf8_frame_arrives_before_provider_finishes(monkeypatch, terminated):
    first = json.dumps({'choices': [{'delta': {'content': 'Hi — 你好'}}]}, ensure_ascii=False)
    frame = ('data: ' + first + '\n\n').encode('utf-8')
    assert len(frame) < 512  # requests' former default could withhold this frame
    sent, release, delivered = Event(), Event(), Event()
    received, transport_errors = [], []

    class Provider(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Connection', 'close')
            self.end_headers()
            # Split a multi-byte character across network writes as well.
            split = frame.index('你'.encode()) + 1
            self.wfile.write(frame[:split]); self.wfile.flush()
            self.wfile.write(frame[split:]); self.wfile.flush()
            sent.set()
            release.wait(5)
            if terminated:
                self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
            self.close_connection = True

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    url = f'http://127.0.0.1:{server.server_port}/v1/chat/completions'
    server_thread = Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    session = requests.Session()
    session.trust_env = False

    def owned_post(destination, **kwargs):
        assert destination == url
        assert kwargs.pop('allow_redirects') is False
        prepared = requests.Request('POST', url, json=kwargs.pop('json')).prepare()
        # Use the real byte decoder while retaining the suite's global network
        # prohibition. Session.request remains blocked for every other caller.
        return session.send(prepared, allow_redirects=False, **kwargs)

    monkeypatch.setattr(ai_routes.requests, 'post', owned_post)

    def consume():
        try:
            for item in ai_routes._llama_stream_unlocked(url, {'messages': []}, allow_redirects=False):
                received.append(json.loads(item))
                if received[-1].get('choices'):
                    delivered.set()
        except Exception as exc:
            transport_errors.append(str(exc))

    reader = Thread(target=consume, daemon=True)
    try:
        reader.start()
        assert sent.wait(3), 'The owned provider did not send its first frame'
        assert delivered.wait(2), 'First response was buffered until later provider output'
        assert not release.is_set()  # observed before completion, not a duration guess
        assert received[0]['choices'][0]['delta']['content'] == 'Hi — 你好'
    finally:
        release.set()
        reader.join(5)
        server.shutdown()
        server.server_close()
        server_thread.join(3)
        session.close()
    assert not reader.is_alive() and not server_thread.is_alive()
    assert not transport_errors
    errors = [item for item in received if item.get('type') == 'error']
    if terminated:
        assert not errors and len(received) == 1
    else:
        assert len(errors) == 1 and 'interrupted' in errors[0]['detail']
