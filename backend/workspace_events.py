"""Owner-only, body-free invalidations for the shared phone/browser workspace."""
from collections import deque
import threading
import uuid

_lock = threading.RLock()
_epoch = uuid.uuid4().hex
_sequence = 0
_events = deque(maxlen=512)


def publish(owner: str, kind: str, resource_id: str = "") -> None:
    global _sequence
    if not isinstance(owner, str) or not owner:
        return
    with _lock:
        _sequence += 1
        _events.append({"id": _sequence, "owner": owner, "kind": kind, "resource_id": resource_id})


def snapshot(owner: str, after: int = 0, epoch: str = "") -> dict:
    with _lock:
        reset = epoch != _epoch or (bool(_events) and after < _events[0]["id"] - 1) or after > _sequence
        return {"epoch": _epoch, "cursor": _sequence, "reset": reset,
                "events": [{k: v for k, v in event.items() if k != "owner"}
                           for event in _events if event["owner"] == owner and (reset or event["id"] > after)]}
