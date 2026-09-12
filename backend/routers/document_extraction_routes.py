"""Authenticated bounded binary intake. No multipart spool or retained document."""
import asyncio
import threading
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from intelligence import documents, document_extraction as extraction
from routers.system_routes import require_session

router = APIRouter(prefix='/api/ai/documents', tags=['Document text extraction'])
_intake_slots = threading.BoundedSemaphore(2)
UPLOAD_TIMEOUT = 30


def authorize(request, user):
    origin = request.headers.get('origin')
    if request.headers.get('sec-fetch-site') == 'cross-site' or origin and origin != str(request.base_url).rstrip('/'):
        raise HTTPException(403, 'Open this TLI host to extract a selected document.')
    if require_session(request.cookies.get('tli_session'), request) != user:
        raise HTTPException(401, 'Your TLI session changed. Unlock and select the document again.')


@router.get('/extraction-capabilities')
def capabilities(user: str = Depends(require_session)):
    return JSONResponse({'ok': True, **extraction.capabilities()}, headers={'Cache-Control': 'no-store'})


@router.post('/extract')
async def extract(request: Request, name: str = Query(min_length=1, max_length=120), user: str = Depends(require_session)):
    authorize(request, user)
    if not documents._valid_name(name) or not name.lower().endswith(('.pdf', '.docx')):
        raise HTTPException(422, 'Choose a PDF or DOCX filename without path separators, brackets or control characters.')
    kind = name.rsplit('.', 1)[-1].lower()
    capability = extraction.capabilities()['formats'][kind]
    if not capability['available']:
        raise HTTPException(503, capability['reason'])
    if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/octet-stream':
        raise HTTPException(415, 'Send the selected document as a binary file, not a multipart form.')
    length = request.headers.get('content-length')
    if length is not None and (not length.isdigit() or not 0 < int(length) <= extraction.MAX_FILE_BYTES):
        raise HTTPException(413, 'Choose a nonempty file of at most 8 MiB.')
    if not _intake_slots.acquire(blocking=False):
        raise HTTPException(429, 'The document upload/reader is busy. Wait and retry deliberately.')
    body = bytearray()
    try:
        try:
            async with asyncio.timeout(UPLOAD_TIMEOUT):
                async for chunk in request.stream():
                    if len(body) + len(chunk) > extraction.MAX_FILE_BYTES:
                        raise HTTPException(413, 'The uploaded document exceeded 8 MiB. Nothing was extracted.')
                    body.extend(chunk)
        except TimeoutError:
            raise HTTPException(408, 'The document upload exceeded 30 seconds. No extraction or AI request ran.') from None
        authorize(request, user)
        result = await run_in_threadpool(extraction.extract, user, name, bytes(body))
        authorize(request, user)
    finally:
        body.clear()
        _intake_slots.release()
    return JSONResponse({'ok': True, 'protocol': extraction.PROTOCOL, 'document': result,
                         'actions_performed': False, 'inference_called': False, 'source_retained': False},
                        headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})
