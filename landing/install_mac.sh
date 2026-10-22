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
# An unrelated Python environment must not interfere with interpreter detection.
unset PYTHONHOME PYTHONPATH
# Use final standard CPython builds with supported dependency wheels. An
# enabled GIL at runtime does not make a free-threaded build a standard build.
supported_python() {
    "$1" -I -c 'import sys, sysconfig; raise SystemExit(not (sys.implementation.name == "cpython" and (3, 10) <= sys.version_info[:2] <= (3, 14) and sys.version_info.releaselevel == "final" and sysconfig.get_config_var("Py_GIL_DISABLED") not in (1, "1") and "t" not in getattr(sys, "abiflags", "")))' >/dev/null 2>&1
}

find_python() {
    local version candidate executable
    local candidates=("$@")
    # Versioned paths also work when Finder omits Homebrew or python.org from
    # PATH, or the generic python3/Current points at an unsupported preview.
    for version in 3.13 3.14 3.12 3.11 3.10; do
        candidates+=("python$version"
            "/Library/Frameworks/Python.framework/Versions/$version/bin/python$version"
            "/opt/homebrew/opt/python@$version/bin/python$version"
            "/usr/local/opt/python@$version/bin/python$version"
            "/opt/homebrew/bin/python$version" "/usr/local/bin/python$version")
    done
    candidates+=(python3 /opt/homebrew/bin/python3 /usr/local/bin/python3
        /Library/Frameworks/Python.framework/Versions/Current/bin/python3 python)
    for candidate in "${candidates[@]}"; do
        executable="$(command -v "$candidate" 2>/dev/null || true)"
        if [ -n "$executable" ] && supported_python "$executable"; then
            printf '%s\n' "$executable"
            return 0
        fi
    done
    return 1
}

PYTHON="$(find_python || true)"
if [ -z "$PYTHON" ]; then
    printf 'Install standard Python 3.13 from https://www.python.org/downloads/ and run this installer again. TLI requires final CPython 3.10–3.14 without free-threading.\n' >&2
    exit 1
fi
"$PYTHON" - <<'TLI_INSTALLER_PY'
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import zipfile

MANIFEST_URL = "https://thelanintelligence.com/downloads.json"
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024
CURL = "/usr/bin/curl"
REQUIRED = {"TLI_Start.command", "TLI_Start.sh", "backend/main.py", "backend/requirements.txt", "frontend/index.html"}
EXECUTABLES = {"TLI_Start.command", "TLI_Start.sh",
               "TLI_Update.command", "TLI_Update.sh", "Uninstall_TLI.command", "Uninstall_TLI.sh",
               "backend/ai/runtime/macos-arm64/llama-server", "backend/ai/runtime/macos-x64/llama-server"}


def download(url, destination, limit):
    if urllib.parse.urlsplit(url).scheme != "https":
        raise ValueError("Downloads must use HTTPS.")
    # Use macOS's verified HTTPS transport, just like the command that fetched
    # this script. A fresh python.org installation may not have its separate
    # certificate bundle yet. Never disable certificate or redirect checks.
    command = [CURL, "--disable", "--fail", "--silent", "--show-error", "--location",
               "--proto", "=https", "--proto-redir", "=https",
               "--connect-timeout", "20", "--max-time", "600",
               "--user-agent", "TLI-macOS-installer", "--", url]
    created = False
    try:
        with tempfile.TemporaryFile() as errors, destination.open("xb") as output:
            created = True
            with subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=errors) as process:
                try:
                    total = 0
                    while chunk := process.stdout.read(1024 * 1024):
                        total += len(chunk)
                        if total > limit:
                            raise ValueError("The download exceeds this installer's size limit.")
                        output.write(chunk)
                    if process.wait(timeout=5) != 0:
                        errors.seek(0)
                        detail = errors.read(2000).decode("utf-8", errors="replace").strip()
                        raise RuntimeError("The secure download failed. " + detail)
                except BaseException:
                    process.kill()
                    process.wait()
                    raise
    except BaseException:
        if created:
            destination.unlink(missing_ok=True)
        raise


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
    print("If Apple could not verify TLI_Start.command from this trusted release, click Done on the warning.")
    print("Open System Settings > Privacy & Security, scroll to Security, and choose Open Anyway for TLI_Start.command.")
    print("Confirm Open and authenticate if asked. See https://support.apple.com/en-us/102445")
    print("No security attributes were removed. No old data was copied or changed.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("TLI installation did not complete: " + str(error), file=sys.stderr)
        raise SystemExit(1)
TLI_INSTALLER_PY
