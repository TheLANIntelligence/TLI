"""Strong browser authority for optional host-local voice."""
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field

from browser_authority import browser_control_access
from routers.system_routes import require_session
import voice_service as voice

router = APIRouter(prefix='/api/voice', tags=['Local host voice'])


class Settings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    model_path: str = Field(default='', max_length=2048)
    bind_ip: str = Field(default='', max_length=45)
    port: int = Field(default=8766, ge=1024, le=65535, strict=True)


class Speech(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: str = Field(min_length=16, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')
    run_id: str = Field(min_length=1, max_length=128)
    speaker_id: str | None = Field(default=None, max_length=128)
    volume: int = Field(default=25, ge=0, le=100, strict=True)


class Cancel(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: str | None = Field(default=None, max_length=80)


class Announcement(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: str = Field(min_length=16, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')
    speaker_id: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=8000)
    volume: int = Field(default=25, ge=0, le=100, strict=True)


@router.get('/capabilities')
def capabilities(owner=Depends(require_session), check=Depends(browser_control_access)):
    check()
    result = voice.capabilities(owner)
    check()
    return result


@router.put('/settings')
def settings(req: Settings, owner=Depends(require_session), check=Depends(browser_control_access)):
    return voice.configure(owner, req.model_path, req.bind_ip, req.port, check)


@router.post('/media/enable')
def media_enable(owner=Depends(require_session), check=Depends(browser_control_access)):
    return voice.enable_media(owner, check)


@router.post('/media/disable')
def media_disable(owner=Depends(require_session), check=Depends(browser_control_access)):
    check()
    return voice.disable_media(owner)


@router.post('/transcribe')
def transcribe(audio: UploadFile = File(...), request_id: str = Form(...), owner=Depends(require_session), check=Depends(browser_control_access)):
    import re
    check()
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,80}', request_id):
        raise HTTPException(422, 'Invalid voice request identity.')
    try:
        data = audio.file.read(voice.MAX_UPLOAD + 1)
        return voice.transcribe(owner, request_id, data, check)
    finally:
        audio.file.close()


@router.post('/speak')
def speak(req: Speech, owner=Depends(require_session), check=Depends(browser_control_access)):
    return voice.speak(owner, req.request_id, req.run_id, req.speaker_id, req.volume, check)


@router.get('/audio/{clip_id}')
def audio(clip_id: str, owner=Depends(require_session), check=Depends(browser_control_access)):
    return Response(voice.browser_audio(owner, clip_id, check), media_type='audio/wav', headers={'Cache-Control': 'no-store'})


@router.post('/announce')
def announce(req: Announcement, owner=Depends(require_session), check=Depends(browser_control_access)):
    return voice.announce(owner, req.request_id, req.speaker_id, req.text, req.volume, check)


@router.post('/cancel')
def cancel(req: Cancel, owner=Depends(require_session), check=Depends(browser_control_access)):
    check()
    return voice.cancel(owner, req.request_id)
