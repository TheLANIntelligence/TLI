"""Authenticated archives and reviewed separate copies; never live restoration."""
from __future__ import annotations

from datetime import datetime, timezone
import asyncio
import hashlib
import ipaddress
import json

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from intelligence import backups, recovery
from companion_auth import operation_access
from routers.system_routes import require_session

router = APIRouter(prefix="/api/intelligence/backups", tags=["Notebook & history backup"])
MAX_CREATE_BODY = 8192
MAX_VERIFY_BODY = backups.MAX_ARCHIVE_BYTES + 64 * 1024


def _private_transport(request):
    if request.url.scheme == "https":
        return
    try:
        loopback = ipaddress.ip_address(request.client.host).is_loopback if request.client else False
    except ValueError:
        loopback = False
    if not loopback:
        raise HTTPException(400, "Open TLI on its host computer or use its secure HTTPS address before submitting a backup password.")


def _fields(value):
    if not isinstance(value, dict) or set(value) != {"password", "request_id"}:
        raise HTTPException(422, "Supply a backup password and a new request identifier.")
    backups.password_bytes(value["password"])
    if not isinstance(value["request_id"], str):
        raise HTTPException(422, "Supply a new backup request identifier.")
    return value["password"], value["request_id"]


async def _small_json(request):
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_CREATE_BODY:
            raise HTTPException(413, "The backup request is too large.")
        chunks.append(chunk)
    try:
        return backups._load_json(b"".join(chunks))
    except Exception:
        raise HTTPException(422, "The backup request must contain valid JSON fields.") from None


async def _owned_worker(function, *args):
    """A cancelled request cannot release the lease while its worker continues."""
    worker = asyncio.create_task(run_in_threadpool(function, *args))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        # Retrieve a failed worker's exception before preserving cancellation.
        if worker.done() and not worker.cancelled():
            worker.exception()
        raise


@router.post("/create")
async def create_backup(request: Request, user: str = Depends(require_session)):
    _private_transport(request)
    authorize = operation_access(request, user)
    with backups.operation():
        try:
            fields = await asyncio.wait_for(_small_json(request), timeout=15)
            authorize()
            format = fields.get("format") if isinstance(fields, dict) else None
            if format is not None and format != "saved-work-v2":
                raise HTTPException(422, "Choose a supported saved-work backup format.")
            password, request_id = _fields({key: value for key, value in fields.items() if key != "format"} if isinstance(fields, dict) else fields)
        except TimeoutError:
            raise HTTPException(408, "The backup request did not arrive in time. Start a new request when connected.") from None
        backups.claim_request(user, request_id)
        try:
            blob = await _owned_worker(lambda: backups.create_archive(user, password, format, authorize=authorize))
            authorize()
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, "Notebook & history backup could not be created. Existing saved data and encryption keys were preserved.") from exc
    filename = ("TLI-Saved-work-" if format else "TLI-Notebook-history-") + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + ".tlibackup"
    return Response(blob, media_type="application/vnd.tli.notebook-history-backup", headers={
        "Cache-Control": "no-store", "Content-Disposition": f'attachment; filename="{filename}"',
        "X-TLI-Backup-Protocol": backups.PROTOCOL_V2 if format else backups.PROTOCOL, "X-TLI-Backup-SHA256": hashlib.sha256(blob).hexdigest(),
    })


@router.post("/verify")
async def verify_backup(request: Request, user: str = Depends(require_session)):
    _private_transport(request)
    authorize = operation_access(request, user)
    with backups.operation():
        total = 0
        async def bounded_stream():
            nonlocal total
            async for chunk in request.stream():
                authorize()
                total += len(chunk)
                if total > MAX_VERIFY_BODY:
                    # The multipart parser closes encrypted upload spools when
                    # this exception is raised, including an incomplete upload.
                    raise MultiPartException("Upload limit exceeded")
                yield chunk
        parser = MultiPartParser(request.headers, bounded_stream(), max_files=1, max_fields=2, max_part_size=2048)
        form = None
        try:
            form = await asyncio.wait_for(parser.parse(), timeout=120)
            authorize()
            fields = form.multi_items()
            if len(fields) != 3 or {name for name, _ in fields} != {"password", "request_id", "file"} or not isinstance(form.get("file"), UploadFile):
                raise HTTPException(422, "Choose one Notebook & history archive and provide its password and a new request identifier.")
            password, request_id = _fields({"password": form.get("password"), "request_id": form.get("request_id")})
            backups.claim_request(user, request_id)
            blob = await form["file"].read(backups.MAX_ARCHIVE_BYTES + 1)
            authorize()
            result = await _owned_worker(lambda: backups.verify_archive(blob, password, authorize=authorize))
            authorize()
            return Response(json.dumps(result, ensure_ascii=False), media_type="application/json", headers={"Cache-Control": "no-store"})
        except MultiPartException:
            status = 413 if total > MAX_VERIFY_BODY else 422
            raise HTTPException(status, "Choose one Notebook & history archive no larger than 64 MiB and valid password fields.") from None
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(422, "The uploaded archive could not be verified. No live saved data was restored or changed.") from exc
        finally:
            if form is not None:
                await form.close()
            else:
                # Also close spools on client disconnect or a parser error that
                # is not a MultiPartException; none contain plaintext exports.
                for handle in parser._files_to_close_on_error:
                    handle.close()


async def _recovery_upload(request: Request, user: str, *, create: bool):
    """Own the upload and worker lease until filesystem work actually finishes.

    Recovery deliberately has its own review/create paths. Existing verification
    still performs no persistent recovery and there is no live restore endpoint.
    """
    _private_transport(request)
    origin = request.headers.get("origin")
    if (request.headers.get("sec-fetch-site") == "cross-site"
            or (origin and origin != str(request.base_url).rstrip("/"))):
        raise HTTPException(403, "Review and create recovery copies from the TLI page on this host.")
    authorize = operation_access(request, user)
    with backups.operation():
        total = 0

        async def bounded_stream():
            nonlocal total
            async for chunk in request.stream():
                authorize()
                total += len(chunk)
                if total > MAX_VERIFY_BODY:
                    raise MultiPartException("Upload limit exceeded")
                yield chunk

        names = {"password", "request_id", "file", "destination"}
        if create:
            names.add("review_token")
        parser = MultiPartParser(request.headers, bounded_stream(), max_files=1,
                                 max_fields=len(names) - 1, max_part_size=4096)
        form = None
        try:
            form = await asyncio.wait_for(parser.parse(), timeout=120)
            authorize()
            fields = form.multi_items()
            if (len(fields) != len(names) or {name for name, _ in fields} != names
                    or not isinstance(form.get("file"), UploadFile)
                    or any(not isinstance(form.get(name), str) for name in names - {"file"})):
                raise HTTPException(422, "Choose one archive, its password and a new destination folder. Review the recovery before creating a separate copy.")
            password, request_id = _fields({"password": form["password"], "request_id": form["request_id"]})
            backups.claim_request(user, request_id)
            blob = await form["file"].read(backups.MAX_ARCHIVE_BYTES + 1)
            authorize()
            args = (blob, password, user, form["destination"])
            if create:
                result = await _owned_worker(lambda: recovery.create_copy(*args, form["review_token"], authorize=authorize))
            else:
                result = await _owned_worker(lambda: recovery.review_archive(*args, authorize=authorize))
            authorize()
            return Response(json.dumps(result, ensure_ascii=False), media_type="application/json",
                            headers={"Cache-Control": "no-store"})
        except TimeoutError:
            raise HTTPException(408, "The archive upload did not arrive in time. Review again when connected; no automatic retry was started.") from None
        except MultiPartException:
            raise HTTPException(413 if total > MAX_VERIFY_BODY else 422,
                                "Choose one archive no larger than 64 MiB and valid recovery fields.") from None
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, "TLI could not confirm this separate-copy recovery request. Check the chosen destination before reviewing a new attempt. The active installation was not replaced; no automatic retry was started.") from exc
        finally:
            if form is not None:
                await form.close()
            else:
                for handle in parser._files_to_close_on_error:
                    handle.close()


@router.post("/recovery/review")
async def review_recovery(request: Request, user: str = Depends(require_session)):
    return await _recovery_upload(request, user, create=False)


@router.post("/recovery/create")
async def create_recovery(request: Request, user: str = Depends(require_session)):
    return await _recovery_upload(request, user, create=True)
