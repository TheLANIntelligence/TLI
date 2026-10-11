"""Refresh local JS/CSS content hashes in current root HTML, not historical views."""
import hashlib
from pathlib import Path
import re


def refresh(root: Path) -> int:
    frontend = (root / "frontend").resolve()
    changed = 0
    pattern = re.compile(r'''((?:src|href)=["'])(/?(?:[\w.-]+/)*[\w.-]+\.(?:js|css))(?:\?v=[^"']*)?(["'])''')
    for page in frontend.glob("*.html"):
        text = page.read_text(encoding="utf-8")

        def version(match):
            asset = (frontend / match[2].lstrip("/")).resolve()
            if not asset.is_relative_to(frontend) or not asset.is_file():
                return match[0]
            digest = hashlib.sha256(asset.read_bytes()).hexdigest()[:12]
            return f"{match[1]}{match[2]}?v={digest}{match[3]}"

        updated = pattern.sub(version, text)
        if updated != text:
            page.write_text(updated, encoding="utf-8", newline="\n")
            changed += 1
    return changed


if __name__ == "__main__":
    print(f"Updated {refresh(Path(__file__).resolve().parents[1])} current HTML documents.")
