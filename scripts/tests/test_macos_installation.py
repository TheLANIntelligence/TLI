"""Synthetic macOS installer archives and source-launcher control flow."""
import hashlib
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[2]
INSTALLER = (ROOT / "landing/install_mac.sh").read_text(encoding="utf-8")
PYTHON_SOURCE = INSTALLER.split("<<'TLI_INSTALLER_PY'\n", 1)[1].split("\nTLI_INSTALLER_PY", 1)[0]
INSTALL = {"__name__": "tli_installer_test"}
exec(compile(PYTHON_SOURCE, "install_mac.sh:embedded-python", "exec"), INSTALL)
BASH = (str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe")
        if os.name == "nt" else shutil.which("bash"))
VERSION = "1.4.0-beta"


class MacInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tli-install-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.applications = self.root / "Applications"

    def archive(self, extra=None, prefix=""):
        path = self.root / "release.zip"
        with zipfile.ZipFile(path, "w") as archive:
            for name in sorted(INSTALL["REQUIRED"]):
                archive.writestr(prefix + name, "synthetic source\n")
            for name, body in (extra or {}).items():
                archive.writestr(name, body)
        # Windows ZipInfo normalizes backslashes when writing; restore the raw
        # name in both ZIP headers to exercise an actual hostile archive name.
        raw = path.read_bytes()
        for name in (extra or {}):
            if isinstance(name, str) and "\\" in name:
                raw = raw.replace(name.replace("\\", "/").encode(), name.encode())
        path.write_bytes(raw)
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def install(self, path, digest):
        return INSTALL["install_archive"](path, digest, VERSION, self.applications)

    def test_verified_fresh_install_preserves_old_folder_and_supports_spaces(self):
        old = self.root / "TLI/data/notes.json"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"private synthetic note")
        self.applications = self.root / "Applications With Spaces"
        archive, digest = self.archive()
        target = self.install(archive, digest)
        self.assertEqual(target, self.applications / ("TLI-" + VERSION))
        self.assertTrue((target / "backend/main.py").is_file())
        self.assertEqual(old.read_bytes(), b"private synthetic note")
        if os.name != "nt":
            self.assertTrue((target / "TLI_Start.command").stat().st_mode & stat.S_IXUSR)

    def test_existing_version_is_never_merged_or_removed(self):
        target = self.applications / ("TLI-" + VERSION)
        private = target / "data/notes.json"
        private.parent.mkdir(parents=True)
        private.write_bytes(b"keep exactly")
        archive, digest = self.archive()
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.install(archive, digest)
        self.assertEqual(private.read_bytes(), b"keep exactly")
        self.assertFalse((target / "backend").exists())

    def test_checksum_failure_writes_no_installation(self):
        archive, _ = self.archive()
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.install(archive, "0" * 64)
        self.assertFalse(self.applications.exists())

    def test_unsafe_archive_entries_are_rejected_before_install(self):
        for name in ("../escape.txt", "/absolute.txt", "C:/drive.txt", "backend\\escape.txt",
                     "data/private.json", "frontend/INDEX.HTML"):
            with self.subTest(name=name):
                archive, digest = self.archive({name: "synthetic"})
                with self.assertRaises(ValueError):
                    self.install(archive, digest)
                self.assertFalse(self.applications.exists())
        link = zipfile.ZipInfo("backend/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive, digest = self.archive({link: "../../outside"})
        with self.assertRaisesRegex(ValueError, "unsafe"):
            self.install(archive, digest)

    def test_optional_enclosing_folder_and_runtime_permissions(self):
        runtime = zipfile.ZipInfo("TLI/backend/ai/runtime/macos-arm64/llama-server")
        runtime.create_system = 3
        runtime.external_attr = (stat.S_IFREG | 0o6755) << 16
        archive, digest = self.archive({runtime: "synthetic executable"}, prefix="TLI/")
        target = self.install(archive, digest)
        installed = target / "backend/ai/runtime/macos-arm64/llama-server"
        self.assertTrue(installed.is_file())
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(installed.stat().st_mode), 0o755)

    def test_manifest_requires_exact_official_asset_and_sha256(self):
        filename = "TLI_" + VERSION + "_macOS.zip"
        asset = {"url": "https://github.com/TheLANIntelligence/TLI/releases/download/v" + VERSION + "/" + filename,
                 "filename": filename, "sha256": "a" * 64}
        manifest = {"version": VERSION, "platforms": {"macos": asset}}
        self.assertEqual(INSTALL["validate_manifest"](manifest), (VERSION, asset["url"], "a" * 64))
        for key, value in (("url", "http://example.com/download.zip"), ("sha256", ""), ("filename", "other.zip")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                INSTALL["validate_manifest"]({"version": VERSION, "platforms": {"macos": {**asset, key: value}}})


@unittest.skipUnless(BASH and Path(BASH).is_file(), "Bash is required for launcher checks")
class SourceLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tli-launch-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "Installation With Spaces"
        self.root.mkdir()
        (self.root / "backend").mkdir()
        for name in ("TLI_Start.sh", "TLI_Start.command"):
            shutil.copyfile(ROOT / name, self.root / name)
        for name in ("main.py", "host_launcher.py", "launch_checks.py", "requirements.txt"):
            (self.root / "backend" / name).write_text("synthetic fixture", encoding="utf-8")
        self.bin = self.root / "fake-bin"
        self.bin.mkdir()
        self.python = self.bin / "python3"
        self.python.write_text('''#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$TEST_LOG"
if [ "$1" = "-c" ]; then exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
    mkdir -p "$3/bin"; cp "$0" "$3/bin/python"; chmod +x "$3/bin/python"; exit 0
fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
    [ "${TEST_PIP_FAIL:-0}" = "0" ] || exit 2
    touch "$TEST_READY"; exit 0
fi
case "$1" in
    */host_launcher.py) [ -f "$TEST_READY" ]; exit $? ;;
    */launch_checks.py) exit "${TEST_PORT_FAIL:-0}" ;;
    */main.py) printf '%s\\n' "$TLI_OPEN_BROWSER" > "$TEST_STARTED"; exit 0 ;;
esac
exit 9
''', encoding="utf-8", newline="\n")
        self.python.chmod(0o755)
        shell_bin = self.bin.as_posix()
        if os.name == "nt":
            shell_bin = "/" + shell_bin[0].lower() + shell_bin[2:]
        self.env = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ.get("PATH", ""), "TEST_BIN": shell_bin,
                    "TEST_LOG": (self.root / "calls.txt").as_posix(), "TEST_READY": (self.root / "ready").as_posix(),
                    "TEST_STARTED": (self.root / "started").as_posix(), "TLI_ROOT": "unrelated-installation"}

    def launch(self, *arguments, wrapper=False):
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        # Git Bash prepends its own /usr/bin during startup. Put the synthetic
        # commands first inside the shell as well, so uname is fake on Windows.
        return subprocess.run([BASH, "-c", 'export PATH="$TEST_BIN:$PATH"; exec bash "$@"', "test-launcher",
                               "TLI_Start.command" if wrapper else "TLI_Start.sh", *arguments],
                              cwd=self.root, env=self.env, capture_output=True, text=True, timeout=30, **options)

    def test_setup_only_then_offline_ready_launch(self):
        result = self.launch("--setup-only", wrapper=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / "started").exists())
        calls = (self.root / "calls.txt").read_text()
        self.assertEqual(calls.count("-m pip "), 1)
        result = self.launch("--no-browser")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "started").read_text().strip(), "0")
        self.assertEqual((self.root / "calls.txt").read_text().count("-m pip "), 1)

    def test_dependency_failure_and_busy_port_never_start_backend(self):
        self.env["TEST_PIP_FAIL"] = "1"
        self.assertNotEqual(self.launch().returncode, 0)
        self.assertFalse((self.root / "started").exists())
        self.env["TEST_PIP_FAIL"] = "0"
        self.env["TEST_PORT_FAIL"] = "1"
        self.assertNotEqual(self.launch().returncode, 0)
        self.assertFalse((self.root / "started").exists())

    def test_incomplete_existing_environment_is_preserved(self):
        private = self.root / "backend/.venv/keep.txt"
        private.parent.mkdir()
        private.write_bytes(b"do not remove")
        result = self.launch()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("incomplete or belongs to another platform", result.stderr)
        self.assertEqual(private.read_bytes(), b"do not remove")
        self.assertFalse((self.root / "started").exists())

    def test_unsupported_macos_is_stopped_before_environment_setup(self):
        (self.bin / "uname").write_text('#!/usr/bin/env bash\nif [ "$1" = "-s" ]; then echo Darwin; else echo "$TEST_ARCH"; fi\n', encoding="utf-8", newline="\n")
        (self.bin / "sw_vers").write_text('#!/usr/bin/env bash\necho "$TEST_MAC_VERSION"\n', encoding="utf-8", newline="\n")
        (self.bin / "uname").chmod(0o755)
        (self.bin / "sw_vers").chmod(0o755)
        for architecture, version in (("arm64", "13.9"), ("x86_64", "13.2")):
            with self.subTest(architecture=architecture, version=version):
                self.env.update(TEST_ARCH=architecture, TEST_MAC_VERSION=version)
                result = self.launch("--setup-only")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("requires macOS", result.stderr)
                self.assertFalse((self.root / "backend/.venv").exists())
        self.env.update(TEST_ARCH="arm64", TEST_MAC_VERSION="14.0")
        self.assertEqual(self.launch("--setup-only").returncode, 0)
        self.env.update(TEST_ARCH="x86_64", TEST_MAC_VERSION="13.3")
        self.assertEqual(self.launch("--setup-only").returncode, 0)


if __name__ == "__main__":
    unittest.main()
