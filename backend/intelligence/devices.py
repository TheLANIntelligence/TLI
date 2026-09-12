"""A view over existing registries plus optional shared room/name metadata."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from fastapi import HTTPException
import tli_state as S
from intelligence.store import LOCK, root
from device_resolution import resolve


def stable_id(source: str, key: str) -> str:
    return f"{source}-{hashlib.sha256(key.encode()).hexdigest()[:20]}"


def node() -> dict:
    cfg = S.load_node_config()
    name = metadata().get(f"node-{cfg.node_id}", {}).get("name") or cfg.node_name
    return {"id": cfg.node_id, "name": name, "role": cfg.role}


def metadata() -> dict:
    """An unreadable overlay is unavailable, never an empty replacement store."""
    path = Path(S.DATA_DIR) / "intelligence" / "device_context.json"
    try:
        with path.open("rb") as handle:
            raw = handle.read(1024 * 1024 + 1)
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise HTTPException(503, "Shared device details are unavailable. Existing data was retained.") from exc
    try:
        if len(raw) > 1024 * 1024:
            raise ValueError("Oversized device metadata")
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError("Duplicate metadata field")
                result[key] = value
            return result
        value = json.loads(raw, object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid number")))
        if not isinstance(value, dict) or len(value) > 2000:
            raise ValueError("Invalid device metadata")
        for ident, entry in value.items():
            if not isinstance(ident, str) or not ident or len(ident) > 256 or not isinstance(entry, dict):
                raise ValueError("Invalid device entry")
            if "name" in entry and (not isinstance(entry["name"], str) or not entry["name"].strip() or len(entry["name"]) > 120):
                raise ValueError("Invalid display name")
            if "room" in entry and entry["room"] is not None and (not isinstance(entry["room"], str) or len(entry["room"]) > 120):
                raise ValueError("Invalid room")
            if "aliases" in entry and (not isinstance(entry["aliases"], list) or len(entry["aliases"]) > 20 or
                    any(not isinstance(a, str) or not a.strip() or len(a) > 120 for a in entry["aliases"])):
                raise ValueError("Invalid aliases")
            if "importance" in entry and (not isinstance(entry["importance"], str) or entry["importance"] not in {"normal", "important", "critical"}):
                raise ValueError("Invalid importance")
        return value
    except (ValueError, TypeError, RecursionError) as exc:
        raise HTTPException(503, "Shared device details could not be read. Existing data was retained.") from exc


def context_revision(ident: str, overlays: dict | None = None) -> str:
    data = metadata() if overlays is None else overlays
    raw = json.dumps({"id": ident, "context": data.get(ident, {})}, sort_keys=True,
                     separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def refresh_printers() -> list:
    from routers.printers import get_printers
    result = get_printers()
    if not isinstance(result, list):
        raise HTTPException(503, "The host printer list is unavailable. Existing cached printers were retained.")
    with LOCK:
        S.save_json_file(root() / "printer_cache.json", {"checked_at": S.now_iso(), "printers": result})
    return result


def inventory() -> dict:
    host = node()
    entries = [{"id": f"node-{host['id']}", "name": host["name"], "kind": "computer", "source": "local_node",
                "source_id": host["id"], "address": None, "relay": None, "node_id": host["id"], "room": None, "aliases": []}]
    shelly = S.load_shelly_registry()
    from routers.home_power import get_runtime
    runtime = get_runtime()
    home = runtime.load_devices() if runtime else []
    occupied = set()
    for source, registry in (("homepower", home), ("shelly", shelly)):
        for d in registry:
            if not isinstance(d, dict):
                continue
            address = str(d.get("ip") or d.get("host") or "").strip()
            try:
                relay = int(d.get("relay") or 0)
            except (ValueError, TypeError):
                continue
            physical = (address.lower(), relay)
            if source == "shelly" and physical in occupied:
                continue
            occupied.add(physical)
            source_id = str(d.get("device_id") or d.get("id") or f"{address}:{relay}")
            entries.append({"id": stable_id(source, source_id), "source_id": source_id, "source": source,
                            "vendor": "shelly" if source == "shelly" else str(d.get("vendor") or "shelly").lower(),
                            "name": d.get("name") or d.get("label") or address, "kind": "smart_device", "address": address,
                            "relay": relay, "node_id": host["id"], "room": d.get("room"), "aliases": d.get("aliases") or []})
    cached = S.load_json_file(root() / "printer_cache.json", {})
    for d in cached.get("printers", []):
        key = d.get("system_name") or d.get("name")
        if not key:
            continue
        entries.append({"id": stable_id("printer", str(key)), "source_id": str(key), "source": "printer",
                        "name": d.get("name") or key, "kind": "printer", "address": d.get("ip") or d.get("hostname"),
                        "node_id": host["id"], "relay": None, "room": d.get("location"), "aliases": [],
                        "status": d.get("status"), "observed_at": cached.get("checked_at")})
    for peer_id, peer in S.load_mesh_directory().items():
        if peer_id == host["id"]:
            continue
        entries.append({"id": f"node-{peer_id}", "source_id": peer_id, "source": "mesh", "kind": "computer",
                        "name": peer.get("node_name") or peer.get("display_name") or peer_id, "address": peer.get("ip"),
                        "node_id": peer_id, "room": None, "aliases": [], "observed_at": peer.get("last_seen")})
    overlays = metadata()
    for d in entries:
        d.update({k: v for k, v in overlays.get(d["id"], {}).items() if k in {"name", "aliases", "room"}})
        importance = overlays.get(d["id"], {}).get("importance", "normal")
        d["importance"] = importance if importance in {"normal", "important", "critical"} else "unknown"
        d["context_revision"] = context_revision(d["id"], overlays)
    return {"node": host, "devices": entries, "printer_list_checked_at": cached.get("checked_at"),
            "scope": "Devices registered with this TLI host. Client location is not inferred."}


def get(ident: str) -> dict:
    result = next((d for d in inventory()["devices"] if d["id"] == ident), None)
    if result is None:
        raise HTTPException(404, "Device is no longer registered on this host.")
    return result


def update(ident: str, patch: dict, expected_revision: str | None = None) -> dict:
    get(ident)
    with LOCK:
        data = metadata()
        if expected_revision is not None and expected_revision != context_revision(ident, data):
            raise HTTPException(409, "Device details changed. Your edits were not saved; review the current details.")
        data.setdefault(ident, {}).update(patch)
        if len(json.dumps(data, indent=2).encode("utf-8")) > 1024 * 1024 or len(data) > 2000:
            raise HTTPException(413, "Shared device details exceed their storage limit. Existing data was retained.")
        S.save_json_file(root() / "device_context.json", data)
    return get(ident)


def match(query: str):
    view = inventory()["devices"]
    return resolve(query, [{**d, "ip": d.get("address"), "device_id": d["id"]} for d in view])


def with_context(registry: list[dict]) -> list[dict]:
    """Overlay shared names without modifying persisted IDs or relay targets."""
    overlays = metadata()
    if not overlays:
        return registry
    view = inventory()["devices"]
    result = []
    for original in registry:
        if not isinstance(original, dict):
            continue
        d = dict(original)
        matches = [v for v in view if v.get("kind") == "smart_device" and
                   v.get("address") == (d.get("ip") or d.get("host")) and
                   str(v.get("relay") or 0) == str(d.get("relay") or 0)]
        if len(matches) == 1 and matches[0]["id"] in overlays:
            meta = overlays[matches[0]["id"]]
            aliases = d.get("aliases") or []
            if isinstance(aliases, str):
                aliases = [aliases]
            d["aliases"] = list(dict.fromkeys([*aliases, d.get("name") or d.get("label") or "", *meta.get("aliases", [])]))
            d.update({k: meta[k] for k in ("name", "room") if k in meta})
        result.append(d)
    return result
