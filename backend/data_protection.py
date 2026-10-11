"""
data_protection.py — OS-level key protection helpers for TLI.

Uses Windows DPAPI (via ctypes, no extra dependencies) to protect
machine-local AES keys at rest.  Falls back to unprotected raw bytes
on non-Windows so the app still works on Linux/macOS.

Key lifecycle:
  - First run: generate 32 random bytes, DPAPI-encrypt them, write to disk.
  - Subsequent runs: read blob, DPAPI-decrypt → same 32 bytes.
  - Legacy compatibility: an existing 32-byte raw key is read unchanged.
  - Unreadable existing keys are preserved, never replaced during recovery.
  - DPAPI binds the blob to the current Windows OS user account — a
    different user or a different machine cannot decrypt it without the key.
"""
from __future__ import annotations

import os
import sys
import threading
from pathlib import Path


# ── Platform guard ────────────────────────────────────────────────

def is_windows() -> bool:
    return sys.platform == "win32"


# ── DPAPI wrappers (Windows only) ─────────────────────────────────

def dpapi_protect(data: bytes) -> bytes:
    """Encrypt *data* with Windows DPAPI (current-user scope)."""
    import ctypes
    import ctypes.wintypes

    class _BLOB(ctypes.Structure):
        _fields_ = [
            ("cbData", ctypes.wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    buf   = ctypes.create_string_buffer(data)
    b_in  = _BLOB(len(data), buf)
    b_out = _BLOB()

    ok = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(b_in), None, None, None, None, 0,
        ctypes.byref(b_out),
    )
    if not ok:
        raise OSError(f"CryptProtectData failed (error {ctypes.GetLastError()})")

    result = bytes(ctypes.string_at(b_out.pbData, b_out.cbData))
    ctypes.windll.kernel32.LocalFree(b_out.pbData)
    return result


def dpapi_unprotect(data: bytes) -> bytes:
    """Decrypt a DPAPI-protected blob (current-user scope)."""
    import ctypes
    import ctypes.wintypes

    class _BLOB(ctypes.Structure):
        _fields_ = [
            ("cbData", ctypes.wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    buf   = ctypes.create_string_buffer(data)
    b_in  = _BLOB(len(data), buf)
    b_out = _BLOB()

    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(b_in), None, None, None, None, 0,
        ctypes.byref(b_out),
    )
    if not ok:
        raise OSError(f"CryptUnprotectData failed (error {ctypes.GetLastError()})")

    result = bytes(ctypes.string_at(b_out.pbData, b_out.cbData))
    ctypes.windll.kernel32.LocalFree(b_out.pbData)
    return result


# ── Key management ────────────────────────────────────────────────

class KeyUnavailableError(ValueError):
    """An existing key is unavailable, or a new key could not be persisted."""


_KEY_LOCK = threading.RLock()


def load_existing_key(path: str) -> bytes:
    """Read without creating, migrating or modifying a file.

    Missing files raise FileNotFoundError. Reading existing ciphertext never
    authorizes creation of a replacement for its missing key.
    """
    with _KEY_LOCK:
        try:
            with Path(path).open('rb') as handle:
                raw = handle.read(65537)
            if len(raw) == 32:
                return raw
            if not raw or len(raw) > 65536 or not is_windows():
                raise ValueError('Invalid key format')
            key = dpapi_unprotect(raw)
            if not isinstance(key, bytes) or len(key) != 32:
                raise ValueError('Invalid decrypted key')
            return key
        except FileNotFoundError:
            raise
        except Exception as exc:
            raise KeyUnavailableError(
                'The existing encryption key could not be read. It was preserved. '
                'Use the original operating-system account and matching backup; do not reset the key.'
            ) from exc


def get_or_create_key(path: str) -> bytes:
    """Load an existing key, or exclusively persist a key for new data.

    Malformed or inaccessible files are never replaced. Creation failure never
    returns a usable but unpersisted key.
    """
    with _KEY_LOCK:
        try:
            return load_existing_key(path)
        except FileNotFoundError:
            pass
        p = Path(path)
        try:
            key = os.urandom(32)
            blob = dpapi_protect(key) if is_windows() else key
            p.parent.mkdir(parents=True, exist_ok=True)
            try:
                descriptor = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                return load_existing_key(path)
            with os.fdopen(descriptor, 'wb') as handle:
                if handle.write(blob) != len(blob):
                    raise OSError('Incomplete key write')
                handle.flush()
                os.fsync(handle.fileno())
            return key
        except KeyUnavailableError:
            raise
        except Exception as exc:
            raise KeyUnavailableError(
                'A new encryption key could not be safely saved. No encrypted data was written with it. '
                'Check storage access and free space before trying again.'
            ) from exc
