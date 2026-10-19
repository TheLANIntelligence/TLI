"""One persisted guessing budget and transaction boundary for the host PIN.

The host runs one backend process. The PIN lock covers credential reads,
verification, journal writes, credential changes and browser token issuance.
Only a successful authentication or authorized credential change resets attempts.
"""
from __future__ import annotations

import hashlib
import math
import secrets
import time

from fastapi import HTTPException

import tli_state as S

FAILURE_LIMIT = 5
BASE_COOLDOWN = 60
MAX_COOLDOWN = 900
_now = time.time
_monotonic = time.monotonic
_cooldown_cache = None


def hash_pin(pin: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt.encode("utf-8"), 260_000).hex()


def _retry(seconds: int) -> None:
    raise HTTPException(429, f"Too many PIN attempts. Try again in {seconds} seconds.",
                        headers={"Retry-After": str(seconds), "Cache-Control": "no-store"})


def _check_pin(pin: str, cfg: dict) -> None:
    """Caller holds the PIN transaction lock; never log a supplied credential."""
    global _cooldown_cache
    attempts = cfg.get("attempts", {"failures": 0, "blocked_until": 0})
    key = (str(S.PIN_CONFIG_FILE), cfg["salt"], attempts["failures"], attempts["blocked_until"])
    if _cooldown_cache is None or _cooldown_cache[0] != key:
        remaining = min(MAX_COOLDOWN, max(0, attempts["blocked_until"] - _now()))
        _cooldown_cache = (key, _monotonic() + remaining)
    remaining = math.ceil(_cooldown_cache[1] - _monotonic())
    if remaining > 0:
        _retry(remaining)

    failures = min(32, attempts["failures"] + 1)
    delay = 0 if failures < FAILURE_LIMIT else min(MAX_COOLDOWN, BASE_COOLDOWN * 2 ** min(4, failures - FAILURE_LIMIT))
    deadline = _now() + delay if delay else 0
    # Reserve the attempt before computing the verifier: a failed disk write or
    # interrupted process must not permit uncounted guesses, even a correct one.
    S.record_pin_attempts(failures, deadline)
    _cooldown_cache = ((str(S.PIN_CONFIG_FILE), cfg["salt"], failures, deadline), _monotonic() + delay)
    if not secrets.compare_digest(hash_pin(pin, cfg["salt"]), cfg["hash"]):
        if delay:
            _retry(delay)
        raise HTTPException(403, "Incorrect PIN.", headers={"Cache-Control": "no-store"})

    # A reset must land before issuing a session or accepting a credential edit.
    S.record_pin_attempts(0, 0)
    _cooldown_cache = None


def _local_if_open(cfg: dict, local: bool) -> None:
    if not cfg["enabled"] and not local:
        raise HTTPException(403, "Set up PIN protection at localhost on the TLI host before using remote access.")


def verify(pin: str, *, local: bool) -> str | None:
    with S._PIN_CONFIG_LOCK:
        cfg = S.load_pin_config()
        _local_if_open(cfg, local)
        if not cfg["enabled"]:
            return None
        _check_pin(pin.strip(), cfg)
        return S.create_session_token("local")


def set_pin(pin: str, current_pin: str, *, local: bool) -> None:
    pin = pin.strip()
    if not 4 <= len(pin) <= 32:
        raise HTTPException(400, "PIN must be 4–32 characters.")
    with S._PIN_CONFIG_LOCK:
        cfg = S.load_pin_config()
        _local_if_open(cfg, local)
        if cfg["enabled"]:
            _check_pin(current_pin.strip(), cfg)
        salt = secrets.token_hex(32)
        digest = hash_pin(pin, salt)
        try:
            S.save_pin_config(digest, salt)
        finally:
            # Even an error reported after replacement must retire old sessions.
            S.revoke_all_sessions()


def remove(pin: str, *, local: bool) -> None:
    with S._PIN_CONFIG_LOCK:
        cfg = S.load_pin_config()
        _local_if_open(cfg, local)
        if cfg["enabled"]:
            _check_pin(pin.strip(), cfg)
            try:
                S.clear_pin_config()
            finally:
                S.revoke_all_sessions()


def reset(check) -> None:
    """An already unlocked browser can recover without guessing the old PIN."""
    with S._PIN_CONFIG_LOCK:
        check()  # A rotation while waiting for this lock revokes reset authority.
        S.load_pin_config()
        try:
            S.clear_pin_config(check=check)
        finally:
            S.revoke_all_sessions()
