"""Stage pinned upstream llama.cpp binaries for a desktop release, without models.

Existing different files are never replaced. Use a fresh output directory when
changing the pin; this is a release preparation tool, not an installed updater.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BUILD = "b7896"
UPSTREAM = "https://github.com/ggml-org/llama.cpp/releases/download/" + BUILD
COMMIT = "ec6c7421e4f3c0e1bdb9fdc6ee9670e14a490854"
SOURCE = "https://raw.githubusercontent.com/ggml-org/llama.cpp/" + COMMIT
LLVM_SOURCE = "https://raw.githubusercontent.com/llvm/llvm-project/3b5b5c1ec4a3095ab096dd780e84d7ab81f3d7ff"
ASSETS = {
    "windows": ("llama-b7896-bin-win-cpu-x64.zip", "6a1dcc9a3d5344c3afe461c7a9247a69bb4099e15ef1da3a115fea94584b09eb"),
    "macos-arm64": ("llama-b7896-bin-macos-arm64.tar.gz", "231f8f7ff3763de2ab1cbeb097e728e4bb442b0bc941f6dacc7ef83d01ae47bb"),
    "macos-x64": ("llama-b7896-bin-macos-x64.tar.gz", "6de178b3f364734e442b4579554f102a6c36c9343cf31cdb8381c02053b2bf11"),
}
LICENSES = {
    "LICENSE-llama.cpp.txt": (SOURCE + "/LICENSE", "e562a2ddfaf8280537795ac5ecd34e3012b6582a147ef69ba6a6a5c08c84757d"),
    "LICENSE-jsonhpp.txt": (SOURCE + "/licenses/LICENSE-jsonhpp", "c0d068392ea65358b798b8c165103560f06e9e3b38c4ab4e2d8810a7b931af86"),
    "LICENSE-cpp-httplib.txt": (SOURCE + "/vendor/cpp-httplib/LICENSE", "4b45cbe16d7b71b89ae6127e26e0d90a029198ca5e958ad8e3d0b8bbed364d8b"),
    "LICENSE-LLVM-OpenMP.txt": (LLVM_SOURCE + "/openmp/LICENSE.TXT", "fdad1758a9e1f9d5a81e18879b3406772115edc92c24bfa36b70c654f325e8e4"),
}
MAX_DOWNLOAD = 300 * 1024 * 1024
MAX_FILE = 128 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024
DLL = re.compile(r"(?:ggml(?:-[a-z0-9-]+)?|llama|mtmd|libomp140\.x86_64)\.dll\Z")
DYLIB = re.compile(r"lib(?:llama|mtmd|ggml(?:-[a-z0-9-]+)?)(?:\.\d+)*\.dylib\Z")


def unlinked(path):
    """Check existing ancestors before resolving or writing through them."""
    path = Path(os.path.abspath(path))
    for entry in (path, *path.parents):
        if entry.is_symlink() or (entry.exists() and getattr(entry.lstat(), "st_file_attributes", 0) & 0x400):
            raise ValueError(f"Linked output/cache paths are not allowed: {entry}")
    return path


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def cached_download(url, expected, cache, name):
    cache = unlinked(cache)
    cache.mkdir(parents=True, exist_ok=True)
    target = unlinked(cache / name)
    if target.exists():
        if not target.is_file() or target.stat().st_size > MAX_DOWNLOAD or digest(target) != expected:
            raise ValueError(f"Cached file failed SHA-256 verification: {name}")
        return target
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=cache, prefix="download-", suffix=".part", delete=False) as stream:
            temporary = Path(stream.name)
            request = urllib.request.Request(url, headers={"User-Agent": "TLI-release-runtime-preparation"})
            with urllib.request.urlopen(request, timeout=60) as response:
                size = 0
                while block := response.read(1024 * 1024):
                    size += len(block)
                    if size > MAX_DOWNLOAD:
                        raise ValueError("Pinned download exceeds its size limit")
                    stream.write(block)
        if digest(temporary) != expected:
            raise ValueError(f"Downloaded file failed SHA-256 verification: {name}")
        # Do not replace a cache file introduced by another build.
        with target.open("xb") as output, temporary.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                output.write(block)
        return target
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def safe_name(name):
    path = PurePosixPath(name)
    if not name or "\\" in name or "\0" in name or path.is_absolute() or any(part in {"..", "."} or ":" in part for part in name.split("/")):
        raise ValueError(f"Unsafe archive path: {name!r}")
    return path


def read_windows(archive):
    selected, seen = {}, set()
    with zipfile.ZipFile(archive) as source:
        if len(source.infolist()) > 2048:
            raise ValueError("Too many runtime archive entries")
        for member in source.infolist():
            path = safe_name(member.filename.rstrip("/"))
            if str(path).casefold() in seen:
                raise ValueError("Duplicate archive path")
            seen.add(str(path).casefold())
            if stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError("ZIP links are not permitted")
            if member.is_dir():
                continue
            if member.file_size > MAX_FILE:
                raise ValueError("Runtime file exceeds its size limit")
            if len(path.parts) == 1 and (path.name == "llama-server.exe" or DLL.fullmatch(path.name)):
                name = "llama_server.exe" if path.name == "llama-server.exe" else path.name
                selected[name] = source.read(member)
    required = {"llama_server.exe", "llama.dll", "mtmd.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu-x64.dll", "libomp140.x86_64.dll"}
    if not required <= selected.keys():
        raise ValueError("Windows runtime archive is incomplete")
    return selected


def read_macos(archive, architecture):
    selected, entries, seen = {}, {}, set()
    prefix = f"llama-{BUILD}"
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        if len(members) > 2048:
            raise ValueError("Too many runtime archive entries")
        for member in members:
            if member.name == "." and member.isdir():
                continue
            path = safe_name(member.name.rstrip("/"))
            if str(path).casefold() in seen:
                raise ValueError("Duplicate archive path")
            seen.add(str(path).casefold())
            if not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError("Unsupported archive entry type")
            if member.size > MAX_FILE:
                raise ValueError("Runtime file exceeds its size limit")
            if member.issym():
                # Upstream dylib aliases are simple sibling filenames.
                target = safe_name(member.linkname)
                if len(target.parts) != 1:
                    raise ValueError("Runtime link must name a sibling in this archive")
            entries[path.as_posix()] = member
        names = {name for name in entries if len(PurePosixPath(name).parts) == 2
                 and PurePosixPath(name).parts[0] == prefix
                 and (PurePosixPath(name).name in {"llama-server", "LICENSE"} or DYLIB.fullmatch(PurePosixPath(name).name))}

        def contents(name, visited):
            if name not in names or name in visited:
                raise ValueError("Runtime link is outside the selected archive or cyclic")
            member = entries[name]
            if member.issym():
                return contents(f"{prefix}/{member.linkname}", visited | {name})
            if not member.isfile():
                raise ValueError("Expected a regular runtime file")
            with source.extractfile(member) as stream:
                return stream.read(MAX_FILE + 1)

        for name in sorted(names):
            raw = contents(name, set())
            base = PurePosixPath(name).name
            if base != "LICENSE":
                # Pinned archives must agree with their advertised native CPU.
                expected_cpu = b"\x0c\x00\x00\x01" if architecture == "arm64" else b"\x07\x00\x00\x01"
                if raw[:4] != b"\xcf\xfa\xed\xfe" or raw[4:8] != expected_cpu:
                    raise ValueError("Runtime binary architecture does not match its archive")
            selected[base] = raw
    required = {"llama-server", "LICENSE", "libllama.0.dylib", "libmtmd.0.dylib", "libggml.0.dylib", "libggml-base.0.dylib", "libggml-cpu.0.dylib", "libggml-blas.0.dylib", "libggml-rpc.0.dylib"}
    if architecture == "arm64":
        required.add("libggml-metal.0.dylib")
    if not required <= selected.keys():
        raise ValueError("macOS runtime archive is incomplete")
    return selected


def prepare(platform, output, cache):
    output = unlinked(output)
    keys = ["windows"] if platform == "windows" else ["macos-arm64", "macos-x64"]
    pending = {}
    for key in keys:
        filename, sha = ASSETS[key]
        url = f"{UPSTREAM}/{filename}"
        archive = cached_download(url, sha, cache, filename)
        files = read_windows(archive) if key == "windows" else read_macos(archive, key.removeprefix("macos-"))
        notice = [f"llama.cpp {BUILD} ({COMMIT})", f"Upstream archive: {url}", f"Archive SHA-256: {sha}",
                  "Only the server and runtime libraries are included; no model weights.",
                  "Server binary and libraries are unchanged. Windows server filename is adapted for TLI.",
                  "macOS dylib aliases are materialized as regular copies of their archive targets."]
        if key.startswith("macos-"):
            notice.append("Minimum macOS from binary load commands: " + ("14.0 (Apple Silicon)." if key == "macos-arm64" else "13.3 (Intel)."))
        for name, (license_url, license_sha) in LICENSES.items():
            if name == "LICENSE-LLVM-OpenMP.txt" and key != "windows":
                continue
            raw = cached_download(license_url, license_sha, cache, name).read_bytes()
            if name == "LICENSE-llama.cpp.txt" and "LICENSE" in files and files["LICENSE"] != raw:
                raise ValueError("Archive license does not match the pinned upstream license")
            files[name] = raw
            notice.extend([f"{name}: {license_url}", f"License SHA-256: {license_sha}"])
        if key == "windows":
            notice.append("libomp140.x86_64.dll is the upstream archive's LLVM OpenMP runtime; its license is included separately.")
        files["RUNTIME-NOTICES.txt"] = ("\n".join(notice) + "\n").encode()
        destination = output if key == "windows" else output / key
        for name, raw in files.items():
            pending[destination / name] = raw
    if sum(map(len, pending.values())) > MAX_EXPANDED:
        raise ValueError("Selected runtime exceeds its expanded size limit")
    # Preflight the complete set before writing any runtime file.
    for path, raw in pending.items():
        unlinked(path)
        if path.exists() and (not path.is_file() or path.read_bytes() != raw):
            raise ValueError(f"Refusing to replace an existing different runtime file: {path}")
    for path, raw in pending.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            with path.open("xb") as stream:
                stream.write(raw)
        path.chmod(0o644 if path.name.startswith(("LICENSE", "RUNTIME-NOTICES")) else 0o755)
    return {"build": BUILD, "platform": platform, "output": str(output), "files": len(pending),
            "bytes": sum(map(len, pending.values())), "archives": {key: ASSETS[key][1] for key in keys}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=("windows", "macos"), required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "backend/ai/runtime")
    parser.add_argument("--cache", type=Path, default=ROOT / "build_work/release-1.4.0-beta/runtime-downloads")
    args = parser.parse_args()
    print(json.dumps(prepare(args.platform, args.output, args.cache), indent=2))


if __name__ == "__main__":
    main()
