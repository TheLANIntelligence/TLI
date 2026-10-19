"""Optional host-local voice, with ephemeral session-bound audio capabilities.

Nothing is loaded, downloaded, recorded or exposed on a LAN at import time.
The media listener serves only generated WAV bytes to one enrolled speaker IP.
"""
from __future__ import annotations

import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fastapi import HTTPException
import tli_state as S
from process_utils import hidden_process_kwargs

MAX_UPLOAD = 8 * 1024 * 1024
MAX_TEXT = 8000
CLIP_TTL = 120
_lock = threading.RLock()
_jobs = {}
_clips = {}
_cancelled = {}
_listener = None
_janitor_store = None

# This program receives paths/text as JSON data, never as executable source.
_STT = r'''
import json, sys
from pathlib import Path
import av
import numpy as np
from faster_whisper import WhisperModel
p = json.load(sys.stdin)
if not all((Path(p['model']) / name).is_file() for name in ('model.bin', 'config.json', 'tokenizer.json')):
    raise ValueError('Local model files are missing; downloading is disabled')
chunks, samples = [], 0
with av.open(p['audio']) as source:
    resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
    for frame in source.decode(audio=0):
        for frame in resampler.resample(frame):
            samples += frame.samples
            if samples > 31 * 16000:
                raise ValueError('Audio exceeds thirty seconds')
            chunks.append(frame.to_ndarray().flatten())
    for frame in resampler.resample(None):
        samples += frame.samples
        if samples > 31 * 16000:
            raise ValueError('Audio exceeds thirty seconds')
        chunks.append(frame.to_ndarray().flatten())
if not chunks:
    raise ValueError('No audio')
audio = np.concatenate(chunks).astype(np.float32) / 32768.0
model = WhisperModel(p['model'], device='cpu', compute_type='int8', local_files_only=True, cpu_threads=2, num_workers=1)
segments, info = model.transcribe(audio, language='en', beam_size=1, condition_on_previous_text=False)
parts = []
for n, segment in enumerate(segments):
    parts.append(segment.text.strip())
    if n > 256 or sum(map(len, parts)) > 8000:
        raise ValueError('Transcript too large')
print(json.dumps({'text': ' '.join(parts), 'duration': samples / 16000}))
'''
_TTS = r"""
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $speaker.SetOutputToWaveFile([string]$data.path)
  $speaker.Speak([string]$data.text)
} finally { $speaker.Dispose() }
"""


def _settings_path():
    return Path(S.DATA_DIR) / 'voice' / 'settings.json'


def _read_settings():
    path = _settings_path()
    try:
        value = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, OSError):
        raise HTTPException(503, 'Voice settings cannot be read.') from None


def interface_addresses():
    import psutil
    result = set()
    for values in psutil.net_if_addrs().values():
        for value in values:
            try:
                address = ipaddress.ip_address(value.address)
                if address.version == 4 and address.is_private and not (address.is_loopback or address.is_link_local or address.is_unspecified or address.is_multicast):
                    result.add(str(address))
            except ValueError:
                pass
    return sorted(result)


def _available():
    return sys.version_info >= (3, 11) and sys.platform == 'win32'


def capabilities(owner):
    with _lock:
        settings = _read_settings().get(owner, {})
        listener = _listener
    return {'protocol': 'tli-voice-v1', 'host_voice_supported': _available(),
            'reason': None if _available() else 'Host voice requires Windows with Python 3.11 or newer. Existing browser-local dictation remains available.',
            'transcription_installed': importlib.util.find_spec('faster_whisper') is not None,
            'settings': settings, 'interfaces': interface_addresses(),
            'media_enabled': bool(listener and listener.owner == owner and not listener.stop.is_set()),
            'model_downloads': False, 'cloud_fallback': False, 'max_recording_seconds': 30}


def configure(owner, model_path, bind_ip, port, check):
    check()
    model = None
    if model_path:
        candidate = Path(model_path)
        if not candidate.is_absolute() or not candidate.is_dir():
            raise HTTPException(422, 'Choose an existing absolute directory containing a preinstalled faster-whisper model.')
        model = str(candidate.resolve())
        if not all((Path(model) / name).is_file() for name in ('model.bin', 'config.json', 'tokenizer.json')):
            raise HTTPException(422, 'The local model directory needs model.bin, config.json and tokenizer.json. TLI does not download missing model files.')
    if bind_ip and bind_ip not in interface_addresses():
        raise HTTPException(422, 'Choose a private IPv4 address assigned to this host.')
    if type(port) is not int or not 1024 <= port <= 65535:
        raise HTTPException(422, 'Choose a media port from 1024 to 65535.')
    with _lock:
        if _listener and _listener.owner == owner:
            raise HTTPException(409, 'Disable the media listener before changing voice settings.')
        check()
        settings = _read_settings()
        settings[owner] = {'model_path': model or '', 'bind_ip': bind_ip or '', 'port': port}
        path = _settings_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.voice-')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(settings, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return capabilities(owner)


def _cleanup():
    now = time.monotonic()
    with _lock:
        for key, clip in list(_clips.items()):
            try:
                clip['check']()
                valid = clip['expires'] > now and not clip['job']['stop'].is_set()
            except Exception:
                valid = False
            if not valid:
                _clips.pop(key, None)
        for key, job in list(_jobs.items()):
            if job.get('finished', now) + 300 < now:
                _jobs.pop(key, None)
        for key, expires in list(_cancelled.items()):
            if expires < now:
                _cancelled.pop(key, None)


def _ensure_expiry_worker():
    global _janitor_store
    with _lock:
        if _janitor_store is _clips:
            return
        store = _clips
        _janitor_store = store
    def expire():
        global _janitor_store
        try:
            while True:
                with _lock:
                    if _clips is not store or not store:
                        return
                _cleanup()
                time.sleep(0.5)
        finally:
            with _lock:
                if _janitor_store is store:
                    _janitor_store = None
    threading.Thread(target=expire, name='tli-voice-expiry', daemon=True).start()


def _start(owner, request_id, kind, check, fingerprint=None):
    check()
    _cleanup()
    with _lock:
        key = (owner, request_id)
        if key in _cancelled:
            raise HTTPException(409, 'This voice request was cancelled before processing. It was not started.')
        if key in _jobs:
            old = _jobs[key]
            if old['kind'] != kind or old.get('fingerprint') != fingerprint:
                raise HTTPException(409, 'This voice request ID belongs to different work.')
            raise HTTPException(409, 'This voice request was already submitted. It was not repeated.')
        if len(_jobs) >= 256 or sum('finished' not in job for job in _jobs.values()) >= 4:
            raise HTTPException(429, 'Voice processing is busy. Try again after the current operation finishes.')
        job = {'owner': owner, 'request_id': request_id, 'kind': kind, 'fingerprint': fingerprint,
               'stop': threading.Event(), 'check': check, 'process': None}
        _jobs[key] = job
        return job


def _check(job):
    job['check']()
    if job['stop'].is_set():
        raise HTTPException(409, 'Voice operation stopped. No remaining speech will be sent.')


def _process(job, argv, payload, timeout):
    _check(job)
    environment = dict(os.environ)
    environment.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1')
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment,
                                   **hidden_process_kwargs())
    except OSError:
        raise HTTPException(503, 'The local voice runtime could not start. Check the host installation.') from None
    job['process'] = process
    started = time.monotonic()
    try:
        data = json.dumps(payload, ensure_ascii=True).encode('utf-8')
        while True:
            _check(job)
            if time.monotonic() - started > timeout:
                raise HTTPException(408, 'Local voice processing reached its time limit.')
            try:
                output, errors = process.communicate(input=data, timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                data = None
        _check(job)
        if process.returncode or len(output) > 40000 or len(errors) > 100000:
            raise HTTPException(422, 'Local voice processing failed. Check the installed model and optional voice dependencies; no cloud fallback was used.')
        return output
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate()
        job['process'] = None


def transcribe(owner, request_id, data, check):
    if not _available():
        raise HTTPException(503, capabilities(owner)['reason'])
    if not data or len(data) > MAX_UPLOAD:
        raise HTTPException(413, 'Record up to thirty seconds and eight MB of audio.')
    with _lock:
        model = _read_settings().get(owner, {}).get('model_path')
    if not model or not Path(model).is_dir() or importlib.util.find_spec('faster_whisper') is None:
        raise HTTPException(503, 'Configure a preinstalled local faster-whisper model and optional voice dependencies first. Nothing was downloaded.')
    job = _start(owner, request_id, 'transcribe', check)
    try:
        with tempfile.TemporaryDirectory(prefix='tli-voice-') as directory:
            path = Path(directory) / 'recording.audio'
            path.write_bytes(data)
            try:
                result = json.loads(_process(job, [sys.executable, '-I', '-c', _STT], {'audio': str(path), 'model': model}, 120))
            except (ValueError, UnicodeError):
                raise HTTPException(422, 'The local transcription process returned an unreadable result.') from None
            _check(job)
            if not isinstance(result, dict) or not isinstance(result.get('text'), str) or len(result['text']) > MAX_TEXT:
                raise HTTPException(422, 'The local transcript was invalid.')
            return {'text': result['text'], 'duration': result.get('duration'), 'source': 'local_host', 'sent_to_chat': False}
    finally:
        job['finished'] = time.monotonic()


def _synthesize(job, text):
    if not _available():
        raise HTTPException(503, 'Host speech requires Windows with Python 3.11 or newer.')
    if not text.strip() or len(text) > MAX_TEXT:
        raise HTTPException(422, 'This completed response is too long for speech (maximum 8,000 characters).')
    executable = str(Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'WindowsPowerShell' / 'v1.0' / 'powershell.exe')
    with tempfile.TemporaryDirectory(prefix='tli-voice-') as directory:
        path = Path(directory) / 'speech.wav'
        _process(job, [executable, '-NoProfile', '-NonInteractive', '-Command', _TTS], {'text': text, 'path': str(path)}, 60)
        _check(job)
        if not path.is_file() or path.stat().st_size > MAX_UPLOAD:
            raise HTTPException(413, 'Generated speech exceeded the audio limit.')
        data = path.read_bytes()
        if len(data) < 44 or data[:4] != b'RIFF' or data[8:12] != b'WAVE':
            raise HTTPException(422, 'Windows did not produce valid WAV audio.')
        return data


def _completed_reply(owner, run_id):
    import host_runs
    run = host_runs.get(run_id, owner)
    if run.get('status') != 'completed':
        raise HTTPException(409, 'Only a completed, saved response can be spoken.')
    result = run.get('result') or {}
    text = result.get('reply') or run.get('text')
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(409, 'The completed response is unavailable for speech.')
    return text


def _audio_duration(data):
    import io
    import wave
    try:
        with wave.open(io.BytesIO(data), 'rb') as audio:
            duration = audio.getnframes() / audio.getframerate()
        if not 0 < duration <= 180:
            raise ValueError()
        return round(duration, 3)
    except (ValueError, ZeroDivisionError, EOFError, wave.Error):
        raise HTTPException(422, 'Generated speech must be valid WAV audio lasting at most three minutes.') from None


def speak(owner, request_id, run_id, speaker_id, volume, check):
    check()
    text = _completed_reply(owner, run_id)
    return _speech(owner, request_id, text, speaker_id, volume, check, 'speak', (run_id, speaker_id, volume))


def announce(owner, request_id, speaker_id, text, volume, check):
    """Speak a user-reviewed message; callers never supply a media URL."""
    import hashlib
    check()
    if not isinstance(speaker_id, str) or not speaker_id or len(speaker_id) > 128:
        raise HTTPException(422, 'Choose an enrolled Sonos speaker for this announcement.')
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        raise HTTPException(422, 'Provide an announcement of 1 to 8,000 characters.')
    if type(volume) is not int or not 0 <= volume <= 100:
        raise HTTPException(422, 'Choose a speaker volume from 0 to 100; its configured cap also applies.')
    digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
    return _speech(owner, request_id, text, speaker_id, volume, check, 'announce', (digest, speaker_id, volume))


def _speech(owner, request_id, text, speaker_id, volume, check, kind, fingerprint):
    job = _start(owner, request_id, kind, check, fingerprint)
    clip_id = None
    try:
        target_ip = None
        if speaker_id:
            import sonos_service
            observed = sonos_service.status(owner, speaker_id, check=check)
            device = observed.get('device') or observed
            target_ip = device.get('ip')
            try:
                target_ip = str(ipaddress.IPv4Address(target_ip))
            except (ValueError, TypeError):
                raise HTTPException(409, 'The enrolled speaker has no verified IPv4 address.') from None
            with _lock:
                if not _listener or _listener.owner != owner:
                    raise HTTPException(409, 'Explicitly enable the temporary Sonos media listener first.')
        audio = _synthesize(job, text)
        duration = _audio_duration(audio)
        _check(job)
        clip_id = secrets.token_urlsafe(32)
        clip = {'owner': owner, 'audio': audio, 'target_ip': target_ip, 'expires': time.monotonic() + CLIP_TTL,
                'check': check, 'job': job, 'speaker_id': speaker_id, 'remote_clip_id': None}
        with _lock:
            _cleanup()
            if len(_clips) >= 16 or sum(len(item['audio']) for item in _clips.values()) + len(audio) > 32 * 1024 * 1024:
                raise HTTPException(429, 'Temporary speech storage is full. Stop earlier speech or wait for its audio to expire.')
            _clips[clip_id] = clip
            listener = _listener
        _ensure_expiry_worker()
        result = {'clip_id': clip_id, 'expires_in': CLIP_TTL, 'request_id': request_id, 'outcome': 'ready',
                  'duration_seconds': duration, 'capture_hold_seconds': duration + 10}
        if speaker_id:
            if not listener or listener.owner != owner:
                raise HTTPException(409, 'The media listener was disabled. No announcement was sent.')
            _check(job)
            url = f'http://{listener.server_address[0]}:{listener.server_address[1]}/audio/{clip_id}.wav'
            receipt = sonos_service.announce(owner, speaker_id, url, volume, request_id, check=lambda: _check(job))
            clip['remote_clip_id'] = receipt.get('clip_id')
            result.update(outcome=receipt.get('outcome', 'unknown'), announcement=receipt)
            if job['stop'].is_set():
                cancel(owner, request_id)
                raise HTTPException(409, 'Speech stopped. Any already playing speaker audio may need stopping on the speaker.')
        return result
    except Exception:
        if clip_id:
            with _lock:
                _clips.pop(clip_id, None)
        raise
    finally:
        job['finished'] = time.monotonic()


def browser_audio(owner, clip_id, check):
    check()
    _cleanup()
    with _lock:
        clip = _clips.get(clip_id)
        if not clip or clip['owner'] != owner or clip['target_ip'] is not None:
            raise HTTPException(404, 'Speech audio is unavailable or expired.')
        clip['check']()
        return clip['audio']


def cancel(owner, request_id=None):
    remote = []
    with _lock:
        if request_id and (owner, request_id) not in _cancelled:
            if len(_cancelled) >= 512:
                _cleanup()
            if len(_cancelled) >= 512:
                raise HTTPException(429, 'Recent voice cancellation storage is full.')
            _cancelled[(owner, request_id)] = time.monotonic() + 300
        for job in _jobs.values():
            if job['owner'] == owner and (request_id is None or job['request_id'] == request_id):
                job['stop'].set()
        for token, clip in list(_clips.items()):
            if clip['owner'] == owner and (request_id is None or clip['job']['request_id'] == request_id):
                _clips.pop(token, None)
                if clip['remote_clip_id']:
                    remote.append(clip)
    outcomes = []
    for clip in remote:
        try:
            import sonos_service
            # Only the already-issued clip may be cancelled, never music playback.
            outcomes.append(sonos_service.cancel_announcement(owner, clip['speaker_id'], clip['remote_clip_id'], check=clip['check']))
        except Exception:
            outcomes.append({'outcome': 'unknown', 'detail': 'Audio access revoked. Already fetched speaker audio may continue; clip cancellation was not confirmed.'})
    return {'ok': True, 'audio_revoked': True, 'speaker_cancellation': outcomes}


def _range(value, size):
    if value is None:
        return 0, size - 1, False
    import re
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', value)
    if not match or not any(match.groups()):
        raise ValueError()
    first, last = match.groups()
    if first:
        start, end = int(first), min(int(last) if last else size - 1, size - 1)
    else:
        length = int(last)
        if length <= 0:
            raise ValueError()
        start, end = max(0, size - length), size - 1
    if start >= size or end < start:
        raise ValueError()
    return start, end, True


class _MediaHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # URLs contain ephemeral capabilities; never log them.

    def do_HEAD(self):
        self._audio(head=True)

    def do_GET(self):
        self._audio(head=False)

    def _audio(self, head):
        self.connection.settimeout(3)
        _cleanup()
        token = self.path.removeprefix('/audio/').removesuffix('.wav')
        with _lock:
            clip = _clips.get(token) if self.path == f'/audio/{token}.wav' else None
            valid = clip and clip['owner'] == self.server.owner and clip['target_ip'] == self.client_address[0]
            data = clip['audio'] if valid else None
        if data is None:
            self.send_error(404)
            return
        try:
            clip['check']()
            start, end, partial = _range(self.headers.get('Range'), len(data))
        except ValueError:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{len(data)}')
            self.end_headers()
            return
        except Exception:
            self.send_error(404)
            return
        self.send_response(206 if partial else 200)
        self.send_header('Content-Type', 'audio/wav')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        if partial:
            self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
        self.end_headers()
        if not head:
            try:
                for offset in range(start, end + 1, 16384):
                    _check(clip['job'])
                    if time.monotonic() >= clip['expires']:
                        break
                    self.wfile.write(data[offset:min(offset + 16384, end + 1)])
            except (OSError, HTTPException):
                pass


class _MediaServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 4

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(4)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(3)
        return connection, address


def enable_media(owner, check):
    global _listener
    check()
    if not _available():
        raise HTTPException(503, 'Host voice requires Windows with Python 3.11 or newer.')
    with _lock:
        if _listener:
            if _listener.owner != owner:
                raise HTTPException(409, 'Another owner already enabled the voice media listener.')
            if _listener.stop.is_set():
                raise HTTPException(409, 'The media listener is closing. Try enabling it again shortly.')
            return {'enabled': True, 'address': _listener.server_address[0], 'port': _listener.server_address[1]}
        settings = _read_settings().get(owner, {})
        address, port = settings.get('bind_ip'), settings.get('port', 8766)
        if address not in interface_addresses():
            raise HTTPException(422, 'Select an available private IPv4 address in voice settings first.')
        try:
            server = _MediaServer((address, port), _MediaHandler)
        except OSError:
            raise HTTPException(409, 'The selected media address or port could not be opened.') from None
        server.owner, server.check, server.stop = owner, check, threading.Event()
        server.timeout = 0.5
        _listener = server
        threading.Thread(target=_serve, args=(server,), name='tli-voice-media', daemon=True).start()
    return {'enabled': True, 'address': address, 'port': server.server_address[1]}


def _serve(server):
    global _listener
    try:
        while _listener is server and not server.stop.is_set():
            server.check()
            _cleanup()
            server.handle_request()
    except Exception:
        pass
    finally:
        with _lock:
            if _listener is server:
                cancel(server.owner)
                _listener = None
        server.server_close()


def disable_media(owner):
    global _listener
    with _lock:
        if _listener and _listener.owner == owner:
            _listener.stop.set()
    return cancel(owner)


def shutdown():
    global _listener
    with _lock:
        if _listener:
            _listener.stop.set()
        _listener = None
        for job in _jobs.values():
            job['stop'].set()
        _clips.clear()


def revoke_browser_session(_token=None):
    """Discard ephemeral audio and stop jobs whose original authority was revoked."""
    with _lock:
        for job in _jobs.values():
            try:
                job['check']()
            except Exception:
                job['stop'].set()
    _cleanup()


def revoke_all_sessions():
    revoke_browser_session()
