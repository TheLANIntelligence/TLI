# backend/routers/file_routes.py
from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
import platform
import subprocess
import sys

import tli_state as S

try:
    from send2trash import send2trash
except Exception:
    send2trash = None

from routers.system_routes import require_session

router = APIRouter(tags=["files"])


# ============================================
#  Pydantic models
# ============================================
class FileScanRequest(BaseModel):
    path: str
class FileOrganizeRequest(BaseModel):
    path: str
    actions: Dict[str, List[str]]
    confirm: bool = False
class FileRenameRequest(BaseModel):
    path: str
    prefix: str
class FilesScanRequest(BaseModel):
    root: str
class FilesApplyRulesRequest(BaseModel):
    root: str
    rules: str
class VisualizerDeleteRequest(BaseModel):
    path: str
    permanent: bool = False


# ============================================
#  Helpers
# ============================================

def expand_base_path(path_str: str) -> str:
    if not path_str:
        raise HTTPException(status_code=400, detail="Path is required")
    raw = path_str.strip()
    expanded = os.path.expandvars(raw)
    expanded = os.path.expanduser(expanded)
    if os.name == "posix" and re.match(r"^[A-Za-z]:[\\/]", expanded):
        drive_letter = expanded[0].lower()
        rest = expanded[2:].lstrip("\\/")
        expanded = f"/mnt/{drive_letter}/" + rest.replace("\\", "/")
    expanded = os.path.normpath(expanded)
    if not os.path.isabs(expanded):
        expanded = os.path.abspath(os.path.join(S.BASE_DIR, expanded))
    return expanded


def categorize_extension(ext: str) -> str:
    e = ext.lower()
    if e in {".jpg",".jpeg",".png",".gif",".webp",".tif",".tiff",".bmp",".heic"}: return "Images"
    if e in {".mp4",".mov",".avi",".mkv",".wmv",".flv",".webm"}: return "Videos"
    if e in {".mp3",".wav",".flac",".aac",".ogg",".m4a"}: return "Audio"
    if e in {".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".txt",".rtf",".md"}: return "Documents"
    if e in {".zip",".rar",".7z",".tar",".gz"}: return "Archives"
    if e in {".exe",".msi",".pkg",".dmg"}: return "Installers"
    return "Other"


def _resolve_scan_path(path_str: str) -> Path:
    raw = path_str.strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Path cannot be empty")
    expanded = os.path.expandvars(os.path.expanduser(raw))
    p = Path(expanded)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Path does not exist: {expanded}")
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {expanded}")
    return p


# ============================================
#  Directory tree builder
# ============================================

SYSTEM_DIR_MARKERS = ["\\\\windows", "\\\\program files", "\\\\program files (x86)",
                      "\\\\programdata", "\\\\system volume information", "\\\\$recycle.bin"]

def _build_directory_tree(root: Path, max_depth: int = 6, min_size_bytes: int = 20 * 1024) -> Dict[str, Any]:
    root = root.resolve()
    MAX_NODES = 30_000
    node_count = 0
    MIN_LEAF_BYTES = max(1, int(min_size_bytes))

    def is_system_dir(p):
        lower = str(p).lower()
        return any(marker in lower for marker in SYSTEM_DIR_MARKERS)

    def walk(p, depth):
        nonlocal node_count
        if depth > max_depth or node_count >= MAX_NODES:
            return None
        node_count += 1
        try:
            is_file = p.is_file()
            is_dir = p.is_dir()
        except (PermissionError, FileNotFoundError, OSError):
            return {"name": p.name or str(p), "size": 0, "error": "unreadable"}
        if is_file:
            try:
                sz = int(p.stat().st_size)
            except Exception:
                sz = 0
            if sz < MIN_LEAF_BYTES:
                return None
            return {"name": p.name or str(p), "size": sz}
        if is_dir and is_system_dir(p):
            return None
        children = []
        total_size = 0
        try:
            entries = list(p.iterdir())
        except (PermissionError, FileNotFoundError, OSError):
            return {"name": p.name or str(p), "size": 0, "error": "unreadable_dir"}
        for child in entries:
            node = walk(child, depth + 1)
            if not node:
                continue
            sz = int(node.get("size", 0) or 0)
            if sz < MIN_LEAF_BYTES:
                continue
            children.append(node)
            total_size += sz
        children.sort(key=lambda n: int(n.get("size", 0) or 0), reverse=True)
        return {"name": p.name or str(p), "size": int(total_size), "children": children}

    tree = walk(root, 0) or {"name": root.name or str(root), "size": 0, "children": []}
    _attach_paths(tree, root)
    return tree


def _attach_paths(node, current_path):
    node["path"] = str(current_path)
    for child in node.get("children") or []:
        name = child.get("name") or ""
        if name:
            _attach_paths(child, current_path / name)


# ============================================
#  Squarify treemap layout
# ============================================

@dataclass
class _Rect:
    x: float; y: float; w: float; h: float

def _normalize_sizes(items, area):
    total = sum(max(0.0, float(it.get("size", 0) or 0)) for it in items)
    if total <= 0:
        n = max(1, len(items))
        return [area / n] * len(items)
    return [(max(0.0, float(it.get("size", 0) or 0)) / total) * area for it in items]

def _worst(row, short_side):
    if not row or short_side <= 0:
        return float("inf")
    s = sum(row); mx = max(row); mn = min(row)
    return max((short_side**2 * mx) / (s**2), (s**2) / (short_side**2 * mn))

def _layout_row(row, rect, horizontal):
    s = sum(row)
    out = []
    if horizontal:
        h = s / rect.w if rect.w > 0 else 0.0
        x = rect.x
        for a in row:
            w = a / h if h > 0 else 0.0
            out.append(_Rect(x, rect.y, w, h)); x += w
        remaining = _Rect(rect.x, rect.y + h, rect.w, max(0.0, rect.h - h))
    else:
        w = s / rect.h if rect.h > 0 else 0.0
        y = rect.y
        for a in row:
            h = a / w if w > 0 else 0.0
            out.append(_Rect(rect.x, y, w, h)); y += h
        remaining = _Rect(rect.x + w, rect.y, max(0.0, rect.w - w), rect.h)
    return out, remaining

def _squarify(items, x, y, w, h):
    if not items or w <= 0 or h <= 0:
        return []
    items_sorted = sorted(items, key=lambda it: float(it.get("size", 0) or 0), reverse=True)
    container = _Rect(x, y, w, h)
    sizes = _normalize_sizes(items_sorted, w * h)
    row, row_items, out = [], [], []
    remaining = container
    i = 0
    while i < len(items_sorted):
        a = sizes[i]
        short_side = min(remaining.w, remaining.h)
        new_row = row + [a]
        if (not row) or (_worst(new_row, short_side) <= _worst(row, short_side)):
            row = new_row; row_items.append(items_sorted[i]); i += 1
        else:
            horizontal = remaining.w >= remaining.h
            rects, remaining = _layout_row(row, remaining, horizontal)
            for it, r in zip(row_items, rects):
                it2 = dict(it); it2["rect"] = {"x": r.x, "y": r.y, "w": r.w, "h": r.h}; out.append(it2)
            row, row_items = [], []
    if row_items:
        horizontal = remaining.w >= remaining.h
        rects, _ = _layout_row(row, remaining, horizontal)
        for it, r in zip(row_items, rects):
            it2 = dict(it); it2["rect"] = {"x": r.x, "y": r.y, "w": r.w, "h": r.h}; out.append(it2)
    return out


# ============================================
#  Protected path helpers (for visualizer delete)
# ============================================

def _is_relative_to(p, base):
    try:
        p.resolve().relative_to(base.resolve())
        return True
    except Exception:
        return False

def _protected_roots_for_os():
    sysname = platform.system()
    roots = []
    if sysname == "Windows":
        windir = os.environ.get("WINDIR") or r"C:\Windows"
        roots += [Path(windir), Path(r"C:\Program Files"), Path(r"C:\Program Files (x86)"), Path(r"C:\ProgramData")]
    elif sysname == "Darwin":
        roots += [Path("/System"), Path("/Library"), Path("/Applications"), Path("/private"), Path("/Volumes")]
    else:
        roots += [Path(p) for p in ["/bin","/sbin","/usr","/etc","/lib","/lib64","/proc","/sys","/dev","/run","/boot","/var/lib"]]
    # Always protect the TLI install and data directories themselves
    try:
        roots.append(Path(S.BASE_DIR).resolve())
    except Exception:
        pass
    return roots

def _safe_delete_roots():
    roots = []
    try: roots.append(Path.home())
    except Exception: pass
    try: roots.append(Path(S.DATA_DIR))
    except Exception: pass
    return roots

# Windows system files that live at the drive root and must never be deleted.
_WINDOWS_ROOT_SYSTEM_FILES = {
    "hiberfil.sys",       # hibernation image — deleting breaks sleep/wake
    "pagefile.sys",       # virtual memory page file — deleting causes crash on low RAM
    "swapfile.sys",       # UWP swap file
    "bootmgr",            # Windows Boot Manager — deleting breaks boot
    "bootnxt",            # Windows boot next file
    "boot",               # boot configuration directory
    "system volume information",
    "$recycle.bin",
    "$windows.~bt",       # Windows upgrade staging
    "$windows.~ws",
    "$winreagent",
    "recovery",
    "config.sys",
    "autoexec.bat",
    "io.sys",
    "msdos.sys",
}

def _is_protected_path(p):
    pr = p.expanduser().resolve(strict=False)
    try:
        if pr.resolve() == Path(pr.anchor).resolve():
            return "Blocked: filesystem root"
    except Exception:
        pass

    # Explicit Windows drive-root system file block (e.g. C:\hiberfil.sys)
    if platform.system() == "Windows":
        try:
            if str(pr.parent) == str(Path(pr.anchor)):
                if pr.name.lower() in _WINDOWS_ROOT_SYSTEM_FILES:
                    return f"Blocked: Windows system file ({pr.name})"
        except Exception:
            pass

    for root in _protected_roots_for_os():
        try:
            if _is_relative_to(pr, root) or pr == root.resolve():
                return f"Blocked: protected system location ({root})"
        except Exception:
            continue
    allowed = any(_is_relative_to(pr, r) or pr == r.resolve() for r in _safe_delete_roots())
    if not allowed:
        return "Blocked: outside safe delete roots"
    return None


# ============================================
#  Endpoints
# ============================================

@router.get("/scan_directory")
def scan_directory(path: str = Query(...), max_depth: int = 6):
    root = _resolve_scan_path(path)
    tree = _build_directory_tree(root, max_depth=max_depth)
    tree["path"] = str(root)
    return tree


@router.post("/open_path")
def open_path(payload: dict, _session=Depends(require_session)):
    raw = payload.get("path")
    if not raw or not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="Missing or invalid 'path'")
    p = Path(raw).expanduser()
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {p}")
    try:
        system = platform.system()
        if system == "Windows":
            os.startfile(str(p))
        elif system == "Darwin":
            subprocess.Popen(["open", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p)])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"status": "ok"}


@router.post("/open_reveal")
def open_reveal(payload: dict, _session=Depends(require_session)):
    raw = payload.get("path")
    if not raw or not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="Missing or invalid 'path'")
    p = Path(raw).expanduser()
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {p}")
    try:
        system = platform.system()
        if system == "Windows":
            if p.is_dir():
                os.startfile(str(p))
            else:
                subprocess.Popen(["explorer.exe", "/select,", str(p)])
        elif system == "Darwin":
            subprocess.Popen(["open", "-R", str(p)])
        else:
            parent = p if p.is_dir() else p.parent
            subprocess.Popen(["xdg-open", str(parent)])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"status": "ok"}


@router.post("/fs/delete")
def delete_path(payload: dict, _session=Depends(require_session)):
    """
    Safe delete — always moves to Recycle Bin / Trash via send2trash.
    Directories are NEVER permanently deleted through this endpoint.
    Use /visualizer/delete with permanent=true for explicit permanent file deletion
    (still gated by _is_protected_path and only allowed for individual files).
    """
    raw = payload.get("path")
    if not raw or not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="Missing or invalid 'path'")
    p = Path(raw).expanduser()
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {p}")
    # Gate 1: system-protected locations
    if S.is_protected_system_path(p):
        raise HTTPException(status_code=403, detail=f"System-protected path: {p}")
    # Gate 2: _is_protected_path (whitelist — must be inside home or DATA_DIR)
    reason = _is_protected_path(p)
    if reason:
        raise HTTPException(status_code=403, detail=reason)
    # Always use send2trash — no shutil.rmtree, no permanent directory deletion
    if send2trash is None:
        raise HTTPException(
            status_code=501,
            detail="send2trash not available — safe delete requires it. Install with: pip install send2trash"
        )
    try:
        send2trash(str(p.resolve()))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"status": "trashed", "path": str(p)}


@router.post("/file/scan")
def file_scan(req: FileScanRequest):
    base_path = expand_base_path(req.path)
    p = Path(base_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Path does not exist: {base_path}")
    if not p.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")
    buckets: Dict[str, List[str]] = {}
    total_files = 0
    for entry in p.iterdir():
        if not entry.is_file():
            continue
        total_files += 1
        cat = categorize_extension(entry.suffix)
        buckets.setdefault(cat, []).append(entry.name)
    return {"path": str(p), "total_files": total_files, "buckets": buckets}


@router.post("/file/organize")
def file_organize(req: FileOrganizeRequest, _session=Depends(require_session)):
    base_path = expand_base_path(req.path)
    p = Path(base_path)
    if not p.exists() or not p.is_dir():
        raise HTTPException(status_code=400, detail="Base path must be an existing directory")
    plan: Dict[str, List[str]] = {}
    for dest_name, filenames in (req.actions or {}).items():
        if not dest_name:
            continue
        dest_dir = p / dest_name.strip()
        safe_files = [os.path.basename(fname) for fname in filenames if os.path.basename(fname)]
        if safe_files:
            plan[str(dest_dir)] = safe_files
    if not plan:
        return {"path": str(p), "plan": {}, "moved_count": 0, "preview": not req.confirm}
    if not req.confirm:
        return {"path": str(p), "plan": plan, "moved_count": 0, "preview": True}
    moves = []
    moved_count = 0
    for dest_dir_str, files in plan.items():
        dest_dir = Path(dest_dir_str)
        dest_dir.mkdir(parents=True, exist_ok=True)
        for fname in files:
            src = p / fname
            if not src.is_file():
                continue
            dst = dest_dir / fname
            try:
                shutil.move(str(src), str(dst))
                moves.append({"src": str(src), "dst": str(dst)})
                moved_count += 1
            except Exception:
                continue
    if moved_count > 0:
        S.save_last_file_operation({"type": "organize", "timestamp": datetime.utcnow().isoformat(),
                                     "moves": moves, "renames": []})
    return {"path": str(p), "plan": plan, "moved_count": moved_count, "preview": False}


@router.post("/file/rename")
def file_rename(req: FileRenameRequest, _session=Depends(require_session)):
    base_path = expand_base_path(req.path)
    p = Path(base_path)
    if not p.exists() or not p.is_dir():
        raise HTTPException(status_code=400, detail="Path must be an existing directory")
    prefix = req.prefix.strip()
    if not prefix:
        raise HTTPException(status_code=400, detail="Prefix cannot be empty")
    files = sorted([f for f in p.iterdir() if f.is_file()])
    if not files:
        return {"count": 0, "renamed": []}
    width = len(str(len(files)))
    renames = []
    count = 0
    for idx, f in enumerate(files, start=1):
        ext = f.suffix
        new_name = f"{prefix}_{str(idx).zfill(width)}{ext}"
        new_path = p / new_name
        try:
            f.rename(new_path)
            renames.append({"old": str(f), "new": str(new_path)})
            count += 1
        except Exception:
            continue
    if count > 0:
        S.save_last_file_operation({"type": "rename", "timestamp": datetime.utcnow().isoformat(),
                                     "moves": [], "renames": renames})
    return {"count": count, "renamed": renames}


@router.post("/file/undo")
def file_undo():
    op = S.load_last_file_operation()
    if not op:
        return {"message": "No previous file operation to undo.", "undone": 0}
    undone = 0
    for mv in op.get("moves", []):
        src = Path(mv.get("dst", ""))
        dst = Path(mv.get("src", ""))
        if not src.is_file():
            continue
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            undone += 1
        except Exception:
            continue
    for rn in op.get("renames", []):
        new_path = Path(rn.get("new", ""))
        old_path = Path(rn.get("old", ""))
        if not new_path.exists():
            continue
        try:
            old_path.parent.mkdir(parents=True, exist_ok=True)
            new_path.rename(old_path)
            undone += 1
        except Exception:
            continue
    return {"message": f"Reverted last '{op.get('type', 'unknown')}' operation.", "undone": undone}


@router.post("/files/scan")
def files_scan(req: FilesScanRequest):
    base_path = expand_base_path(req.root)
    p = Path(base_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Path does not exist: {base_path}")
    if not p.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")
    ext_map: Dict[str, Dict[str, Any]] = {}
    for entry in p.iterdir():
        if not entry.is_file():
            continue
        ext = entry.suffix.lower() or "(no ext)"
        info = ext_map.setdefault(ext, {"count": 0, "example": None})
        info["count"] += 1
        if info["example"] is None:
            info["example"] = entry.name
    summary = [{"extension": ext, "count": info["count"], "example": info["example"]}
               for ext, info in sorted(ext_map.items(), key=lambda kv: (-kv[1]["count"], kv[0]))]
    return {"path": str(p), "extension_summary": summary}


@router.post("/files/apply_rules")
def files_apply_rules(req: FilesApplyRulesRequest):
    base_path = expand_base_path(req.root)
    p = Path(base_path)
    if not p.exists() or not p.is_dir():
        raise HTTPException(status_code=400, detail="Path must be an existing directory")

    # Collect all filenames grouped by extension
    files_by_ext: Dict[str, List[str]] = {}
    all_files: List[str] = []
    for entry in p.iterdir():
        if not entry.is_file():
            continue
        ext = entry.suffix.lower() or "(no ext)"
        files_by_ext.setdefault(ext, []).append(entry.name)
        all_files.append(entry.name)

    if not all_files:
        return {"path": str(p), "plan": {}, "summary": "Folder is empty.", "ai": False}

    ext_summary = "\n".join(
        f"  {ext}: {', '.join(names[:6])}{'…' if len(names) > 6 else ''}"
        for ext, names in sorted(files_by_ext.items())
    )
    user_rules = (req.rules or "").strip()

    # Try LM Studio
    try:
        if not S.lm_provider or not S.lm_provider.health_check():
            raise RuntimeError("LM Studio unavailable")
        model_id = S.MODEL_CONFIG.get(S.DEFAULT_MODEL_KEY, {}).get("id", "")
        prompt = (
            f"You are a file organization assistant.\n"
            f"Folder: {p}\n"
            f"Files by extension:\n{ext_summary}\n\n"
            + (f"User instruction: {user_rules}\n\n" if user_rules else "")
            + "Suggest how to organize these files into subfolders. "
            "Reply ONLY with a JSON object where each key is a subfolder name "
            'and each value is an array of exact filenames to move there. '
            'Example: {"Documents": ["report.pdf"], "Images": ["photo.jpg"]}'
        )
        result = S.lm_provider.complete(
            messages=[{"role": "user", "content": prompt}],
            model_id=model_id,
            temperature=0.2,
            max_tokens=768,
        )
        raw = (result.get("text") or "").strip()
        # Extract JSON from response (model may wrap it in markdown)
        import re as _re
        json_match = _re.search(r"\{[\s\S]+\}", raw)
        plan: Dict[str, List[str]] = {}
        if json_match:
            try:
                proposed = json.loads(json_match.group())
                # Validate: only include filenames that actually exist in the folder
                valid_files = set(all_files)
                for folder, fnames in proposed.items():
                    if not isinstance(fnames, list):
                        continue
                    valid = [f for f in fnames if isinstance(f, str) and f in valid_files]
                    if valid:
                        plan[folder.strip()] = valid
            except Exception:
                pass
        return {"path": str(p), "plan": plan, "summary": raw, "ai": True}
    except Exception as e:
        S.log_debug("files", "WARN", "AI apply_rules failed, returning extension plan", error=str(e))

    # Fallback: use the built-in extension categorizer
    fallback_plan: Dict[str, List[str]] = {}
    for ext, names in files_by_ext.items():
        cat = categorize_extension(ext)
        fallback_plan.setdefault(cat, []).extend(names)
    return {
        "path": str(p),
        "plan": fallback_plan,
        "summary": f"Organized {len(all_files)} files into {len(fallback_plan)} categories by extension. (AI unavailable — used built-in rules.)",
        "ai": False,
    }


@router.post("/files/insight")
def files_insight(req: FilesScanRequest):
    base_path = expand_base_path(req.root)
    p = Path(base_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Path does not exist: {base_path}")
    if not p.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    entries = list(p.iterdir())
    files   = [e for e in entries if e.is_file()]
    dirs    = [e for e in entries if e.is_dir()]

    ext_counts: Dict[str, int] = {}
    total_bytes = 0
    for f in files:
        ext = f.suffix.lower() or "(no ext)"
        ext_counts[ext] = ext_counts.get(ext, 0) + 1
        try:
            total_bytes += f.stat().st_size
        except Exception:
            pass

    top_exts = sorted(ext_counts.items(), key=lambda x: x[1], reverse=True)[:6]
    size_mb  = round(total_bytes / 1e6, 1)
    ext_line = ", ".join(f"{ext} ×{n}" for ext, n in top_exts) or "none"
    context  = (
        f"Folder: {p.name}  ({len(files)} files, {len(dirs)} subfolders, ~{size_mb} MB)\n"
        f"Top file types: {ext_line}"
    )

    # Try LM Studio
    try:
        if not S.lm_provider or not S.lm_provider.health_check():
            raise RuntimeError("LM Studio unavailable")
        model_id = S.MODEL_CONFIG.get(S.DEFAULT_MODEL_KEY, {}).get("id", "")
        prompt = (
            f"You are a helpful file analyst.\n{context}\n\n"
            "Give a short, plain-English summary of what this folder appears to contain "
            "and any obvious housekeeping suggestions. Be concise (3-5 sentences)."
        )
        result = S.lm_provider.complete(
            messages=[{"role": "user", "content": prompt}],
            model_id=model_id,
            temperature=0.5,
            max_tokens=256,
        )
        summary = (result.get("text") or "").strip()
        if summary:
            return {"path": str(p), "context": context, "summary": summary, "ai": True}
    except Exception as e:
        S.log_debug("files", "WARN", "AI insight failed, returning stats", error=str(e))

    return {
        "path": str(p),
        "context": context,
        "summary": f"{len(files)} files totalling {size_mb} MB across {len(ext_counts)} file types. {len(dirs)} subfolders.",
        "ai": False,
    }


# ============================================
#  Visualizer treemap + delete
# ============================================

@router.get("/visualizer/treemap")
def visualizer_treemap(path: str = Query(...), width: int = Query(1200, ge=200, le=8000),
                        height: int = Query(700, ge=200, le=8000), max_children: int = Query(1200, ge=50, le=5000)):
    root = _resolve_scan_path(path)
    tree = _build_directory_tree(root, max_depth=1)
    items = []
    for ch in (tree.get("children") or []):
        name = ch.get("name")
        if not name:
            continue
        cp = root / name
        kind = "dir" if cp.is_dir() else "file"
        items.append({"name": name, "path": str(cp), "size": int(ch.get("size", 0) or 0), "kind": kind})
    items.sort(key=lambda x: x["size"], reverse=True)
    if len(items) > max_children:
        keep = items[:max_children - 1]
        tail = items[max_children - 1:]
        tail_size = sum(int(x.get("size", 0) or 0) for x in tail)
        keep.append({"name": "Other", "path": str(root), "size": int(tail_size), "kind": "virtual"})
        items = keep
    enriched = []
    for it in items:
        it2 = dict(it)
        if it2.get("kind") == "virtual":
            it2["deletable"] = False; it2["delete_reason"] = "Virtual bucket"
        else:
            reason = _is_protected_path(Path(it2["path"]))
            it2["deletable"] = not bool(reason); it2["delete_reason"] = reason or ""
        enriched.append(it2)
    nodes = _squarify(enriched, 0.0, 0.0, float(width), float(height))
    return {"ok": True, "root_path": str(root), "width": width, "height": height, "nodes": nodes}


@router.post("/visualizer/delete")
def visualizer_delete(req: VisualizerDeleteRequest, _session=Depends(require_session)):
    """
    Visualizer delete. Default (permanent=false) moves to Recycle Bin / Trash.
    permanent=true is only allowed for individual files, never directories.
    """
    p = Path(req.path).expanduser()
    if not p.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    reason = _is_protected_path(p)
    if reason:
        raise HTTPException(status_code=403, detail=reason)
    # Permanent deletion of directories is always refused — too dangerous
    if req.permanent and p.is_dir():
        raise HTTPException(
            status_code=400,
            detail="Permanent deletion of directories is not allowed. Use trash (permanent=false) instead."
        )
    if not req.permanent:
        if send2trash is None:
            raise HTTPException(status_code=501, detail="send2trash not installed")
        send2trash(str(p.resolve()))
        return {"ok": True, "trashed": True}
    # permanent=true, individual file only
    p.unlink()
    return {"ok": True, "trashed": False}
