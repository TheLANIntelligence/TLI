"""User-triggered, bounded read-only diagnostics and encrypted evidence history."""
from __future__ import annotations

import ipaddress
import copy
import hashlib
import json
import platform
import re
import socket
import subprocess
import sys
import threading
import time
import uuid

import psutil
from fastapi import HTTPException
import tli_state as S
from intelligence import devices
from intelligence.store import LOCK, read_private, write_private

_slots = threading.BoundedSemaphore(2)


def command(args: list[str], timeout=5) -> str:
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, shell=False,
                            **({"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}))
    if result.returncode:
        raise RuntimeError((result.stderr or "Check returned no successful result")[:300])
    return result.stdout


def gateway() -> str:
    system = platform.system()
    if system == "Windows":
        raw = command(["powershell", "-NoProfile", "-Command",
                       "Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1 -ExpandProperty NextHop"])
        address = raw.strip()
    elif system == "Darwin":
        raw = command(["route", "-n", "get", "default"])
        found = re.search(r"gateway:\s*(\S+)", raw)
        address = found.group(1) if found else ""
    else:
        rows = json.loads(command(["ip", "-json", "route", "show", "default"]))
        rows.sort(key=lambda row: row.get("metric", 0))
        address = rows[0].get("gateway", "") if rows else ""
    return str(ipaddress.ip_address(address))


def probe(ident: str, label: str, fn) -> dict:
    start = time.monotonic()
    try:
        status, detail = fn()
    except Exception as exc:
        status, detail = "unavailable", str(exc)[:300]
    return {"id": ident, "label": label, "status": status, "detail": detail,
            "duration_ms": int((time.monotonic() - start) * 1000)}


def ping(address: str) -> tuple:
    address = str(ipaddress.ip_address(address))  # arguments are always literal IPs
    try:
        command(["ping", "-n" if platform.system() == "Windows" else "-c", "1", address], timeout=3)
        return "pass", f"{address} answered ICMP."
    except RuntimeError:
        return "fail", f"No ICMP reply from {address}; blocked ping does not establish that it is offline."


def tcp(address: str, port: int) -> tuple:
    # Resolve names in a time-bounded subprocess instead of blocking indefinitely in libc DNS.
    try:
        ipaddress.ip_address(address)
    except ValueError:
        address = resolve_hostname(address)
    try:
        with socket.create_connection((address, port), timeout=2):
            return "pass", f"A TCP connection to {address}:{port} succeeded."
    except OSError:
        return "fail", f"No TCP connection to {address}:{port}. The service may be unavailable or filtered."


def resolve_hostname(host: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", host):
        raise ValueError("Registered address is not a valid hostname.")
    raw = command(["nslookup", "-type=A", host])
    # Ignore the resolver address printed before the answer section.
    answer = re.split(r"Name:\s*", raw, flags=re.IGNORECASE)[-1] if re.search(r"Name:\s*", raw, re.IGNORECASE) else ""
    addresses = re.findall(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])", answer)
    if not addresses:
        raise RuntimeError("DNS lookup returned no IPv4 answer.")
    return str(ipaddress.ip_address(addresses[0]))


def history(user: str) -> list:
    with LOCK:
        return read_private(user, "diagnostics", [])


def get_report(user: str, report_id: str) -> dict:
    result = next((r for r in history(user) if r["id"] == report_id), None)
    if result is None:
        raise HTTPException(404, "Diagnostic report not found.")
    return result


def save_report(user: str, report: dict, request_id: str | None = None) -> dict:
    """Save an explicitly reviewed observation, without running any check.

    Stable source content and an optional request key prevent competing saves
    from overwriting an existing report, including later user-confirmed fixes.
    Internal receipts share the existing encrypted diagnostic store and backups.
    """
    required = {"id", "created_at", "kind", "host", "target", "checks", "findings", "next_steps", "scope"}
    if not isinstance(report, dict) or not required.issubset(report) or not isinstance(report.get("id"), str) or not report["id"]:
        raise HTTPException(422, "The observation does not contain a complete report.")
    if any(str(key).startswith("_save_") for key in report):
        raise HTTPException(422, "Internal save receipts cannot be supplied as report content.")
    if request_id is not None and (not isinstance(request_id, str) or not 1 <= len(request_id) <= 128):
        raise HTTPException(422, "Use a bounded, nonempty save request identifier.")
    try:
        raw = json.dumps(report, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError):
        raise HTTPException(422, "The observation contains invalid values.") from None
    if len(raw) > 256 * 1024:
        raise HTTPException(413, "This observation exceeds the saved report limit.")
    fingerprint = hashlib.sha256(raw).hexdigest()
    receipt = hashlib.sha256(request_id.encode()).hexdigest() if request_id else None
    with LOCK:
        saved = history(user)  # Missing keys or unreadable data must fail first.
        for item in saved:
            if item.get("id") == report["id"] or receipt and item.get("_save_request") == receipt:
                if item.get("_save_fingerprint") != fingerprint:
                    raise HTTPException(409, "This save identifier already belongs to a different observation. No report was replaced.")
                return copy.deepcopy(item)
        value = copy.deepcopy(report)
        value["_save_fingerprint"] = fingerprint
        if receipt:
            value["_save_request"] = receipt
        write_private(user, "diagnostics", [value, *saved][:200])
        return copy.deepcopy(value)


def run(user: str, kind: str, target_id: str | None, internet: bool = False, *, _request_receipt=None, _reviewed_scope=None) -> dict:
    if kind not in {"system", "network", "device"}:
        raise HTTPException(422, "Choose an available diagnostic check.")
    if internet and kind != "network":
        raise HTTPException(422, "Internet checks belong to the network check only.")
    # Preserve old callers that supplied the local inventory entry, while never
    # labelling a host measurement as a check of another selected computer.
    if kind != "device" and target_id:
        requested, execution_host = devices.get(target_id), devices.node()
        if (requested.get("source") != "local_node" or
                (requested.get("source_id") or requested.get("node_id")) != execution_host.get("id")):
            raise HTTPException(422, "System and network checks measure the TLI host, not another selected computer.")
        target_id = None
    if not _slots.acquire(blocking=False):
        raise HTTPException(429, "Two diagnostic sessions are already running. Try again shortly.")
    from event_bus import emit_event
    emit_event("system", "info", "Diagnostic checks requested", "Preparing the requested checks. No repairs will be performed.")
    try:
        host = copy.deepcopy(_reviewed_scope["host"]) if _reviewed_scope else devices.node()
        target = copy.deepcopy(_reviewed_scope["target"]) if _reviewed_scope else (devices.get(target_id) if target_id else None)
        checks, next_steps = [], []
        if kind == "device":
            if not target:
                raise HTTPException(422, "Select a registered device first.")
            if target["source"] == "local_node":
                raise HTTPException(422, "Use host resource checks for this TLI computer.")
            address = target.get("address")
            if not address:
                checks.append({"id": "address", "label": "Registered network address", "status": "unavailable",
                               "detail": "No network address is registered. A USB printer cannot be tested with a network probe."})
            else:
                ports = (631, 9100) if target["kind"] == "printer" else (80, 443)
                for port in ports:
                    checks.append(probe(f"tcp_{port}", f"Service reachability (port {port})", lambda p=port: tcp(address, p)))
            next_steps = ["Check the device's power and registered address.",
                          "A successful connection confirms reachability, not that printing or another device function works."]
        elif kind == "system":
            def cpu():
                value = psutil.cpu_percent(interval=0.2)
                return ("fail" if value >= 90 else "pass"), f"CPU usage was {value:.0f}% in this sample."
            def ram():
                value = psutil.virtual_memory().percent
                return ("fail" if value >= 90 else "pass"), f"RAM usage was {value:.0f}%."
            checks = [probe("cpu", "Host CPU", cpu), probe("ram", "Host memory", ram)]
            try:
                partitions = psutil.disk_partitions(all=False)[:16]
            except Exception as exc:
                partitions = []
                checks.append({"id": "disks", "label": "Host storage", "status": "unavailable", "detail": str(exc)[:300]})
            for partition in partitions:
                def disk(mount=partition.mountpoint):
                    value = psutil.disk_usage(mount).percent
                    return ("fail" if value >= 85 else "pass"), f"{mount}: {value:.0f}% used."
                checks.append(probe(f"disk:{partition.mountpoint}", f"Storage {partition.mountpoint}", disk))
            next_steps = ["If resource pressure persists, review running applications or storage in the existing TLI panels."]
        else:
            def interfaces():
                stats = psutil.net_if_stats()
                addresses = psutil.net_if_addrs()
                names = [name for name, stat in stats.items() if stat.isup and any(
                    a.family == socket.AF_INET and not ipaddress.ip_address(a.address).is_loopback for a in addresses.get(name, []))]
                return ("pass" if names else "fail"), ("Active interfaces: " + ", ".join(names)) if names else "No active non-loopback IPv4 interface was found."
            checks.append(probe("interfaces", "Host network interfaces", interfaces))
            route = {}
            def route_check():
                route["gateway"] = gateway()
                return "pass", f"Default IPv4 gateway: {route['gateway']}."
            checks.append(probe("gateway", "Default route", route_check))
            if route.get("gateway"):
                checks.append(probe("gateway_ping", "Gateway response", lambda: ping(route["gateway"])))
            if internet:
                checks.append(probe("internet", "External reachability (1.1.1.1:443)", lambda: tcp("1.1.1.1", 443)))
                def dns():
                    try:
                        value = resolve_hostname("example.com")
                        return "pass", f"The configured resolver resolved example.com to {value}."
                    except RuntimeError:
                        return "fail", "The configured resolver did not resolve example.com."
                checks.append(probe("dns", "DNS lookup (example.com)", dns))
            next_steps = ["Check the host's cable or Wi-Fi connection and router if local checks fail."]
            if not internet:
                next_steps.append("External reachability and DNS were not tested. Enable internet checks to include them.")
        findings = []
        statuses = {c["id"]: c["status"] for c in checks}
        if statuses.get("internet") == "pass" and statuses.get("dns") == "fail":
            findings.append({"certainty": "likely", "text": "Name resolution may be failing: an external TCP connection succeeded while DNS lookup failed."})
        for c in checks:
            if c["status"] != "pass":
                findings.append({"certainty": "confirmed" if c["status"] == "fail" else "uncertain", "text": c["detail"]})
        if not findings:
            findings.append({"certainty": "confirmed", "text": "The checks performed passed. This does not establish that every device function or network path is healthy."})
        report = {"id": uuid.uuid4().hex, "created_at": S.now_iso(), "kind": kind, "target": target,
                  "host": host, "internet_checks": internet, "checks": checks, "findings": findings,
                  "next_steps": next_steps, "verified_fix": None,
                  "scope": f"Checks ran on {host['name']}. They do not measure the requesting phone or browser's connection."}
        if _request_receipt is not None:
            report["_check_request"] = dict(_request_receipt)
        with LOCK:
            saved = history(user)
            from intelligence.report_review import compare
            repeated = (_request_receipt or {}).get("repeat_of")
            previous = next((r for r in saved if r.get("id") == repeated), None) if repeated else next(
                (r for r in saved if compare(r, report)["comparable"]), None)
            report["comparison"] = compare(previous, report) if previous else None
            write_private(user, "diagnostics", [report, *saved][:200])
        from event_bus import emit_event
        failed = sum(c["status"] == "fail" for c in checks)
        unavailable = sum(c["status"] == "unavailable" for c in checks)
        emit_event("system", "warn" if failed or unavailable else "ok", "Diagnostic checks completed",
                   f"{len(checks)} checks: {len(checks) - failed - unavailable} passed, {failed} failed, {unavailable} unavailable. Open your diagnostic history for scope and results; no repairs were performed.")
        return report
    except Exception:
        emit_event("system", "warn", "Diagnostic checks did not finish", "The request could not complete. Review the error in Diagnostics; no repairs were performed.")
        raise
    finally:
        _slots.release()


def confirm_fix(user: str, report_id: str, text: str) -> dict:
    with LOCK:
        reports = history(user)
        report = next((r for r in reports if r["id"] == report_id), None)
        if not report:
            raise HTTPException(404, "Diagnostic report not found.")
        report["verified_fix"] = {"text": text.strip(), "confirmed_at": S.now_iso(), "source": "user_confirmation"}
        from intelligence.memory import save_fact
        fact = save_fact(user, text=f"Confirmed fix for {(report.get('target') or {}).get('name') or report['kind']}: {text.strip()}",
                         category="verified_fix", device_id=(report.get("target") or {}).get("id"), report_id=report_id)
        report["memory_id"] = fact["id"]
        write_private(user, "diagnostics", reports)
        return report
