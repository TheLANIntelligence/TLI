"""Presentation of accumulated discovery hints, never peer authority.

Saved identities and their histories remain separate. Only pending, unreviewed
records at the same literal address and listener can be folded out of the main
roster; the most recently observed discovery represents that address there.
"""
from __future__ import annotations

import ipaddress
import math
from datetime import datetime


def _timestamp(value):
    if not isinstance(value, str) or not value or len(value) > 64:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        result = parsed.timestamp()
        return result if math.isfinite(result) else None
    except (ValueError, OverflowError, OSError):
        return None


def observed_at(entry):
    discovery = entry.get("discovery")
    value = discovery.get("observed_at") if isinstance(discovery, dict) else None
    return value if _timestamp(value) is not None else None


def _endpoint(entry):
    ip, port = entry.get("ip"), entry.get("tli_port", 8000)
    if not isinstance(ip, str) or isinstance(port, bool):
        return None
    if isinstance(port, str):
        if not port.isascii() or not port.isdecimal() or len(port) > 5:
            return None
        port = int(port)
    if not isinstance(port, int) or not 1 <= port <= 65535:
        return None
    try:
        return str(ipaddress.IPv4Address(ip)), port
    except ipaddress.AddressValueError:
        return None


def previous_discoveries(directory, *, self_id=None):
    """Return older-ID -> newest-ID hints without modifying the directory.

    A valid discovery timestamp takes precedence; older records can fall back
    to last_seen. Equal/invalid times have an insertion-order-independent ID
    tiebreaker. Names, unsigned verified flags and trust capabilities never
    affect grouping or grant permissions.
    """
    groups, foldable = {}, set()
    for device_id, entry in directory.items():
        status, trust = entry.get("status", "pending"), entry.get("peer_trust")
        if device_id == self_id or (status not in ("pending", "allowed", "blocked") and trust is None):
            continue
        endpoint = _endpoint(entry)
        if endpoint is not None:
            groups.setdefault(endpoint, []).append(device_id)
            if status == "pending" and trust is None:
                foldable.add(device_id)

    def rank(device_id):
        entry = directory[device_id]
        observed = _timestamp(observed_at(entry))
        seen = _timestamp(entry.get("last_seen"))
        effective = observed if observed is not None else seen
        return (effective if effective is not None else float("-inf"),
                seen if seen is not None else float("-inf"), device_id)

    previous = {}
    for identities in groups.values():
        if len(identities) < 2:
            continue
        current = max(identities, key=rank)
        # The current record remains the anchor after its human trust review.
        # Older reviewed/blocked identities are never folded, and a genuinely
        # newer pending identity remains visible for a new explicit review.
        previous.update({identity: current for identity in identities if identity != current and identity in foldable})
    return previous
