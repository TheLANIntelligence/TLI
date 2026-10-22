"""Offline policy checks; native compilation/ABI acceptance belongs to macOS CI."""
import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from scripts import build_macos_intel_dependency as B


class IntelDependencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # macOS exposes its temporary directory through the system /var symlink.
        # Use its owned canonical path without relaxing output-link rejection.
        self.root = Path(self.tmp.name).resolve()

    def archive(self, entries):
        path = self.root / "source.tar.gz"
        with tarfile.open(path, "w:gz") as archive:
            for name, kind in entries:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.size = 3 if kind == tarfile.REGTYPE else 0
                member.linkname = "../../private" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""
                archive.addfile(member, io.BytesIO(b"abc") if member.size else None)
        return path

    def test_pins_are_fixed_https_sources(self):
        self.assertEqual(B.VERSION, "50.0.2+tli.1")
        self.assertEqual(B.OPENSSL_VERSION, "4.0.3")
        for url, sha in B.SOURCES.values():
            self.assertTrue(url.startswith("https://"))
            self.assertRegex(sha, r"^[0-9a-f]{64}$")

    def test_app_requirements_keep_every_other_dependency_and_marker(self):
        kept = '# cryptography comment\nhttpx>=0.28,<0.29\ncryptography-example==1\nuvicorn[standard]>=0.29 ; sys_platform == "darwin"\n'
        removed = ('cryptography @ https://example.invalid/exact.whl#sha256=abc ; sys_platform == "darwin"\n'
                   'cryptography>=50.0.2 ; \\\n    sys_platform != "darwin"\n')
        source = self.root / "requirements.txt"
        source.write_text(kept + removed, encoding="utf-8", newline="")
        original = source.read_bytes()
        output = self.root / "app.txt"
        B.application_requirements(source, output)
        self.assertEqual(output.read_text(), kept)
        self.assertEqual(source.read_bytes(), original)
        with self.assertRaises(FileExistsError):
            B.application_requirements(source, output)

    def test_app_requirements_refuse_missing_crypto_or_incomplete_block(self):
        source = self.root / "requirements.txt"
        for text in ["httpx>=0.28\n", "cryptography @ \\\n"]:
            with self.subTest(text=text):
                source.write_text(text)
                with self.assertRaises(ValueError):
                    B.application_requirements(source, self.root / "app.txt")
                self.assertFalse((self.root / "app.txt").exists())

    def test_valid_archive_is_extracted_without_parent_escape(self):
        archive = self.archive([("source/file.py", tarfile.REGTYPE)])
        result = B.extract_source(archive, self.root / "out", "source")
        self.assertEqual((result / "file.py").read_bytes(), b"abc")

    def test_entire_source_validated_before_extraction(self):
        for name, kind in [("../escape", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
                           ("source/link", tarfile.SYMTYPE), ("source/link", tarfile.LNKTYPE),
                           ("source/fifo", tarfile.FIFOTYPE), ("other/file", tarfile.REGTYPE),
                           ("source/file", tarfile.REGTYPE)]:
            with self.subTest(name=name, kind=kind):
                archive = self.archive([("source/file", tarfile.REGTYPE), (name, kind)])
                with self.assertRaises(ValueError):
                    B.extract_source(archive, self.root / "out", "source")
                self.assertFalse((self.root / "out").exists())

    def test_version_patch_changes_exactly_two_declarations(self):
        source = self.root / "source"
        (source / "src/cryptography").mkdir(parents=True)
        (source / "pyproject.toml").write_text('[project]\nversion = "50.0.2"\n')
        (source / "src/cryptography/__about__.py").write_text('__version__ = "50.0.2"\n')
        canary = source / "src/cryptography/crypto.py"
        canary.write_bytes(b"unchanged implementation")
        artifact = self.root / "artifact"
        artifact.mkdir()
        result = B.patch_version(source, artifact)
        self.assertEqual(len(result), 2)
        self.assertEqual(canary.read_bytes(), b"unchanged implementation")
        self.assertIn('+version = "50.0.2+tli.1"', (artifact / "version-only.patch").read_text())
        self.assertEqual(result[0]["after_sha256"], B.digest(source / "pyproject.toml"))

    def test_source_version_mismatch_fails(self):
        source = self.root / "source"
        source.mkdir()
        (source / "pyproject.toml").write_text('version = "51.0.0"\n')
        with self.assertRaisesRegex(ValueError, "declaration"):
            B.patch_version(source, self.root)

    def test_macho_requires_intel_ventura_and_only_system_dependencies(self):
        load = "Load command 9\n cmd LC_BUILD_VERSION\n platform 1\n minos 13.3\n sdk 15.0\n ntools 1\n tool 3\n version 1115.7.3\n"
        deps = "module.so:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n"
        report = B.inspect_macho(load, deps, "x86_64\n")
        self.assertEqual(report["minimum_macos"], ["13.3"])
        old = "Load command 9\n cmd LC_VERSION_MIN_MACOSX\n version 13.0\n sdk 15.0\n"
        self.assertEqual(B.inspect_macho(old, deps, "x86_64")["minimum_macos"], ["13.0"])
        for wrong_load, wrong_deps, arch in [(load.replace("13.3", "14.0"), deps, "x86_64"),
                                             (load.replace("platform 1", "platform 2"), deps, "x86_64"),
                                             ("", deps, "x86_64"), (load, deps, "arm64"),
                                             (load, deps, "x86_64 arm64"),
                                             (load, deps.replace("/usr/lib/", "/opt/homebrew/lib/"), "x86_64"),
                                             (load, deps.replace("/usr/lib/", "@rpath/"), "x86_64")]:
            with self.subTest(load=wrong_load, deps=wrong_deps, arch=arch):
                with self.assertRaises(ValueError):
                    B.inspect_macho(wrong_load, wrong_deps, arch)

    def test_download_rejects_wrong_digest(self):
        response = io.BytesIO(b"untrusted source")
        response.url = "https://example.invalid/source"
        with patch.object(B.urllib.request, "urlopen", return_value=response):
            with self.assertRaisesRegex(ValueError, "SHA256"):
                B.download(response.url, "0" * 64, self.root / "download")

    def test_macho_own_install_name_is_not_an_external_dependency(self):
        load = ("Load command 3\n cmd LC_ID_DYLIB\n name @rpath/_rust.abi3.so (offset 24)\n"
                "Load command 9\n cmd LC_BUILD_VERSION\n platform 1\n minos 13.3\n")
        deps = ("module.so:\n @rpath/_rust.abi3.so (compatibility version 0.0.0)\n"
                " /usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n")
        report = B.inspect_macho(load, deps, "x86_64")
        self.assertEqual(report["install_name"], "@rpath/_rust.abi3.so")
        self.assertEqual(report["dependencies"], ["/usr/lib/libSystem.B.dylib"])
        with self.assertRaisesRegex(ValueError, "Non-system dylib"):
            B.inspect_macho(load, deps + " @rpath/libcrypto.dylib (compatibility version 1.0.0)\n", "x86_64")

    def test_output_is_exclusive(self):
        output = B.exclusive_directory(self.root / "build")
        (output / "canary").write_bytes(b"keep")
        with self.assertRaises(FileExistsError):
            B.exclusive_directory(output)
        self.assertEqual((output / "canary").read_bytes(), b"keep")

    def test_build_refuses_non_native_host_before_creating_output(self):
        with patch.object(B.sys, "platform", "win32"):
            with self.assertRaisesRegex(ValueError, "native Intel macOS"):
                B.build(self.root / "out")
        self.assertFalse((self.root / "out").exists())


if __name__ == "__main__":
    unittest.main()
