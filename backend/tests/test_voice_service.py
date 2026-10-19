"""Voice tests use synthetic audio/processes; never load a model or contact speakers."""
import http.client
import io
import json
import threading
import time
import wave
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import voice_service as voice
import tli_state as S
from routers.voice_routes import router


def synthetic_wav(seconds=1):
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b'\x00\x00' * int(16000 * seconds))
    return output.getvalue()


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, '_active_sessions', {})
    monkeypatch.setattr(voice, '_jobs', {})
    monkeypatch.setattr(voice, '_clips', {})
    monkeypatch.setattr(voice, '_cancelled', {})
    monkeypatch.setattr(voice, '_listener', None)
    monkeypatch.setattr(voice, '_available', lambda: True)
    yield
    voice.shutdown()


def test_core_capability_check_does_not_load_model_or_start_listener(monkeypatch):
    monkeypatch.setattr(voice, '_available', lambda: False)
    monkeypatch.setattr(voice, 'interface_addresses', lambda: [])
    load = Mock(side_effect=AssertionError('must not synthesize'))
    monkeypatch.setattr(voice, '_synthesize', load)
    result = voice.capabilities('owner')
    assert result['host_voice_supported'] is False
    assert result['model_downloads'] is False
    assert result['media_enabled'] is False
    assert voice._listener is None
    load.assert_not_called()


def test_config_requires_existing_local_model_and_host_interface(tmp_path, monkeypatch):
    monkeypatch.setattr(voice, 'interface_addresses', lambda: ['192.168.1.2'])
    with pytest.raises(HTTPException):
        voice.configure('owner', 'base.en', '', 8766, lambda: None)
    model = tmp_path / 'model'
    model.mkdir()
    for name in ('model.bin', 'config.json', 'tokenizer.json'):
        (model / name).write_text('fixture')
    with pytest.raises(HTTPException):
        voice.configure('owner', str(model), '0.0.0.0', 8766, lambda: None)
    result = voice.configure('owner', str(model), '192.168.1.2', 8766, lambda: None)
    assert result['settings']['model_path'] == str(model.resolve())
    assert result['media_enabled'] is False
    assert voice.capabilities('other')['settings'] == {}


def test_transcription_only_uses_configured_path_and_never_downloads(tmp_path, monkeypatch):
    model = tmp_path / 'model'; model.mkdir()
    monkeypatch.setattr(voice, '_read_settings', lambda: {'owner': {'model_path': str(model)}})
    monkeypatch.setattr(voice.importlib.util, 'find_spec', lambda _: object())
    calls = []
    def run(job, argv, payload, timeout):
        calls.append((argv, payload, timeout))
        return b'{"text":"fix this game","duration":2}'
    monkeypatch.setattr(voice, '_process', run)
    result = voice.transcribe('owner', 'a'*16, b'audio', lambda: None)
    assert result['text'] == 'fix this game'
    assert result['sent_to_chat'] is False
    assert calls[0][1]['model'] == str(model)
    assert 'local_files_only=True' in calls[0][0][-1]
    assert 'device=\'cpu\'' in calls[0][0][-1]
    with pytest.raises(HTTPException):
        voice.transcribe('owner', 'a'*16, b'audio', lambda: None)


def test_sapi_text_is_stdin_data_not_command(tmp_path, monkeypatch):
    dangerous = 'hello $(Start-Process nope); "quoted" `data`'
    seen = []
    def run(job, argv, payload, timeout):
        seen.append((argv, payload))
        from pathlib import Path
        Path(payload['path']).write_bytes(b'RIFF' + b'\x00'*4 + b'WAVE' + b'\x00'*40)
        return b''
    monkeypatch.setattr(voice, '_process', run)
    job = voice._start('owner', 'x'*16, 'speak', lambda: None)
    assert voice._synthesize(job, dangerous).startswith(b'RIFF')
    assert seen[0][1]['text'] == dangerous
    assert dangerous not in ' '.join(seen[0][0])
    assert 'ReadToEnd' in seen[0][0][-1]


def test_speak_rejects_incomplete_or_other_owned_run(monkeypatch):
    import host_runs
    synth = Mock()
    monkeypatch.setattr(voice, '_synthesize', synth)
    monkeypatch.setattr(host_runs, 'get', lambda run_id, owner: {'status': 'failed', 'text': 'partial'})
    with pytest.raises(HTTPException) as error:
        voice.speak('owner', 'x'*16, 'run', None, 25, lambda: None)
    assert error.value.status_code == 409
    synth.assert_not_called()


def test_browser_audio_owner_expiry_revocation_and_cancel(monkeypatch):
    import host_runs
    monkeypatch.setattr(host_runs, 'get', lambda *_: {'status': 'completed', 'result': {'reply': 'complete'}})
    audio = synthetic_wav()
    monkeypatch.setattr(voice, '_synthesize', lambda *_: audio)
    valid = [True]
    def check():
        if not valid[0]:
            raise HTTPException(401, 'revoked')
    result = voice.speak('owner', 'x'*16, 'run', None, 25, check)
    token = result['clip_id']
    assert voice.browser_audio('owner', token, check) == audio
    assert result['duration_seconds'] == 1
    assert result['capture_hold_seconds'] == 11
    with pytest.raises(HTTPException):
        voice.browser_audio('other', token, lambda: None)
    valid[0] = False
    with pytest.raises(HTTPException):
        voice.browser_audio('owner', token, lambda: None)
    assert token not in voice._clips
    valid[0] = True
    result = voice.speak('owner', 'y'*16, 'run', None, 25, check)
    voice.cancel('owner', 'y'*16)
    assert result['clip_id'] not in voice._clips


@pytest.mark.parametrize('value,expected', [(None,(0,9,False)),('bytes=2-4',(2,4,True)),('bytes=-3',(7,9,True)),('bytes=8-',(8,9,True))])
def test_single_audio_ranges(value, expected):
    assert voice._range(value, 10) == expected


@pytest.mark.parametrize('value', ['bytes=30-', 'bytes=4-2', 'bytes=0-1,3-4', 'bytes=-0', 'garbage'])
def test_invalid_audio_ranges(value):
    with pytest.raises(ValueError):
        voice._range(value, 10)


def test_media_handler_limits_target_ranges_head_and_revoked_tokens():
    server = voice._MediaServer(('127.0.0.1', 0), voice._MediaHandler)
    server.owner = 'owner'
    job = voice._start('owner', 'x'*16, 'speak', lambda: None)
    voice._clips['token'] = {'owner':'owner','audio':b'0123456789','target_ip':'127.0.0.1','expires':time.monotonic()+60,'check':lambda:None,'job':job,'remote_clip_id':None}
    thread = threading.Thread(target=server.serve_forever, daemon=True);thread.start()
    def get(method='GET', headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
        conn.request(method, '/audio/token.wav', headers=headers or {})
        response = conn.getresponse();value=(response.status,dict(response.getheaders()),response.read());conn.close();return value
    try:
        assert get()[2] == b'0123456789'
        status,headers,data = get(headers={'Range':'bytes=2-4'})
        assert (status,data) == (206,b'234')
        assert headers['Content-Range'] == 'bytes 2-4/10'
        assert get('HEAD')[2] == b''
        assert get(headers={'Range':'bytes=100-'})[0] == 416
        voice._clips['token']['target_ip'] = '192.168.1.99'
        assert get()[0] == 404
        voice._clips['token']['target_ip'] = '127.0.0.1'
        voice._clips['token']['expires'] = 0
        assert get()[0] == 404
    finally:
        server.shutdown();server.server_close();thread.join(timeout=2)


def test_all_browser_endpoints_reject_open_lan_and_cross_origin(monkeypatch):
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    app = FastAPI();app.include_router(router)
    effect = Mock()
    monkeypatch.setattr(voice, 'capabilities', effect)
    with TestClient(app, base_url='http://host.test', client=('192.168.1.20',123)) as client:
        assert client.get('/api/voice/capabilities').status_code == 403
    with TestClient(app, base_url='http://localhost', client=('127.0.0.1',123)) as client:
        assert client.post('/api/voice/media/enable', headers={'Origin':'http://other.test'}).status_code == 403
        assert client.post('/api/voice/media/enable').status_code == 403
    effect.assert_not_called()


def test_process_checks_revocation_and_kills_child(monkeypatch):
    process = Mock()
    process.poll.return_value = None
    process.communicate.side_effect = [voice.subprocess.TimeoutExpired('voice', .2), (b'',b'')]
    monkeypatch.setattr(voice.subprocess, 'Popen', Mock(return_value=process))
    allowed = [True]
    def check():
        if not allowed[0]:
            raise HTTPException(401, 'revoked')
    job = voice._start('owner', 'x'*16, 'speak', check)
    def communicate(**kwargs):
        if kwargs:
            allowed[0] = False
            raise voice.subprocess.TimeoutExpired('voice', .2)
        return b'', b''
    process.communicate.side_effect = communicate
    with pytest.raises(HTTPException):
        voice._process(job, ['fixture'], {'text':'test'}, 10)
    process.kill.assert_called_once()
    assert voice.subprocess.Popen.call_args.kwargs['env']['HF_HUB_OFFLINE'] == '1'


def test_stop_arriving_before_upload_processing_prevents_later_work():
    voice.cancel('owner', 'cancelled-request-1')
    with pytest.raises(HTTPException) as error:
        voice._start('owner', 'cancelled-request-1', 'transcribe', lambda: None)
    assert error.value.status_code == 409
    assert voice._jobs == {}


def test_explicit_announcement_uses_local_tts_and_host_issued_scoped_url(monkeypatch):
    import sonos_service
    status = Mock(return_value={'device': {'ip':'192.168.1.20'}})
    send = Mock(return_value={'outcome':'accepted','clip_id':'remote-owned-clip'})
    synth = Mock(return_value=synthetic_wav(2.5))
    monkeypatch.setattr(sonos_service, 'status', status)
    monkeypatch.setattr(sonos_service, 'announce', send)
    monkeypatch.setattr(voice, '_synthesize', synth)
    monkeypatch.setattr(voice, '_listener', SimpleNamespace(owner='owner', server_address=('192.168.1.2',8766), stop=threading.Event()))
    result = voice.announce('owner','announcement-012345','speaker','Dinner is ready',25,lambda: None)
    assert result['outcome'] == 'accepted'
    assert result['duration_seconds'] == 2.5
    assert result['capture_hold_seconds'] == 12.5
    synth.assert_called_once()
    assert synth.call_args.args[1] == 'Dinner is ready'
    assert send.call_args.args[2].startswith('http://192.168.1.2:8766/audio/')
    assert voice._clips[result['clip_id']]['target_ip'] == '192.168.1.20'
    with pytest.raises(HTTPException):
        voice.announce('owner','announcement-012345','speaker','Dinner is ready',25,lambda: None)
    assert send.call_count == 1


def test_explicit_announcement_needs_speaker_and_enabled_media(monkeypatch):
    import sonos_service
    monkeypatch.setattr(sonos_service, 'status', lambda *a, **kw: {'device':{'ip':'192.168.1.20'}})
    synth = Mock();monkeypatch.setattr(voice, '_synthesize', synth)
    with pytest.raises(HTTPException):
        voice.announce('owner','announcement-012345','','hello',25,lambda: None)
    with pytest.raises(HTTPException) as error:
        voice.announce('owner','announcement-012346','speaker','hello',25,lambda: None)
    assert error.value.status_code == 409
    synth.assert_not_called()


@pytest.mark.parametrize('seconds', [None, 0, 181])
def test_generated_audio_requires_bounded_measurable_duration(seconds):
    audio = b'invalid-wav' if seconds is None else synthetic_wav(seconds)
    with pytest.raises(HTTPException):
        voice._audio_duration(audio)


def test_invalid_generated_audio_is_never_sent_to_a_speaker(monkeypatch):
    import sonos_service
    send = Mock()
    monkeypatch.setattr(sonos_service, 'status', lambda *a, **kw: {'device':{'ip':'192.168.1.20'}})
    monkeypatch.setattr(sonos_service, 'announce', send)
    monkeypatch.setattr(voice, '_synthesize', lambda *a: b'invalid-wav')
    monkeypatch.setattr(voice, '_listener', SimpleNamespace(owner='owner', server_address=('192.168.1.2',8766), stop=threading.Event()))
    with pytest.raises(HTTPException):
        voice.announce('owner','announcement-invalid','speaker','Dinner is ready',25,lambda: None)
    send.assert_not_called()
    assert not voice._clips
