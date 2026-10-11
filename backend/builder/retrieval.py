from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .safety import is_protected_path


ALIASES = {
    "ai": ["ai", "model", "llm", "chat", "status", "pill"],
    "status": ["status", "health", "checking", "online", "offline", "pill"],
    "visualizer": ["visualizer", "treemap", "storage", "label", "delete"],
    "vault": ["vault", "encrypt", "decrypt", "secret"],
    "mesh": ["mesh", "peer", "node", "lan", "federation"],
    "device": ["device", "shelly", "hue", "kasa", "govee", "home"],
    "builder": ["builder", "patch", "diff", "receipt", "rollback", "composer", "workspace"],
    "subtitle": ["subtitle", "title", "header", "copy"],
    "composer": ["composer", "chat", "textarea", "attachment", "dropzone"],
    "attachment": ["attachment", "attach", "file", "photo", "dropzone"],
}

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
    "in", "into", "it", "of", "on", "or", "say", "that", "the", "this", "to",
    "with",
}


def retrieve_relevant_files(root: Path, project_map: dict[str, Any], query: str, limit: int = 12) -> list[dict[str, Any]]:
    terms = expand_terms(query)
    files = project_map.get("files", [])
    scored: list[tuple[int, dict[str, Any]]] = []

    for file_info in files:
        if file_info.get("protected"):
            continue
        rel = file_info.get("path", "")
        score = score_path(rel, terms)
        if score < 0:
            continue
        if file_info.get("size", 0) <= 256_000 and file_info.get("ext") in {".py", ".js", ".ts", ".html", ".css", ".md"}:
            score += score_content(root / rel, terms)
        if score > 0:
            item = dict(file_info)
            item["score"] = score
            item["matches"] = matching_terms(rel, terms)
            scored.append((score, item))

    scored.sort(key=lambda pair: (-pair[0], pair[1]["path"]))
    return [summarize_file(root, item) for _, item in scored[:limit]]


def answer_from_project_map(project_map: dict[str, Any], query: str, relevant_files: list[dict[str, Any]]) -> str:
    q = query.strip()
    if not q:
        return "Ask Builder a question about this project, and it will identify the most relevant files without editing anything."

    parts: list[str] = []
    lower = q.lower()
    if any(word in lower for word in ["explain", "architecture", "overview", "structure"]):
        parts.append(_architecture_summary(project_map))
    elif any(word in lower for word in ["where", "file", "located", "controls", "bug", "why"]):
        if relevant_files:
            top = relevant_files[0]
            parts.append(
                f"The strongest match is `{top['path']}`. "
                f"It matched the task through {', '.join(top.get('matches') or ['project structure'])}."
            )
        else:
            parts.append("I did not find a strong file match for that wording yet.")
    else:
        parts.append("I scanned the project map and ranked likely relevant files for this question.")

    if relevant_files:
        parts.append("Likely files to inspect next:")
        for item in relevant_files[:6]:
            reason = item.get("summary") or "Matched by filename or nearby symbols."
            parts.append(f"- `{item['path']}`: {reason}")
    else:
        parts.append("No source files matched strongly. Try naming the panel, route, error text, or feature.")

    parts.append("No files were changed and no commands were run.")
    return "\n".join(parts)


def expand_terms(query: str) -> list[str]:
    raw = re.findall(r"[a-zA-Z0-9_./-]+", query.lower())
    terms: list[str] = []
    for term in raw:
        if len(term) >= 2 and term not in STOPWORDS:
            terms.append(term)
        for alias_key, alias_terms in ALIASES.items():
            if term == alias_key or term in alias_terms:
                terms.extend(alias_terms)
    return sorted(set(terms), key=lambda t: (-len(t), t))[:40]


def score_path(rel: str, terms: list[str]) -> int:
    lower = rel.lower()
    name = Path(rel).name.lower()
    score = 0
    for term in terms:
        if term in name:
            score += 10
        elif term in lower:
            score += 5
    if lower.startswith("backend/routers/"):
        score += 2
    if lower.startswith("frontend/js/") or lower in {"frontend/app.js", "frontend/index.html"}:
        score += 2
    if lower.startswith(("backend/", "frontend/")):
        score += 4
    if lower.startswith("docs/") or lower.endswith(".md"):
        score -= 8
    if lower.startswith("landing/") or lower.endswith(".json"):
        score -= 5
    if lower in {"build_dist.py"} and not any(term in terms for term in ["build", "dist", "package", "installer"]):
        score -= 18
    if lower.endswith(".bak") or "/bundle/" in lower:
        score -= 18
    if "visualizer" in terms and "visualizer" in lower:
        score += 20
    if "ai" in terms and (lower.startswith("backend/ai/") or lower == "frontend/app.js"):
        score += 16
    if "status" in terms and lower in {"frontend/app.js", "backend/ai/ai_routes.py", "backend/routers/system_routes.py"}:
        score += 14
    if "subtitle" in terms:
        if lower == "frontend/index.html":
            score += 45
        elif lower in {"frontend/builder.css", "frontend/js/builder.js"}:
            score += 18
    if ("composer" in terms or "attachment" in terms) and lower in {"frontend/index.html", "frontend/builder.css", "frontend/js/builder.js", "backend/routers/builder.py"}:
        score += 20
    return score


def score_content(path: Path, terms: list[str]) -> int:
    if is_protected_path(path):
        return 0
    try:
        text = path.read_text(encoding="utf-8", errors="replace")[:200_000].lower()
    except OSError:
        return 0
    score = 0
    for term in terms:
        count = text.count(term)
        if count:
            score += min(count, 6)
    return score


def matching_terms(rel: str, terms: list[str]) -> list[str]:
    lower = rel.lower()
    return [term for term in terms if term in lower][:6]


def summarize_file(root: Path, item: dict[str, Any]) -> dict[str, Any]:
    rel = item["path"]
    path = root / rel
    summary = ""
    if path.suffix.lower() in {".py", ".js", ".ts", ".html", ".css", ".md"} and item.get("size", 0) <= 256_000:
        summary = first_useful_line(path)
    return {
        "path": rel,
        "language": item.get("language"),
        "size": item.get("size"),
        "score": item.get("score"),
        "matches": item.get("matches", []),
        "summary": summary,
    }


def first_useful_line(path: Path) -> str:
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith(("#", "//", "/*", "*")):
                cleaned = stripped.lstrip("#/* ").strip()
                if cleaned:
                    return cleaned[:180]
                continue
            return stripped[:180]
    except OSError:
        return ""
    return ""


def _architecture_summary(project_map: dict[str, Any]) -> str:
    languages = project_map.get("languages") or {}
    frameworks = project_map.get("frameworks") or []
    entries = project_map.get("entry_points") or []
    features = project_map.get("detected_features") or []
    lines = [
        f"`{project_map.get('project_name', 'Project')}` has {project_map.get('file_count', 0)} indexed files.",
    ]
    if languages:
        lines.append("Main languages: " + ", ".join(f"{k} ({v})" for k, v in languages.items()))
    if frameworks:
        lines.append("Detected stack: " + ", ".join(frameworks))
    if entries:
        lines.append("Entry points: " + ", ".join(f"`{p}`" for p in entries))
    if features:
        lines.append("Detected features: " + ", ".join(features))
    return "\n".join(lines)
