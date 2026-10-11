"""Build a small, source-only TLI Node archive from an explicit public allowlist.

No application state, models, environment files or host UI are traversed.
The destination must not already exist. Requires only Python's standard library.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import zipfile

ROOT = Path(__file__).resolve().parent
FILES = (
    "TLI_Node.bat", "node/README.md", "node/requirements.txt",
    "backend/tli_node.py", "backend/tli_state.py", "backend/node_identity.py",
    "backend/data_protection.py", "backend/security_state.py", "backend/tls_cert.py",
    "backend/peer_trust.py", "backend/lan_inference.py", "backend/peer_inference_routes.py",
    "backend/stream_lifecycle.py", "backend/intelligence/__init__.py",
    "backend/intelligence/input_budget.py",
)
MAX_FILE_BYTES = 2 * 1024 * 1024


def snapshot(root: Path) -> dict[str, bytes]:
    root = root.resolve(strict=True)
    result = {}
    for relative in FILES:
        path = root / relative
        # Even allowlisted names must not redirect into private files or mounts.
        for candidate in (path, *path.parents):
            if candidate == root:
                break
            info = candidate.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
                raise ValueError(f"Refusing redirected bundle source: {relative}")
        if not path.is_file() or not path.resolve(strict=True).is_relative_to(root):
            raise ValueError(f"Invalid bundle source: {relative}")
        with path.open("rb") as stream:
            data = stream.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise ValueError(f"Bundle source exceeded its size limit: {relative}")
        result[relative] = data
    return result


def version(files: dict[str, bytes]) -> str:
    found = re.search(rb'^TLI_VERSION\s*=\s*"([A-Za-z0-9._-]+)"', files["backend/tli_state.py"], re.MULTILINE)
    if found is None:
        raise ValueError("Cannot read the source TLI version without importing application state.")
    return found.group(1).decode("ascii")


def build(root: Path, destination: Path | None = None) -> Path:
    files = snapshot(root)
    release = version(files)
    target = destination if destination is not None else root / "artifacts" / f"TLI_Node_{release}.zip"
    target = target.absolute()
    manifest = {"format": "tli-node-source-bundle-v1", "tli_version": release,
                "contains_models": False, "contains_dependencies": False,
                "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
        archive.writestr("node/manifest.json", json.dumps(manifest, indent=2) + "\n")
    target.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation cannot overwrite an earlier artifact or an unrelated file.
    with target.open("xb") as stream:
        stream.write(buffer.getvalue())
        stream.flush()
        os.fsync(stream.fileno())
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="New .zip destination; existing files are never replaced")
    args = parser.parse_args()
    try:
        target = build(ROOT, args.output)
    except (OSError, ValueError) as error:
        parser.exit(1, f"TLI Node bundle was not created: {error}\n")
    print(f"TLI Node source bundle: {target}")
    print("Install the documented dependencies and a local model before offline use.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
