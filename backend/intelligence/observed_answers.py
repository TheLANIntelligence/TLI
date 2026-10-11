"""Narrow host-status answers shared by chat providers, without model/tool actions.

Readers perform passive local OS reads or consume existing observations. They
never scan the LAN, run diagnostics, contact devices or refresh printer state.
Supplying readers makes the complete path deterministic in isolated tests.
"""
from __future__ import annotations

from datetime import datetime, timezone
import ipaddress
import json
import math
from pathlib import Path
import re
import socket
import time

FRESH_SECONDS = 30
MAX_ROWS = 24
MAX_CACHE_BYTES = 1024 * 1024
TOPICS = frozenset({"cpu", "ram", "storage", "network", "printers", "system"})
_HOST = r"(?:(?:my|our|this|the)\s+)?(?:(?:tli\s+)?(?:host|computer|pc|machine)(?:'s)?\s+)?"
_PREFIX = r"(?:(?:show|check|list)(?:\s+me)?\s+|tell\s+me\s+|what(?:'s|\s+is|\s+are)\s+)?"
_SUFFIX = r"(?:\s+(?:right\s+now|now|currently))?"
_CPU = r"(?:cpu|processor)(?:\s+(?:usage|use|utilization|utilisation|load|status))?"
_RAM = r"(?:ram(?:\s+(?:usage|use|utilization|utilisation|status|available|free))?|memory\s+(?:usage|use|utilization|utilisation|status|available|free))"
_STORAGE = r"(?:storage|disk\s*space|free\s+space|disk\s+usage|drive\s+usage|storage\s+usage|drives|disks)(?:\s+status)?"
_NETWORK = r"(?:network|wi-?fi|wifi|lan)(?:\s+(?:status|connection|connections|interfaces|addresses))?"
_PRINTER = r"(?:printers|printer\s+(?:status|list|inventory)|default\s+printer)"
_PATTERNS = {
    "cpu": (
        rf"{_PREFIX}{_HOST}{_CPU}{_SUFFIX}",
        rf"how\s+(?:much|busy)\s+(?:is\s+)?{_HOST}(?:cpu|processor)(?:\s+(?:being\s+)?used|\s+usage)?{_SUFFIX}",
        rf"is\s+{_HOST}(?:cpu|processor)\s+(?:overloaded|busy|under\s+load){_SUFFIX}",
    ),
    "ram": (
        rf"{_PREFIX}{_HOST}{_RAM}{_SUFFIX}",
        rf"how\s+much\s+(?:ram|memory)(?:\s+do\s+(?:i|we)\s+have(?:\s+(?:free|available))?|\s+is\s+(?:free|available|(?:being\s+)?used)|\s+(?:is\s+)?{_HOST}(?:using|available|free)|\s+(?:do\s+)?{_HOST}(?:have|use)){_SUFFIX}",
        rf"how\s+much\s+(?:ram|memory)\s+(?:am\s+i\s+using|is\s+in\s+(?:my|this|the)\s+(?:computer|pc|host)){_SUFFIX}",
        rf"is\s+{_HOST}(?:ram|memory)\s+(?:full|running\s+low|under\s+pressure){_SUFFIX}",
    ),
    "storage": (
        rf"{_PREFIX}{_HOST}{_STORAGE}{_SUFFIX}",
        rf"how\s+much\s+(?:disk\s+|storage\s+|free\s+)?space\s+(?:do\s+(?:i|we)\s+have(?:\s+left)?|is\s+(?:left|free|available)){_SUFFIX}",
        rf"(?:which|what)\s+(?:of\s+my\s+)?(?:drives|disks)\s+(?:are\s+(?:full|nearly\s+full|running\s+low)|need\s+attention|can\s+be\s+cleaned){_SUFFIX}",
        rf"is\s+{_HOST}(?:storage|disk|drive)\s+(?:full|running\s+out\s+of\s+space){_SUFFIX}",
    ),
    "network": (
        rf"{_PREFIX}{_HOST}{_NETWORK}{_SUFFIX}",
        rf"(?:what(?:'s|\s+is|\s+are)|show(?:\s+me)?)\s+{_HOST}(?:(?:local|lan|network)\s+)?ip\s+address(?:es)?{_SUFFIX}",
        rf"(?:list|show)(?:\s+me)?\s+{_HOST}network\s+interfaces{_SUFFIX}",
    ),
    "printers": (
        rf"{_PREFIX}{_HOST}{_PRINTER}{_SUFFIX}",
        rf"(?:what|which)\s+printers\s+(?:are\s+(?:installed|configured|registered)|do\s+(?:i|we)\s+have){_SUFFIX}",
        rf"what(?:'s|\s+is)\s+{_HOST}printer{_SUFFIX}",
    ),
    "system": (
        rf"{_PREFIX}{_HOST}system\s+(?:status|usage){_SUFFIX}",
        rf"{_PREFIX}{_HOST}cpu\s+(?:and|&)\s+(?:ram|memory)(?:\s+(?:usage|status))?{_SUFFIX}",
    ),
}
_PATTERNS = {topic: tuple(re.compile(pattern) for pattern in patterns) for topic, patterns in _PATTERNS.items()}
# A named drive is a resource selection, not a substring keyword match.
_DRIVE = r"(?P<drive>[a-z]):(?:\\)?"
_DRIVE_PATTERNS = tuple(re.compile(pattern) for pattern in (
    rf"(?:how\s+much\s+)?(?:free\s+space|disk\s*space|space\s+(?:left|free|available))\s+(?:is\s+)?(?:on\s+)?{_DRIVE}{_SUFFIX}",
    rf"(?:what(?:'s|\s+is)\s+|show\s+)?(?:the\s+)?(?:free\s+space|disk\s*space|storage\s+usage|disk\s+usage)\s+(?:on|for)\s+{_DRIVE}{_SUFFIX}",
    rf"(?:is\s+)?(?:my\s+|the\s+)?{_DRIVE}(?:\s+drive)?\s+(?:full|nearly\s+full|running\s+low){_SUFFIX}",
    rf"how\s+much\s+(?:free\s+)?space\s+(?:is\s+(?:left|free|available)\s+on|does)\s+{_DRIVE}(?:\s+have(?:\s+left)?)?{_SUFFIX}",
))


def classify(text: str):
    """Return a narrow host topic; general, causal and action requests do not match."""
    if not isinstance(text, str) or len(text) > 240:
        return None
    q = re.sub(r"\s+", " ", text.lower().replace("’", "'")).strip().rstrip("?!. ")
    q = re.sub(r"^(?:please\s+|can\s+you\s+|could\s+you\s+)", "", q, count=1)
    if re.fullmatch(r"what(?:'s| is) (?:a |an |the )?(?:cpu|processor|ram|memory|storage|disk space|network|wifi|wi-fi|lan|ip address|system status)", q):
        return None
    for pattern in _DRIVE_PATTERNS:
        match = pattern.fullmatch(q)
        if match:
            return {"topic": "storage", "resource": match["drive"].upper() + ":\\"}
    for topic, patterns in _PATTERNS.items():
        if any(pattern.fullmatch(q) for pattern in patterns):
            return {"topic": topic, "resource": None}
    return None


def _number(value, *, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return float(value) if maximum is None or value <= maximum else None


def _timestamp(value):
    if isinstance(value, str):
        try:
            stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                return None
            return stamp.timestamp()
        except ValueError:
            return None
    return _number(value)


def _iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def _plain(value, limit=256):
    return re.sub(r"[\x00-\x1f\x7f]+", " ", value).strip()[:limit] if isinstance(value, str) else ""


def _markdown(value):
    # Names and mount paths remain literal text in the existing chat renderer.
    return re.sub(r"([\\`*_{}\[\]()<>!|])", r"\\\1", _plain(value, 512))


def _host():
    from intelligence.data_health import _host as read_host
    return read_host()


def _metrics():
    from routers.dashboard_presence import _read_state
    value = _read_state()
    return {"ok": not bool(value.get("probe_error")), "observed_at": value.get("probed_ts"),
            "cpu_pct": value.get("cpu_pct"), "ram_pct": value.get("ram_pct")}


def _memory():
    import psutil
    value = psutil.virtual_memory()
    gib = 1024 ** 3
    return {"ok": True, "observed_at": time.time(), "ram_pct": value.percent,
            "total_gb": value.total / gib, "used_gb": value.used / gib, "available_gb": value.available / gib}


def _storage():
    from routers.system_routes import system_disk
    value = system_disk()
    return {**value, "observed_at": time.time() if value.get("ok") is True else None}


def _network():
    import psutil
    addresses = psutil.net_if_addrs()
    try:
        stats = psutil.net_if_stats()
    except Exception:
        stats = {}
    rows = []
    for name, entries in addresses.items():
        ips = []
        for entry in entries:
            if entry.family not in (socket.AF_INET, socket.AF_INET6):
                continue
            try:
                address = ipaddress.ip_address(entry.address.split("%")[0])
            except (ValueError, AttributeError):
                continue
            if not address.is_loopback:
                ips.append(entry.address)
        if ips:
            status = stats.get(name)
            rows.append({"name": name, "addresses": ips, "is_up": status.isup if status else None})
    return {"ok": True, "observed_at": time.time(), "interfaces": rows}


def _printers():
    import tli_state as S
    # Unlike devices.inventory(), this read does not initialize metadata paths
    # or conceal a missing/malformed cache as an empty, freshly checked list.
    path = Path(S.DATA_DIR) / "intelligence" / "printer_cache.json"
    try:
        with path.open("rb") as handle:
            raw = handle.read(MAX_CACHE_BYTES + 1)
    except FileNotFoundError:
        return {"ok": None, "printers": None, "observed_at": None}
    if len(raw) > MAX_CACHE_BYTES:
        raise ValueError("Printer observation exceeds its read limit")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("Invalid printer cache")
    return {"ok": True, "printers": value.get("printers"), "observed_at": value.get("checked_at")}


def _read(readers, key):
    try:
        reader = readers[key] if readers is not None else {
            "host": _host, "cpu": _metrics, "ram": _memory, "system": _metrics,
            "storage": _storage, "network": _network, "printers": _printers,
        }[key]
        result = reader()
        return result if isinstance(result, dict) else {"ok": False}
    except Exception:
        return {"ok": False}


_DESCRIPTIONS = {
    "cpu": ("CPU utilization", "Dashboard metric observation", "CPU utilization sample only; this does not establish sustained overload or its cause."),
    "ram": ("RAM usage", "Host memory observation (psutil)", "Host RAM at this observation; this does not identify which application uses it or diagnose memory pressure."),
    "system": ("CPU and RAM utilization", "Dashboard metric observation", "CPU and RAM samples only; storage, networking and AI availability are separate checks."),
    "storage": ("Reported storage volumes", "Host storage observation (psutil)", "Reported volumes only; inaccessible mounts may be omitted. This is not a folder scan or a list of files safe to delete."),
    "network": ("Host network interfaces", "Host network-interface observation (psutil)", "Local interface addresses and reported link state only. No LAN scan, ping, DNS, internet-speed or Wi-Fi-signal test was run."),
    "printers": ("Saved printer inventory", "Saved printer inventory", "Previously saved host printer inventory only; no refresh, queue check, device contact or physical print check was run."),
}


def _observation_state(data, now):
    observed = _timestamp(data.get("observed_at"))
    if observed is not None and (observed <= 0 or observed > now + 2):
        observed = None
    if data.get("ok") is False:
        return "unavailable", observed
    if data.get("ok") is not True or observed is None:
        return "unknown", observed
    return ("current" if now - observed <= FRESH_SECONDS else "stale"), observed


def _metric_line(label, value):
    percent = _number(value, maximum=100)
    return f"- {label}: **{percent:g}%** used." if percent is not None else f"- {label}: unavailable in this observation."


def _resource_lines(topic, data, resource):
    """Return lines and whether the returned domain shape is usable."""
    if topic == "cpu":
        return [_metric_line("CPU", data.get("cpu_pct"))], _number(data.get("cpu_pct"), maximum=100) is not None
    if topic == "system":
        return [_metric_line("CPU", data.get("cpu_pct")), _metric_line("RAM", data.get("ram_pct"))], any(_number(data.get(key), maximum=100) is not None for key in ("cpu_pct", "ram_pct"))
    if topic == "ram":
        lines = [_metric_line("RAM", data.get("ram_pct"))]
        for key, label in (("total_gb", "Total RAM"), ("used_gb", "Used RAM"), ("available_gb", "Available RAM")):
            value = _number(data.get(key))
            lines.append(f"- {label}: **{value:.1f} GiB**." if value is not None else f"- {label}: unavailable in this observation.")
        return lines, _number(data.get("ram_pct"), maximum=100) is not None or any(_number(data.get(key)) is not None for key in ("total_gb", "used_gb", "available_gb"))
    if topic == "storage":
        rows = data.get("drives")
        if not isinstance(rows, list) or not rows or any(not isinstance(row, dict) or not _plain(row.get("mount")) for row in rows):
            return ["No usable volume readings were returned. This does not mean that the host has no drives."], False
        if resource:
            rows = [row for row in rows if row["mount"].rstrip("\\/").casefold() == resource.rstrip("\\/").casefold()]
            if not rows:
                return [f"The requested drive {_markdown(resource)} was not returned by this observation. Its capacity and accessibility are unconfirmed."], False
        lines, usable = [], False
        for row in rows[:MAX_ROWS]:
            percent = _number(row.get("pct"), maximum=100)
            free, total = _number(row.get("free_gb")), _number(row.get("total_gb"))
            capacity = f"{free:.1f} GiB free of {total:.1f} GiB" if free is not None and total is not None and total > 0 and free <= total else "free/total capacity unavailable"
            used = f"{percent:g}% used" if percent is not None else "percentage unavailable"
            usable = usable or percent is not None or free is not None and total is not None and total > 0 and free <= total
            lines.append(f"- **{_markdown(row['mount'])}**: {capacity}; {used}.")
        if len(rows) > MAX_ROWS:
            lines.append(f"Showing {MAX_ROWS} of {len(rows)} reported volumes. Open Free Space to review more.")
        lines.append("Open Free Space to inspect large files and folders; no cleanup was performed.")
        return lines, usable
    if topic == "network":
        rows = data.get("interfaces")
        if not isinstance(rows, list) or any(not isinstance(row, dict) or not _plain(row.get("name")) or not isinstance(row.get("addresses"), list) or not all(isinstance(address, str) for address in row["addresses"]) for row in rows):
            return ["The host's network interface information is unavailable."], False
        if not rows:
            return ["No non-loopback IP addresses were returned by the host interface observation. This does not establish internet availability."], True
        lines = []
        for row in rows[:MAX_ROWS]:
            link = "up" if row.get("is_up") is True else "down" if row.get("is_up") is False else "unknown"
            lines.append(f"- **{_markdown(row['name'])}**: {', '.join(_markdown(address) for address in row['addresses'][:8]) or 'address unavailable'}; reported link {link}.")
        if len(rows) > MAX_ROWS:
            lines.append(f"Showing {MAX_ROWS} of {len(rows)} reported interfaces.")
        return lines, True
    rows = data.get("printers")
    if not isinstance(rows, list) or any(not isinstance(row, dict) or not _plain(row.get("name") or row.get("system_name")) for row in rows):
        return ["No readable printer inventory is available. Open Printers & USB and choose Refresh to check the host."], False
    if not rows:
        return ["The saved inventory contains no printers. This is the recorded inventory, not a new discovery result."], True
    lines = []
    for row in rows[:MAX_ROWS]:
        name = _markdown(row.get("name") or row.get("system_name"))
        default = " · recorded default" if row.get("is_default") is True else ""
        status = _markdown(row.get("status")) or "unknown"
        lines.append(f"- **{name}**{default} · recorded status: {status}.")
    if len(rows) > MAX_ROWS:
        lines.append(f"Showing {MAX_ROWS} of {len(rows)} saved printers.")
    if not any(row.get("is_default") is True for row in rows):
        lines.append("The saved inventory does not confirm a default printer.")
    return lines, True


def public_receipt(value):
    """Copy only the versioned public fields; malformed persisted receipts vanish."""
    fields = {"schema_version", "topic", "host", "resource", "source", "observed_at", "checked_at", "status", "coverage"}
    if not isinstance(value, dict) or set(value) != fields or type(value.get("schema_version")) is not int or value["schema_version"] != 1:
        return None
    host = value.get("host")
    if value.get("topic") not in TOPICS or value.get("status") not in {"current", "stale", "unavailable", "unknown"}:
        return None
    if not isinstance(host, dict) or set(host) != {"id", "name"} or any(not isinstance(host.get(key), str) or not 1 <= len(host[key]) <= 256 for key in host):
        return None
    if any(not isinstance(value.get(key), str) or not 1 <= len(value[key]) <= limit for key, limit in (("resource", 512), ("source", 160), ("coverage", 1000))):
        return None
    if not isinstance(value.get("checked_at"), str) or _timestamp(value["checked_at"]) is None:
        return None
    if value.get("observed_at") is not None and (not isinstance(value["observed_at"], str) or _timestamp(value["observed_at"]) is None):
        return None
    if value["status"] in {"current", "stale"} and value["observed_at"] is None:
        return None
    return {**value, "host": dict(host)}


def answer(text: str, *, has_context=False, readers=None, now=None):
    """Answer only an explicit host query with no attached/selected context.

    Inject zero-argument readers named host/cpu/ram/storage/network/printers/
    system in tests. A failed matched query returns an unavailable answer, never
    an empty success or a model fallback that could invent current measurements.
    """
    if has_context:
        return None
    intent = classify(text)
    if intent is None:
        return None
    topic = intent["topic"]
    data = _read(readers, topic)
    checked = time.time() if now is None else float(now)
    host = _read(readers, "host")
    host = {"id": _plain(host.get("id")) or "unknown", "name": _plain(host.get("name")) or "Unknown TLI host"}
    resource, source, coverage = _DESCRIPTIONS[topic]
    resource = intent["resource"] or resource
    status, observed = _observation_state(data, checked)
    if status in {"current", "stale"} or status == "unavailable" and observed is not None:
        lines, usable = _resource_lines(topic, data, intent["resource"])
        if not usable:
            status = "unavailable"
        elif status == "unavailable":
            lines.insert(0, "The latest check failed. These are retained readings from the last successful observation, not current measurements.")
    else:
        lines = [f"{resource} could not be confirmed from this host observation."]
        # A never-run printer inventory is unknown, not a confirmed empty list.
        if topic == "printers":
            lines.append("Open Printers & USB and choose Refresh to check the host's printer inventory.")
    timing = f"Observed {_iso(observed)}" if observed is not None else "Observation time unavailable"
    state_label = {"current": "within the 30-second freshness window", "stale": "stale; previous readings only", "unknown": "current readings unknown", "unavailable": "current readings unavailable"}[status]
    body = f"**{_markdown(resource)} — TLI host: {_markdown(host['name'])}**\n\n" + "\n".join(lines)
    body += f"\n\n{timing} · {state_label}.\nSource: {source}. {coverage}"
    receipt = {"schema_version": 1, "topic": topic, "host": host, "resource": resource, "source": source,
               "observed_at": _iso(observed) if observed is not None else None, "checked_at": _iso(checked), "status": status, "coverage": coverage}
    from intelligence import answer_evidence
    return {"text": body, "observation_context": public_receipt(receipt),
            "evidence_context": answer_evidence.finalize(answer_evidence.build(observation=receipt), body)}
