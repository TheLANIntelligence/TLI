"""Owner-authenticated portable Vault backup and reviewed separate recovery."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from datetime import datetime, timezone
import json
import hashlib
import os
import secrets
import threading
import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

import vault_backup as archive
import vault_backup_recovery as recovery
import vault_security as security
from companion_auth import operation_access
from routers.backup_routes import _private_transport, _small_json, _owned_worker
from routers.system_routes import require_session

router = APIRouter(prefix="/vault/backups", tags=["Portable Vault backup"])
_downloads = OrderedDict()
_download_lock = threading.RLock()
DOWNLOAD_TTL = 600
MAX_DOWNLOADS = 4


class _Download(StreamingResponse):
    """Disconnects and failed streams release ciphertext just like completion."""
    def __init__(self, path, *, token, filename=None, headers=None, authorize=None, **kwargs):
        self.token = token
        self.authorize = authorize
        self.handle = None
        try:
            if authorize: authorize()
            info = archive._ordinary(path)
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
            self.handle = os.fdopen(descriptor, "rb")
            opened = os.fstat(self.handle.fileno())
            if (opened.st_dev, opened.st_ino, opened.st_size) != (info.st_dev, info.st_ino, info.st_size):
                raise ValueError("Prepared archive changed while opening")
            digest, total = hashlib.sha256(), 0
            for chunk in iter(lambda: self.handle.read(archive.CHUNK), b""):
                if authorize: authorize()
                total += len(chunk)
                if total > archive.MAX_ARCHIVE:
                    raise ValueError("Prepared archive exceeds its limit")
                digest.update(chunk)
            if digest.hexdigest() != _downloads[token]["sha256"] or total != opened.st_size:
                raise ValueError("Prepared archive hash differs")
            self.handle.seek(0)
            if authorize: authorize()
            def chunks():
                for chunk in iter(lambda: self.handle.read(archive.CHUNK), b""):
                    if authorize: authorize()
                    yield chunk
            final_headers = {**(headers or {}), "Content-Length": str(total)}
            if filename:
                final_headers["Content-Disposition"] = f'attachment; filename="{filename}"'
            super().__init__(chunks(), headers=final_headers, **kwargs)
        except Exception as exc:
            if self.handle is not None:
                self.handle.close()
            _remove_download(token)
            if isinstance(exc, HTTPException):
                raise
            raise HTTPException(503, "The prepared encrypted Vault archive changed or could not be read. Create a new backup after checking temporary storage.") from exc

    async def __call__(self, scope, receive, send):
        try:
            if self.authorize: self.authorize()
            await super().__call__(scope, receive, send)
        finally:
            if self.handle is not None:
                self.handle.close()
            _remove_download(self.token)


def _same_origin(request):
    _private_transport(request)
    origin = request.headers.get("origin")
    if request.headers.get("sec-fetch-site") == "cross-site" or (origin and origin != str(request.base_url).rstrip("/")):
        raise HTTPException(403, "Use the TLI page on this host for Vault backup operations.")


def _authorization(request, owner):
    original_access = operation_access(request, owner)
    last = [0.0]
    def check(force=False):
        now = time.monotonic()
        if force or now - last[0] >= 1:
            original_access()
            last[0] = now
    return check


def _remove_download(token):
    with _download_lock:
        entry = _downloads.get(token)
        if entry:
            try:
                entry["path"].unlink(missing_ok=True)
            except OSError:
                entry.update(expires=0, sending=False)
                return False
            _downloads.pop(token, None)
        return True


def _expire_downloads():
    now = time.monotonic()
    with _download_lock:
        for token, entry in list(_downloads.items()):
            if entry["expires"] <= now and not entry.get("sending"):
                _remove_download(token)


def _json(value):
    return Response(json.dumps(value, ensure_ascii=False), media_type="application/json", headers={"Cache-Control": "no-store"})


@router.get("/capabilities")
def capabilities(_owner: str = Depends(require_session)):
    _expire_downloads()
    try:
        recovery.available()
        supported, reason = True, None
    except HTTPException as error:
        supported, reason = False, error.detail
    return _json({"ok": True, "protocol": archive.PROTOCOL, "scope": archive.SCOPE, "excluded": archive.EXCLUSIONS,
        "limits": {"file_bytes": archive.MAX_FILE, "total_bytes": archive.MAX_TOTAL,
                   "entries": archive.MAX_ENTRIES, "archive_bytes": archive.MAX_ARCHIVE},
        "recovery_available": supported, "recovery_reason": reason, "download_expires_in_seconds": DOWNLOAD_TTL})


@router.post("/create")
async def create(request: Request, owner: str = Depends(require_session)):
    _same_origin(request)
    authorization = _authorization(request, owner)
    with archive.operation():
        _expire_downloads()
        with _download_lock:
            if len(_downloads) >= MAX_DOWNLOADS or any(row["owner"] == owner for row in _downloads.values()):
                raise HTTPException(409, "Download or discard your prepared Vault archive before creating another. Prepared downloads expire after ten minutes.")
        try:
            body = await asyncio.wait_for(_small_json(request), 15)
            authorization(True)
        except TimeoutError:
            raise HTTPException(408, "The Vault backup request did not arrive in time.") from None
        if not isinstance(body, dict) or set(body) != {"password", "request_id"}:
            raise HTTPException(422, "Supply an archive password and a new request identifier.")
        archive.password_bytes(body["password"])
        archive.claim(owner, body["request_id"])
        authorization(True)
        path = None
        completed = []
        try:
            def prepare():
                value = archive.create_archive(owner, body["password"], authorization)
                completed.append(value[0])
                return value
            path, result = await _owned_worker(prepare)
            authorization(True)
            token = secrets.token_urlsafe(32)
            with _download_lock:
                _downloads[token] = {"path": path, "owner": owner, "expires": time.monotonic() + DOWNLOAD_TTL,
                                     "sha256": result["archive_sha256"], "sending": False, "receipt": result}
            path = None
            completed.clear()  # The authenticated download registry now owns it.
            asyncio.get_running_loop().call_later(DOWNLOAD_TTL + 1, _expire_downloads)
            return _json({**result, "download_url": "/vault/backups/download/" + token,
                          "expires_in_seconds": DOWNLOAD_TTL, "downloaded": False})
        finally:
            for prepared in completed:
                prepared.unlink(missing_ok=True)


@router.get("/prepared")
def prepared(request: Request, owner: str = Depends(require_session)):
    _same_origin(request)
    authorize = operation_access(request, owner)
    if not security.is_vault_unlocked(owner):
        raise HTTPException(403, "Unlock this account's Vault before finding its prepared backup.")
    _expire_downloads()
    with _download_lock:
        for token, entry in _downloads.items():
            if entry["owner"] != owner:
                continue
            if entry["sending"]:
                raise HTTPException(409, "This Vault archive is already downloading. Wait for the browser download to finish.")
            authorize()
            return _json({**entry["receipt"], "prepared": True, "downloaded": False,
                          "download_url": "/vault/backups/download/" + token,
                          "expires_in_seconds": max(0, int(entry["expires"] - time.monotonic()))})
    return _json({"ok": True, "protocol": archive.PROTOCOL, "prepared": False})


@router.get("/download/{token}")
def download(token: str, request: Request, owner: str = Depends(require_session)):
    _same_origin(request)
    authorize = operation_access(request, owner)
    _expire_downloads()
    with _download_lock:
        entry = _downloads.get(token)
        if not entry or entry["owner"] != owner:
            raise HTTPException(404, "This prepared Vault download expired or belongs to another account.")
        if entry["sending"]:
            raise HTTPException(409, "This Vault archive is already downloading.")
        if request.headers.get("range"):
            raise HTTPException(416, "Download this complete Vault archive in one request.")
        entry["sending"] = True
    filename = "TLI-Vault-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + ".tlivaultbackup"
    return _Download(entry["path"], token=token, media_type="application/vnd.tli.vault-backup", filename=filename,
        authorize=authorize,
        headers={"Cache-Control": "no-store", "X-TLI-Backup-SHA256": entry["sha256"], "X-TLI-Backup-Protocol": archive.PROTOCOL},
        )


@router.delete("/download/{token}")
def discard_download(token: str, request: Request, owner: str = Depends(require_session)):
    _same_origin(request)
    authorize = operation_access(request, owner)
    with _download_lock:
        entry = _downloads.get(token)
        if entry and entry["owner"] == owner:
            if entry["sending"]:
                raise HTTPException(409, "The browser download is already running; wait for it to finish.")
            authorize()
            if not _remove_download(token):
                raise HTTPException(503, "The encrypted temporary archive could not be removed. Retry discarding it.")
    return _json({"ok": True, "discarded": True})


@router.post("/check")
async def check_source(request: Request, owner: str = Depends(require_session)):
    _same_origin(request)
    authorization = _authorization(request, owner)
    with archive.operation():
        try:
            body = await asyncio.wait_for(_small_json(request), 15)
            authorization(True)
        except TimeoutError:
            raise HTTPException(408, "The Vault check request did not arrive in time.") from None
        if not isinstance(body, dict) or set(body) != {"request_id"}:
            raise HTTPException(422, "Supply a new Vault check request identifier.")
        archive.claim(owner, body["request_id"])
        authorization(True)
        result = await _owned_worker(archive.check_source, owner, authorization)
        authorization(True)
        return _json(result)


async def _upload(request, owner, action):
    _same_origin(request)
    authorization = _authorization(request, owner)
    with archive.operation():
        if action in ("review", "recover"):
            recovery.available()
        names = {"file", "password", "request_id"}
        if action in ("review", "recover"):
            names.add("destination")
        if action == "recover":
            names.update(("review_token", "new_vault_password"))
        total = 0
        async def bounded():
            nonlocal total
            async for chunk in request.stream():
                authorization(True)
                total += len(chunk)
                if total > archive.MAX_ARCHIVE + 65536:
                    raise MultiPartException("Encrypted upload limit exceeded")
                yield chunk
        parser = MultiPartParser(request.headers, bounded(), max_files=1, max_fields=len(names) - 1, max_part_size=4096)
        form = None
        try:
            form = await asyncio.wait_for(parser.parse(), 1800)
            authorization(True)
            if (len(form.multi_items()) != len(names) or set(form) != names or not isinstance(form.get("file"), UploadFile)
                    or any(not isinstance(form[name], str) for name in names - {"file"})):
                raise HTTPException(422, "Supply one portable Vault archive and the required password and recovery fields.")
            archive.password_bytes(form["password"])
            archive.claim(owner, form["request_id"])
            authorization(True)
            handle = form["file"].file  # The multipart spool contains encrypted bytes only.
            if action == "verify":
                result = await _owned_worker(lambda: archive.verify_archive(handle, form["password"], authorize=authorization))
            elif action == "review":
                result = await _owned_worker(lambda: recovery.review(handle, form["password"], owner, form["destination"], authorize=authorization))
            else:
                result = await _owned_worker(recovery.create, handle, form["password"], owner, form["destination"],
                    form["review_token"], form["new_vault_password"], lambda: authorization(True))
            authorization(True)
            return _json(result)
        except TimeoutError:
            raise HTTPException(408, "Vault archive upload timed out. No automatic retry was started.") from None
        except MultiPartException:
            raise HTTPException(413 if total > archive.MAX_ARCHIVE + 65536 else 422, "The encrypted Vault upload exceeded its limit or has invalid fields.") from None
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, "TLI could not confirm the Vault backup request. Check its result before retrying. The active Vault was not replaced.") from exc
        finally:
            if form is not None:
                await form.close()
            else:
                for handle in parser._files_to_close_on_error:
                    handle.close()


@router.post("/verify")
async def verify(request: Request, owner: str = Depends(require_session)):
    return await _upload(request, owner, "verify")


@router.post("/recovery/review")
async def review(request: Request, owner: str = Depends(require_session)):
    return await _upload(request, owner, "review")


@router.post("/recovery/create")
async def recover(request: Request, owner: str = Depends(require_session)):
    return await _upload(request, owner, "recover")
