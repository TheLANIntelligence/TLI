"""Normalize existing driver and multi-step results without hiding failures."""
from __future__ import annotations


def driver_succeeded(result: object) -> bool:
    if isinstance(result, bool):
        return result
    if not isinstance(result, dict):
        return False
    raw = result.get("raw")
    if "error" in result or (isinstance(raw, dict) and any(k in raw for k in ("error", "code", "text"))):
        return False
    if "ok" in result:
        return result["ok"] is True
    # Legacy Shelly driver raises on transport failure and returns the RPC body.
    return isinstance(raw, dict) and "error" not in raw and "code" not in raw and "text" not in raw


def execution_summary(results: list[dict], name: str) -> tuple[bool, str]:
    succeeded = sum(r.get("ok") is True for r in results)
    if results and succeeded == len(results):
        return True, f"Completed {name}: {succeeded} step(s) succeeded."
    if succeeded:
        return False, f"Partially completed {name}: {succeeded} of {len(results)} step(s) succeeded. Review receipts before retrying."
    return False, f"Failed to complete {name}: no steps succeeded."
