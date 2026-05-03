# TheLANIntelligence/backend/routers/printers.py
"""Printers Router (TLI HomeOS) — Phase 1.5

Endpoints:
- GET      /api/printers
- GET      /api/printers/context
- GET|POST /api/printers/test_print
- GET|POST /api/printers/open_scan

IMPORTANT:
- main.py already defines /api/printers/open_add and /api/printers/discover.
  This router intentionally does NOT define /api/printers/open_add to avoid route collisions.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from typing import Any, Dict, List, Optional
import json
import platform
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# --- Optional SNMP (for ink/toner) ---
try:
    from pysnmp.hlapi import (
        SnmpEngine, CommunityData, UdpTransportTarget, ContextData,
        ObjectType, ObjectIdentity, nextCmd
    )
    _SNMP_AVAILABLE = True
except Exception:
    _SNMP_AVAILABLE = False


# --- SNMP Config (Option B: per-printer override) ---
SNMP_CFG_PATH = Path(__file__).with_name("printers_snmp.json")

def _load_snmp_cfg() -> Dict[str, Any]:
    if SNMP_CFG_PATH.exists():
        try:
            return json.loads(SNMP_CFG_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"default_community": "public", "printers": {}}

def _save_snmp_cfg(cfg: Dict[str, Any]) -> None:
    SNMP_CFG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

def _cfg_get_printer_override(cfg: Dict[str, Any], printer_name: str) -> Dict[str, Any]:
    try:
        return (cfg.get("printers") or {}).get(printer_name) or {}
    except Exception:
        return {}


printer_router = APIRouter(tags=["printers"])
router = printer_router
__all__ = ["printer_router", "router"]


def _ps_json(script: str, timeout_s: int = 12) -> Any:
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    if p.returncode != 0:
        err = (p.stderr or "").strip() or "PowerShell failed"
        raise RuntimeError(err)
    out = (p.stdout or "").strip()
    return json.loads(out) if out else None


def _run_powershell(script: str, timeout_s: int = 20) -> subprocess.CompletedProcess:
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)


def _safe_text(v: Any, max_len: int = 180) -> str:
    s = str(v or "").replace("\r", " ").replace("\n", " ").strip()
    if len(s) > max_len:
        s = s[: max_len - 1] + "…"
    return s


def _norm_status(raw: Any) -> str:
    s = str(raw or "").strip().lower()
    if not s:
        return "unknown"
    if s in {"idle", "ready", "normal"}:
        return "ready"
    if any(k in s for k in ["offline", "off-line", "not available", "unavailable"]):
        return "offline"
    if any(k in s for k in ["error", "paper", "jam", "door", "toner", "ink", "paused", "busy", "attention", "problem"]):
        return "error"
    return "unknown"


def _looks_virtual(name: str) -> bool:
    n = (name or "").strip().lower()
    if not n:
        return False
    return any(k in n for k in ["microsoft print to pdf", "fax", "xps", "onenote"])


def _tli_test_page() -> str:
    art = r"""
 _________  ___       ___     
|\___   ___\\  \     |\  \    
\|___ \  \_\ \  \    \ \  \   
     \ \  \ \ \  \    \ \  \  
      \ \  \ \ \  \____\ \  \ 
       \ \__\ \ \_______\ \__\
        \|__|  \|_______|\|__|
""".strip("\n")

    return (
        "================================================================================\n"
        " TheLANIntelligence — LAN Console\n"
        " Offline-first • LAN-only • No cloud • No tracking\n"
        "--------------------------------------------------------------------------------\n\n"
        + art
        + "\n\n"
        "--------------------------------------------------------------------------------\n"
        " TEST PRINT: OK\n"
        " If you can read this page, printing is working.\n"
        "================================================================================\n"
    )


# =====================================================
# CUPS helpers — macOS / Linux
# =====================================================

def _extract_ip_from_uri(uri: str) -> Optional[str]:
    """Pull host/IP out of a CUPS device URI like ipp://192.168.1.10/ipp/print."""
    if not uri:
        return None
    m = re.search(r'://([^/:@]+)', uri)
    if m:
        host = m.group(1)
        if host and host not in ("localhost", "127.0.0.1", "::1"):
            return host
    return None


def _cups_list_printers() -> List[Dict[str, Any]]:
    """Enumerate CUPS printers via lpstat on macOS / Linux."""
    printers: List[Dict[str, Any]] = []

    # --- printer names + status ---
    try:
        r = subprocess.run(["lpstat", "-p"], capture_output=True, text=True, timeout=10)
        for line in r.stdout.splitlines():
            m = re.match(r'^\s*printer\s+(\S+)\s+is\s+(\w+)', line, re.IGNORECASE)
            if m:
                printers.append({"name": m.group(1), "status_raw": m.group(2).lower()})
    except Exception:
        pass

    # If lpstat returned nothing, fall back to lpstat -a
    if not printers:
        try:
            r = subprocess.run(["lpstat", "-a"], capture_output=True, text=True, timeout=10)
            for line in r.stdout.splitlines():
                m = re.match(r'^\s*(\S+)\s+accepting', line, re.IGNORECASE)
                if m:
                    printers.append({"name": m.group(1), "status_raw": "idle"})
        except Exception:
            pass

    # --- device URIs (for IP extraction) ---
    uri_map: Dict[str, str] = {}
    try:
        r = subprocess.run(["lpstat", "-v"], capture_output=True, text=True, timeout=10)
        for line in r.stdout.splitlines():
            m = re.match(r'^\s*device for\s+(\S+):\s+(.+)$', line, re.IGNORECASE)
            if m:
                uri_map[m.group(1)] = m.group(2).strip()
    except Exception:
        pass

    # --- default printer ---
    default_name: Optional[str] = None
    try:
        r = subprocess.run(["lpstat", "-d"], capture_output=True, text=True, timeout=5)
        m = re.search(r'system default destination:\s+(\S+)', r.stdout, re.IGNORECASE)
        if m:
            default_name = m.group(1)
    except Exception:
        pass

    result: List[Dict[str, Any]] = []
    for p in printers:
        name = p["name"]
        uri  = uri_map.get(name, "")
        ip   = _extract_ip_from_uri(uri)
        is_network = bool(ip) or any(
            uri.startswith(scheme) for scheme in ("ipp://", "ipps://", "socket://", "lpd://", "http://")
        )
        result.append({
            "name": name,
            "system_name": name,
            "is_default": (name == default_name),
            "status": _norm_status(p["status_raw"]),
            "driver": None,
            "port": uri or None,
            "location": None,
            "is_network": is_network,
            "is_virtual": _looks_virtual(name),
            "ip": ip or None,
            "hostname": ip or None,
            "port_number": None,
            "connection_type": "network" if is_network else "local",
        })

    result.sort(key=lambda x: (0 if x.get("is_default") else 1, (x.get("name") or "").lower()))
    return result


def _cups_job_counts() -> Dict[str, Any]:
    """Return pending job counts from CUPS via lpstat -o."""
    try:
        r = subprocess.run(["lpstat", "-o"], capture_output=True, text=True, timeout=5)
        lines = [l for l in r.stdout.splitlines() if l.strip()]
        by_printer: Dict[str, int] = {}
        for line in lines:
            # job-id format: "printerName-123  user  ..."
            job_id = line.split()[0] if line.split() else ""
            m = re.match(r'^(.+?)-\d+$', job_id)
            pname = m.group(1) if m else job_id
            by_printer[pname] = by_printer.get(pname, 0) + 1
        return {"total": len(lines), "by_printer": by_printer}
    except Exception:
        return {"total": 0, "by_printer": {}}


def _print_text_cups(text: str, printer_name: Optional[str] = None) -> None:
    """Send a text file to the default (or named) CUPS printer."""
    with tempfile.TemporaryDirectory(prefix="tli_print_") as td:
        p = Path(td) / "tli_test_page.txt"
        p.write_text(text, encoding="utf-8")
        cmd = ["lp"]
        if printer_name:
            cmd += ["-d", printer_name]
        cmd.append(str(p))
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if r.returncode != 0:
            msg = (r.stderr or r.stdout or "").strip() or "lp command failed"
            raise RuntimeError(msg)


def _open_scan_posix() -> None:
    """Open a scan application on macOS or Linux."""
    sys = platform.system()
    if sys == "Darwin":
        # Image Capture is the standard macOS scanner UI
        for app in ("Image Capture", "Preview"):
            r = subprocess.run(["open", "-a", app], capture_output=True, text=True, timeout=5)
            if r.returncode == 0:
                return
        raise RuntimeError("Could not open Image Capture. Install it from the App Store or use Preview.")
    else:
        # Linux — try common scan tools
        for cmd in (["simple-scan"], ["xsane"], ["gscan2pdf"]):
            try:
                subprocess.Popen(cmd, close_fds=True)
                return
            except FileNotFoundError:
                continue
        raise RuntimeError("No scanner app found. Install simple-scan: sudo apt install simple-scan")


def _open_add_printer_posix() -> None:
    """Open the system printer management UI on macOS or Linux."""
    sys = platform.system()
    if sys == "Darwin":
        r = subprocess.run(
            ["open", "x-apple.systempreferences:com.apple.Print-Scan-preference-pane"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode != 0:
            # Fallback for older macOS
            subprocess.Popen(["open", "/System/Library/PreferencePanes/PrintAndFax.prefPane"], close_fds=True)
    else:
        for cmd in (["system-config-printer"], ["gnome-control-center", "printers"]):
            try:
                subprocess.Popen(cmd, close_fds=True)
                return
            except FileNotFoundError:
                continue
        raise RuntimeError("No printer settings app found. Try: sudo apt install system-config-printer")


# =====================================================
# Windows helpers
# =====================================================

def _print_text_windows_default_printer(text: str) -> None:
    with tempfile.TemporaryDirectory(prefix="tli_print_") as td:
        p = Path(td) / "tli_test_page.txt"
        p.write_text(text, encoding="utf-8")
        ps = f"$fp = '{str(p)}'; Get-Content -Raw -Encoding UTF8 $fp | Out-Printer"
        r = _run_powershell(ps)
        if r.returncode != 0:
            msg = (r.stderr or r.stdout or "").strip() or "Print failed"
            raise RuntimeError(msg)


def _open_windows_scan_app() -> None:
    ps = "Start-Process 'shell:AppsFolder\\Microsoft.WindowsScan_8wekyb3d8bbwe!App'"
    r = _run_powershell(ps, timeout_s=8)
    if r.returncode != 0:
        msg = (r.stderr or r.stdout or "").strip() or "Could not open Windows Scan"
        raise RuntimeError(msg)


def _windows_job_counts(timeout_s: int = 10) -> Dict[str, Any]:
    ps = r"""
try {
  $jobs = Get-PrintJob | Select-Object PrinterName
  $counts = @{}
  foreach ($j in $jobs) { if ($j.PrinterName) { $counts[$j.PrinterName] = 1 + ($counts[$j.PrinterName] -as [int]) } }
  [PSCustomObject]@{ total = ($jobs | Measure-Object).Count; by_printer = $counts } | ConvertTo-Json -Depth 4
} catch {
  [PSCustomObject]@{ total = 0; by_printer = @{} } | ConvertTo-Json -Depth 4
}
"""
    try:
        data = _ps_json(ps, timeout_s=timeout_s) or {}
        if not isinstance(data, dict):
            return {"total": 0, "by_printer": {}}
        byp = data.get("by_printer") or {}
        if not isinstance(byp, dict):
            byp = {}
        return {"total": int(data.get("total") or 0), "by_printer": byp}
    except Exception:
        return {"total": 0, "by_printer": {}}


@printer_router.get("/api/printers")
def get_printers() -> Any:
    if platform.system() != "Windows":
        return _cups_list_printers()

    cfg = _load_snmp_cfg()
    ps = r"""
$printers = Get-Printer | Select-Object Name,DriverName,PortName,Location,PrinterStatus,Default
$ports    = Get-PrinterPort | Select-Object Name,PrinterHostAddress,HostName,PortNumber,Description
$default  = (Get-CimInstance Win32_Printer | Where-Object {$_.Default -eq $true} | Select-Object -First 1 -ExpandProperty Name)
[PSCustomObject]@{
  printers = $printers
  ports = $ports
  default = $default
} | ConvertTo-Json -Depth 4
"""
    try:
        data = _ps_json(ps) or {}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    printers = data.get("printers") or []
    ports = data.get("ports") or []
    default_name = data.get("default")

    if isinstance(printers, dict):
        printers = [printers]
    if isinstance(ports, dict):
        ports = [ports]

    port_map: Dict[str, Dict[str, Any]] = {}
    for p in ports:
        if isinstance(p, dict) and p.get("Name"):
            port_map[str(p["Name"])] = p

    out: List[Dict[str, Any]] = []
    for pr in printers:
        if not isinstance(pr, dict):
            continue

        name = _safe_text(pr.get("Name") or "Unknown")
        driver = _safe_text(pr.get("DriverName") or "")
        port = _safe_text(pr.get("PortName") or "")
        location = _safe_text(pr.get("Location") or "")

        is_default = bool(pr.get("Default")) or (default_name and str(default_name) == str(pr.get("Name")))
        pinfo = port_map.get(str(pr.get("PortName") or ""), {})

        ip = _safe_text(pinfo.get("PrinterHostAddress") or "")
        host = _safe_text(pinfo.get("HostName") or "")
        desc = _safe_text(pinfo.get("Description") or "")

        # Apply per-printer overrides (Option B) — helps WSD ports
        ov = _cfg_get_printer_override(cfg, name)
        if ov.get("ip"):
            ip = _safe_text(ov.get("ip"))
        if ov.get("hostname"):
            host = _safe_text(ov.get("hostname"))

        is_network = (
            bool(ip or host)
            or port.lower().startswith(("ip_", "tcpip", "wsd"))
            or ("tcp" in desc.lower())
            or ("network" in desc.lower())
        )

        out.append(
            {
                "name": name,
                "system_name": name,
                "is_default": is_default,
                "status": _norm_status(pr.get("PrinterStatus")),
                "driver": driver or None,
                "port": port or None,
                "location": location or None,
                "is_network": is_network,
                "is_virtual": _looks_virtual(name),
                "ip": ip or None,
                "hostname": host or None,
                "port_number": pinfo.get("PortNumber") if isinstance(pinfo, dict) else None,
                "connection_type": ("network" if is_network else "local"),
            }
        )

    out.sort(key=lambda x: (0 if x.get("is_default") else 1, (x.get("name") or "").lower()))
    return out


@printer_router.get("/api/printers/context")
def get_printer_context() -> Any:
    printers = get_printers()
    if isinstance(printers, dict) and printers.get("ok") is False:
        return JSONResponse(printers, status_code=500)

    arr: List[Dict[str, Any]] = printers if isinstance(printers, list) else []
    default_name: Optional[str] = None
    for p in arr:
        if p.get("is_default"):
            default_name = p.get("name") or p.get("system_name")
            break

    jobs = _windows_job_counts() if platform.system() == "Windows" else _cups_job_counts()

    return {
        "default_printer": default_name,
        "printers": arr,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "jobs": jobs,
    }


@printer_router.get("/api/printers/open_scan")
@printer_router.post("/api/printers/open_scan")
def open_scan() -> Any:
    try:
        if platform.system() == "Windows":
            _open_windows_scan_app()
        else:
            _open_scan_posix()
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"ok": False, "message": str(e)}, status_code=500)


@printer_router.get("/api/printers/open_add")
@printer_router.post("/api/printers/open_add")
def open_add_printer() -> Any:
    try:
        if platform.system() == "Windows":
            subprocess.Popen(["explorer.exe", "ms-settings:printers"], close_fds=True)
        else:
            _open_add_printer_posix()
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"ok": False, "message": str(e)}, status_code=500)


@printer_router.get("/api/printers/discover")
def discover_printers() -> Any:
    """Trigger printer discovery — returns current printer list after a brief probe."""
    if platform.system() == "Windows":
        try:
            # Kick off WSD discovery asynchronously (best-effort, non-blocking)
            subprocess.Popen(
                ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command",
                 "Add-PrinterPort -Name WSD-Discovery -PrinterHostAddress 0.0.0.0 -ErrorAction SilentlyContinue"],
                close_fds=True,
            )
        except Exception:
            pass
    # On macOS/Linux CUPS auto-discovers via Bonjour/Avahi — just return current list
    return get_printers()


@printer_router.get("/api/printers/test_print")
@printer_router.post("/api/printers/test_print")
def test_print() -> Any:
    try:
        if platform.system() == "Windows":
            _print_text_windows_default_printer(_tli_test_page())
        else:
            _print_text_cups(_tli_test_page())
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"ok": False, "message": str(e)}, status_code=500)


# =====================================================
# Additive "Life" endpoints (Golden-safe)
# =====================================================

@printer_router.get("/api/printers/snmp/community")
def get_snmp_community_cfg() -> Any:
    return {"ok": True, "cfg": _load_snmp_cfg(), "snmp_available": _SNMP_AVAILABLE}

@printer_router.post("/api/printers/snmp/community")
def set_snmp_community_cfg(payload: Dict[str, Any]) -> Any:
    cfg = _load_snmp_cfg()
    default = payload.get("default_community")
    if default:
        cfg["default_community"] = str(default)

    pname = payload.get("printer_name")
    if pname:
        cfg.setdefault("printers", {})
        cfg["printers"][pname] = cfg["printers"].get(pname, {})
        if payload.get("community"):
            cfg["printers"][pname]["community"] = str(payload.get("community"))
        if payload.get("ip"):
            cfg["printers"][pname]["ip"] = str(payload.get("ip"))
        if payload.get("hostname"):
            cfg["printers"][pname]["hostname"] = str(payload.get("hostname"))

    _save_snmp_cfg(cfg)
    return {"ok": True, "cfg": cfg}

@printer_router.post("/api/printers/ip_override")
def set_printer_ip_override(payload: Dict[str, Any]) -> Any:
    pname = payload.get("printer_name")
    ip = payload.get("ip")
    if not pname or not ip:
        return JSONResponse({"ok": False, "error": "printer_name and ip required"}, status_code=400)

    cfg = _load_snmp_cfg()
    cfg.setdefault("printers", {})
    cfg["printers"][pname] = cfg["printers"].get(pname, {})
    cfg["printers"][pname]["ip"] = str(ip)
    _save_snmp_cfg(cfg)
    return {"ok": True, "printer_name": pname, "ip": ip}

def _ping(ip: str, timeout_s: int = 3) -> bool:
    try:
        count_flag = "-n" if platform.system() == "Windows" else "-c"
        r = subprocess.run(["ping", count_flag, "1", ip], capture_output=True, text=True, timeout=timeout_s)
        return r.returncode == 0
    except Exception:
        return False

@printer_router.get("/api/printers/health")
def printers_health() -> Any:
    cfg = _load_snmp_cfg()
    try:
        plist = get_printers()
        # if get_printers returned JSONResponse, normalize
        if isinstance(plist, dict) and plist.get("ok") is False:
            return {"ok": False, "error": plist.get("error")}

        results = []
        for pr in (plist or []):
            name = pr.get("name")
            ip = pr.get("ip") or _cfg_get_printer_override(cfg, name).get("ip")
            reachable = _ping(ip) if ip else False
            state = "unknown"
            if ip and reachable:
                state = "ready"
            elif ip and not reachable:
                state = "offline"
            results.append({
                "name": name,
                "ip": ip,
                "reachable": reachable,
                "state": state,
                "ts": datetime.now(timezone.utc).isoformat()
            })
        return {"ok": True, "health": results}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

# SNMP Printer-MIB supplies
# OIDs (prtMarkerSuppliesTable):
_OID_SUP_DESC = "1.3.6.1.2.1.43.11.1.1.6.1"
_OID_SUP_MAX  = "1.3.6.1.2.1.43.11.1.1.8.1"
_OID_SUP_LVL  = "1.3.6.1.2.1.43.11.1.1.9.1"

_SUPPLIES_CACHE: Dict[str, Any] = {}
_SUPPLIES_TTL_S = 60

def _snmp_walk(host: str, community: str, oid: str, timeout: int = 1, retries: int = 0) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not _SNMP_AVAILABLE:
        return out
    for (errInd, errStat, errIdx, varBinds) in nextCmd(
        SnmpEngine(),
        CommunityData(community, mpModel=1),  # v2c
        UdpTransportTarget((host, 161), timeout=timeout, retries=retries),
        ContextData(),
        ObjectType(ObjectIdentity(oid)),
        lexicographicMode=False,
    ):
        if errInd or errStat:
            break
        for vb in varBinds:
            k = str(vb[0])
            v = vb[1]
            out[k] = v.prettyPrint()
    return out

def _parse_index(oid_key: str) -> str:
    # index is everything after base oid + dot
    return oid_key.split(_OID_SUP_DESC + ".")[-1] if _OID_SUP_DESC in oid_key else oid_key.split(".")[-1]

@printer_router.get("/api/printers/supplies")
def printers_supplies() -> Any:

    cfg = _load_snmp_cfg()
    now = datetime.now(timezone.utc).timestamp()

    # cache key is printer name+ip
    plist = get_printers()
    results = []

    for pr in (plist or []):
        name = pr.get("name")
        ip = pr.get("ip") or _cfg_get_printer_override(cfg, name).get("ip")
        if not ip:
            results.append({"name": name, "ok": False, "error": "no_ip"})
            continue

        cache_key = f"{name}::{ip}"
        cached = _SUPPLIES_CACHE.get(cache_key)
        if cached and (now - cached.get("ts", 0)) < _SUPPLIES_TTL_S:
            results.append(cached.get("data"))
            continue

        ov = _cfg_get_printer_override(cfg, name)
        community = str(ov.get("community") or cfg.get("default_community") or "public")

        if not _SNMP_AVAILABLE:
            data = {"name": name, "ip": ip, "ok": False, "error": "pysnmp_not_installed"}
            _SUPPLIES_CACHE[cache_key] = {"ts": now, "data": data}
            results.append(data)
            continue

        try:
            descs = _snmp_walk(ip, community, _OID_SUP_DESC, timeout=1, retries=0)
            maxs  = _snmp_walk(ip, community, _OID_SUP_MAX,  timeout=1, retries=0)
            lvls  = _snmp_walk(ip, community, _OID_SUP_LVL,  timeout=1, retries=0)

            items = []
            # Build by index suffix from desc keys
            for k, d in descs.items():
                idx = k.split(_OID_SUP_DESC + ".")[-1]
                # find corresponding keys in other tables
                max_key = _OID_SUP_MAX + "." + idx
                lvl_key = _OID_SUP_LVL + "." + idx
                try:
                    mx = int(maxs.get(max_key, "-1"))
                except Exception:
                    mx = -1
                try:
                    lv = int(lvls.get(lvl_key, "-1"))
                except Exception:
                    lv = -1

                pct = None
                if mx and mx > 0 and lv >= 0:
                    pct = max(0, min(100, int(round((lv / mx) * 100))))
                items.append({
                    "description": d,
                    "level": lv,
                    "max": mx,
                    "percent": pct
                })

            data = {"name": name, "ip": ip, "ok": True, "items": items}
            # If nothing returned, mark unavailable
            if not items:
                data = {"name": name, "ip": ip, "ok": False, "error": "no_supplies_exposed"}

            _SUPPLIES_CACHE[cache_key] = {"ts": now, "data": data}
            results.append(data)
        except Exception as e:
            data = {"name": name, "ip": ip, "ok": False, "error": str(e)}
            _SUPPLIES_CACHE[cache_key] = {"ts": now, "data": data}
            results.append(data)

    return {"ok": True, "supplies": results}
