# backend/routers/device_routes.py
from __future__ import annotations

import json
import os
import platform
import re
import subprocess
from typing import Dict

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from browser_authority import browser_control_access
import tli_state as S
from process_utils import hidden_process_kwargs

router = APIRouter(tags=["devices"])


def _access(check):
    if check is not None:
        check()


def _checked(check, operation):
    _access(check)
    try:
        value = operation()
    except Exception:
        _access(check)
        raise
    _access(check)
    return value


def _browser_access(request: Request, response: Response):
    def private_error(error):
        error.headers = {**(error.headers or {}), "Cache-Control": "no-store"}
        return error
    try:
        captured = browser_control_access(request, response)
    except HTTPException as error:
        raise private_error(error)
    def check():
        try:
            captured()
        except HTTPException as error:
            raise private_error(error)
    return check


def _probe(cmd, timeout, check):
    # A running OS probe cannot be recalled. Check in its worker immediately
    # before dispatch and after completion/error; never start follow-up work
    # or disclose its private output after the original authority ends.
    return _checked(check, lambda: subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout, shell=False,
        **hidden_process_kwargs()))


def _run_subprocess(cmd, timeout=20, *, check=None):
    try:
        proc = _probe(cmd, timeout, check)
        return {"ok": proc.returncode == 0, "returncode": proc.returncode,
                "stdout": proc.stdout, "stderr": proc.stderr}
    except HTTPException:
        raise
    except Exception as e:
        _access(check)
        return {"ok": False, "error": str(e), "cmd": cmd}


# ============================================
#  Removable mounts
# ============================================

def detect_removable_mounts(*, check=None):
    _access(check)
    mounts = []
    system = platform.system().lower()
    if system == "windows":
        # Query by BusType=USB so we catch both thumb drives (Removable) and USB SSDs (Fixed)
        try:
            ps = _probe(
                ["powershell", "-NoProfile", "-Command",
                 "Get-Disk | Where-Object { $_.BusType -eq 'USB' } | "
                 "Get-Partition | Where-Object { $_.DriveLetter } | "
                 "Get-Volume | Select-Object DriveLetter, FileSystemLabel, FileSystem, DriveType, Size | "
                 "ConvertTo-Json -Depth 3"],
                10, check)
            if ps.returncode == 0 and ps.stdout.strip():
                data = json.loads(ps.stdout)
                if isinstance(data, dict):
                    data = [data]
                for vol in (data or []):
                    _access(check)
                    letter = (vol.get("DriveLetter") or "").strip()
                    if letter:
                        mounts.append({
                            "mount_path": f"{letter}:\\",
                            "label": (vol.get("FileSystemLabel") or "").strip(),
                            "fs_type": (vol.get("FileSystem") or "").strip(),
                            "size_bytes": vol.get("Size"),
                            "drive_type": (vol.get("DriveType") or "").strip(),
                        })
        except HTTPException:
            raise
        except Exception:
            _access(check)
            pass
        # Fallback: catch Removable drives missed above (SD cards, old readers)
        if not mounts:
            try:
                ps = _probe(
                    ["powershell", "-NoProfile", "-Command",
                     "Get-Volume | Where-Object { $_.DriveType -eq 'Removable' -and $_.DriveLetter } | "
                     "Select-Object DriveLetter, FileSystemLabel, FileSystem, Size | ConvertTo-Json -Depth 3"],
                    5, check)
                if ps.returncode == 0 and ps.stdout.strip():
                    data = json.loads(ps.stdout)
                    if isinstance(data, dict):
                        data = [data]
                    for vol in (data or []):
                        _access(check)
                        letter = (vol.get("DriveLetter") or "").strip()
                        if letter:
                            mounts.append({
                                "mount_path": f"{letter}:\\",
                                "label": (vol.get("FileSystemLabel") or "").strip(),
                                "fs_type": (vol.get("FileSystem") or "").strip(),
                                "size_bytes": vol.get("Size"),
                                "drive_type": "Removable",
                            })
            except HTTPException:
                raise
            except Exception:
                _access(check)
                pass
    elif system == "darwin":
        try:
            proc = _probe(["mount"], 5, check)
            if proc.returncode == 0:
                for line in proc.stdout.splitlines():
                    _access(check)
                    parts = line.split(" on ")
                    if len(parts) < 2:
                        continue
                    mnt_part = parts[1]
                    mnt_path = mnt_part.split(" (", 1)[0].strip()
                    if not mnt_path.startswith("/Volumes/"):
                        continue
                    fs_type = mnt_part.split("(", 1)[1].split(",", 1)[0].strip(") ") if "(" in mnt_part else ""
                    label = mnt_path.split("/Volumes/", 1)[-1]
                    size_bytes = None
                    try:
                        st = _checked(check, lambda: os.statvfs(mnt_path))
                        size_bytes = st.f_blocks * st.f_frsize
                    except HTTPException:
                        raise
                    except Exception:
                        _access(check)
                        pass
                    mounts.append({"mount_path": mnt_path, "label": label, "fs_type": fs_type, "size_bytes": size_bytes})
        except HTTPException:
            raise
        except Exception:
            _access(check)
            pass
    else:
        try:
            _access(check)
            with open("/proc/mounts", "r", encoding="utf-8", errors="ignore") as f:
                while True:
                    line = _checked(check, lambda: next(f, None))
                    if line is None:
                        break
                    parts = line.split()
                    if len(parts) >= 3:
                        mnt_path, fs_type = parts[1], parts[2]
                        if mnt_path.startswith("/media/") or mnt_path.startswith("/run/media/"):
                            mounts.append({"mount_path": mnt_path, "label": mnt_path.rsplit("/", 1)[-1], "fs_type": fs_type})
        except HTTPException:
            raise
        except Exception:
            _access(check)
            pass
    _access(check)
    return mounts


# ============================================
#  USB snapshots
# ============================================

def usb_basic_snapshot(*, check=None):
    _access(check)
    sys_lower = platform.system().lower()
    snapshot = {"timestamp": S.now_iso(), "platform": platform.system(), "devices": [], "note": None}
    if sys_lower.startswith("win"):
        cmd = ["powershell.exe", "-NoLogo", "-NoProfile", "-Command",
               "Get-PnpDevice -Class USB,USBDevice | Select-Object Name,InstanceId,Status | ConvertTo-Json -Depth 3"]
        res = _run_subprocess(cmd, timeout=40, check=check)
        text = (res.get("stdout") or "").strip()
        if res.get("ok") and text:
            try:
                data = json.loads(text)
                if isinstance(data, dict):
                    data = [data]
                snapshot["devices"] = [{"name": d.get("Name") or "USB Device", "instance_id": d.get("InstanceId"),
                                        "status": d.get("Status")} for d in (data or []) if isinstance(d, dict)]
            except HTTPException:
                raise
            except Exception:
                _access(check)
                pass
    elif sys_lower == "darwin":
        cmd = ["system_profiler", "SPUSBDataType", "-json"]
        res = _run_subprocess(cmd, timeout=60, check=check)
        text = (res.get("stdout") or "").strip()
        if res.get("ok") and text:
            try:
                payload = json.loads(text)
                devices = []
                def flatten(items):
                    for item in items:
                        _access(check)
                        devices.append({"name": item.get("_name", "USB Device"), "vendor_id": item.get("vendor_id"),
                                        "product_id": item.get("product_id"), "manufacturer": item.get("manufacturer")})
                        if isinstance(item.get("_items"), list):
                            flatten(item["_items"])
                flatten(payload.get("SPUSBDataType", []))
                snapshot["devices"] = devices
            except HTTPException:
                raise
            except Exception:
                _access(check)
                pass
    else:
        res = _run_subprocess(["lsusb"], timeout=20, check=check)
        if res.get("ok"):
            for line in (res.get("stdout") or "").strip().splitlines():
                _access(check)
                parts = line.strip().split()
                if len(parts) >= 6:
                    snapshot["devices"].append({"name": " ".join(parts[6:]) or "USB Device",
                                                "vendor_id": parts[5].split(":")[0] if ":" in parts[5] else parts[5]})
    _access(check)
    return snapshot


# ============================================
#  LAN scan
# ============================================

MAC_OUI_VENDOR_MAP: Dict[str, str] = {}

def _lookup_mac_vendor(mac):
    if not mac:
        return None
    cleaned = re.sub(r"[^0-9A-Fa-f]", "", mac).upper()
    if len(cleaned) < 6:
        return None
    return MAC_OUI_VENDOR_MAP.get(cleaned[:6])


def basic_lan_scan(*, check=None):
    _access(check)
    snapshot = {"timestamp": S.now_iso(), "platform": platform.system()}
    # ARP table
    arp_entries = []
    mesh_ip_index = {}
    try:
        directory = _checked(check, S.load_mesh_directory)
        for dev_id, info in directory.items():
            _access(check)
            if isinstance(info, dict) and info.get("ip"):
                mesh_ip_index[str(info["ip"])] = {"device_id": dev_id, "display_name": info.get("display_name") or dev_id,
                                                    "status": info.get("status"), "is_host": bool(info.get("is_host"))}
    except HTTPException:
        raise
    except Exception:
        _access(check)
        pass
    try:
        res = _run_subprocess(["arp", "-a"], timeout=10, check=check)
        if res.get("ok"):
            ip_pat = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}")
            mac_pat = re.compile(r"([0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5})")
            for line in (res.get("stdout") or "").splitlines():
                _access(check)
                ip_m = ip_pat.search(line)
                mac_m = mac_pat.search(line)
                if ip_m and mac_m:
                    entry = {"ip": ip_m.group(0), "mac": mac_m.group(1), "source": "arp"}
                    vendor = _lookup_mac_vendor(mac_m.group(1))
                    if vendor:
                        entry["vendor"] = vendor
                    mesh = mesh_ip_index.get(ip_m.group(0))
                    if mesh:
                        entry["mesh_device"] = mesh
                    arp_entries.append(entry)
        snapshot["arp_table"] = arp_entries
        snapshot["arp_scan_ok"] = bool(arp_entries)
    except HTTPException:
        raise
    except Exception as e:
        _access(check)
        snapshot["arp_scan_ok"] = False
        snapshot["arp_error"] = str(e)
    _access(check)
    return snapshot


# ============================================
#  Endpoints
# ============================================

def devices_usb_list(*, check=None):
    return _checked(check, lambda: usb_basic_snapshot(check=check))

def devices_usb_info(*, check=None):
    return _checked(check, lambda: usb_basic_snapshot(check=check))  # simplified; original had verbose mode

def devices_usb_raw(*, check=None):
    _access(check)
    sys_lower = platform.system().lower()
    if sys_lower.startswith("win"):
        cmd = ["powershell.exe", "-NoLogo", "-NoProfile", "-Command",
               "Get-PnpDevice -Class USB,USBDevice | Format-List *"]
    elif sys_lower == "darwin":
        cmd = ["system_profiler", "SPUSBDataType"]
    else:
        cmd = ["lsusb", "-v"]
    res = _run_subprocess(cmd, timeout=90, check=check)
    _access(check)
    return {"timestamp": S.now_iso(), "platform": platform.system(), "ok": res.get("ok", False),
            "stdout": (res.get("stdout") or "")[:20000], "stderr": (res.get("stderr") or "")[:8000]}

def devices_usb_detail(*, check=None):
    return _checked(check, lambda: devices_usb_info(check=check))

def _get_usb_disk_names_windows(*, check=None) -> Dict[str, str]:
    """Return a map of drive_letter → disk friendly name from Get-Disk (BusType=USB)."""
    result: Dict[str, str] = {}
    try:
        ps = _probe(
            ["powershell", "-NoProfile", "-Command",
             "Get-Disk | Where-Object { $_.BusType -eq 'USB' } | "
             "Select-Object Number, FriendlyName | ConvertTo-Json -Depth 2"],
            10, check)
        if ps.returncode != 0 or not ps.stdout.strip():
            return result
        disks = json.loads(ps.stdout)
        if isinstance(disks, dict):
            disks = [disks]
        for disk in (disks or []):
            _access(check)
            num = disk.get("Number")
            name = (disk.get("FriendlyName") or "").strip()
            if type(num) is not int or num < 0 or not name:
                continue
            # Map disk number → drive letters via Get-Partition
            ps2 = _probe(
                ["powershell", "-NoProfile", "-Command",
                 f"Get-Partition -DiskNumber {num} | Where-Object {{ $_.DriveLetter }} | "
                 "Select-Object -ExpandProperty DriveLetter | ConvertTo-Json"],
                5, check)
            if ps2.returncode == 0 and ps2.stdout.strip():
                letters = json.loads(ps2.stdout)
                if isinstance(letters, str):
                    letters = [letters]
                for letter in (letters or []):
                    _access(check)
                    if letter:
                        result[f"{letter.strip()}:\\"] = name
    except HTTPException:
        raise
    except Exception:
        _access(check)
        pass
    _access(check)
    return result


def devices_usb(*, check=None):
    _access(check)
    system = platform.system().lower()
    mounts = detect_removable_mounts(check=check)

    disk_names: Dict[str, str] = {}
    if system == "windows":
        disk_names = _get_usb_disk_names_windows(check=check)

    devices = []
    for m in mounts:
        _access(check)
        path = m.get("mount_path", "")
        label = m.get("label") or ""
        disk_name = disk_names.get(path, "")
        # Build a human-friendly name: prefer disk model, then volume label, then drive letter
        if disk_name:
            name = f"{disk_name}" + (f" ({label})" if label else "")
        elif label:
            name = label
        else:
            name = path.rstrip("\\") or "USB Drive"
        devices.append({
            "name": name,
            "is_storage": True,
            "mount_path": path,
            "volume_label": label,
            "fs_type": m.get("fs_type"),
            "size_bytes": m.get("size_bytes"),
            "drive_type": m.get("drive_type"),
        })

    _access(check)
    return {"devices": devices, "storage_mounts": mounts, "count": len(devices), "platform": system}


def devices_scan(*, check=None):
    return _checked(check, lambda: basic_lan_scan(check=check))


# HTTP authority stays separate from reusable, optionally checked services.
@router.get("/devices/usb/list")
def devices_usb_list_http(check=Depends(_browser_access)):
    return _checked(check, lambda: devices_usb_list(check=check))


@router.get("/devices/usb/info")
def devices_usb_info_http(check=Depends(_browser_access)):
    return _checked(check, lambda: devices_usb_info(check=check))


@router.get("/devices/usb/raw")
def devices_usb_raw_http(check=Depends(_browser_access)):
    return _checked(check, lambda: devices_usb_raw(check=check))


@router.get("/devices/usb/detail")
def devices_usb_detail_http(check=Depends(_browser_access)):
    return _checked(check, lambda: devices_usb_detail(check=check))


@router.get("/devices/usb")
def devices_usb_http(check=Depends(_browser_access)):
    return _checked(check, lambda: devices_usb(check=check))


@router.get("/devices/scan")
def devices_scan_http(check=Depends(_browser_access)):
    return _checked(check, lambda: devices_scan(check=check))
