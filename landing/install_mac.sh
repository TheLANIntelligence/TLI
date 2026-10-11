#!/usr/bin/env bash
# Download and inspect this script before running: bash install_mac.sh
# Installs a verified release beside existing installations; never migrates data.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
    printf 'This installer is for macOS. Download the package for your platform.\n' >&2
    exit 1
fi
mac_version="$(sw_vers -productVersion)"
mac_arch="$(uname -m)"
if [[ ! "$mac_version" =~ ^([0-9]+)\.([0-9]+) ]]; then
    printf 'Could not determine this Mac\047s version.\n' >&2
    exit 1
fi
mac_major="${BASH_REMATCH[1]}"; mac_minor="${BASH_REMATCH[2]}"
case "$mac_arch" in
    arm64) (( 10#$mac_major >= 14 )) || { printf 'This release requires macOS 14 or newer on Apple Silicon.\n' >&2; exit 1; } ;;
    x86_64) (( 10#$mac_major > 13 || (10#$mac_major == 13 && 10#$mac_minor >= 3) )) || { printf 'This release requires macOS 13.3 or newer on Intel.\n' >&2; exit 1; } ;;
    *) printf 'This release supports Apple Silicon and Intel Macs.\n' >&2; exit 1 ;;
esac
PYTHON=""
for candidate in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 \
        /Library/Frameworks/Python.framework/Versions/Current/bin/python3; do
    executable="$(command -v "$candidate" 2>/dev/null || true)"
    if [ -n "$executable" ] && "$executable" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
        PYTHON="$executable"
        break
    fi
done
if [ -z "$PYTHON" ]; then
    printf 'Install Python 3.10 or newer from https://www.python.org/downloads/ and run this installer again.\n' >&2
    exit 1
fi
unset PYTHONHOME PYTHONPATH
"$PYTHON" - <<'TLI_INSTALLER_PY'
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import stat
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile

MANIFEST_URL = "https://thelanintelligence.com/downloads.json"
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024
REQUIRED = {"TLI_Start.command", "TLI_Start.sh", "backend/main.py", "backend/requirements.txt", "frontend/index.html"}
EXECUTABLES = {"TLI_Start.command", "TLI_Start.sh",
               "backend/ai/runtime/macos-arm64/llama-server", "backend/ai/runtime/macos-x64/llama-server"}


class HTTPSRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise ValueError("An HTTPS download tried to redirect to an insecure address.")
        return super().redirect_request(request, fp, code, message, headers, newurl)


def download(url, destination, limit):
    if urllib.parse.urlsplit(url).scheme != "https":
        raise ValueError("Downloads must use HTTPS.")
    opener = urllib.request.build_opener(HTTPSRedirects())
    request = urllib.request.Request(url, headers={"User-Agent": "TLI-macOS-installer"})
    with opener.open(request, timeout=60) as response, destination.open("xb") as output:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > limit:
                raise ValueError("The download exceeds this installer's size limit.")
            output.write(chunk)


def validate_manifest(manifest):
    version = manifest.get("version")
    if not isinstance(version, str) or len(version) > 64 or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("The download manifest has an invalid version.")
    asset = manifest["platforms"]["macos"]
    filename = "TLI_" + version + "_macOS.zip"
    expected_url = "https://github.com/TheLANIntelligence/TLI/releases/download/v" + version + "/" + filename
    digest = asset.get("sha256", "")
    if asset.get("filename") != filename or asset.get("url") != expected_url:
        raise ValueError("The macOS download does not match the official release and version.")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
        raise ValueError("The macOS release has no valid SHA-256 checksum.")
    return version, expected_url, digest.lower()


def archive_entries(archive):
    entries = archive.infolist()
    if not entries or len(entries) > 10000 or sum(item.file_size for item in entries) > MAX_EXTRACTED_BYTES:
        raise ValueError("The archive is empty or exceeds extraction limits.")
    names = set()
    for item in entries:
        name = item.orig_filename
        components = name.rstrip("/").split("/")
        mode = stat.S_IFMT(item.external_attr >> 16)
        if (not name or "\\" in name or "\x00" in name or ":" in name
                or any(part in {"", ".", ".."} for part in components)
                or mode not in {0, stat.S_IFREG, stat.S_IFDIR} or item.flag_bits & 1):
            raise ValueError("The archive contains an unsafe path, link or encrypted entry.")
        key = name.rstrip("/").casefold()
        if key in names:
            raise ValueError("The archive contains duplicate or case-colliding paths.")
        names.add(key)
    file_names = {item.filename for item in entries if not item.is_dir()}
    prefix = ""
    if not REQUIRED.issubset(file_names):
        roots = {name.split("/", 1)[0] for name in file_names}
        if len(roots) != 1:
            raise ValueError("This is not a complete TLI desktop archive.")
        prefix = roots.pop() + "/"
        if not {prefix + name for name in REQUIRED}.issubset(file_names):
            raise ValueError("This is not a complete TLI desktop archive.")
    result = []
    for item in entries:
        if prefix and not item.filename.startswith(prefix):
            raise ValueError("The archive contains files outside its application folder.")
        relative = item.filename[len(prefix):].rstrip("/")
        if not relative:
            continue
        parts = PurePosixPath(relative).parts
        if any(part.casefold() in {"data", ".venv", ".git"} for part in parts):
            raise ValueError("The archive contains installation state instead of source only.")
        result.append((item, parts))
    return result


def install_archive(archive_path, checksum, version, applications):
    digest = hashlib.sha256()
    with archive_path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != checksum:
        raise ValueError("SHA-256 verification failed. The archive was not installed.")
    target = applications / ("TLI-" + version)
    # Refuse a link or an existing target; even an empty old folder is preserved.
    if applications.is_symlink() or (applications.exists() and not applications.is_dir()):
        raise ValueError("The Applications destination must be a regular directory.")
    if target.exists() or target.is_symlink():
        raise ValueError("The destination already exists: " + str(target) + ". Keep it and choose a separate folder for another copy.")
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive_entries(archive)
        applications.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".tli-install-", dir=applications) as temporary:
            stage = Path(temporary) / "application"
            stage.mkdir()
            for item, parts in entries:
                destination = stage.joinpath(*parts)
                if item.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(item) as source, destination.open("xb") as output:
                        shutil.copyfileobj(source, output)
                    destination.chmod(0o644)
            # Only the known launchers/runtime entry points become executable.
            # Never apply arbitrary executable, setuid or writable ZIP modes.
            for name in EXECUTABLES:
                executable = stage / name
                if executable.is_file():
                    executable.chmod(0o755)
            # copytree creates the target exclusively; it never merges or replaces
            # an existing installation, including one created during the download.
            shutil.copytree(stage, target)
    return target


def main():
    print("TheLANIntelligence — fresh macOS installation")
    print("Existing TLI folders and saved data will stay in place.", flush=True)
    with tempfile.TemporaryDirectory(prefix="tli-download-") as temporary:
        temporary = Path(temporary)
        manifest_file = temporary / "downloads.json"
        download(MANIFEST_URL, manifest_file, 65536)
        version, url, checksum = validate_manifest(json.loads(manifest_file.read_text(encoding="utf-8")))
        print("Downloading TLI " + version + " and verifying SHA-256...", flush=True)
        archive = temporary / "release.zip"
        download(url, archive, MAX_ARCHIVE_BYTES)
        target = install_archive(archive, checksum, version, Path.home() / "Applications")
    print("\nInstalled: " + str(target))
    print("In Finder, open that folder and double-click TLI_Start.command.")
    print("Or run: bash " + shlex.quote(str(target / "TLI_Start.command")))
    print("First launch downloads Python dependencies into this new folder.")
    print("The package includes the AI runtime. Download and select model weights in TLI separately, or configure LM Studio.")
    print("If macOS blocks the unsigned launcher, review it and use System Settings > Privacy & Security.")
    print("No security attributes were removed. No old data was copied or changed.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("TLI installation did not complete: " + str(error), file=sys.stderr)
        raise SystemExit(1)
TLI_INSTALLER_PY
