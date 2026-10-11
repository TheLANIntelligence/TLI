# backend/routers/vault_routes.py
from __future__ import annotations

import json
import os
import re
import tempfile
from functools import wraps
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import io
import zipfile

from urllib.parse import quote as _url_quote

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import tli_state as S
from license_gate import gate as _gate
from vault_security import (
    setup_password, get_status, unlock, lock,
    is_vault_unlocked, get_encryption_key,
    is_initialized as vault_is_initialized,
    reset_vault as _security_reset_vault,
    verify_password as _verify_vault_password,
    generate_api_key, validate_api_key, revoke_api_key, has_api_key,
    VaultSessionRevocationError, content_transaction,
)
from routers.system_routes import require_session

router = APIRouter(tags=["vault"])


def _content_mutation(fn):
    @wraps(fn)
    def guarded(*args, **kwargs):
        with content_transaction():
            return fn(*args, **kwargs)
    return guarded


# ============================================
#  Encryption helpers
# ============================================

def _safe_vault_filename(name: str) -> str:
    base = re.sub(r"[^a-zA-Z0-9_-]+", "_", name.strip())
    if not base:
        base = f"file_{int(datetime.utcnow().timestamp())}"
    return base + ".vault"


def _vault_path(name_or_base: str) -> str:
    if name_or_base.lower().endswith(".vault"):
        name_or_base = name_or_base[:-6]
    filename = _safe_vault_filename(name_or_base)
    candidate = Path(S.VAULT_DIR) / filename
    vault_dir_real = Path(S.VAULT_DIR).resolve()
    resolved = candidate.resolve()
    # Existing linked files must never read, replace or delete another store.
    if candidate.is_symlink() or resolved.parent != vault_dir_real:
        raise HTTPException(status_code=400, detail="Invalid vault path.")
    return str(resolved)


def _file_identifier(value: str) -> str:
    base = value[:-6] if value.lower().endswith(".vault") else value
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", base) or base.startswith("__"):
        raise HTTPException(status_code=400, detail="Invalid Vault file identifier.")
    return base


def _note_identifier(value: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", value):
        raise HTTPException(status_code=400, detail="Invalid Vault note identifier.")
    return value if value.startswith(NOTE_PREFIX) else NOTE_PREFIX + value


@_content_mutation
def _write_encrypted_blob(path: str, blob: bytes) -> None:
    """Replace only after a complete encrypted payload is durably written."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=Path(path).parent,
                                         prefix=".tli-vault-", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(blob)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
    except OSError as exc:
        raise HTTPException(status_code=503, detail="Vault content could not be saved. Existing encrypted data was preserved.") from exc
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


def _get_aes_key_for_user(user_id: str) -> bytes:
    key = get_encryption_key(user_id)
    if not key:
        raise HTTPException(status_code=403, detail="Vault is locked or no encryption key for this user.")
    if len(key) != 32:
        raise HTTPException(status_code=500, detail="Invalid vault key length.")
    return key


def _encrypt_for_user(user_id: str, plaintext: bytes) -> bytes:
    key = _get_aes_key_for_user(user_id)
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)
    return nonce + ciphertext


def _decrypt_for_user(user_id: str, blob: bytes) -> bytes:
    key = _get_aes_key_for_user(user_id)
    if len(blob) < 13:
        raise HTTPException(status_code=400, detail="Invalid encrypted payload.")
    nonce = blob[:12]
    ciphertext = blob[12:]
    aesgcm = AESGCM(key)
    try:
        return aesgcm.decrypt(nonce, ciphertext, None)
    except Exception:
        raise HTTPException(status_code=403, detail="Unable to decrypt vault content (wrong key or corrupted data).")


def _list_vault_files_base() -> List[str]:
    if not os.path.isdir(S.VAULT_DIR):
        return []
    names = [name[:-6] for name in os.listdir(S.VAULT_DIR) if name.lower().endswith(".vault")]
    names.sort()
    return names


def _write_vault_file(user_id: str, title: str, content_bytes: bytes) -> str:
    if _safe_vault_filename(title).startswith("__"):
        raise HTTPException(status_code=400, detail="Filenames beginning with two underscores are reserved for internal Vault data. Rename the file before uploading.")
    path = _vault_path(title)
    enc = _encrypt_for_user(user_id, content_bytes)
    _write_encrypted_blob(path, enc)
    base = os.path.basename(path)
    if base.lower().endswith(".vault"):
        base = base[:-6]
    return base


def _read_vault_file(user_id: str, base_name: str) -> bytes:
    path = _vault_path(_file_identifier(base_name))
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Vault file not found")
    with open(path, "rb") as f:
        blob = f.read()
    return _decrypt_for_user(user_id, blob)


@_content_mutation
def _delete_vault_file(user_id: str, base_name: str) -> bool:
    path = _vault_path(_file_identifier(base_name))
    if not os.path.exists(path):
        return False
    os.remove(path)
    return True


# ============================================
#  Vault secrets (per-user encrypted key/value)
# ============================================

def _vault_secrets_path(user_id: str) -> str:
    safe_id = "".join(c for c in user_id if c.isalnum() or c in "-_") or "default"
    return _vault_path(f"__secrets_{safe_id}")


def load_vault_secrets(user_id: str) -> Dict[str, str]:
    path = _vault_secrets_path(user_id)
    try:
        with open(path, "rb") as f:
            blob = f.read()
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise HTTPException(status_code=503, detail="The saved Vault secrets could not be read. Existing encrypted data was preserved.") from exc
    try:
        decrypted = _decrypt_for_user(user_id, blob)
        data = json.loads(decrypted.decode("utf-8"))
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items()}
        raise ValueError("Invalid secrets store")
    except Exception as exc:
        raise HTTPException(status_code=503, detail="The saved Vault secrets could not be read. Existing encrypted data was preserved.") from exc


@_content_mutation
def save_vault_secrets(user_id: str, secrets: Dict[str, str]) -> None:
    path = _vault_secrets_path(user_id)
    payload = json.dumps(secrets, ensure_ascii=False, indent=2).encode("utf-8")
    enc = _encrypt_for_user(user_id, payload)
    _write_encrypted_blob(path, enc)


# ============================================
#  Pydantic models
# ============================================

class VaultSetupRequest(BaseModel):
    password: str

class VaultUnlockRequest(BaseModel):
    password: str
    user_id: Optional[str] = None  # ignored — user_id is derived from session

class VaultDeleteFileRequest(BaseModel):
    file_id: str

class VaultSecretSetRequest(BaseModel):
    value: str

class VaultNoteWriteRequest(BaseModel):
    title: str
    content: str

class VaultResetRequest(BaseModel):
    confirmation: str  # must equal "RESET VAULT"
    password: str      # current vault master password (required to authorise the wipe)


# ============================================
#  Endpoints
# ============================================

@router.post("/vault/setup")
def vault_setup(body: VaultSetupRequest, _l=Depends(_gate("vault")), _session: str = Depends(require_session)):
    if vault_is_initialized():
        raise HTTPException(status_code=400, detail="Vault already initialized")
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password too short (min 8 chars)")
    try:
        setup_password(body.password)
        S.log_debug("vault", "INFO", "Vault setup completed")
    except HTTPException:
        raise
    except Exception as e:
        S.log_debug("vault", "ERROR", "Error setting up vault", error=str(e))
        raise HTTPException(status_code=500, detail=f"Error setting up vault: {e}")
    return {"ok": True}


@router.get("/vault/status")
def vault_status(user_id: str = Depends(require_session)):
    status = get_status(user_id)
    return {
        "initialized": status.get("is_initialized", False),
        "locked_until": status.get("locked_until"),
        "failed_attempts": status.get("failed_attempts", 0),
        "unlocked": status.get("is_unlocked_for_user", False),
    }


@router.post("/vault/unlock")
def vault_unlock_route(body: VaultUnlockRequest, user_id: str = Depends(require_session), _l=Depends(_gate("vault"))):
    if not vault_is_initialized():
        raise HTTPException(status_code=400, detail="Vault not initialized")
    result = unlock(user_id, body.password)
    if not result.get("success"):
        S.log_debug("vault", "WARN", "Vault unlock failed", user_id=user_id, result=result)
        raise HTTPException(status_code=403, detail=result)
    S.log_debug("vault", "INFO", "Vault unlocked", user_id=user_id)
    return result


@router.post("/vault/lock")
def vault_lock_route(user_id: str = Depends(require_session)):
    try:
        lock(user_id)
    except VaultSessionRevocationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    S.log_debug("vault", "INFO", "Vault locked", user_id=user_id)
    return {"ok": True}


@router.get("/vault/export_backup")
def vault_export_backup(user_id: str = Depends(require_session)):
    """
    Export the current user's encrypted .vault files as a zip archive.
    Includes: all user-uploaded files, their secrets store, and their notes.
    Files are AES-256 encrypted — useless without the vault password.
    """
    if not os.path.isdir(S.VAULT_DIR):
        raise HTTPException(status_code=404, detail="No vault files found.")

    # Build the per-user secrets filename prefix so we can match it
    safe_uid = "".join(c for c in user_id if c.isalnum() or c in "-_") or "default"
    user_secrets_base = f"__secrets_{safe_uid}.vault"

    def _belongs_to_user(fname: str) -> bool:
        """Include user-uploaded files (no __ prefix) and this user's secrets/notes."""
        if not fname.lower().endswith(".vault"):
            return False
        base = fname[:-6]
        if not base.startswith("__"):
            return True                         # user-uploaded file
        if fname == user_secrets_base:
            return True                         # this user's secrets store
        if base.startswith(NOTE_PREFIX):
            return True                         # notes are shared per vault (single user)
        return False

    vault_files = [f for f in os.listdir(S.VAULT_DIR) if _belongs_to_user(f)]
    if not vault_files:
        raise HTTPException(status_code=404, detail="No vault files to export.")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for fname in vault_files:
            fpath = os.path.join(S.VAULT_DIR, fname)
            zf.write(fpath, arcname=fname)
    buf.seek(0)

    S.log_debug("vault", "WARN", "Encrypted vault backup exported", user_id=user_id, file_count=len(vault_files))
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=\"tli_vault_backup.zip\""},
    )


@router.post("/vault/reset")
@_content_mutation
def vault_reset(body: VaultResetRequest, user_id: str = Depends(require_session)):
    """
    Hard reset: wipes all vault data and password hash.
    Requires the caller to pass confirmation = 'RESET VAULT' AND the current vault password.
    Data is permanently destroyed — export backup first.
    """
    if body.confirmation != "RESET VAULT":
        raise HTTPException(status_code=400, detail="Confirmation phrase did not match.")
    if not _verify_vault_password(body.password):
        raise HTTPException(status_code=403, detail="Incorrect vault password.")

    # Delete all encrypted vault files
    deleted_files = 0
    if os.path.isdir(S.VAULT_DIR):
        for fname in os.listdir(S.VAULT_DIR):
            if fname.lower().endswith(".vault"):
                try:
                    os.remove(os.path.join(S.VAULT_DIR, fname))
                    deleted_files += 1
                except OSError:
                    raise HTTPException(status_code=503, detail={
                        "message": "Vault reset did not complete because a saved file could not be removed. Password metadata was preserved.",
                        "deleted_files": deleted_files,
                    })

    # Wipe password hash + in-memory keys
    _security_reset_vault()

    S.log_debug("vault", "WARN", "Vault hard reset executed", deleted_files=deleted_files)
    return {"ok": True, "message": "Vault has been reset. All data deleted.", "deleted_files": deleted_files}


@router.post("/vault/upload")
async def vault_upload_file(file: UploadFile = File(...), user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    data = await file.read()
    _MAX_VAULT_FILE = 250 * 1024 * 1024  # 250 MB per file
    if len(data) > _MAX_VAULT_FILE:
        raise HTTPException(status_code=413, detail="File too large. Maximum vault file size is 250 MB.")
    filename_base = _write_vault_file(user_id, file.filename, data)
    S.log_debug("vault", "INFO", "Vault file uploaded", user_id=user_id, file_id=filename_base)
    return {"ok": True, "file_id": filename_base}


@router.get("/vault/list")
def vault_list_files(user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    files_info = []
    for base in _list_vault_files_base():
        # Skip internal entries: secrets store and notes
        if base.startswith("__"):
            continue
        path = _vault_path(base)
        size_bytes = os.path.getsize(path)
        if size_bytes < 1024:
            size_display = f"{size_bytes} B"
        elif size_bytes < 1024 * 1024:
            size_display = f"{size_bytes / 1024:.1f} KB"
        else:
            size_display = f"{size_bytes / (1024 * 1024):.2f} MB"
        files_info.append({"id": base, "name": base, "size": size_bytes, "size_display": size_display})
    return {"files": files_info}


@router.get("/vault/get_file")
def vault_get_file(file_id: str, user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    data = _read_vault_file(user_id, file_id)
    # RFC 5987 encoding keeps ASCII names simple; non-ASCII or special chars are percent-encoded
    ascii_name = file_id.encode("ascii", errors="replace").decode("ascii")
    encoded_name = _url_quote(file_id, safe="")
    content_disposition = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded_name}"
    headers = {"Content-Disposition": content_disposition, "Content-Type": "application/octet-stream"}
    return StreamingResponse(iter([data]), headers=headers)


@router.post("/vault/delete_file")
def vault_delete_file(req: VaultDeleteFileRequest, user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    deleted = _delete_vault_file(user_id, req.file_id)
    if deleted:
        S.log_debug("vault", "INFO", "Vault file deleted", user_id=user_id, file_id=req.file_id)
    return {"ok": True, "deleted": deleted}


# ---------- Vault secrets endpoints ----------

@router.get("/vault/secrets")
def vault_list_secrets(user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    secrets = load_vault_secrets(user_id)
    return {"keys": list(secrets.keys())}


@router.get("/vault/secret/{key}")
def vault_get_secret(key: str, user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    secrets = load_vault_secrets(user_id)
    if key not in secrets:
        raise HTTPException(status_code=404, detail="Secret not found")
    return {"key": key, "value": secrets[key]}


@router.post("/vault/secret/{key}")
@_content_mutation
def vault_set_secret(key: str, body: VaultSecretSetRequest, user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    secrets = load_vault_secrets(user_id)
    secrets[key] = body.value
    save_vault_secrets(user_id, secrets)
    S.log_debug("vault", "INFO", "Vault secret set", user_id=user_id, key=key)
    return {"ok": True, "key": key}


@router.delete("/vault/secret/{key}")
@_content_mutation
def vault_delete_secret(key: str, user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    secrets = load_vault_secrets(user_id)
    existed = key in secrets
    if existed:
        del secrets[key]
        save_vault_secrets(user_id, secrets)
        S.log_debug("vault", "INFO", "Vault secret deleted", user_id=user_id, key=key)
    return {"ok": True, "existed": existed}


# ============================================
#  Vault notes (encrypted text notes)
# ============================================

NOTE_PREFIX = "__note_"


def _note_base(title: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_-]+", "_", title.strip()) or f"note_{int(datetime.utcnow().timestamp())}"
    return NOTE_PREFIX + safe


def _list_vault_notes_base() -> List[str]:
    if not os.path.isdir(S.VAULT_DIR):
        return []
    names = [
        name[:-6] for name in os.listdir(S.VAULT_DIR)
        if name.lower().endswith(".vault") and name[:-6].startswith(NOTE_PREFIX)
    ]
    names.sort()
    return names


@router.get("/vault/notes")
def vault_list_notes(user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    notes = []
    for base in _list_vault_notes_base():
        title = base[len(NOTE_PREFIX):]
        path = _vault_path(base)
        size_bytes = os.path.getsize(path)
        notes.append({"id": base, "title": title, "size": size_bytes})
    return {"notes": notes}


@router.post("/vault/note")
def vault_write_note(body: VaultNoteWriteRequest, user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    base = _note_base(body.title)
    path = _vault_path(base)
    enc = _encrypt_for_user(user_id, body.content.encode("utf-8"))
    _write_encrypted_blob(path, enc)
    S.log_debug("vault", "INFO", "Vault note saved", user_id=user_id, title=body.title)
    return {"ok": True, "id": base, "title": body.title}


@router.get("/vault/note/{note_id}")
def vault_read_note(note_id: str, user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    # note_id may be the base (with prefix) or just the title slug
    note_id = _note_identifier(note_id)
    path = _vault_path(note_id)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Note not found")
    with open(path, "rb") as f:
        blob = f.read()
    content = _decrypt_for_user(user_id, blob).decode("utf-8")
    title = note_id[len(NOTE_PREFIX):]
    return {"id": note_id, "title": title, "content": content}


@router.delete("/vault/note/{note_id}")
@_content_mutation
def vault_delete_note(note_id: str, user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    note_id = _note_identifier(note_id)
    path = _vault_path(note_id)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Note not found")
    os.remove(path)
    S.log_debug("vault", "INFO", "Vault note deleted", user_id=user_id, note_id=note_id)
    return {"ok": True}


# ============================================
#  Vault logins (browser autofill credentials)
# ============================================

LOGIN_STORE_PREFIX = "__logins_"


def _vault_logins_path(user_id: str) -> str:
    safe_id = "".join(c for c in user_id if c.isalnum() or c in "-_") or "default"
    return _vault_path(f"{LOGIN_STORE_PREFIX}{safe_id}")


def load_vault_logins(user_id: str) -> List[Dict]:
    path = _vault_logins_path(user_id)
    try:
        with open(path, "rb") as f:
            blob = f.read()
    except FileNotFoundError:
        return []
    except OSError as exc:
        raise HTTPException(status_code=503, detail="The saved Vault logins could not be read. Existing encrypted data was preserved.") from exc
    try:
        decrypted = _decrypt_for_user(user_id, blob)
        data = json.loads(decrypted.decode("utf-8"))
        if not isinstance(data, list) or any(
            not isinstance(entry, dict) or any(not isinstance(entry.get(key), str)
                for key in ("id", "name", "domain", "username", "password"))
            for entry in data
        ):
            raise ValueError("Invalid login store")
        return data
    except Exception as exc:
        raise HTTPException(status_code=503, detail="The saved Vault logins could not be read. Existing encrypted data was preserved.") from exc


@_content_mutation
def save_vault_logins(user_id: str, logins: List[Dict]) -> None:
    path = _vault_logins_path(user_id)
    payload = json.dumps(logins, ensure_ascii=False, indent=2).encode("utf-8")
    enc = _encrypt_for_user(user_id, payload)
    _write_encrypted_blob(path, enc)


class VaultLoginCreateRequest(BaseModel):
    name: str
    domain: str
    username: str
    password: str
    notes: Optional[str] = ""


class VaultLoginUpdateRequest(BaseModel):
    name: Optional[str] = None
    domain: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    notes: Optional[str] = None


@router.get("/vault/logins/{login_id}")
def vault_get_login(login_id: str, user_id: str = Depends(require_session)):
    """Return a single login entry including its password."""
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    logins = load_vault_logins(user_id)
    for entry in logins:
        if entry["id"] == login_id:
            return entry
    raise HTTPException(status_code=404, detail="Login entry not found")


@router.get("/vault/logins")
def vault_list_logins(user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    logins = load_vault_logins(user_id)
    # Strip passwords from list view
    return {"logins": [
        {"id": l["id"], "name": l["name"], "domain": l["domain"], "username": l["username"]}
        for l in logins
    ]}


@router.post("/vault/logins")
@_content_mutation
def vault_create_login(body: VaultLoginCreateRequest, user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    logins = load_vault_logins(user_id)
    now = datetime.utcnow().isoformat()
    entry = {
        "id": f"login_{int(datetime.utcnow().timestamp() * 1000)}",
        "name": body.name,
        "domain": body.domain.lower().strip(),
        "username": body.username,
        "password": body.password,
        "notes": body.notes or "",
        "created_at": now,
        "updated_at": now,
    }
    logins.append(entry)
    save_vault_logins(user_id, logins)
    S.log_debug("vault", "INFO", "Login entry created", user_id=user_id, name=body.name)
    return {"ok": True, "id": entry["id"]}


@router.put("/vault/logins/{login_id}")
@_content_mutation
def vault_update_login(login_id: str, body: VaultLoginUpdateRequest, user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    logins = load_vault_logins(user_id)
    for entry in logins:
        if entry["id"] == login_id:
            if body.name is not None:
                entry["name"] = body.name
            if body.domain is not None:
                entry["domain"] = body.domain.lower().strip()
            if body.username is not None:
                entry["username"] = body.username
            if body.password is not None:
                entry["password"] = body.password
            if body.notes is not None:
                entry["notes"] = body.notes
            entry["updated_at"] = datetime.utcnow().isoformat()
            save_vault_logins(user_id, logins)
            S.log_debug("vault", "INFO", "Login entry updated", user_id=user_id, login_id=login_id)
            return {"ok": True}
    raise HTTPException(status_code=404, detail="Login entry not found")


@router.delete("/vault/logins/{login_id}")
@_content_mutation
def vault_delete_login(login_id: str, user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    logins = load_vault_logins(user_id)
    updated = [l for l in logins if l["id"] != login_id]
    if len(updated) == len(logins):
        raise HTTPException(status_code=404, detail="Login entry not found")
    save_vault_logins(user_id, updated)
    S.log_debug("vault", "INFO", "Login entry deleted", user_id=user_id, login_id=login_id)
    return {"ok": True}


# ============================================
#  Extension API key management
# ============================================

@router.post("/vault/apikey/generate")
def vault_apikey_generate(user_id: str = Depends(require_session)):
    if not is_vault_unlocked(user_id):
        raise HTTPException(status_code=403, detail="Vault is locked for this user")
    raw = generate_api_key(user_id)
    S.log_debug("vault", "WARN", "Extension API key generated", user_id=user_id)
    return {"ok": True, "api_key": raw}


@router.get("/vault/apikey/status")
def vault_apikey_status(user_id: str = Depends(require_session)):
    return {"has_key": has_api_key()}


@router.post("/vault/apikey/revoke")
def vault_apikey_revoke(user_id: str = Depends(require_session)):
    revoke_api_key()
    S.log_debug("vault", "WARN", "Extension API key revoked", user_id=user_id)
    return {"ok": True}


# ============================================
#  Extension endpoint (API key auth, no session)
# ============================================

def _require_api_key(x_tli_api_key: Optional[str] = Header(default=None)) -> str:
    uid = validate_api_key(x_tli_api_key)
    if not uid:
        raise HTTPException(status_code=401, detail="Invalid or missing TLI API key")
    return uid


@router.get("/vault/ext/logins")
def vault_ext_logins(domain: Optional[str] = None, ext_user: str = Depends(_require_api_key)):
    """
    Browser extension calls this to get matching logins for the current domain.
    Auth: X-TLI-API-Key header (no session cookie required).
    The vault must still be unlocked on the server for this to return credentials.
    """
    if not is_vault_unlocked(ext_user):
        raise HTTPException(status_code=403, detail="Vault is locked — unlock it in TLI first")
    logins = load_vault_logins(ext_user)
    if domain:
        domain_clean = domain.lower().strip()
        logins = [l for l in logins if domain_clean in l.get("domain", "")]
    # Return full credentials — the extension only calls this when autofilling
    return {"logins": [
        {"id": l["id"], "name": l["name"], "domain": l["domain"],
         "username": l["username"], "password": l["password"]}
        for l in logins
    ]}


@router.post("/vault/ext/logins")
@_content_mutation
def vault_ext_save_login(body: VaultLoginCreateRequest, ext_user: str = Depends(_require_api_key)):
    """Browser extension saves a newly detected login to the vault."""
    if not is_vault_unlocked(ext_user):
        raise HTTPException(status_code=403, detail="Vault is locked — unlock it in TLI first")
    logins = load_vault_logins(ext_user)
    now = datetime.utcnow().isoformat()
    entry = {
        "id": f"login_{int(datetime.utcnow().timestamp() * 1000)}",
        "name": body.name.strip() or body.domain,
        "domain": body.domain.lower().strip(),
        "username": body.username,
        "password": body.password,
        "notes": body.notes or "",
        "created_at": now,
        "updated_at": now,
    }
    logins.append(entry)
    save_vault_logins(ext_user, logins)
    S.log_debug("vault", "INFO", "Login saved via extension", user_id=ext_user, name=entry["name"])
    return {"ok": True, "id": entry["id"]}


@router.post("/vault/clear-lockout")
def vault_clear_lockout(user_id: str = Depends(require_session)):
    """
    Clear the vault lockout and reset the failed-attempts counter.
    Requires a valid TLI session (PIN auth) — prevents unauthenticated
    brute-force bypass. This does NOT unlock the vault or skip the
    passphrase — it only lifts the rate-limit so the owner can retry.
    """
    import vault_security as _vs
    meta = _vs._load_meta()
    meta["failed_attempts"] = 0
    meta["locked_until"] = None
    _vs._save_meta(meta)
    S.log_debug("vault", "WARN", "Vault lockout cleared via recovery endpoint", user_id=user_id)
    return {"ok": True, "note": "Lockout cleared. You can try your passphrase again."}
