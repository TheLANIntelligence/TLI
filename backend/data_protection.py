"""
data_protection.py — OS-level key protection helpers for TLI.

Uses Windows DPAPI (via ctypes, no extra dependencies) to protect
machine-local AES keys at rest.  Falls back to unprotected raw bytes
on non-Windows so the app still works on Linux/macOS.

Key lifecycle:
  - First run: generate 32 random bytes, DPAPI-encrypt them, write to disk.
  - Subsequent runs: read blob, DPAPI-decrypt → same 32 bytes.
  - Legacy migration: if an existing file is exactly 32 bytes (old format),
    re-encrypt it with DPAPI in-place; return the raw key unchanged.
  - DPAPI binds the blob to the current Windows OS user account — a
    different user or a different machine cannot decrypt it without the key.
"""
from __future__ import annotations

import os
import sys
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

def get_or_create_key(path: str) -> bytes:
    """
    Load or generate a 32-byte AES machine key stored at *path*.

    On Windows the on-disk blob is DPAPI-protected so only the current
    OS user account can read it.  On non-Windows the raw 32-byte key is
    stored directly (same security level as before).

    Automatically migrates legacy 32-byte unprotected key files to the
    DPAPI-protected format on first access.
    """
    p = Path(path)

    if p.exists():
        raw = p.read_bytes()

        if is_windows():
            if len(raw) == 32:
                # ── Legacy plain key — migrate to DPAPI in-place ──
                try:
                    p.write_bytes(dpapi_protect(raw))
                except Exception:
                    pass  # keep plain if DPAPI is unavailable (e.g. service account)
                return raw
            else:
                # ── DPAPI blob ────────────────────────────────────
                try:
                    return dpapi_unprotect(raw)
                except Exception:
                    # Blob unreadable (different user / machine after restore).
                    # Fall through to generate a fresh key.
                    pass
        else:
            if len(raw) == 32:
                return raw
            # Corrupted non-Windows file — regenerate.

    # ── Generate and persist a new key ───────────────────────────
    key = os.urandom(32)
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        p.write_bytes(dpapi_protect(key) if is_windows() else key)
    except Exception:
        pass  # key usable for this session even if we can't persist it
    return key
