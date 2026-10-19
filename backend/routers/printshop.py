# backend/routers/printshop.py
# TLI Print & Scan Studio — cross-platform, brand-agnostic
#
# Endpoints
#   GET  /printshop/printers          → list available printers
#   GET  /printshop/scanners          → list available scanners
#   POST /printshop/print             → send file to printer
#   POST /printshop/scan              → acquire from scanner → token
#   GET  /printshop/scan/{token}      → download scanned file
#   DELETE /printshop/scan/{token}    → clean up temp file
#
# Platform strategy
#   Windows : win32print (printers) + PowerShell/WIA (scanners)
#   macOS   : CUPS/lpstat (printers) + SANE/scanimage (scanners)
#   Linux   : CUPS/lpstat (printers) + SANE/scanimage (scanners)
#   All     : IPP direct over HTTP when printer exposes IP

from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import tempfile
import threading
import uuid
from dataclasses import dataclass
from collections.abc import Callable
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from process_utils import hidden_process_kwargs
from browser_authority import browser_control_access
import tli_state as S

PLATFORM = platform.system()   # "Windows" | "Darwin" | "Linux"
printshop_router = APIRouter(tags=["printshop"])

# Legacy unowned tuples are deliberately retained but never granted an owner.
@dataclass(frozen=True)
class _ScanRecord:
    path: str
    mime: str
    owner: str


_scan_store: Dict[str, Any] = {}
_scan_lock  = threading.Lock()


def _private_json(content, status_code=200):
    return JSONResponse(content, status_code=status_code, headers={"Cache-Control": "no-store"})


def _scan_owner(request: Request, check: Callable[[], None]) -> str:
    check()
    token = request.cookies.get("tli_session")
    owner = S.get_session_user_id(token) if token else "local"
    check()
    return owner


def _owned_scan(token: str, owner: str, check: Callable[[], None]) -> _ScanRecord:
    check()
    with _scan_lock:
        entry = _scan_store.get(token)
    check()
    if not isinstance(entry, _ScanRecord) or entry.owner != owner:
        raise HTTPException(404, "Scan token not found for this owner")
    return entry


def _remove_new_scan(path: str) -> None:
    """Remove only this operation's known temporary files, never legacy files."""
    target = Path(path)
    for candidate in (target, target.with_suffix(".bmp")):
        try:
            candidate.unlink()
        except FileNotFoundError:
            pass
    try:
        target.parent.rmdir()
    except OSError:
        pass  # Never remove an unexpected file or recursively delete a directory.


class _AuthorizedScanResponse(FileResponse):
    """Recheck before headers and each chunk; revocation terminates a transfer."""
    def __init__(self, *args, check: Callable[[], None], **kwargs):
        super().__init__(*args, **kwargs)
        self._check = check

    async def __call__(self, scope, receive, send):
        self._check()
        # A server's zero-copy path-send extension would bypass chunk checks.
        scope = {**scope, "extensions": {key: value for key, value in scope.get("extensions", {}).items()
                                         if key != "http.response.pathsend"}}

        async def checked_send(message):
            self._check()
            await send(message)

        try:
            await super().__call__(scope, receive, checked_send)
        except Exception:
            self._check()
            raise


# ══════════════════════════════════════════════════════════════════════════════
# PRINTER ENUMERATION
# ══════════════════════════════════════════════════════════════════════════════

def _printers_win32() -> List[Dict]:
    try:
        import win32print
        default = ""
        try:
            default = win32print.GetDefaultPrinter()
        except Exception:
            pass
        seen: set = set()
        out: List[Dict] = []
        for flags in (
            win32print.PRINTER_ENUM_LOCAL,
            win32print.PRINTER_ENUM_CONNECTIONS,
        ):
            try:
                for _, _, name, _ in win32print.EnumPrinters(flags):
                    if name in seen:
                        continue
                    seen.add(name)
                    out.append({
                        "name":    name,
                        "default": name == default,
                        "source":  "win32",
                        "status":  "unknown",
                    })
            except Exception:
                pass
        return out
    except ImportError:
        # win32print not available — use PowerShell Get-Printer (Windows 8+)
        return _printers_powershell()


def _printers_powershell() -> List[Dict]:
    """PowerShell Get-Printer — works on any Windows without pywin32."""
    # Two separate calls: one for the printer list, one for the default name.
    # Keeping them separate avoids computed-property scope issues in -Command.
    script = "Get-Printer | Select-Object Name,Default,PrinterStatus | ConvertTo-Json -Compress"
    default_script = "(Get-WmiObject -Query 'SELECT * FROM Win32_Printer WHERE Default=True').Name"
    try:
        # Get default printer name
        default_name = ""
        try:
            dr = subprocess.run(
                ["powershell", "-NoProfile", "-Command", default_script],
                capture_output=True, text=True, timeout=8,
                **hidden_process_kwargs(),
            )
            default_name = dr.stdout.strip().strip('"')
        except Exception:
            pass

        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            capture_output=True, text=True, timeout=12,
            **hidden_process_kwargs(),
        )
        raw = r.stdout.strip()
        if not raw:
            return []
        data = json.loads(raw)
        if isinstance(data, dict):
            data = [data]

        _VIRTUAL = {"microsoft print to pdf", "microsoft xps document writer",
                    "onenote", "fax", "send to onenote"}

        out: List[Dict] = []
        for p in data:
            name = (p.get("Name") or "").strip()
            if not name:
                continue
            # Mark virtual printers but still include them
            virtual = any(v in name.lower() for v in _VIRTUAL)
            is_default = (name == default_name) or bool(p.get("Default"))
            out.append({
                "name":    name,
                "default": is_default,
                "source":  "powershell",
                "virtual": virtual,
                "status":  str(p.get("PrinterStatus") or "unknown"),
            })
        # Sort: real printers first, default first within each group
        out.sort(key=lambda p: (p["virtual"], not p["default"]))
        return out
    except Exception:
        return []


def _printers_cups() -> List[Dict]:
    out: List[Dict] = []
    default = ""
    try:
        r = subprocess.run(
            ["lpstat", "-d"], capture_output=True, text=True, timeout=5
        )
        if "destination:" in r.stdout:
            default = r.stdout.split("destination:")[-1].strip()
    except Exception:
        pass
    try:
        r = subprocess.run(
            ["lpstat", "-a"], capture_output=True, text=True, timeout=5
        )
        for line in r.stdout.splitlines():
            name = line.split()[0] if line.strip() else None
            if name:
                out.append({
                    "name":    name,
                    "default": name == default,
                    "source":  "cups",
                    "status":  "unknown",
                })
    except Exception:
        pass
    return out


def _list_printers() -> List[Dict]:
    return _printers_win32() if PLATFORM == "Windows" else _printers_cups()


# ══════════════════════════════════════════════════════════════════════════════
# SCANNER ENUMERATION
# ══════════════════════════════════════════════════════════════════════════════

def _scanners_wia() -> List[Dict]:
    """PowerShell/WIA scanner enumeration — Windows only."""
    script = (
        "$wia = New-Object -ComObject WIA.DeviceManager;"
        "$out = @();"
        "foreach ($d in $wia.DeviceInfos) {"
        "  if ($d.Type -eq 1) {"
        "    $n = try { $d.Properties.Item('Name').Value } catch { $d.DeviceID };"
        "    $out += [PSCustomObject]@{ id=$d.DeviceID; name=$n }"
        "  }"
        "};"
        "if ($out.Count -eq 0) { '[]' } else { ConvertTo-Json @($out) -Compress }"
    )
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            capture_output=True, text=True, timeout=12,
            **hidden_process_kwargs(),
        )
        raw = r.stdout.strip()
        if not raw:
            return []
        data = json.loads(raw)
        if isinstance(data, dict):
            data = [data]
        return [
            {"id": d.get("id", ""), "name": d.get("name", "Scanner"), "source": "wia"}
            for d in data
        ]
    except Exception:
        return []


def _scanners_sane() -> List[Dict]:
    """scanimage -L — macOS / Linux."""
    try:
        r = subprocess.run(
            ["scanimage", "-L"], capture_output=True, text=True, timeout=15
        )
        out: List[Dict] = []
        for line in r.stdout.splitlines():
            m = re.search(r"device `([^']+)' is a (.+)$", line)
            if m:
                out.append({
                    "id":     m.group(1),
                    "name":   m.group(2).strip(),
                    "source": "sane",
                })
        return out
    except Exception:
        return []


def _list_scanners() -> List[Dict]:
    return _scanners_wia() if PLATFORM == "Windows" else _scanners_sane()


# ══════════════════════════════════════════════════════════════════════════════
# PRINT JOB
# ══════════════════════════════════════════════════════════════════════════════

_DUPLEX_WIN = {
    "none":  "OneSided",
    "long":  "TwoSidedLongEdge",
    "short": "TwoSidedShortEdge",
}
_DUPLEX_CUPS = {
    "none":  "one-sided",
    "long":  "two-sided-long-edge",
    "short": "two-sided-short-edge",
}
_QUALITY_CUPS = {
    "draft":  "3",
    "normal": "4",
    "high":   "5",
}


def _ps_literal(value: str) -> str:
    """Single-quoted PowerShell data; no interpolation or escape evaluation."""
    return "'" + value.replace("'", "''") + "'"


def _print_windows(
    path: str,
    printer: str,
    copies: int,
    color: bool,
    duplex: str    = "none",
    scale: int     = 100,
    orientation: str = "portrait",
    quality: str   = "normal",
) -> None:
    """
    Use PowerShell Set-PrintConfiguration (best-effort) then Start-Process PrintTo.
    ShellExecute "printto" can't pass options — PowerShell can.
    """
    ps_duplex  = _DUPLEX_WIN.get(duplex, "OneSided")
    ps_color   = "$true" if color else "$false"
    ps_orient  = "1" if orientation == "portrait" else "2"   # DEVMODE: 1=portrait, 2=landscape
    ps_copies  = max(1, copies)
    safe_path = _ps_literal(path)
    safe_printer = _ps_literal(printer)

    script = f"""
$pn = {safe_printer}
try {{
    $cfg = Get-PrintConfiguration -PrinterName $pn -ErrorAction Stop
    $cfg.DuplexingMode = "{ps_duplex}"
    $cfg.Color         = {ps_color}
    if ($cfg.PSObject.Properties["NumberOfCopies"]) {{ $cfg.NumberOfCopies = {ps_copies} }}
    Set-PrintConfiguration -PrintConfiguration $cfg -ErrorAction SilentlyContinue
}} catch {{
    # Printer may not support Set-PrintConfiguration — continue anyway
}}
Start-Process -FilePath {safe_path} -Verb PrintTo -ArgumentList $pn -WindowStyle Hidden -Wait
"""
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        capture_output=True, text=True, timeout=90,
        **hidden_process_kwargs(),
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "Print via PowerShell failed")


def _print_cups(
    path: str,
    printer: str,
    copies: int,
    color: bool,
    paper_size: str  = "Letter",
    duplex: str      = "none",
    scale: int       = 100,
    orientation: str = "portrait",
    quality: str     = "normal",
) -> None:
    args = ["lpr", "-P", printer, f"-#{max(1, copies)}"]

    if not color:
        args += ["-o", "ColorModel=Gray"]

    if paper_size:
        args += ["-o", f"media={paper_size}"]

    sides = _DUPLEX_CUPS.get(duplex, "one-sided")
    args += ["-o", f"sides={sides}"]

    if scale and 25 <= scale <= 200 and scale != 100:
        args += ["-o", f"scaling={scale}"]

    if orientation == "landscape":
        args += ["-o", "landscape"]

    q = _QUALITY_CUPS.get(quality)
    if q:
        args += ["-o", f"print-quality={q}"]

    args.append(path)
    subprocess.run(args, check=True, timeout=90)


# ══════════════════════════════════════════════════════════════════════════════
# SCAN JOB
# ══════════════════════════════════════════════════════════════════════════════

_WIA_COLOR_MAP = {"color": 2, "gray": 4, "bw": 8}
# PNG format GUID for WIA transfer
_WIA_PNG_GUID  = "{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}"


def _scan_wia(
    scanner_id: str, out_path: str, resolution: int, color_mode: str
) -> None:
    color_val = _WIA_COLOR_MAP.get(color_mode, 2)
    # Use BMP GUID — supported by every WIA driver, unlike PNG which some skip
    BMP_GUID = "{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}"  # actually PNG; use BMP as primary
    BMP_GUID = "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}"  # BMP
    bmp_path = str(Path(out_path).with_suffix(".bmp"))
    ps_bmp = _ps_literal(bmp_path)
    ps_png = _ps_literal(out_path)
    safe_id = _ps_literal(scanner_id)

    script = f"""
$ErrorActionPreference = 'Stop'
try {{
    $wia   = New-Object -ComObject WIA.DeviceManager
    $found = $null
    $requestedId = {safe_id}

    # An explicit target must never silently become a different scanner.
    foreach ($d in $wia.DeviceInfos) {{
        if ($d.Type -eq 1 -and $d.DeviceID -eq $requestedId) {{ $found = $d; break }}
    }}
    if ($requestedId -and -not $found) {{ throw 'The selected scanner is unavailable. Select an available scanner and try again.' }}
    if (-not $requestedId) {{
        foreach ($d in $wia.DeviceInfos) {{
            if ($d.Type -eq 1) {{ $found = $d; break }}
        }}
    }}
    if (-not $found) {{ throw 'No WIA scanner found. Is the scanner powered on and connected?' }}

    $dev = $found.Connect()
    if (-not $dev)  {{ throw 'Could not connect to scanner (WIA.Connect returned null)' }}

    $items = $dev.Items
    if (-not $items -or $items.Count -eq 0) {{ throw 'Scanner connected but reported no scan items' }}
    $item = $items.Item(1)
    if (-not $item) {{ throw 'Could not access scanner item' }}

    # Set properties — silently ignore any that the device does not support
    foreach ($prop in $item.Properties) {{
        switch ($prop.PropertyID) {{
            6146 {{ try {{ $prop.Value = {color_val} }} catch {{}} }}   # color intent
            6147 {{ try {{ $prop.Value = {resolution} }} catch {{}} }}  # H-resolution
            6148 {{ try {{ $prop.Value = {resolution} }} catch {{}} }}  # V-resolution
        }}
    }}

    # Transfer to BMP (universally supported) then convert to PNG via .NET
    $img = $item.Transfer('{BMP_GUID}')
    $img.SaveFile({ps_bmp})

    # Convert BMP → PNG using .NET System.Drawing
    Add-Type -AssemblyName System.Drawing
    $bmp = [System.Drawing.Image]::FromFile({ps_bmp})
    $bmp.Save({ps_png}, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Remove-Item -LiteralPath {ps_bmp} -ErrorAction SilentlyContinue
}} catch {{
    throw $_.Exception.Message
}}
"""
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        capture_output=True, text=True, timeout=120,
        **hidden_process_kwargs(),
    )
    if r.returncode != 0:
        err = r.stderr.strip() or r.stdout.strip() or "WIA scan failed"
        # Strip PowerShell noise — last non-empty line is usually the real error
        lines = [l.strip() for l in err.splitlines() if l.strip()]
        raise RuntimeError(lines[-1] if lines else "WIA scan failed")
    if not Path(out_path).exists():
        # Maybe BMP conversion failed but BMP itself saved
        if Path(bmp_path).exists():
            Path(bmp_path).rename(out_path)
        else:
            raise RuntimeError("WIA produced no output file")


def _scan_sane(
    scanner_id: str, out_path: str, resolution: int, color_mode: str
) -> None:
    mode_map = {"color": "Color", "gray": "Gray", "bw": "Lineart"}
    mode = mode_map.get(color_mode, "Color")
    args = [
        "scanimage",
        "-d", scanner_id,
        f"--resolution={resolution}",
        f"--mode={mode}",
        "--format=png",
        f"--output-file={out_path}",
    ]
    r = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "SANE scan failed")
    if not Path(out_path).exists():
        raise RuntimeError("scanimage produced no output file")


# ══════════════════════════════════════════════════════════════════════════════
# ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

@printshop_router.get("/printshop/printers")
def ep_list_printers(check: Callable[[], None] = Depends(browser_control_access)):
    """List all printers available on this TLI node."""
    check()
    printers = _list_printers()
    check()
    return _private_json({
        "printers": printers,
        "platform": PLATFORM,
        "count":    len(printers),
    })


@printshop_router.get("/printshop/scanners")
def ep_list_scanners(check: Callable[[], None] = Depends(browser_control_access)):
    """List all scanners available on this TLI node."""
    check()
    scanners = _list_scanners()
    check()
    return _private_json({
        "scanners": scanners,
        "platform": PLATFORM,
        "count":    len(scanners),
    })


@printshop_router.post("/printshop/print")
async def ep_print_file(
    file:        UploadFile = File(...),
    printer:     str        = Form(...),
    copies:      int        = Form(1),
    color:       bool       = Form(True),
    paper_size:  str        = Form("Letter"),
    duplex:      str        = Form("none"),    # none | long | short
    scale:       int        = Form(100),       # 25–200 %
    orientation: str        = Form("portrait"), # portrait | landscape
    quality:     str        = Form("normal"),  # draft | normal | high
    check: Callable[[], None] = Depends(browser_control_access),
):
    """Send a file to the specified printer with full options."""
    if not printer:
        raise HTTPException(400, "printer name is required")

    copies = max(1, min(copies, 99))
    scale  = max(25, min(scale, 200))
    if duplex      not in ("none", "long", "short"):        duplex      = "none"
    if orientation not in ("portrait", "landscape"):        orientation = "portrait"
    if quality     not in ("draft", "normal", "high"):      quality     = "normal"

    suffix = Path(file.filename or "document.pdf").suffix or ".pdf"

    check()
    contents = await file.read()
    check()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            tmp.write(contents)
        check()
        if PLATFORM == "Windows":
            _print_windows(tmp_path, printer, copies, color, duplex, scale, orientation, quality)
        else:
            _print_cups(tmp_path, printer, copies, color, paper_size, duplex, scale, orientation, quality)
        check()
        return _private_json({
            "status":      "sent",
            "printer":     printer,
            "copies":      copies,
            "color":       color,
            "duplex":      duplex,
            "scale":       scale,
            "orientation": orientation,
            "quality":     quality,
        })
    except HTTPException:
        check()
        raise
    except Exception as exc:
        check()
        raise HTTPException(500, f"Print failed: {exc}")
    finally:
        try:
            if tmp_path is not None:
                os.unlink(tmp_path)
        except Exception:
            pass


@printshop_router.post("/printshop/scan")
async def ep_scan_document(
    request: Request,
    scanner_id:  str = Form(...),
    resolution:  int = Form(300),
    color_mode:  str = Form("color"),   # color | gray | bw
    check: Callable[[], None] = Depends(browser_control_access),
):
    """Acquire a scan from the specified scanner."""
    if resolution not in (75, 150, 300, 600):
        resolution = 300
    if color_mode not in ("color", "gray", "bw"):
        color_mode = "color"

    owner = _scan_owner(request, check)
    out_path = str(Path(tempfile.mkdtemp(prefix="tli-scan-")) / "scan.png")
    token = None
    try:
        check()
        if PLATFORM == "Windows":
            _scan_wia(scanner_id, out_path, resolution, color_mode)
        else:
            _scan_sane(scanner_id, out_path, resolution, color_mode)

        check()
        token = uuid.uuid4().hex
        with _scan_lock:
            check()
            _scan_store[token] = _ScanRecord(out_path, "image/png", owner)

        check()
        return _private_json({
            "status":  "ok",
            "token":   token,
            "format":  "png",
        })
    except Exception as exc:
        if token:
            with _scan_lock:
                _scan_store.pop(token, None)
        try:
            _remove_new_scan(out_path)
        except OSError:
            pass
        check()
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(500, f"Scan failed: {exc}")


@printshop_router.get("/printshop/scan/{token}")
def ep_download_scan(token: str, request: Request,
                     check: Callable[[], None] = Depends(browser_control_access)):
    """Download a completed scan by token."""
    owner = _scan_owner(request, check)
    entry = _owned_scan(token, owner, check)
    exists = Path(entry.path).exists()
    check()
    if not exists:
        raise HTTPException(410, "Scan file no longer available")

    def transfer_check():
        if _owned_scan(token, owner, check) is not entry:
            raise HTTPException(404, "Scan token is no longer available")

    transfer_check()
    return _AuthorizedScanResponse(
        entry.path,
        media_type=entry.mime,
        filename=f"tli-scan-{token[:8]}.png",
        headers={"Cache-Control": "no-store"},
        check=transfer_check,
    )


@printshop_router.delete("/printshop/scan/{token}")
def ep_delete_scan(token: str, request: Request,
                   check: Callable[[], None] = Depends(browser_control_access)):
    """Clean up a scan temp file."""
    owner = _scan_owner(request, check)
    entry = _owned_scan(token, owner, check)
    with _scan_lock:
        check()
        if _scan_store.get(token) is not entry:
            raise HTTPException(404, "Scan token is no longer available")
        try:
            _remove_new_scan(entry.path)
        except OSError:
            check()
            raise HTTPException(500, "The scan file could not be removed; its record was retained.") from None
        _scan_store.pop(token, None)
    check()
    return _private_json({"status": "deleted"})
