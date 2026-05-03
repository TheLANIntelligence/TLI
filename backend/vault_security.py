import os
import json
import base64
import hashlib
import hmac
import secrets as _secrets_mod
from datetime import datetime, timedelta
from typing import Optional, Dict, Tuple

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import data_protection as _dp

VAULT_META_PATH = "vault_meta.json"
VAULT_UNLOCK_MINUTES = 30

# In-memory map of which users currently have the vault unlocked
UNLOCKED_VAULTS: Dict[str, datetime] = {}

# In-memory encryption keys for unlocked users (32-byte AES keys)
ENCRYPTION_KEYS: Dict[str, bytes] = {}

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
    Legacy plain 32-byte key files are automatically migrated to DPAPI in-place.
    """
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
    key = _get_or_create_machine_key()
    raw = base64.b64decode(b64)
    nonce, ciphertext = raw[:12], raw[12:]
    return AESGCM(key).decrypt(nonce, ciphertext, None)


def _load_sessions_file() -> dict:
    path = _sessions_path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_sessions_file(sessions: dict) -> None:
    path = _sessions_path()
    os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(sessions, f, indent=2)


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
    try:
        sessions = _load_sessions_file()
        if user_id in sessions:
            del sessions[user_id]
            _save_sessions_file(sessions)
    except Exception:
        pass


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
                expired_keys.append(user_id)
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


def _load_meta() -> dict:
    if not os.path.exists(VAULT_META_PATH):
        return {}
    try:
        with open(VAULT_META_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_meta(meta: dict) -> None:
    with open(VAULT_META_PATH, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)


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
    This key is NOT stored on disk, only derived in-memory on unlock.
    """
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        200_000,
        dklen=32,
    )


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


def lock(user_id: Optional[str] = None) -> None:
    """
    Lock the vault either for a specific user or for everyone.
    This also wipes the in-memory AES keys and any persisted session.
    """
    if user_id is None:
        # Clear all in-memory sessions and the entire sessions file
        UNLOCKED_VAULTS.clear()
        ENCRYPTION_KEYS.clear()
        try:
            _save_sessions_file({})
        except Exception:
            pass
    else:
        norm_user = _normalize_user_id(user_id)
        UNLOCKED_VAULTS.pop(norm_user, None)
        ENCRYPTION_KEYS.pop(norm_user, None)
        _remove_persisted_session(norm_user)


def is_vault_unlocked(user_id: str) -> bool:
    """
    Check if a given user currently has vault access.
    """
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


def reset_vault() -> None:
    """
    Hard reset: wipe the password hash/salts and all in-memory session state.
    Caller is responsible for deleting the encrypted .vault files.
    """
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
