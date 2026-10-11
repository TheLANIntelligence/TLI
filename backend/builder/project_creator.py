from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .safety import is_within_root


TEMPLATES = {"blank", "python", "web"}


def create_project(parent_path: str, name: str, template: str = "blank", create_parent: bool = False) -> dict[str, Any]:
    parent = Path(parent_path).expanduser().resolve()
    if not parent.exists() or not parent.is_dir():
        if not create_parent:
            raise ValueError("Parent folder does not exist. Approve creating it, then try again.")
        parent.mkdir(parents=True, exist_ok=True)

    clean_name = sanitize_name(name)
    if not clean_name:
        raise ValueError("Project name must contain letters, numbers, spaces, underscores, or dashes.")

    template = (template or "blank").lower()
    if template not in TEMPLATES:
        raise ValueError("Unknown project template.")

    project_root = (parent / clean_name).resolve()
    if not is_within_root(parent, project_root):
        raise ValueError("Project folder must stay inside the parent folder.")
    if project_root.exists() and any(project_root.iterdir()):
        raise ValueError("Project folder already exists and is not empty.")

    project_root.mkdir(parents=True, exist_ok=True)
    written = write_template(project_root, clean_name, template)
    return {
        "project_name": clean_name,
        "root": str(project_root),
        "template": template,
        "files_created": written,
    }


def sanitize_name(name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9 _.-]+", "", name.strip())
    cleaned = cleaned.strip(" .")
    return cleaned[:80]


def write_template(root: Path, name: str, template: str) -> list[str]:
    files: dict[str, str] = {
        "README.md": f"# {name}\n\nCreated with TLI Builder.\n",
    }
    if template == "python":
        files.update({
            "main.py": 'def main():\n    print("Hello from TLI Builder.")\n\n\nif __name__ == "__main__":\n    main()\n',
            "requirements.txt": "",
        })
    elif template == "web":
        files.update({
            "index.html": '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>' + name + '</title>\n  <link rel="stylesheet" href="style.css" />\n</head>\n<body>\n  <main>\n    <h1>' + name + '</h1>\n    <p>Created with TLI Builder.</p>\n  </main>\n  <script src="app.js"></script>\n</body>\n</html>\n',
            "style.css": "body {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n  background: #0f172a;\n  color: #f8fafc;\n}\n\nmain {\n  max-width: 720px;\n  margin: 80px auto;\n  padding: 24px;\n}\n",
            "app.js": 'console.log("Hello from TLI Builder.");\n',
        })

    written: list[str] = []
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        written.append(rel)
    return written
