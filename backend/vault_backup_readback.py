"""Fresh-process authenticated current Vault readers; no server or saved sessions."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

TIMEOUT = 180
MAX_INPUT = 9 * 1024 * 1024
MAX_OUTPUT = 8192
CHECKS = {"passphrase_authenticated": True, "current_readers": True, "exact_content": True,
          "owner_mapping": True, "locked_without_sessions": True, "files_unchanged": True}


def ensure_available():
    if getattr(sys, "frozen", False):
        raise RuntimeError("Verified Vault recovery requires a Python/source installation")


def _tree(root, expected_files):
    from intelligence.recovery_readback import _linked, DIRECTORIES
    import vault_backup as archive
    result, directories = {}, set()
    for path in root.rglob("*"):
        if _linked(path):
            raise ValueError("Recovery contains linked paths")
        relative = path.relative_to(root).as_posix()
        if path.is_dir():
            if relative not in DIRECTORIES:
                raise ValueError("Unexpected recovered directory")
            directories.add(relative)
            continue
        if path.is_file():
            if relative not in expected_files or len(result) >= archive.MAX_ENTRIES + 2:
                raise ValueError("Unexpected recovered file")
            result[relative] = archive.file_hash(path, archive.MAX_FILE + 28)
        else:
            raise ValueError("Unsupported recovered file type")
    if set(result) != expected_files or directories != DIRECTORIES:
        raise ValueError("Recovered layout is incomplete")
    return result


def run_readback(destination, password, manifest, origin):
    ensure_available()
    from intelligence.recovery_readback import _root, _environment
    import vault_backup as archive
    root = _root(destination)
    archive.validate_manifest(manifest)
    expected_files = {"vault_meta.json", "data/vault-backup-origin.enc"} | {"data/vault/" + entry["name"] for entry in manifest["entries"]}
    before = _tree(root, expected_files)
    if set(before) != expected_files:
        raise ValueError("Recovered Vault layout is incomplete or contains unexpected files")
    payload = archive.json_bytes({"password": password, "manifest": manifest, "origin": origin})
    if len(payload) > MAX_INPUT:
        raise ValueError("Recovery verification request too large")
    response = subprocess.run([sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--vault-readback"],
        input=payload, capture_output=True, timeout=TIMEOUT, cwd=root, env=_environment(root), shell=False,
        **({"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}))
    if response.returncode or len(response.stdout) > MAX_OUTPUT or response.stderr:
        raise ValueError("Vault readback failed")
    receipt = archive._load_json(response.stdout)
    if (not isinstance(receipt, dict) or receipt.get("ok") is not True or receipt.get("checks") != CHECKS
            or receipt.get("reader") != "current-application" or receipt.get("counts") != archive.summary(manifest)["counts"]
            or _tree(root, expected_files) != before):
        raise ValueError("Current Vault readers did not confirm unchanged content")
    return receipt


def _read_current(root, payload):
    import base64
    from datetime import timedelta
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    import tli_state as S
    import vault_security as security
    import vault_backup as archive
    from routers import vault_routes as routes
    from vault_backup_recovery import ORIGIN, ORIGIN_AAD
    if Path(S.VAULT_DIR).resolve() != root / "data" / "vault" or Path(security.VAULT_META_PATH).resolve() != root / "vault_meta.json":
        raise ValueError("Vault readers escaped the isolated destination")
    manifest = archive.validate_manifest(payload["manifest"])
    if not security.verify_password(payload["password"]):
        raise ValueError("Recovered passphrase authentication failed")
    meta = security.read_existing_meta()
    if meta.get("failed_attempts") != 0 or meta.get("locked_until") is not None or any(name.startswith("ext_api") for name in meta):
        raise ValueError("Recovered security state is not fresh")
    if security.is_vault_unlocked("local"):
        raise ValueError("Recovered copy unexpectedly started unlocked")
    key = security._derive_encryption_key(payload["password"], base64.b64decode(meta["encryption_salt"], validate=True))
    expected_files = {"vault_meta.json", "data/vault-backup-origin.enc"} | {"data/vault/" + entry["name"] for entry in manifest["entries"]}
    before = _tree(root, expected_files)
    # Establish authenticated memory-only access, without calling unlock(),
    # which would persist a session and rewrite the metadata being checked.
    security.UNLOCKED_VAULTS["local"] = security._now() + timedelta(seconds=TIMEOUT + 5)
    security.ENCRYPTION_KEYS["local"] = key
    try:
        for entry in manifest["entries"]:
            if entry["kind"] == "file":
                raw = routes._read_vault_file("local", entry["name"][:-6])
            else:
                raw = routes._decrypt_for_user("local", (root / "data/vault" / entry["name"]).read_bytes())
            if len(raw) != entry["size"] or hashlib.sha256(raw).hexdigest() != entry["sha256"]:
                raise ValueError("Current Vault reader changed content")
            actual = archive.validate_plain(entry["kind"], (raw,))
            if actual["records"] != entry["records"]:
                raise ValueError("Current Vault record count differs")
            if entry["kind"] == "secrets" and routes.load_vault_secrets("local") != archive._load_json(raw):
                raise ValueError("Current secret reader changes stored values")
            if entry["kind"] == "logins" and routes.load_vault_logins("local") != archive._load_json(raw):
                raise ValueError("Current saved-login reader changes records")
            if entry["kind"] == "note" and routes.vault_read_note(entry["name"][:-6], "local")["content"] != raw.decode("utf-8"):
                raise ValueError("Current Vault note reader changes text")
        encrypted = (root / ORIGIN).read_bytes()
        origin = archive._load_json(AESGCM(key).decrypt(encrypted[:12], encrypted[12:], ORIGIN_AAD))
        if (origin != payload["origin"] or origin["source_owner"] != manifest["source_owner"]
                or origin["recovered_owner"] != "local"
                or origin["manifest_sha256"] != hashlib.sha256(archive.json_bytes(manifest)).hexdigest()):
            raise ValueError("Recovered owner mapping differs")
    finally:
        security.UNLOCKED_VAULTS.clear()
        security.ENCRYPTION_KEYS.clear()
    if _tree(root, expected_files) != before:
        raise ValueError("Current-reader check changed files")
    return {"ok": True, "reader": "current-application", "tli_version": S.TLI_VERSION,
            "counts": archive.summary(manifest)["counts"], "checked_at": archive.iso(), "checks": CHECKS}


def _child():
    root = Path(os.environ["TLI_ROOT"]).resolve(strict=True)
    if Path.cwd().resolve() != root or "tli_state" in sys.modules:
        raise ValueError("Persistence was not established before imports")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from intelligence.recovery_readback import _guard_child, _strict_json
    payload = _strict_json(sys.stdin.buffer.read(MAX_INPUT + 1))
    if not isinstance(payload, dict) or set(payload) != {"password", "manifest", "origin"}:
        raise ValueError("Unsupported readback request")
    _guard_child(root)
    import contextlib
    class Discard:
        def write(self, text):
            return len(text)
        def flush(self):
            pass
    with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
        return _read_current(root, payload)


if __name__ == "__main__":
    try:
        if sys.argv[1:] != ["--vault-readback"]:
            raise ValueError("Unsupported worker invocation")
        print(json.dumps(_child(), separators=(",", ":")))
    except Exception:
        print('{"ok":false,"error":"vault_readback_failed"}')
        sys.exit(1)
