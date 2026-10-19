"""Assemble the one-time 1.4.5 -> 1.4.6 updater bridge from reviewed source.

Only an explicit overlay is copied. The published main app changes only its
version; narrow authority fixes retain old service interfaces, and requirements
and unrelated UI remain at the 1.4.5 baseline. Assembly never reads runtime state or
prepared binaries. The exact published updater validates source inventory and
final ZIP contents without executing any packaged code.
"""
from __future__ import annotations

import argparse
import hashlib
from html.parser import HTMLParser
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import zipfile


BASE_COMMIT = "b5e60445159127b2dd4098f8b8650fe59b5c484a"
BRIDGE_VERSION = "1.4.6-beta"
POLICY_SHA256 = "9df0690350f70491911d28610131fc13b71ca57aaa5d8f764901afad981dc25b"
# The fixture also matches backend/update_install.py in both published ZIPs.
PUBLISHED_ARCHIVES = {
    "windows": "f24d8fc4ba2f6efb1bb5a7b0b7149e8e77d718e57a8655e5d95da52a20ba68c8",
    "macos": "f89a529ee05e1c7233249e3f45304311f1531d257bd0a625e6c23c6894310209",
}
OVERLAY = (
    "backend/auto_update.py", "backend/update_install.py", "backend/update_handoff.py",
    "backend/host_lifecycle.py", "backend/host_launcher.py",
    "backend/browser_authority.py", "backend/private_client_authority.py", "backend/companion_auth.py",
    "backend/mcp_bridge.py", "backend/peer_pairing.py",
    "backend/routers/update_routes.py", "backend/routers/host_control_routes.py",
    "frontend/js/tli-update.js", "frontend/update-workspace.css",
    "TLI_Start.sh", "docs/TLI_UPDATES.md",
)
VERIFICATION_FILES = (
    "scripts/prepare_update_bridge.py", "scripts/fixtures/update_install_1_4_5.py",
    "scripts/tests/test_update_bridge.py",
    "scripts/tests/test_macos_installation.py",
    ".github/workflows/desktop-packages.yml",
    "backend/tests/conftest.py",
    "backend/tests/test_update_tls.py", "backend/tests/test_update_preparation.py",
    "backend/tests/test_automatic_update_checks.py", "backend/tests/test_update_settings.py",
    "backend/tests/test_update_install.py", "backend/tests/test_update_handoff.py",
    "backend/tests/test_host_lifecycle.py", "backend/tests/test_host_lifecycle_routes.py",
    "backend/tests/test_host_launcher.py", "frontend/tests/update-workflow.test.cjs",
    "backend/tests/test_browser_authority.py", "backend/tests/test_private_client_authority.py",
    "backend/tests/test_mcp_bridge.py", "backend/tests/test_pairing_direct_host.py",
    "docs/RELEASE_1.4.6_BETA.md",
)
VOID = frozenset("area base br col embed hr img input link meta param source track wbr".split())


class BridgeError(ValueError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def _read(path):
    path = Path(path).absolute()
    for part in [path, *path.parents]:
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise BridgeError(f"Linked source or destination is unsupported: {part}")
    return path.read_bytes()


def _git(repo, *args):
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    result = subprocess.run(["git", "-C", str(repo), *args], check=True,
                            capture_output=True, **kwargs)
    return result.stdout


def _module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def published_policy(source):
    path = Path(source) / "scripts/fixtures/update_install_1_4_5.py"
    # Git may check text out as CRLF; the pinned blob uses canonical LF.
    if digest(_read(path).replace(b"\r\n", b"\n")) != POLICY_SHA256:
        raise BridgeError("The published 1.4.5 validator fixture changed.")
    return _module(path, "tli_published_1_4_5_update_policy")


class _ElementSpans(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=False)
        self.html, self.stack, self.spans = html, [], {}
        self.offsets = [0]
        for line in html.splitlines(keepends=True):
            self.offsets.append(self.offsets[-1] + len(line))
        self.feed(html)

    def position(self):
        line, column = self.getpos()
        return self.offsets[line - 1] + column

    def handle_starttag(self, tag, attrs):
        identity = dict(attrs).get("id")
        if identity and (identity in self.spans or any(row[1] == identity for row in self.stack)):
            raise BridgeError(f"Duplicate HTML id: {identity}")
        if tag not in VOID:
            self.stack.append((tag, identity, self.position()))

    def handle_endtag(self, tag):
        # HTML permits implicit closing of some elements; target blocks must
        # nevertheless have an explicit, properly nested matching end tag.
        index = next((i for i in range(len(self.stack) - 1, -1, -1) if self.stack[i][0] == tag), None)
        if index is None:
            return
        _, identity, start = self.stack[index]
        if identity:
            end = self.html.find(">", self.position())
            if end < 0:
                raise BridgeError("Unclosed HTML element")
            self.spans[identity] = (start, end + 1)
        del self.stack[index:]


def element(html, identity):
    try:
        start, end = _ElementSpans(html).spans[identity]
    except KeyError as error:
        raise BridgeError(f"Required HTML element is missing: {identity}") from error
    return start, end, html[start:end]


def patch_index(old, latest, js_bytes, css_bytes):
    old = old.replace("\r\n", "\n")
    latest = latest.replace("\r\n", "\n")
    start, end, _ = element(old, "settings-section-updates")
    _, _, updates = element(latest, "settings-section-updates")
    result = old[:start] + updates + old[end:]
    _, _, dialog = element(latest, "tli-update-install-dialog")
    if 'id="tli-update-install-dialog"' in result:
        raise BridgeError("The base already contains the installation dialog")
    _, end, _ = element(result, "tli-host-lifecycle-dialog")
    result = result[:end] + "\n\n  " + dialog + result[end:]
    if result.count("</head>") != 1:
        raise BridgeError("Expected exactly one head element")
    result = result.replace("</head>", '<link rel="stylesheet" href="update-workspace.css?v=' + digest(css_bytes)[:12] + '" />\n</head>')
    result, count = re.subn(r'(/js/tli-update\.js\?v=)[^"\s]+', lambda m: m[1] + digest(js_bytes)[:12], result)
    if count != 1:
        raise BridgeError("Expected exactly one existing update script")
    _ElementSpans(result)  # reject duplicate ids introduced by the splice
    return result


def patch_version(text):
    text, count = re.subn(r'(?m)^(TLI_VERSION\s*=\s*)["\']1\.4\.5-beta["\']',
                          lambda m: m[1] + repr(BRIDGE_VERSION), text)
    if count != 1:
        raise BridgeError("Expected the unchanged published 1.4.5 version assignment")
    return text


def patch_frontend_version(data):
    """Keep every published app byte except its authoritative version value."""
    original = b'const TLI_VERSION        = "1.4.5-beta";'
    if data.count(original) != 1:
        raise BridgeError("Expected the unchanged published frontend version assignment")
    return data.replace(original, b'const TLI_VERSION        = "' + BRIDGE_VERSION.encode() + b'";')


def patch_app_reference(index, app):
    index, count = re.subn(r'(/app\.js\?v=)[^"\s]+', lambda m: m[1] + digest(app)[:12], index)
    if count != 1:
        raise BridgeError("Expected exactly one published main app script")
    return index


def patch_state(text):
    text = patch_version(text)
    original = "_active_sessions: Dict[str, Dict[str, Any]] = {}"
    replacement = original + ('\n_session_revocation_epoch = object()\n\n\n'
        'def session_revocation_epoch() -> object:\n'
        '    """Process-local invalidation marker, never an access credential."""\n'
        '    return _session_revocation_epoch')
    if text.count(original) != 1 or text.count("def revoke_all_sessions() -> None:\n") != 1:
        raise BridgeError("Published session invalidation anchors changed")
    text = text.replace(original, replacement)
    return text.replace("def revoke_all_sessions() -> None:\n",
                        "def revoke_all_sessions() -> None:\n    global _session_revocation_epoch\n    _session_revocation_epoch = object()\n")


def patch_home_host(text):
    """Validate raw Host while retaining the published device service interfaces."""
    original_import = "from companion_auth import resolve_user\n"
    original_admission = "    try:\n        user = resolve_user(request)\n"
    if text.count(original_import) != 1 or text.count(original_admission) != 1:
        raise BridgeError("Published home authority anchors changed")
    return text.replace(original_import, original_import + "from browser_authority import direct_request_address\n").replace(
        original_admission, "    try:\n        direct_request_address(request)\n        user = resolve_user(request)\n")


def patch_home_test(text):
    """Keep the old service fixtures and exercise malformed Host before any work."""
    original = '"headers": [(b"cookie", b"tli_session=browser-session")]'
    if text.count(original) != 1 or "test_bridge_home_rejects_raw_host" in text:
        raise BridgeError("Published home request fixture changed")
    text = text.replace(original, '"headers": [(b"host", b"testserver"), (b"cookie", b"tli_session=browser-session")]')
    return text + '''


@pytest.mark.parametrize("hosts", [[], [""], ["testserver", "testserver"],
    ["testserver:99999"], ["testserver:bad"], ["testserver:"],
    ["testserver/private"], ["user@testserver"], ["testserver,other"]])
@pytest.mark.parametrize("text", ["turn on lamp", "check lamp", "list my smart devices"])
def test_bridge_home_rejects_raw_host_before_auth_registry_or_device_work(house, monkeypatch, hosts, text):
    from starlette.datastructures import URL
    request = Request({**house.request.scope, "headers": [
        (b"host", host.encode("ascii")) for host in hosts] +
        [(b"cookie", b"tli_session=browser-session")]})
    # Model framework normalization explicitly so this regression also runs on
    # older Starlette versions used by existing installations.
    request._url = URL("https://testserver/ai/chat")
    request._base_url = URL("https://testserver/")
    monkeypatch.setattr(home, "resolve_user", lambda request: pytest.fail("Malformed Host reached credentials"))
    monkeypatch.setattr(home, "_registry", lambda: pytest.fail("Malformed Host read the registry"))
    assert "valid Host header" in home.answer(request, text)
    assert house.calls == []
'''


def patch_companion_host(text):
    """Backport only raw Host admission; preserve the published phone behavior."""
    edits = (
        ("from routers.system_routes import require_session\n",
         "from routers.system_routes import require_session\nfrom browser_authority import direct_request_address\n", 1),
        ('    if request.url.scheme != "https" or not _supported_host(request.url.hostname or ""):',
         '    address = direct_request_address(request)\n    if address.scheme != "https" or not _supported_host(address.hostname):', 1),
        ('def redeem(req: RedeemRequest, request: Request, response: Response):\n',
         'def redeem(req: RedeemRequest, request: Request, response: Response):\n    address = direct_request_address(request)\n', 1),
        ('    if request.url.scheme != "https" or not S.TLS_ENABLED:',
         '    if address.scheme != "https" or not S.TLS_ENABLED:', 1),
        ('    if not _supported_host(request.url.hostname or ""):',
         '    if not _supported_host(address.hostname):', 1),
        ('    certificate = _certificate(request.url.hostname)',
         '    certificate = _certificate(address.hostname)', 2),
        ('    if request.url.scheme != "https" or not S.TLS_ENABLED or not _supported_host(request.url.hostname or ""):',
         '    address = direct_request_address(request)\n    if address.scheme != "https" or not S.TLS_ENABLED or not _supported_host(address.hostname):', 1),
    )
    if "direct_request_address" in text:
        raise BridgeError("Published Companion Host admission was already patched")
    for original, replacement, count in edits:
        if text.count(original) != count:
            raise BridgeError("Published Companion Host admission anchors changed")
        text = text.replace(original, replacement)
    return text


def compatibility_inventory(target, source):
    """Inspect reviewed source paths; prune runtime/private trees before walking."""
    policy = published_policy(source)
    package = _module(Path(target) / "build_dist.py", "tli_bridge_packager")
    paths = []
    for directory, dirs, files in os.walk(target, followlinks=False):
        base = Path(directory)
        kept = []
        for name in dirs:
            rel = (base / name).relative_to(target)
            if rel.as_posix() == "backend/ai/runtime":
                continue  # prepared binaries require final-archive validation
            if package._is_linked_path(base / name):
                raise BridgeError(f"Linked checkout directory: {rel.as_posix()}")
            if rel.as_posix() == "docs" or not package._should_skip(rel / "__directory__")[0]:
                kept.append(name)
        dirs[:] = kept
        for name in files:
            path = base / name
            rel = path.relative_to(target)
            if not package._platform_includes(rel, "windows") and not package._platform_includes(rel, "macos"):
                continue
            if package._should_skip(rel)[0] or not package._policy.is_application_path(rel.as_posix()):
                continue
            if package._is_linked_path(path):
                raise BridgeError(f"Linked checkout file: {rel.as_posix()}")
            if not policy.is_application_path(rel.as_posix()):
                raise BridgeError(f"Published 1.4.5 rejects bridge path: {rel.as_posix()}")
            paths.append(rel.as_posix())
    return sorted(paths)


def prepare(source, target):
    source, target = Path(source).resolve(), Path(target).absolute()
    if target.exists():
        raise BridgeError("Use a new destination; existing work is never overwritten")
    if _git(source, "rev-parse", BASE_COMMIT + "^{commit}").decode().strip() != BASE_COMMIT:
        raise BridgeError("Published bridge baseline is unavailable")
    inputs = {name: _read(source / name) for name in (*OVERLAY, *VERIFICATION_FILES)}
    latest_index = _read(source / "frontend/index.html")
    policy = published_policy(source)
    for name in OVERLAY:
        if not policy.is_application_path(name):
            raise BridgeError(f"Overlay is incompatible with published updater: {name}")
    old_index = _git(source, "show", BASE_COMMIT + ":frontend/index.html").decode("utf-8")
    old_state = _git(source, "show", BASE_COMMIT + ":backend/tli_state.py").decode("utf-8")
    new_app = patch_frontend_version(_git(source, "show", BASE_COMMIT + ":frontend/app.js"))
    new_index = patch_index(old_index, latest_index.decode("utf-8"),
                            inputs["frontend/js/tli-update.js"], inputs["frontend/update-workspace.css"])
    new_index = patch_app_reference(new_index, new_app)
    about = '<span id="about-version">v1.4.5-beta</span>'
    if new_index.count(about) != 1:
        raise BridgeError("Expected the published About-version fallback")
    new_index = new_index.replace(about, '<span id="about-version">v' + BRIDGE_VERSION + '</span>')
    outputs = {**inputs, "frontend/index.html": new_index.encode("utf-8"),
               "frontend/app.js": new_app,
               "backend/tli_state.py": patch_state(old_state).encode("utf-8")}
    for name, patch in (("backend/home_conversation.py", patch_home_host),
                        ("backend/routers/companion_routes.py", patch_companion_host),
                        ("backend/tests/test_home_conversation.py", patch_home_test)):
        outputs[name] = patch(_git(source, "show", BASE_COMMIT + ":" + name).decode("utf-8")).encode("utf-8")
    workflow_name = ".github/workflows/desktop-packages.yml"
    workflow = outputs[workflow_name].decode("utf-8").replace("\r\n", "\n")
    workflow = workflow.replace("1.4.7-beta", BRIDGE_VERSION)
    if "1.4.7-beta" in workflow or "TLI_1.4.6-beta_" not in workflow:
        raise BridgeError("Expected finalized full-release package workflow")
    host_tests = "backend/tests/test_node_pairing.py -q"
    if workflow.count(host_tests) != 1:
        raise BridgeError("Expected the raw Host and Node isolation verification step")
    workflow = workflow.replace(host_tests, "backend/tests/test_node_pairing.py backend/tests/test_home_conversation.py -q")
    marker = "      - name: Verify extracted installation and native runtime\n"
    if workflow.count(marker) != 1:
        raise BridgeError("Cannot identify bridge compatibility validation position")
    workflow = workflow.replace(marker,
        "      - name: Verify published 1.4.5 updater compatibility\n"
        "        run: python scripts/prepare_update_bridge.py --archive build_work/packages/TLI_1.4.6-beta_${{ matrix.label }}.zip --platform ${{ matrix.platform }}\n" + marker)
    outputs[workflow_name] = workflow.encode("utf-8")
    old_start = _git(source, "show", BASE_COMMIT + ":START_HERE.md").decode("utf-8")
    old_start = old_start.replace("1.4.5-beta", BRIDGE_VERSION)
    old_start = old_start.replace(
        "4. Keep Terminal open while TLI is running. Press **Control+C** there to stop TLI.",
        "4. After startup completes, you may close Terminal. TLI runs in the background; use **Quit TLI** inside the local app to stop it. Older foreground releases still use **Control+C**.")
    old_start = old_start.replace("On **macOS / Linux**, stop TLI in its Terminal with **Control+C**,",
                                "On **macOS / Linux**, use **Quit TLI** inside the local app (or **Control+C** for an older foreground launch),")
    outputs["START_HERE.md"] = old_start.encode("utf-8")
    settings_test = _git(source, "show", BASE_COMMIT + ":frontend/tests/settings-behavior.test.cjs").decode("utf-8")
    if settings_test.count("window: {}, navigator:") != 1:
        raise BridgeError("Expected old settings browser fixture")
    outputs["frontend/tests/settings-behavior.test.cjs"] = settings_test.replace(
        "window: {}, navigator:", "AbortController, window: {}, navigator:").encode("utf-8")
    old_readme = _git(source, "show", BASE_COMMIT + ":README.md").decode("utf-8")
    old_readme = old_readme.replace("1.4.5-beta", BRIDGE_VERSION)
    note = ("\n> **Updater compatibility release 1.4.6-beta.** This release preserves the 1.4.5 application "
            "and adds reviewed installation and restart inside TLI. Existing 1.4.5 users can download "
            "this bridge in Settings, then close TLI and finish the one-time update from the prepared "
            "folder. Reopen the original installation to download and install the latest full release "
            "inside TLI. Saved data, models and the existing environment stay in their original folder.\n\n")
    first, separator, rest = old_readme.partition("\n")
    outputs["README.md"] = (first + separator + note + rest).encode("utf-8")
    target.parent.mkdir(parents=True, exist_ok=True)
    _git(source, "worktree", "add", "-b", "codex/update-bridge-1-4-6", str(target), BASE_COMMIT)
    for name, data in outputs.items():
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            _read(destination)  # reject links before replacement
        destination.write_bytes(data)
    paths = compatibility_inventory(target, source)
    for name, expected in inputs.items():
        if _read(source / name) != expected:
            raise BridgeError(f"Source changed while assembling bridge; review retained checkout: {name}")
    if _read(source / "frontend/index.html") != latest_index:
        raise BridgeError("Source index changed while assembling bridge; review retained checkout")
    receipt = {"base_commit": BASE_COMMIT, "version": BRIDGE_VERSION,
               "source_policy": "published-1.4.5", "policy_sha256": POLICY_SHA256,
               "published_1_4_5_archive_sha256": PUBLISHED_ARCHIVES,
               "files": {name: digest(data) for name, data in sorted(outputs.items())},
               "compatible_source_paths": paths,
               "final_archive_validation_required": True,
               "runtime_or_package_execution_performed": False}
    receipt_path = target / "build_work/update-bridge/assembly.json"
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt_path


def verify_archive(source, archive, platform):
    policy = published_policy(source)
    manifest = policy.validate_archive(Path(archive), BRIDGE_VERSION, platform)
    policy.require_full_release(manifest, platform)
    with zipfile.ZipFile(archive) as bundle:
        for name in ("backend/tli_state.py", "frontend/app.js"):
            if name not in bundle.namelist():
                raise BridgeError("Bridge is missing its versioned source: " + name)
            version = re.search(r'\bTLI_VERSION\s*=\s*["\']([^"\']+)["\']', bundle.read(name).decode("utf-8-sig"))
            if version is None or version[1] != BRIDGE_VERSION:
                raise BridgeError("Bridge source version does not match: " + name)
    return {"version": manifest["version"], "platform": manifest["platform"],
            "files": len(manifest["files"]), "published_1_4_5_validation": "passed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--target", type=Path, help="Create a new isolated bridge Git worktree")
    mode.add_argument("--archive", type=Path, help="Validate a final bridge ZIP using the actual old updater")
    parser.add_argument("--platform", choices=("windows", "macos"))
    args = parser.parse_args()
    if args.archive:
        if not args.platform:
            parser.error("--archive requires --platform")
        print(json.dumps(verify_archive(args.source, args.archive, args.platform), indent=2))
    else:
        print(prepare(args.source, args.target))


if __name__ == "__main__":
    main()
