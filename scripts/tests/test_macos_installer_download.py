"""Transport failures must never leave a usable partial installer download."""
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / "landing/install_mac.sh").read_text(encoding="utf-8")
PYTHON_SOURCE = SOURCE.split("<<'TLI_INSTALLER_PY'\n", 1)[1].split("\nTLI_INSTALLER_PY", 1)[0]
INSTALL = {"__name__": "tli_download_test"}
exec(compile(PYTHON_SOURCE, "install_mac.sh:embedded-python", "exec"), INSTALL)


class CurlProcess:
    def __init__(self, body=b"release bytes", status=0):
        self.stdout = io.BytesIO(body)
        self.status = status
        self.killed = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.stdout.close()

    def wait(self, timeout=None):
        return self.status

    def kill(self):
        self.killed = True


class MacInstallerDownloadTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="tli-download-test-")
        self.addCleanup(temporary.cleanup)
        self.destination = Path(temporary.name) / "release.zip"

    def download(self, limit=100, url="https://example.com/release.zip"):
        INSTALL["download"](url, self.destination, limit)

    def test_success_uses_system_tls_and_https_only_redirects_without_reading_stdin(self):
        with patch.object(subprocess, "Popen", return_value=CurlProcess()) as launch:
            self.download()
        self.assertEqual(self.destination.read_bytes(), b"release bytes")
        command = launch.call_args.args[0]
        self.assertEqual(command[0], "/usr/bin/curl")
        self.assertEqual(command[1], "--disable", "Ignore local curlrc options, including insecure/output overrides")
        for flag in ("--proto", "--proto-redir"):
            self.assertEqual(command[command.index(flag) + 1], "=https")
        self.assertIn("--fail", command)
        self.assertIn("--location", command)
        self.assertNotIn("--insecure", command)
        self.assertNotIn("-k", command)
        self.assertEqual(command[-2:], ["--", "https://example.com/release.zip"])
        self.assertEqual(launch.call_args.kwargs["stdin"], subprocess.DEVNULL)

    def test_plain_http_never_starts_a_process_or_creates_a_file(self):
        with patch.object(subprocess, "Popen") as launch:
            with self.assertRaisesRegex(ValueError, "HTTPS"):
                self.download(url="http://example.com/release.zip")
        launch.assert_not_called()
        self.assertFalse(self.destination.exists())

    def test_http_tls_and_redirect_failures_remove_partial_file_and_keep_diagnostic(self):
        for code, diagnostic in ((22, b"curl: (22) HTTP 404"),
                                 (60, b"curl: (60) certificate verify failed"),
                                 (1, b'curl: (1) Protocol "http" disabled')):
            with self.subTest(code=code):
                def launch(*args, **kwargs):
                    kwargs["stderr"].write(diagnostic)
                    return CurlProcess(body=b"partial", status=code)
                with patch.object(subprocess, "Popen", side_effect=launch):
                    with self.assertRaisesRegex(RuntimeError, "secure download failed") as error:
                        self.download()
                self.assertIn(diagnostic.decode(), str(error.exception))
                self.assertFalse(self.destination.exists())

    def test_size_limit_stops_transfer_and_removes_partial_file(self):
        process = CurlProcess(body=b"x" * (1024 * 1024 + 1))
        with patch.object(subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(ValueError, "size limit"):
                self.download(limit=1024 * 1024)
        self.assertTrue(process.killed)
        self.assertFalse(self.destination.exists())

    def test_existing_destination_is_never_replaced(self):
        self.destination.write_bytes(b"preserve this")
        with patch.object(subprocess, "Popen") as launch:
            with self.assertRaises(FileExistsError):
                self.download()
        launch.assert_not_called()
        self.assertEqual(self.destination.read_bytes(), b"preserve this")

    def test_missing_curl_removes_new_empty_file(self):
        with patch.object(subprocess, "Popen", side_effect=FileNotFoundError("curl missing")):
            with self.assertRaises(FileNotFoundError):
                self.download()
        self.assertFalse(self.destination.exists())

    def test_interruption_terminates_transfer_and_removes_partial_file(self):
        process = CurlProcess()
        with patch.object(process.stdout, "read", side_effect=KeyboardInterrupt), \
                patch.object(subprocess, "Popen", return_value=process):
            with self.assertRaises(KeyboardInterrupt):
                self.download()
        self.assertTrue(process.killed)
        self.assertFalse(self.destination.exists())


if __name__ == "__main__":
    unittest.main()
