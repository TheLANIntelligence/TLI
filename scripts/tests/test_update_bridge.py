"""One-time bridge compatibility without starting TLI or reading runtime data."""
import ast
import importlib.util
import json
from pathlib import Path
import stat
import zipfile

import pytest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("bridge", ROOT / "scripts/prepare_update_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def test_pinned_published_validator_accepts_only_explicit_bridge_overlay():
    policy = bridge.published_policy(ROOT)
    assert all(policy.is_application_path(name) for name in bridge.OVERLAY)
    # These are legitimate new full-release files that require the bridge first.
    for name in ("backend/requirements-sonos.txt", "backend/requirements-voice.txt",
                 "backend/requirements-bluetooth.txt", "docs/TLI_TASK_AGENT.md",
                 "docs/TLI_SONOS.md", "docs/TLI_HOST_VOICE.md", "docs/TLI_BLUETOOTH.md"):
        assert not policy.is_application_path(name)


def test_splicing_keeps_old_product_and_adds_only_update_section_dialog_and_assets():
    old = ('<html><head><title>old</title></head><body><main id="old-feature">keep</main>'
           '<div id="settings-section-updates"><div><p>old update</p></div></div>'
           '<dialog id="tli-host-lifecycle-dialog">old quit</dialog>'
           '<script src="/js/tli-update.js?v=old"></script></body></html>')
    latest = ('<div id="unrelated-new-feature">never copy</div>'
              '<div id="settings-section-updates"><details><summary>new</summary></details></div>'
              '<dialog id="tli-update-install-dialog"><button id="confirm">install</button></dialog>')
    patched = bridge.patch_index(old, latest, b"new js", b"new css")
    assert '<main id="old-feature">keep</main>' in patched
    assert "unrelated-new-feature" not in patched
    assert "old quit" in patched and "old update" not in patched
    assert patched.count('id="tli-update-install-dialog"') == 1
    assert "tli-update.js?v=" + bridge.digest(b"new js")[:12] in patched
    assert "update-workspace.css?v=" + bridge.digest(b"new css")[:12] in patched


def test_html_splice_rejects_duplicate_and_missing_required_blocks():
    with pytest.raises(bridge.BridgeError, match="Duplicate"):
        bridge.element('<div id="x"></div><div id="x"></div>', "x")
    with pytest.raises(bridge.BridgeError, match="missing"):
        bridge.element('<div id="x"></div>', "absent")


def test_narrow_state_patch_preserves_unrelated_code_and_rotates_epoch():
    old = '''from typing import Dict, Any
TLI_VERSION = "1.4.5-beta"
UNRELATED = "keep"
_active_sessions: Dict[str, Dict[str, Any]] = {}
def revoke_all_sessions() -> None:
    _active_sessions.clear()
'''
    result = bridge.patch_state(old)
    assert 'UNRELATED = "keep"' in result
    namespace = {}
    exec(compile(ast.parse(result), "synthetic-state", "exec"), namespace)
    assert namespace["TLI_VERSION"] == "1.4.6-beta"
    original = namespace["session_revocation_epoch"]()
    namespace["_active_sessions"]["synthetic"] = {}
    namespace["revoke_all_sessions"]()
    assert namespace["session_revocation_epoch"]() is not original
    assert not namespace["_active_sessions"]
    with pytest.raises(bridge.BridgeError):
        bridge.patch_state(result)


def archive(path, platform, *, extra=None, corrupt=False):
    paths = {"backend/main.py", "backend/tli_state.py", "backend/requirements.txt",
             "backend/update_install.py", "frontend/index.html", *bridge.OVERLAY}
    paths.update({"TLI_Update.bat", "TLI_Update.ps1"} if platform == "windows"
                 else {"TLI_Update.command", "TLI_Update.sh"})
    if extra:
        paths.add(extra)
    inventory = []
    with zipfile.ZipFile(path, "w") as output:
        for name in sorted(paths):
            data = b"synthetic source only\n"
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            output.writestr(info, data)
            inventory.append({"path": name, "size": len(data), "sha256": "0" * 64 if corrupt else bridge.digest(data), "mode": 0o644})
        output.writestr("TLI_RELEASE.json", json.dumps({"schema_version": 1,
            "version": bridge.BRIDGE_VERSION, "platform": platform, "files": inventory}))


@pytest.mark.parametrize("platform", ["windows", "macos"])
def test_real_published_validator_accepts_complete_synthetic_bridge_and_rejects_drift(tmp_path, platform):
    path = tmp_path / "bridge.zip"
    archive(path, platform)
    assert bridge.verify_archive(ROOT, path, platform)["published_1_4_5_validation"] == "passed"
    archive(path, platform, extra="backend/requirements-bluetooth.txt")
    with pytest.raises(ValueError, match="non-application"):
        bridge.verify_archive(ROOT, path, platform)
    archive(path, platform, corrupt=True)
    with pytest.raises(ValueError):
        bridge.verify_archive(ROOT, path, platform)


def test_tampered_historical_policy_is_not_executed(tmp_path):
    path = tmp_path / "scripts/fixtures/update_install_1_4_5.py"
    path.parent.mkdir(parents=True)
    path.write_text("raise AssertionError('must not execute')")
    with pytest.raises(bridge.BridgeError, match="validator fixture changed"):
        bridge.published_policy(tmp_path)
