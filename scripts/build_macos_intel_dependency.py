"""Build TLI's Intel macOS cryptography wheel from fixed, verified upstream sources.

This release tool never runs during application setup. Native CI builds once;
installers consume the reviewed wheel by immutable URL and SHA256. A macOS 15
runner plus binary inspection does not replace acceptance on real Ventura.
"""
from __future__ import annotations

import argparse
import difflib
import email.parser
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import sysconfig
import tarfile
import urllib.request
import zipfile


VERSION = "50.0.2+tli.1"
OPENSSL_VERSION = "4.0.3"
DEPLOYMENT_TARGET = "13.3"
WHEEL_NAME = f"cryptography-{VERSION}-cp39-abi3-macosx_13_0_x86_64.whl"
RUST_VERSION = "1.99.1"
SOURCES = {
    "cryptography-50.0.2.tar.gz": (
        "https://files.pythonhosted.org/packages/9d/af/182eb91b0df3fe75c4d9f26fe70684569566745f6ba7e5c9c73a862c5252/cryptography-50.0.2.tar.gz",
        "7b46165bb56eb4704e2eaaf86f3c940d19154535d9b0ca7d6d590b04060e00d5",
    ),
    "openssl-4.0.3.tar.gz": (
        "https://github.com/openssl/openssl/releases/download/openssl-4.0.3/openssl-4.0.3.tar.gz",
        "325b5c806167c13b40b1ffeadfe0248197c00eccc4cf123ec1e28d2d2fd216d9",
    ),
    "build-requirements.txt": (
        "https://raw.githubusercontent.com/pyca/cryptography/50.0.2/.github/requirements/build-requirements.txt",
        "e59c49ab7da61df7460f5e1fd5386b4e7a767e1f52d95d5a35b08e16c98664c2",
    ),
}
MAX_DOWNLOAD = 100 * 1024 * 1024
MAX_EXPANDED = 400 * 1024 * 1024


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


def exclusive_directory(path: Path) -> Path:
    path = path.absolute()
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink():
            raise ValueError("Output paths must not contain symbolic links")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.mkdir()  # Never reuse or overwrite an earlier build.
    return path


def download(url: str, expected: str, destination: Path) -> None:
    if not url.startswith("https://"):
        raise ValueError("HTTPS source required")
    count = 0
    checksum = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=60) as response, destination.open("xb") as output:
        if not response.url.startswith("https://"):
            raise ValueError("Source redirected away from HTTPS")
        while block := response.read(1024 * 1024):
            count += len(block)
            if count > MAX_DOWNLOAD:
                raise ValueError("Source exceeds download bound")
            checksum.update(block)
            output.write(block)
    if checksum.hexdigest() != expected:
        raise ValueError(f"Source SHA256 mismatch: {destination.name}")


def safe_name(name: str) -> PurePosixPath:
    value = PurePosixPath(name)
    if (not name or "\\" in name or "\x00" in name or ":" in name
            or value.is_absolute() or ".." in value.parts or not value.parts):
        raise ValueError("Unsafe archive member")
    return value


def extract_source(archive: Path, destination: Path, top: str) -> Path:
    """Validate the entire archive before creating any of its contents."""
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        total = 0
        seen = set()
        if len(members) > 30000:
            raise ValueError("Too many source members")
        for member in members:
            name = safe_name(member.name)
            if name.parts[0] != top or name.as_posix() in seen:
                raise ValueError("Unexpected or duplicate source member")
            seen.add(name.as_posix())
            if not (member.isdir() or member.isfile()):
                raise ValueError("Linked or special source member")
            total += member.size
            if total > MAX_EXPANDED:
                raise ValueError("Expanded source exceeds bound")
        destination.mkdir()
        # Do not use tar extraction permissions, ownership or links.
        for member in members:
            target = destination.joinpath(*safe_name(member.name).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as incoming, target.open("xb") as output:
                    shutil.copyfileobj(incoming, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    return destination / top


def patch_version(source: Path, artifact: Path) -> list[dict]:
    """Change only Python distribution/runtime version; never crypto source."""
    patches = []
    changes = []
    for relative, before in (
        ("pyproject.toml", 'version = "50.0.2"'),
        ("src/cryptography/__about__.py", '__version__ = "50.0.2"'),
    ):
        path = source / relative
        original = path.read_bytes()
        old = original.decode("utf-8")
        if old.count(before) != 1:
            raise ValueError("Upstream version declaration changed")
        new = old.replace(before, before.replace("50.0.2", VERSION), 1)
        encoded = new.encode("utf-8")
        patches.extend(difflib.unified_diff(old.splitlines(True), new.splitlines(True),
                                          fromfile=f"a/{relative}", tofile=f"b/{relative}"))
        changes.append({"path": relative, "before_sha256": hashlib.sha256(original).hexdigest(),
                        "after_sha256": hashlib.sha256(encoded).hexdigest()})
        path.write_bytes(encoded)
    (artifact / "version-only.patch").write_text("".join(patches), encoding="utf-8", newline="\n")
    return changes


def command(args: list[str], *, cwd: Path, env: dict, log: Path) -> str:
    with log.open("a", encoding="utf-8") as output:
        output.write("\n$ " + " ".join(args) + "\n")
        output.flush()
        completed = subprocess.run(args, cwd=cwd, env=env, stdout=output,
                                   stderr=subprocess.STDOUT, timeout=2400, check=False)
    if completed.returncode:
        raise RuntimeError(f"Command failed ({completed.returncode}); see {log.name}: {args[0]}")
    return ""


def inspect_macho(load_commands: str, dependencies: str, architecture: str) -> dict:
    if architecture.strip() != "x86_64":
        raise ValueError("Wheel must contain only x86_64 native code")
    versions = re.findall(r"^\s*(?:minos|version)\s+(\d+\.\d+(?:\.\d+)?)\s*$",
                          load_commands, re.MULTILINE)
    # 'version' occurs in LC_VERSION_MIN_MACOSX, 'minos' in LC_BUILD_VERSION.
    if not versions or any(tuple(map(int, value.split("."))) > (13, 3, 0)
                           for value in versions):
        raise ValueError("Missing or too-new Mach-O deployment target")
    linked = []
    for line in dependencies.splitlines()[1:]:
        dependency = line.strip().split(" (", 1)[0]
        if not dependency:
            continue
        if not dependency.startswith(("/usr/lib/", "/System/Library/")):
            raise ValueError("Non-system dylib dependency: " + dependency)
        linked.append(dependency)
    if not linked:
        raise ValueError("Missing Mach-O dependencies")
    return {"architecture": "x86_64", "minimum_macos": versions, "dependencies": linked}


def audit_wheel(wheel: Path, output: Path) -> dict:
    if wheel.name != WHEEL_NAME:
        raise ValueError("Unexpected wheel filename or ABI tag: " + wheel.name)
    output.mkdir()
    native = []
    with zipfile.ZipFile(wheel) as archive:
        infos = archive.infolist()
        names = set()
        total = 0
        for info in infos:
            name = safe_name(info.filename)
            mode = info.external_attr >> 16
            if name.as_posix() in names or stat.S_ISLNK(mode):
                raise ValueError("Linked or duplicate wheel entry")
            names.add(name.as_posix())
            total += info.file_size
            if total > MAX_EXPANDED:
                raise ValueError("Expanded wheel exceeds bound")
        prefix = f"cryptography-{VERSION}.dist-info/"
        metadata = email.parser.Parser().parsestr(archive.read(prefix + "METADATA").decode())
        wheel_metadata = email.parser.Parser().parsestr(archive.read(prefix + "WHEEL").decode())
        if metadata["Name"] != "cryptography" or metadata["Version"] != VERSION:
            raise ValueError("Unexpected wheel metadata")
        if wheel_metadata.get_all("Tag") != ["cp39-abi3-macosx_13_0_x86_64"]:
            raise ValueError("Unexpected wheel ABI tags")
        for info in infos:
            if info.filename.endswith((".so", ".dylib")):
                target = output.joinpath(*safe_name(info.filename).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(info))
                def read(*args):
                    return subprocess.check_output([*args, str(target)], text=True, timeout=60)
                detail = inspect_macho(read("otool", "-l"), read("otool", "-L"), read("lipo", "-archs"))
                native.append({"path": info.filename, "sha256": digest(target), **detail})
    if not native:
        raise ValueError("Wheel contains no audited native module")
    return {"filename": wheel.name, "sha256": digest(wheel), "size": wheel.stat().st_size,
            "version": VERSION, "abi": "cp39-abi3", "native_modules": native,
            "minimum_supported_tli_macos": DEPLOYMENT_TARGET,
            "homebrew_dylib_dependencies": False}


def smoke() -> dict:
    """Execute real primitives against the installed wheel, without TLI imports."""
    import cryptography
    from cryptography.exceptions import InvalidTag
    from cryptography.fernet import Fernet
    from cryptography.hazmat.backends.openssl.backend import backend
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    if cryptography.__version__ != VERSION:
        raise ValueError("Wrong installed cryptography version")
    openssl = backend.openssl_version_text()
    if not openssl.startswith(f"OpenSSL {OPENSSL_VERSION} "):
        raise ValueError("Wrong linked OpenSSL: " + openssl)
    # NIST empty-message AES-256-GCM known answer, and authenticated tamper rejection.
    cipher = AESGCM(bytes(32))
    ciphertext = cipher.encrypt(bytes(12), b"", None)
    if ciphertext.hex() != "530f8afbc74536b9a963b4f1c4cb738b":
        raise ValueError("AES-GCM known-answer failure")
    if cipher.decrypt(bytes(12), ciphertext, None) != b"":
        raise ValueError("AES-GCM roundtrip failure")
    try:
        cipher.decrypt(bytes(12), ciphertext[:-1] + bytes([ciphertext[-1] ^ 1]), None)
    except InvalidTag:
        pass
    else:
        raise ValueError("AES-GCM accepted altered authentication tag")
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=b"salt", iterations=1).derive(b"password")
    if key.hex() != "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b":
        raise ValueError("PBKDF2 known-answer failure")
    signing = Ed25519PrivateKey.generate()
    signing.public_key().verify(signing.sign(b"TLI native smoke"), b"TLI native smoke")
    fernet = Fernet(Fernet.generate_key())
    if fernet.decrypt(fernet.encrypt(b"TLI encrypted data")) != b"TLI encrypted data":
        raise ValueError("Fernet roundtrip failure")
    return {"cryptography": cryptography.__version__, "openssl": openssl,
            "python": platform.python_version(), "machine": platform.machine(),
            "macos": platform.mac_ver()[0], "tests": ["AES256-GCM KAT", "tamper rejection",
            "PBKDF2-SHA256 KAT", "Ed25519 signature", "Fernet roundtrip"]}


def build(output: Path) -> Path:
    if (sys.platform != "darwin" or platform.machine() != "x86_64"
            or sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 13)
            or sysconfig.get_config_var("Py_GIL_DISABLED")):
        raise ValueError("Build requires standard CPython 3.13 on native Intel macOS")
    root = exclusive_directory(output)
    artifact = root / "artifact"
    artifact.mkdir()
    sources = root / "sources"
    sources.mkdir()
    log = root / "build.log"
    env = os.environ.copy()
    env.update({"MACOSX_DEPLOYMENT_TARGET": DEPLOYMENT_TARGET, "ARCHFLAGS": "-arch x86_64",
                "OPENSSL_STATIC": "1", "CARGO_BUILD_TARGET": "x86_64-apple-darwin",
                "CARGO_TARGET_DIR": str(root / "cargo-target"), "CARGO_HOME": str(root / "cargo-home"),
                "PYO3_PYTHON": sys.executable, "RUSTUP_TOOLCHAIN": RUST_VERSION,
                "PYTHONNOUSERSITE": "1"})
    records = []
    for name, (url, checksum) in SOURCES.items():
        download(url, checksum, sources / name)
        records.append({"name": name, "url": url, "sha256": checksum})
    openssl = extract_source(sources / "openssl-4.0.3.tar.gz", root / "openssl-source", "openssl-4.0.3")
    crypto = extract_source(sources / "cryptography-50.0.2.tar.gz", root / "crypto-source", "cryptography-50.0.2")
    patches = patch_version(crypto, artifact)
    prefix = root / "openssl-static"
    env["OPENSSL_DIR"] = str(prefix)
    command([sys.executable, "-m", "pip", "install", "--require-hashes", "--only-binary=:all:",
             "-r", str(sources / "build-requirements.txt")], cwd=root, env=env, log=log)
    command(["perl", "Configure", "darwin64-x86_64-cc", "no-shared", "no-tests",
             "--prefix=" + str(prefix), "--openssldir=" + str(prefix / "ssl"),
             "-mmacosx-version-min=" + DEPLOYMENT_TARGET], cwd=openssl, env=env, log=log)
    command(["make", "-j", "3"], cwd=openssl, env=env, log=log)
    command(["make", "install_sw"], cwd=openssl, env=env, log=log)
    command([sys.executable, "-m", "maturin", "build", "--release", "--locked", "--features",
             "pyo3/abi3-py39", "--interpreter", sys.executable, "--out", str(artifact)],
            cwd=crypto, env=env, log=log)
    wheels = list(artifact.glob("*.whl"))
    if len(wheels) != 1:
        raise ValueError("Expected one wheel")
    wheel = wheels[0]
    report = audit_wheel(wheel, root / "wheel-audit")
    licenses = artifact / "LICENSES"
    licenses.mkdir()
    for path in sorted(crypto.glob("LICENSE*")):
        shutil.copyfile(path, licenses / ("cryptography-" + path.name))
    shutil.copyfile(openssl / "LICENSE.txt", licenses / "OpenSSL-4.0.3-LICENSE.txt")
    if (openssl / "NOTICE").is_file():
        shutil.copyfile(openssl / "NOTICE", licenses / "OpenSSL-4.0.3-NOTICE.txt")
    shutil.copyfile(crypto / "Cargo.lock", artifact / "Cargo.lock")
    shutil.copyfile(sources / "build-requirements.txt", artifact / "build-requirements.txt")
    write_json(artifact / "sources.json", {"sources": records, "version_only_changes": patches,
               "rust": RUST_VERSION, "deployment_target": DEPLOYMENT_TARGET,
               "source_commit": os.environ.get("GITHUB_SHA"),
               "acceptance_limit": "Native CI runs on macOS 15 Intel; Ventura 13.3+ device acceptance remains separate."})
    write_json(artifact / "wheel-verification.json", report)
    (artifact / "SHA256SUMS").write_text(f"{report['sha256']}  {wheel.name}\n", encoding="ascii")
    print(json.dumps(report, indent=2))
    return wheel


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    make = commands.add_parser("build")
    make.add_argument("--output", type=Path, required=True)
    check = commands.add_parser("smoke")
    check.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "build":
        build(args.output)
    else:
        write_json(args.output, smoke())


if __name__ == "__main__":
    main()
