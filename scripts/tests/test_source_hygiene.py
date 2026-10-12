"""The source publication guard uses only names from disposable Git indexes."""
import contextlib
import importlib.util
import io
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "source_hygiene", Path(__file__).resolve().parents[1] / "check_source_hygiene.py")
hygiene = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hygiene)


class SourceHygieneTests(unittest.TestCase):
    def test_public_source_and_synthetic_fixtures_are_allowed(self):
        for path in (
            "README.md", "LICENSE", ".github/workflows/source.yml",
            "backend/ai/runtime/README.md", "backend/ai/model_catalog.py",
            "backend/tests/fixtures/devices.json", "frontend/tests/fixtures/conversations.json",
            "scripts/fixtures/tli_answer_extensions.json", "mobile/tests/fixtures/startup.json",
            "frontend/assets/model-comparison.json", "frontend/assets/fonts/inter.woff2",
            "mobile/package-lock.json", "mobile/modules/tli-transport/android/build.gradle",
            "mobile/modules/tli-transport/android/src/main/AndroidManifest.xml",
            "mobile/modules/tli-transport/android/src/main/java/example/Transport.kt",
            "mobile/modules/tli-transport/ios/Transport.swift", "desktop/TliLauncher.cs",
            ".env.example", "mobile/.env.sample", "backend/.env.template",
            ".dev.vars.example", "website/download-verification.mjs",
        ):
            with self.subTest(path=path):
                self.assertIsNone(hygiene.forbidden_reason(path))

    def test_private_state_dependencies_caches_and_binaries_are_rejected(self):
        for path in (
            "TLI_Installer/node_modules/dependency/index.js", "data/conversations.json",
            "backend/data/notes.json", "backend/ai/memory/session/private.json",
            "backend/memory/saved.json", "backend/ai/active_model.json", "backend/devices.json",
            "backend/routers/printers_snmp.json", "backend/tli_model_config.json",
            "backend/vault_meta.json", "node_identity.json", "mobile/credentials.json",
            "backend/.venv/Scripts/python.exe", "backend/__pycache__/main.pyc",
            ".wrangler/state/store.json", "mobile/.expo/state.json", "mobile/.gradle/cache",
            ".codex/settings.json", ".claude/settings.local.json", ".aws/credentials", "build_work/report.json",
            "dist_build/package.txt", "artifacts/report.json", "TLI_Installer/bundle/frontend/index.html",
            ".env", "mobile/.env.production", "mobile/.env.example.local", "keys/server.pem",
            ".dev.vars", ".dev.vars.production", "website/.dev.vars.preview",
            "signing/release.keystore", "certificates/server.crt", "certificates/server.der",
            "signing/apple.p8", "keys/id_ed25519",
            "TLI.exe", "backend/ai/runtime/llama-server", "backend/ai/runtime/extra/README.md",
            "lib/libggml.so.0.9", "runtime/ggml.dll", "models/model.gguf", "model.safetensors",
            "package.tar.gz", "release.apk", "desktop/setup.msi", "logs/request.log",
            "backend\\DATA\\notes.json", "NODE_MODULES/dependency/package.json",
        ):
            with self.subTest(path=path):
                self.assertIsNotNone(hygiene.forbidden_reason(path))

    @unittest.skipUnless(shutil.which("git"), "Git is required for index integration")
    def test_index_additions_removals_and_untracked_data(self):
        with tempfile.TemporaryDirectory(prefix="tli-hygiene-") as directory:
            root = Path(directory)
            options = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}

            def git(*arguments):
                subprocess.run(["git", *arguments], cwd=root, check=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options)

            git("init", "-q")
            (root / "README.md").write_text("public fixture", encoding="utf-8")
            (root / "data").mkdir()
            (root / "data" / "private.json").write_text("DO-NOT-PRINT-THIS-CONTENT", encoding="utf-8")
            git("add", "README.md")
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(hygiene.main(["--repo", directory]), 0)
            self.assertNotIn("private.json", output.getvalue())
            git("add", "data/private.json")
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(hygiene.main(["--repo", directory]), 1)
            self.assertIn('"data/private.json": runtime data', output.getvalue())
            self.assertNotIn("DO-NOT-PRINT-THIS-CONTENT", output.getvalue())
            git("rm", "--cached", "data/private.json")
            self.assertTrue((root / "data" / "private.json").exists())
            self.assertEqual(hygiene.tracked_paths(root), ["README.md"])

    def test_nul_paths_and_windows_hidden_process(self):
        result = subprocess.CompletedProcess([], 0, stdout=b"README.md\0data/odd\nname.json\0", stderr=b"")
        with mock.patch.object(hygiene.sys, "platform", "win32"), \
             mock.patch.object(hygiene.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True), \
             mock.patch.object(hygiene.subprocess, "run", return_value=result) as run:
            self.assertEqual(hygiene.tracked_paths(Path(".")), ["README.md", "data/odd\nname.json"])
        self.assertEqual(run.call_args.kwargs["creationflags"], 0x08000000)
        self.assertIn("-z", run.call_args.args[0])
        with mock.patch.object(hygiene, "tracked_paths", return_value=["data/odd\nname.json"]), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(hygiene.main([]), 1)
        self.assertEqual(len(output.getvalue().splitlines()), 2)
        self.assertIn('"data/odd\\nname.json"', output.getvalue())

    def test_git_failure_does_not_print_captured_details(self):
        failure = subprocess.CalledProcessError(128, ["git"], stderr=b"PRIVATE-ERROR-DETAILS")
        with mock.patch.object(hygiene, "tracked_paths", side_effect=failure), \
             contextlib.redirect_stderr(io.StringIO()) as output:
            self.assertEqual(hygiene.main([]), 2)
        self.assertNotIn("PRIVATE-ERROR-DETAILS", output.getvalue())


if __name__ == "__main__":
    unittest.main()
