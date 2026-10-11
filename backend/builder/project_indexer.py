from __future__ import annotations

import os
import re
from collections import Counter
from pathlib import Path
from typing import Any

from .safety import is_protected_path, relative_path, should_ignore_dir


LANGUAGE_BY_EXT = {
    ".py": "python",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".jsx": "javascript",
    ".html": "html",
    ".css": "css",
    ".scss": "css",
    ".json": "json",
    ".md": "markdown",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
    ".ps1": "powershell",
    ".sh": "shell",
    ".bat": "batch",
    ".sql": "sql",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".cs": "csharp",
}

IMPORTANT_NAMES = {
    "main.py",
    "app.py",
    "server.py",
    "index.html",
    "app.js",
    "style.css",
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "vite.config.js",
    "vite.config.ts",
    "webpack.config.js",
    "tsconfig.json",
    "Dockerfile",
    "docker-compose.yml",
    "README.md",
    "AGENTS.md",
}

ROUTE_RE = re.compile(r"@\w+\.(get|post|put|delete|patch)\(\s*['\"]([^'\"]+)", re.I)
SKIPPED_FILE_EXTS = {
    ".zip",
    ".rar",
    ".7z",
    ".tar",
    ".gz",
    ".gguf",
    ".bin",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".log",
}


def scan_project(root: Path, max_files: int = 5000) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    languages: Counter[str] = Counter()
    important_files: list[str] = []
    risk_files: list[str] = []
    routes: list[dict[str, str]] = []
    total_size = 0
    skipped_dirs: set[str] = set()

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not _skip_dir(d, skipped_dirs)]
        for filename in filenames:
            if len(files) >= max_files:
                break
            path = Path(dirpath) / filename
            if path.suffix.lower() in SKIPPED_FILE_EXTS:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue

            rel = relative_path(root, path)
            suffix = path.suffix.lower()
            lang = LANGUAGE_BY_EXT.get(suffix)
            if lang:
                languages[lang] += 1
            protected = is_protected_path(path)
            if protected:
                risk_files.append(rel)
            if filename in IMPORTANT_NAMES or _looks_important(rel):
                important_files.append(rel)

            total_size += stat.st_size
            files.append({
                "path": rel,
                "name": filename,
                "ext": suffix,
                "language": lang,
                "size": stat.st_size,
                "modified": stat.st_mtime,
                "protected": protected,
            })

            if suffix == ".py" and stat.st_size <= 512_000 and not protected:
                routes.extend(_extract_fastapi_routes(path, rel))
        if len(files) >= max_files:
            break

    files.sort(key=lambda item: item["path"])
    important_files = sorted(dict.fromkeys(important_files), key=_importance_sort)
    risk_files = sorted(dict.fromkeys(risk_files))

    package_files = [f["path"] for f in files if f["name"] in {
        "package.json", "requirements.txt", "pyproject.toml", "Pipfile", "poetry.lock",
        "pnpm-lock.yaml", "yarn.lock", "package-lock.json",
    }]

    frontend_modules = [
        f["path"] for f in files
        if f["path"].startswith("frontend/") and f["ext"] in {".js", ".css", ".html"}
    ][:80]

    recent_files = sorted(
        (f for f in files if not f["protected"]),
        key=lambda item: item["modified"],
        reverse=True,
    )[:25]

    return {
        "project_name": root.name,
        "root": str(root),
        "file_count": len(files),
        "scan_limit_reached": len(files) >= max_files,
        "total_size_bytes": total_size,
        "languages": dict(languages.most_common()),
        "frameworks": detect_frameworks(files),
        "entry_points": detect_entry_points(files),
        "important_files": important_files[:80],
        "package_files": package_files,
        "backend_routes": routes[:200],
        "frontend_modules": frontend_modules,
        "detected_features": detect_features(files, routes),
        "risk_files": risk_files[:120],
        "recent_files": [
            {"path": f["path"], "modified": f["modified"], "language": f["language"]}
            for f in recent_files
        ],
        "ignored_dirs": sorted(skipped_dirs),
        "files": files,
    }


def public_project_map(project_map: dict[str, Any]) -> dict[str, Any]:
    data = dict(project_map)
    data.pop("files", None)
    return data


def detect_frameworks(files: list[dict[str, Any]]) -> list[str]:
    paths = {f["path"].lower() for f in files}
    names = {f["name"].lower() for f in files}
    frameworks: list[str] = []
    if "requirements.txt" in names or "pyproject.toml" in names:
        if any("routers/" in p for p in paths) or "backend/main.py" in paths:
            frameworks.append("FastAPI")
        else:
            frameworks.append("Python")
    if "package.json" in names:
        frameworks.append("JavaScript app")
    if "vite.config.js" in names or "vite.config.ts" in names:
        frameworks.append("Vite")
    if "electron" in " ".join(paths) or "TLI_Installer/package.json".lower() in paths:
        frameworks.append("Electron")
    if any(p.endswith(".html") for p in paths) and any(p.endswith(".js") for p in paths):
        frameworks.append("Vanilla JS frontend")
    return sorted(dict.fromkeys(frameworks))


def detect_entry_points(files: list[dict[str, Any]]) -> list[str]:
    candidates = [
        "backend/main.py",
        "main.py",
        "app.py",
        "frontend/index.html",
        "frontend/app.js",
        "index.html",
        "src/main.ts",
        "src/main.js",
    ]
    paths = {f["path"] for f in files}
    return [p for p in candidates if p in paths]


def detect_features(files: list[dict[str, Any]], routes: list[dict[str, str]]) -> list[str]:
    paths = {f["path"].lower() for f in files}
    features: list[str] = []
    if any("visualizer" in p for p in paths):
        features.append("Storage visualizer")
    if any("vault" in p for p in paths):
        features.append("Secure vault")
    if any("mesh" in p for p in paths):
        features.append("LAN mesh")
    if any("/ai/" in p or "ai_routes" in p or p.startswith("backend/ai/") for p in paths):
        features.append("AI routing")
    if any("home" in p or "shelly" in p or "drivers/" in p for p in paths):
        features.append("Smart-home/device drivers")
    if any(route["path"].startswith("/api") for route in routes):
        features.append("HTTP API routes")
    return sorted(dict.fromkeys(features))


def _skip_dir(name: str, skipped_dirs: set[str]) -> bool:
    if should_ignore_dir(name):
        skipped_dirs.add(name)
        return True
    return False


def _looks_important(rel: str) -> bool:
    lower = rel.lower()
    return (
        lower.startswith("backend/routers/")
        or lower.startswith("backend/ai/")
        or lower.startswith("frontend/js/")
        or lower.endswith("_routes.py")
        or lower.endswith("routes.py")
    )


def _importance_sort(path: str) -> tuple[int, str]:
    lower = path.lower()
    if lower in {"backend/main.py", "main.py", "frontend/index.html", "frontend/app.js"}:
        return (0, path)
    if lower.startswith("backend/routers/"):
        return (1, path)
    if lower.startswith("backend/ai/"):
        return (2, path)
    if lower.startswith("frontend/"):
        return (3, path)
    return (4, path)


def _extract_fastapi_routes(path: Path, rel: str) -> list[dict[str, str]]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    found: list[dict[str, str]] = []
    for method, route_path in ROUTE_RE.findall(text):
        found.append({"file": rel, "method": method.upper(), "path": route_path})
    return found
