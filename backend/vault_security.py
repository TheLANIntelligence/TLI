import os
import json
import base64
import hashlib
import hmac
import re
import threading
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
import secrets as _secrets_mod
from datetime import datetime, timedelta
from typing import Optional, Dict, Tuple

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import data_protection as _dp
import security_state as _security

VAULT_META_PATH = "vault_meta.json"
VAULT_UNLOCK_MINUTES = 30

# In-memory map of which users currently have the vault unlocked
UNLOCKED_VAULTS: Dict[str, datetime] = {}

# In-memory encryption keys for unlocked users (32-byte AES keys)
ENCRYPTION_KEYS: Dict[str, bytes] = {}
_META_LOCK = threading.RLock()
_CONTENT_LOCK = threading.RLock()


@contextmanager
def content_transaction():
    """Keep a portable snapshot coherent; callers retry writes deliberately.

    Access revocation intentionally does not acquire this lock. A backup checks
    current access between chunks and aborts if the owner locks the Vault.
    """
    from fastapi import HTTPException
    if not _CONTENT_LOCK.acquire(blocking=False):
        raise HTTPException(409, "Vault content is busy with another operation. Wait for its result and retry deliberately.")
    try:
        yield
    finally:
        _CONTENT_LOCK.release()


def _metadata_transaction(fn):
    @wraps(fn)
    def guarded(*args, **kwargs):
        with _META_LOCK:
            return fn(*args, **kwargs)
    return guarded

# ============================================
#  Machine-key session persistence
# ============================================

# Configurable data directory (set via configure() from main.py)
_DATA_DIR: str = "."


def configure(data_dir: str) -> None:
    """Point vault_security at the app's data directory for persisted sessions."""
    global _DATA_DIR
    _DATA_DIR = data_dir


def _machine_key_path() -> str:
    return os.path.join(_DATA_DIR, "vault_machine_key.bin")


def _sessions_path() -> str:
    return os.path.join(_DATA_DIR, "vault_sessions.json")


def _get_or_create_machine_key() -> bytes:
    """
    Load or generate the machine-local 32-byte secret used to encrypt persisted
    session AES keys.  On Windows the key blob is DPAPI-protected (bound to the
    current OS user account).  On non-Windows a plain binary file is used.
    Legacy plain 32-byte key files remain readable without being rewritten.
    """
    try:
        return _dp.load_existing_key(_machine_key_path())
    except FileNotFoundError:
        if _load_sessions_file():
            raise _dp.KeyUnavailableError('The saved Vault sessions need their original machine key. Unlock the Vault with its passphrase; existing session files were preserved.')
        return _dp.get_or_create_key(_machine_key_path())


def _encrypt_with_machine_key(data: bytes) -> str:
    """Encrypt bytes with the machine key; return base64(nonce+ciphertext)."""
    key = _get_or_create_machine_key()
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
    ciphertext = aesgcm.encrypt(nonce, data, None)
    return base64.b64encode(nonce + ciphertext).decode("ascii")


def _decrypt_with_machine_key(b64: str) -> bytes:
    """Decrypt a base64-encoded nonce+ciphertext produced by _encrypt_with_machine_key."""
    key = _dp.load_existing_key(_machine_key_path())
    raw = base64.b64decode(b64)
    nonce, ciphertext = raw[:12], raw[12:]
    return AESGCM(key).decrypt(nonce, ciphertext, None)


def _load_sessions_file() -> dict:
    path = _sessions_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            result = json.load(f)
        if not isinstance(result, dict):
            raise ValueError('Invalid saved sessions')
        return result
    except FileNotFoundError:
        return {}


def _save_sessions_file(sessions: dict) -> None:
    path = _sessions_path()
    _security.write_json(path, sessions, "Vault unlock sessions")


def _persist_session(user_id: str, expiry: datetime, aes_key: bytes) -> None:
    """Encrypt and persist a vault session so it survives backend restarts."""
    try:
        sessions = _load_sessions_file()
        sessions[user_id] = {
            "expiry": expiry.isoformat(),
            "key_enc": _encrypt_with_machine_key(aes_key),
        }
        _save_sessions_file(sessions)
    except Exception:
        pass  # session persistence is best-effort; never block an unlock


def _remove_persisted_session(user_id: str) -> None:
    """Remove a user's session from the sessions file."""
    sessions = _load_sessions_file()
    if user_id in sessions:
        del sessions[user_id]
        _save_sessions_file(sessions)


def load_persisted_sessions() -> None:
    """
    Called once at startup.  Restores unexpired vault sessions from disk back
    into UNLOCKED_VAULTS and ENCRYPTION_KEYS so users don't need to re-unlock
    after a backend restart.
    """
    try:
        sessions = _load_sessions_file()
        now = _now()
        expired_keys = []
        for user_id, entry in sessions.items():
            try:
                expiry = datetime.fromisoformat(entry["expiry"])
                if expiry <= now:
                    expired_keys.append(user_id)
                    continue
                aes_key = _decrypt_with_machine_key(entry["key_enc"])
                if len(aes_key) != 32:
                    expired_keys.append(user_id)
                    continue
                UNLOCKED_VAULTS[user_id] = expiry
                ENCRYPTION_KEYS[user_id] = aes_key
            except Exception:
                # Unreadable is not expired. Preserve ciphertext for recovery;
                # the passphrase can still unlock the Vault normally.
                continue
        # Prune expired entries from disk
        if expired_keys:
            for k in expired_keys:
                sessions.pop(k, None)
            _save_sessions_file(sessions)
    except Exception:
        pass  # startup failure must never crash the server


def _now() -> datetime:
    return datetime.utcnow()


def _normalize_user_id(user_id: Optional[str]) -> str:
    """
    Normalize user IDs so 'Ryzen-Main', 'ryzen-main ', etc. are treated the same.
    """
    if user_id is None:
        return ""
    return user_id.strip().lower()


def _has_vault_dependencies(data_dir=None) -> bool:
    root = Path(data_dir if data_dir is not None else _DATA_DIR)
    # The blob directory remains the same configured directory used by routes.
    import tli_state as S
    vault_dir = Path(S.VAULT_DIR)
    try:
        with os.scandir(vault_dir) as entries:
            for index, entry in enumerate(entries):
                if index >= 4096 or entry.name.lower().endswith(".vault"):
                    return True
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise _security.SecurityStateUnavailable("Vault metadata") from exc
    try:
        sessions = _security.read_json(root / "vault_sessions.json", "Vault metadata")
    except FileNotFoundError:
        return False
    if not isinstance(sessions, dict):
        raise _security.SecurityStateUnavailable("Vault metadata")
    return bool(sessions)


def read_existing_meta(*, data_dir=None) -> dict:
    """Read legacy metadata in its existing location; never repair missing salts."""
    try:
        meta = _security.read_json(VAULT_META_PATH, "Vault metadata")
    except FileNotFoundError:
        if _has_vault_dependencies(data_dir):
            raise _security.SecurityStateUnavailable("Vault metadata")
        return {}
    try:
        if not isinstance(meta, dict):
            raise ValueError("Invalid metadata")
        for field, length in (("password_hash", 32), ("password_salt", 16), ("encryption_salt", 16)):
            if field == "encryption_salt" and field not in meta:
                if _has_vault_dependencies(data_dir):
                    raise ValueError("Missing encryption salt for saved data")
                continue  # Phase 1 vaults without encrypted data may upgrade on unlock.
            if not isinstance(meta.get(field), str) or len(base64.b64decode(meta[field], validate=True)) != length:
                raise ValueError("Invalid metadata field")
        if type(meta.get("failed_attempts", 0)) is not int or meta.get("failed_attempts", 0) < 0:
            raise ValueError("Invalid lockout counter")
        locked = meta.get("locked_until")
        if locked is not None and (not isinstance(locked, str) or datetime.fromisoformat(locked).tzinfo is not None):
            raise ValueError("Invalid lockout time")
        if "ext_api_key_hash" in meta:
            if not isinstance(meta["ext_api_key_hash"], str) or not re.fullmatch(r"[0-9a-f]{64}", meta["ext_api_key_hash"]):
                raise ValueError("Invalid extension key")
            if "ext_api_key_user" in meta and (not isinstance(meta["ext_api_key_user"], str) or not meta["ext_api_key_user"].strip()):
                raise ValueError("Invalid extension owner")
        return meta
    except _security.SecurityStateUnavailable:
        raise
    except Exception as exc:
        raise _security.SecurityStateUnavailable("Vault metadata") from exc


def _load_meta() -> dict:
    return read_existing_meta()


def _save_meta(meta: dict) -> None:
    existing = _load_meta()
    _security.write_json(VAULT_META_PATH, meta, "Vault metadata", new=not existing)


def is_initialized() -> bool:
    meta = _load_meta()
    return "password_hash" in meta and "password_salt" in meta


def _hash_password(password: str, salt: Optional[bytes] = None) -> Tuple[bytes, bytes]:
    if salt is None:
        salt = os.urandom(16)
    pwd_hash = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        200_000,  # iterations
    )
    return salt, pwd_hash


def _derive_encryption_key(password: str, salt: bytes) -> bytes:
    """
    Derive a 32-byte AES key from the password using PBKDF2-HMAC-SHA256.
    Unlock may persist this key encrypted by the separate machine-local key.
    """
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        200_000,
        dklen=32,
    )


@_metadata_transaction
def setup_password(password: str) -> None:
    """
    One-time setup. If a password already exists, this should not overwrite it.
    Also creates an encryption_salt used to derive AES keys.
    """
    meta = _load_meta()
    if "password_hash" in meta:
        raise ValueError("Vault password is already initialized")

    # Salt + hash for password verification
    salt, pwd_hash = _hash_password(password)

    # Separate salt for encryption key derivation (never store the key itself)
    enc_salt = os.urandom(16)

    meta["password_salt"] = base64.b64encode(salt).decode("utf-8")
    meta["password_hash"] = base64.b64encode(pwd_hash).decode("utf-8")
    meta["encryption_salt"] = base64.b64encode(enc_salt).decode("utf-8")
    meta["failed_attempts"] = 0
    meta["locked_until"] = None
    meta["created_at"] = _now().isoformat()
    meta["updated_at"] = meta["created_at"]
    _save_meta(meta)


def _verify_password(password: str) -> bool:
    meta = _load_meta()
    if "password_hash" not in meta or "password_salt" not in meta:
        return False

    salt = base64.b64decode(meta["password_salt"])
    stored_hash = base64.b64decode(meta["password_hash"])
    _, pwd_hash = _hash_password(password, salt)
    # Use hmac.compare_digest for constant-time compare (works on more builds)
    return hmac.compare_digest(stored_hash, pwd_hash)


def verify_password(password: str) -> bool:
    """Public wrapper — verify vault password without side-effects."""
    return _verify_password(password)


def get_status(user_id: Optional[str] = None) -> dict:
    meta = _load_meta()
    locked_until = meta.get("locked_until")
    if locked_until is not None:
        try:
            lock_dt = datetime.fromisoformat(locked_until)
            if lock_dt <= _now():
                locked_until = None
        except Exception:
            locked_until = None

    norm_user = _normalize_user_id(user_id)
    is_unlocked = False
    if norm_user and norm_user in UNLOCKED_VAULTS:
        if UNLOCKED_VAULTS[norm_user] > _now():
            is_unlocked = True
        else:
            # session expired
            UNLOCKED_VAULTS.pop(norm_user, None)
            ENCRYPTION_KEYS.pop(norm_user, None)

    return {
        "is_initialized": is_initialized(),
        "locked_until": locked_until,
        "failed_attempts": int(meta.get("failed_attempts", 0)),
        "is_unlocked_for_user": is_unlocked,
    }


@_metadata_transaction
def unlock(user_id: str, password: str) -> dict:
    """
    Attempt to unlock the vault for a given user_id with a password.
    Enforces lockout after repeated failures and derives an in-memory AES key.
    """
    norm_user = _normalize_user_id(user_id)

    meta = _load_meta()
    if "password_hash" not in meta:
        raise ValueError("Vault not initialized")

    failed_attempts = int(meta.get("failed_attempts", 0))
    locked_until_str = meta.get("locked_until")
    if locked_until_str:
        try:
            locked_until = datetime.fromisoformat(locked_until_str)
            if locked_until > _now():
                return {
                    "success": False,
                    "reason": "locked_out",
                    "locked_until": locked_until.isoformat(),
                }
        except Exception:
            locked_until = None

    if not _verify_password(password):
        failed_attempts += 1
        meta["failed_attempts"] = failed_attempts

        # Lock out after 10 wrong attempts for 10 minutes.
        # This is a personal LAN tool — 10 attempts before lockout is
        # intentionally forgiving. The counter resets on a correct password
        # or after the lockout expires.
        if failed_attempts >= 10:
            lock_dt = _now() + timedelta(minutes=10)
            meta["locked_until"] = lock_dt.isoformat()
            meta["failed_attempts"] = 0   # reset counter so next lockout is also 10 attempts
        meta["updated_at"] = _now().isoformat()
        _save_meta(meta)

        return {
            "success": False,
            "reason": "wrong_password",
            "failed_attempts": failed_attempts,
            "locked_until": meta.get("locked_until"),
        }

    # password correct
    meta["failed_attempts"] = 0
    meta["locked_until"] = None

    # Ensure we have an encryption_salt (for vaults created before Phase 2)
    enc_salt_b64 = meta.get("encryption_salt")
    if enc_salt_b64 is None:
        enc_salt = os.urandom(16)
        meta["encryption_salt"] = base64.b64encode(enc_salt).decode("utf-8")
    else:
        enc_salt = base64.b64decode(enc_salt_b64)

    meta["updated_at"] = _now().isoformat()
    _save_meta(meta)

    # Derive AES key for this session and store it in memory
    aes_key = _derive_encryption_key(password, enc_salt)
    ENCRYPTION_KEYS[norm_user] = aes_key

    # mark this user as unlocked for a period
    expiry = _now() + timedelta(minutes=VAULT_UNLOCK_MINUTES)
    UNLOCKED_VAULTS[norm_user] = expiry

    # Persist session so it survives backend restarts
    _persist_session(norm_user, expiry, aes_key)

    return {
        "success": True,
        "unlocked_until": UNLOCKED_VAULTS[norm_user].isoformat(),
    }


class VaultSessionRevocationError(RuntimeError):
    """Memory was locked, but a saved session could not be durably revoked."""


@_metadata_transaction
def lock(user_id: Optional[str] = None) -> None:
    """
    Lock the vault either for a specific user or for everyone.
    Clear memory first; return successfully only after saved access is revoked.
    """
    if user_id is None:
        # Clear all in-memory sessions and the entire sessions file
        UNLOCKED_VAULTS.clear()
        ENCRYPTION_KEYS.clear()
        try:
            _save_sessions_file({})
        except Exception as exc:
            raise VaultSessionRevocationError("Vault access was cleared from memory, but the saved unlock session could not be removed. Restarting TLI may restore access until that session expires. Retry locking.") from exc
    else:
        norm_user = _normalize_user_id(user_id)
        UNLOCKED_VAULTS.pop(norm_user, None)
        ENCRYPTION_KEYS.pop(norm_user, None)
        try:
            _remove_persisted_session(norm_user)
        except Exception as exc:
            raise VaultSessionRevocationError("Vault access was cleared from memory, but the saved unlock session could not be removed. Restarting TLI may restore access until that session expires. Retry locking.") from exc


def is_vault_unlocked(user_id: str) -> bool:
    """
    Check if a given user currently has vault access.
    """
    _load_meta()  # A cached key never bypasses missing or damaged password metadata.
    norm_user = _normalize_user_id(user_id)
    expiry = UNLOCKED_VAULTS.get(norm_user)
    if not expiry:
        ENCRYPTION_KEYS.pop(norm_user, None)
        return False
    if expiry <= _now():
        UNLOCKED_VAULTS.pop(norm_user, None)
        ENCRYPTION_KEYS.pop(norm_user, None)
        return False
    return True


@_metadata_transaction
def reset_vault() -> None:
    """
    Hard reset: wipe the password hash/salts and all in-memory session state.
    Caller is responsible for deleting the encrypted .vault files.
    """
    _load_meta()
    if os.path.exists(VAULT_META_PATH):
        os.remove(VAULT_META_PATH)
    UNLOCKED_VAULTS.clear()
    ENCRYPTION_KEYS.clear()
    # Clear persisted sessions — they're bound to the old encryption salt
    try:
        sessions_path = _sessions_path()
        if os.path.exists(sessions_path):
            os.remove(sessions_path)
    except Exception:
        pass


def get_encryption_key(user_id: str) -> Optional[bytes]:
    """
    Return the AES key for this user if the vault is unlocked for them.
    Otherwise, return None and clear stale keys if needed.
    """
    norm_user = _normalize_user_id(user_id)
    if not is_vault_unlocked(norm_user):
        ENCRYPTION_KEYS.pop(norm_user, None)
        return None
    key = ENCRYPTION_KEYS.get(norm_user)
    if key is not None and len(key) != 32:
        # should never happen, but be defensive
        return None
    return key


# ---------------------------------------------------------------------------
# Extension API Key management
# ---------------------------------------------------------------------------

@_metadata_transaction
def generate_api_key(user_id: str) -> str:
    """
    Generate a random API key for the browser extension, store its SHA-256
    hash in vault_meta.json, and return the raw key to the caller (only time
    the raw key is ever visible).
    """
    raw = _secrets_mod.token_urlsafe(32)
    key_hash = hashlib.sha256(raw.encode()).hexdigest()
    meta = _load_meta()
    meta["ext_api_key_hash"] = key_hash
    meta["ext_api_key_user"] = _normalize_user_id(user_id)
    meta["ext_api_key_created"] = _now().isoformat()
    _save_meta(meta)
    return raw


def validate_api_key(raw_key: Optional[str]) -> Optional[str]:
    """
    Return the associated user_id if the raw key matches the stored hash,
    otherwise None.
    """
    if not raw_key:
        return None
    meta = _load_meta()
    stored = meta.get("ext_api_key_hash")
    if not stored:
        return None
    incoming = hashlib.sha256(raw_key.encode()).hexdigest()
    if hmac.compare_digest(incoming, stored):
        return meta.get("ext_api_key_user", "default")
    return None


@_metadata_transaction
def revoke_api_key() -> None:
    """Remove the extension API key from vault_meta.json."""
    meta = _load_meta()
    meta.pop("ext_api_key_hash", None)
    meta.pop("ext_api_key_user", None)
    meta.pop("ext_api_key_created", None)
    _save_meta(meta)


def has_api_key() -> bool:
    """Return True if an extension API key has been generated."""
    return "ext_api_key_hash" in _load_meta()
