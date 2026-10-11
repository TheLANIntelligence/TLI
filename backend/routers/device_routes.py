# backend/routers/device_routes.py
from __future__ import annotations

import json
import os
import platform
import re
import subprocess
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter

import tli_state as S
from process_utils import hidden_process_kwargs

router = APIRouter(tags=["devices"])


def _run_subprocess(cmd, timeout=20):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, shell=False,
                              **hidden_process_kwargs())
        return {"ok": proc.returncode == 0, "returncode": proc.returncode,
                "stdout": proc.stdout, "stderr": proc.stderr}
    except Exception as e:
        return {"ok": False, "error": str(e), "cmd": cmd}


# ============================================
#  Removable mounts
# ============================================

def detect_removable_mounts():
    mounts = []
    system = platform.system().lower()
    if system == "windows":
        # Query by BusType=USB so we catch both thumb drives (Removable) and USB SSDs (Fixed)
        try:
            ps = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "Get-Disk | Where-Object { $_.BusType -eq 'USB' } | "
                 "Get-Partition | Where-Object { $_.DriveLetter } | "
                 "Get-Volume | Select-Object DriveLetter, FileSystemLabel, FileSystem, DriveType, Size | "
                 "ConvertTo-Json -Depth 3"],
                capture_output=True, text=True, timeout=10, **hidden_process_kwargs())
            if ps.returncode == 0 and ps.stdout.strip():
                data = json.loads(ps.stdout)
                if isinstance(data, dict):
                    data = [data]
                for vol in (data or []):
                    letter = (vol.get("DriveLetter") or "").strip()
                    if letter:
                        mounts.append({
                            "mount_path": f"{letter}:\\",
                            "label": (vol.get("FileSystemLabel") or "").strip(),
                            "fs_type": (vol.get("FileSystem") or "").strip(),
                            "size_bytes": vol.get("Size"),
                            "drive_type": (vol.get("DriveType") or "").strip(),
                        })
        except Exception:
            pass
        # Fallback: catch Removable drives missed above (SD cards, old readers)
        if not mounts:
            try:
                ps = subprocess.run(
                    ["powershell", "-NoProfile", "-Command",
                     "Get-Volume | Where-Object { $_.DriveType -eq 'Removable' -and $_.DriveLetter } | "
                     "Select-Object DriveLetter, FileSystemLabel, FileSystem, Size | ConvertTo-Json -Depth 3"],
                    capture_output=True, text=True, timeout=5, **hidden_process_kwargs())
                if ps.returncode == 0 and ps.stdout.strip():
                    data = json.loads(ps.stdout)
                    if isinstance(data, dict):
                        data = [data]
                    for vol in (data or []):
                        letter = (vol.get("DriveLetter") or "").strip()
                        if letter:
                            mounts.append({
                                "mount_path": f"{letter}:\\",
                                "label": (vol.get("FileSystemLabel") or "").strip(),
                                "fs_type": (vol.get("FileSystem") or "").strip(),
                                "size_bytes": vol.get("Size"),
                                "drive_type": "Removable",
                            })
            except Exception:
                pass
    elif system == "darwin":
        try:
            proc = subprocess.run(["mount"], capture_output=True, text=True, timeout=5,
                                  **hidden_process_kwargs())
            if proc.returncode == 0:
                for line in proc.stdout.splitlines():
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
                        st = os.statvfs(mnt_path)
                        size_bytes = st.f_blocks * st.f_frsize
                    except Exception:
                        pass
                    mounts.append({"mount_path": mnt_path, "label": label, "fs_type": fs_type, "size_bytes": size_bytes})
        except Exception:
            pass
    else:
        try:
            with open("/proc/mounts", "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) >= 3:
                        mnt_path, fs_type = parts[1], parts[2]
                        if mnt_path.startswith("/media/") or mnt_path.startswith("/run/media/"):
                            mounts.append({"mount_path": mnt_path, "label": mnt_path.rsplit("/", 1)[-1], "fs_type": fs_type})
        except Exception:
            pass
    return mounts


# ============================================
#  USB snapshots
# ============================================

def usb_basic_snapshot():
    sys_lower = platform.system().lower()
    snapshot = {"timestamp": S.now_iso(), "platform": platform.system(), "devices": [], "note": None}
    if sys_lower.startswith("win"):
        cmd = ["powershell.exe", "-NoLogo", "-NoProfile", "-Command",
               "Get-PnpDevice -Class USB,USBDevice | Select-Object Name,InstanceId,Status | ConvertTo-Json -Depth 3"]
        res = _run_subprocess(cmd, timeout=40)
        text = (res.get("stdout") or "").strip()
        if res.get("ok") and text:
            try:
                data = json.loads(text)
                if isinstance(data, dict):
                    data = [data]
                snapshot["devices"] = [{"name": d.get("Name") or "USB Device", "instance_id": d.get("InstanceId"),
                                        "status": d.get("Status")} for d in (data or []) if isinstance(d, dict)]
            except Exception:
                pass
    elif sys_lower == "darwin":
        cmd = ["system_profiler", "SPUSBDataType", "-json"]
        res = _run_subprocess(cmd, timeout=60)
        text = (res.get("stdout") or "").strip()
        if res.get("ok") and text:
            try:
                payload = json.loads(text)
                devices = []
                def flatten(items):
                    for item in items:
                        devices.append({"name": item.get("_name", "USB Device"), "vendor_id": item.get("vendor_id"),
                                        "product_id": item.get("product_id"), "manufacturer": item.get("manufacturer")})
                        if isinstance(item.get("_items"), list):
                            flatten(item["_items"])
                flatten(payload.get("SPUSBDataType", []))
                snapshot["devices"] = devices
            except Exception:
                pass
    else:
        res = _run_subprocess(["lsusb"], timeout=20)
        if res.get("ok"):
            for line in (res.get("stdout") or "").strip().splitlines():
                parts = line.strip().split()
                if len(parts) >= 6:
                    snapshot["devices"].append({"name": " ".join(parts[6:]) or "USB Device",
                                                "vendor_id": parts[5].split(":")[0] if ":" in parts[5] else parts[5]})
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


def basic_lan_scan():
    from routers.system_routes import builtin_sys_snapshot
    snapshot = {"timestamp": S.now_iso(), "platform": platform.system()}
    # ARP table
    arp_entries = []
    mesh_ip_index = {}
    try:
        directory = S.load_mesh_directory()
        for dev_id, info in directory.items():
            if isinstance(info, dict) and info.get("ip"):
                mesh_ip_index[str(info["ip"])] = {"device_id": dev_id, "display_name": info.get("display_name") or dev_id,
                                                    "status": info.get("status"), "is_host": bool(info.get("is_host"))}
    except Exception:
        pass
    try:
        res = _run_subprocess(["arp", "-a"], timeout=10)
        if res.get("ok"):
            ip_pat = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}")
            mac_pat = re.compile(r"([0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5})")
            for line in (res.get("stdout") or "").splitlines():
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
    except Exception as e:
        snapshot["arp_scan_ok"] = False
        snapshot["arp_error"] = str(e)
    return snapshot


# ============================================
#  Endpoints
# ============================================

@router.get("/devices/usb/list")
def devices_usb_list():
    return usb_basic_snapshot()

@router.get("/devices/usb/info")
def devices_usb_info():
    return usb_basic_snapshot()  # simplified; original had verbose mode

@router.get("/devices/usb/raw")
def devices_usb_raw():
    sys_lower = platform.system().lower()
    if sys_lower.startswith("win"):
        cmd = ["powershell.exe", "-NoLogo", "-NoProfile", "-Command",
               "Get-PnpDevice -Class USB,USBDevice | Format-List *"]
    elif sys_lower == "darwin":
        cmd = ["system_profiler", "SPUSBDataType"]
    else:
        cmd = ["lsusb", "-v"]
    res = _run_subprocess(cmd, timeout=90)
    return {"timestamp": S.now_iso(), "platform": platform.system(), "ok": res.get("ok", False),
            "stdout": (res.get("stdout") or "")[:20000], "stderr": (res.get("stderr") or "")[:8000]}

@router.get("/devices/usb/detail")
def devices_usb_detail():
    return devices_usb_info()

def _get_usb_disk_names_windows() -> Dict[str, str]:
    """Return a map of drive_letter → disk friendly name from Get-Disk (BusType=USB)."""
    result: Dict[str, str] = {}
    try:
        ps = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-Disk | Where-Object { $_.BusType -eq 'USB' } | "
             "Select-Object Number, FriendlyName | ConvertTo-Json -Depth 2"],
            capture_output=True, text=True, timeout=10, **hidden_process_kwargs())
        if ps.returncode != 0 or not ps.stdout.strip():
            return result
        disks = json.loads(ps.stdout)
        if isinstance(disks, dict):
            disks = [disks]
        for disk in (disks or []):
            num = disk.get("Number")
            name = (disk.get("FriendlyName") or "").strip()
            if num is None or not name:
                continue
            # Map disk number → drive letters via Get-Partition
            ps2 = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 f"Get-Partition -DiskNumber {num} | Where-Object {{ $_.DriveLetter }} | "
                 "Select-Object -ExpandProperty DriveLetter | ConvertTo-Json"],
                capture_output=True, text=True, timeout=5, **hidden_process_kwargs())
            if ps2.returncode == 0 and ps2.stdout.strip():
                letters = json.loads(ps2.stdout)
                if isinstance(letters, str):
                    letters = [letters]
                for letter in (letters or []):
                    if letter:
                        result[f"{letter.strip()}:\\"] = name
    except Exception:
        pass
    return result


@router.get("/devices/usb")
def devices_usb():
    system = platform.system().lower()
    mounts = detect_removable_mounts()

    disk_names: Dict[str, str] = {}
    if system == "windows":
        disk_names = _get_usb_disk_names_windows()

    devices = []
    for m in mounts:
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

    return {"devices": devices, "storage_mounts": mounts, "count": len(devices), "platform": system}


@router.get("/devices/scan")
def devices_scan():
    return basic_lan_scan()
