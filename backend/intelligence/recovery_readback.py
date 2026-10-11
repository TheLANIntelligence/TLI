"""Reopen a separate encrypted recovery copy with current readers, never a server.

Only hashes and counts cross the child-process boundary. This module deliberately
has no application imports until the child has established its persistence root
and disabled writes, network access, child processes and worker threads.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

KINDS = ("notebook", "conversations", "diagnostics", "origin")
COUNT_KINDS = KINDS[:3]
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = MAX_JSON_BYTES * 4 // 3 + 4096
MAX_RECEIPT_BYTES = 8192
TIMEOUT_SECONDS = 30
_LOCAL_HASH = hashlib.sha256(b"local").hexdigest()
FILES = {
    "notebook": "data/memory_local.json",
    "conversations": "data/conversations.json",
    "diagnostics": f"data/intelligence/diagnostics-{_LOCAL_HASH}.json",
    "origin": f"data/intelligence/recovery-origin-{_LOCAL_HASH}.json",
}
CASE_FILE = f"data/intelligence/cases-{_LOCAL_HASH}.json"


def _kinds(value):
    return (*KINDS, "cases") if "cases" in value else KINDS
KEY_FILES = ("data/memory_key.bin", "data/conversations_key.bin")
DIRECTORIES = {"data", "data/intelligence", "data/vault", "data/tools",
               "data/tools/scripts", "data/tools/tasks", "data/mesh"}
CHECKS = ("encrypted_payloads", "current_readers", "record_identifiers",
          "stored_metadata", "owner_mapping", "files_unchanged")


class ReadbackError(RuntimeError):
    """Safe error text only; never include decrypted records or provider output."""


def canonical_digest(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"),
                     ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError("Recovery area exceeds the readback limit")
    return hashlib.sha256(raw).hexdigest()


def _strict_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    def invalid(_):
        raise ValueError("Unsupported JSON number")
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)


def _identifier(value):
    return isinstance(value, str) and 1 <= len(value) <= 256


def _normalized_notes(value):
    """Expected public-reader shape, including documented legacy defaults.

    Raw digests separately cover every stored field, including metadata the
    current UI does not project. No normalized value is written back to disk.
    """
    from memory_validation import validate_memory_structure
    validate_memory_structure(value)
    output = []
    for index, fact in enumerate(value["facts"]):
        if isinstance(fact, str):
            row = {"id": f"legacy-{index}", "text": fact, "category": "general",
                   "device_id": None, "created_at": value.get("last_updated"),
                   "updated_at": value.get("last_updated"), "deleted": False}
        else:
            if "deleted" in fact and type(fact["deleted"]) is not bool:
                raise ValueError("Unsupported note deletion marker")
            row = {key: fact[key] for key in ("source", "report_id", "title", "chat_source", "note_links") if key in fact}
            row.update(id=fact.get("id") or f"f-{index}", text=fact["text"],
                       category=fact.get("category") or "general", device_id=fact.get("device_id"),
                       created_at=fact.get("created_at"), updated_at=fact.get("updated_at"),
                       deleted=fact.get("deleted", False))
        output.append(row)
    ids = [row["id"] for row in output]
    if any(not _identifier(ident) for ident in ids) or len(set(ids)) != len(ids):
        raise ValueError("Notes cannot be addressed individually")
    return {"facts": output, "last_updated": value.get("last_updated")}


def validate_values(values):
    """Pure structure/readability preflight available to recovery review.

    Values have already been decrypted and ownership-remapped by the service.
    Return counts only. Reject records current readers would hide or misaddress.
    """
    if not isinstance(values, dict) or set(values) != set(_kinds(values)):
        raise ValueError("Invalid recovery areas")
    notes = _normalized_notes(values["notebook"])
    conversations = values["conversations"]
    if not isinstance(conversations, dict):
        raise ValueError("Invalid conversation store")
    for ident, record in conversations.items():
        if (not _identifier(ident) or not isinstance(record, dict) or record.get("user_id") != "local"
                or ("id" in record and record["id"] != ident) or not isinstance(record.get("messages", []), list)):
            raise ValueError("Unsupported conversation identity or ownership")
        for turn in record.get("messages", []):
            if not isinstance(turn, dict) or turn.get("role") not in ("user", "assistant", "system") or not isinstance(turn.get("content"), str):
                raise ValueError("Unsupported conversation message")
    reports = values["diagnostics"]
    if not isinstance(reports, list) or any(not isinstance(row, dict) or not _identifier(row.get("id")) for row in reports):
        raise ValueError("Unsupported diagnostic identity")
    if len({row["id"] for row in reports}) != len(reports):
        raise ValueError("Duplicate diagnostic identity")
    origin = values["origin"]
    if (not isinstance(origin, dict) or set(origin) != {"schema_version", "source", "conversation_owners", "recovered_owner"}
            or type(origin["schema_version"]) is not int or origin["schema_version"] != 1 or origin["recovered_owner"] != "local"
            or not isinstance(origin["source"], dict) or not _identifier(origin["source"].get("owner_id"))
            or not isinstance(origin["conversation_owners"], dict) or set(origin["conversation_owners"]) != set(conversations)):
        raise ValueError("Unsupported recovery ownership metadata")
    source_owner = origin["source"]["owner_id"]
    allowed = {source_owner, "bundled-ai"} if source_owner == "local" else {source_owner}
    if (origin["source"].get("conversation_owner_ids") != sorted(allowed)
            or any(owner not in allowed for owner in origin["conversation_owners"].values())):
        raise ValueError("Recovery ownership associations differ")
    counts = {"notebook": len(notes["facts"]), "conversations": len(conversations), "diagnostics": len(reports)}
    if "cases" in values:
        from intelligence.cases import validate_store
        counts["cases"] = validate_store(values["cases"])
    return counts


def _expectation(value):
    if (not isinstance(value, dict) or set(value) != {*_kinds(value), "counts", "owner"} or value["owner"] != "local"
            or any(not isinstance(value[kind], str) or not re.fullmatch(r"[a-f0-9]{64}", value[kind]) for kind in _kinds(value))
            or not isinstance(value["counts"], dict) or set(value["counts"]) != set(_kinds(value)) - {"origin"}
            or any(type(count) is not int or not 0 <= count <= 1000000 for count in value["counts"].values())):
        raise ValueError("Unsupported readback expectation")
    return value


def _linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _read_bounded(path, limit):
    # Keep the read itself bounded even if a file grows after its stat check.
    with path.open("rb") as handle:
        raw = handle.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("Recovery file exceeds the read limit")
    return raw


def _root(destination):
    path = Path(destination)
    if not path.is_absolute() or not path.is_dir() or any(_linked(part) for part in (path, *path.parents)):
        raise ValueError("Recovery root is not an ordinary absolute directory")
    root = path.resolve(strict=True)
    # A caller must never redirect a verifier onto the active installation.
    live_roots = [Path(__file__).resolve().parents[2]]
    if os.environ.get("TLI_ROOT"):
        live_roots.append(Path(os.environ["TLI_ROOT"]).resolve())
    if any(root == live or root in live.parents or live in root.parents for live in live_roots):
        raise ValueError("Recovery root overlaps an active installation")
    return root


def _snapshot(root, with_cases=False):
    expected_files = set(FILES.values()) | set(KEY_FILES) | ({CASE_FILE} if with_cases else set())
    result, directories = {}, set()
    pending = [root]
    while pending:
        parent = pending.pop()
        for path in parent.iterdir():
            if _linked(path):
                raise ValueError("Linked recovery entry")
            relative = path.relative_to(root).as_posix()
            if path.is_dir():
                if relative not in DIRECTORIES:
                    raise ValueError("Unexpected recovery directory")
                directories.add(relative)
                pending.append(path)
            else:
                if relative not in expected_files or not path.is_file():
                    raise ValueError("Unexpected recovery file")
                info = path.stat()
                limit = 65536 if relative in KEY_FILES else MAX_FILE_BYTES
                if info.st_nlink != 1 or not 0 < info.st_size <= limit:
                    raise ValueError("Unsupported recovery file")
                raw = _read_bounded(path, limit)
                if len(raw) != info.st_size:
                    raise ValueError("Recovery file changed during inspection")
                result[relative] = (hashlib.sha256(raw).hexdigest(), info.st_size, info.st_mtime_ns)
    if set(result) != expected_files or directories != DIRECTORIES:
        raise ValueError("Incomplete recovery layout")
    return result


def _environment(destination):
    # Do not inherit server, persistence, startup, Python import or browser overrides.
    keep = {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "USERPROFILE", "APPDATA",
            "LOCALAPPDATA", "PROGRAMDATA", "HOMEDRIVE", "HOMEPATH", "SYSTEMDRIVE"}
    env = {name: value for name, value in os.environ.items() if name.upper() in keep}
    env.update(TLI_ROOT=str(destination), PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
    return env


def ensure_available():
    """Read-only capability check usable before recovery review or writes."""
    if getattr(sys, "frozen", False):
        raise ReadbackError("Current-application recovery checking requires a Python/source installation in this checkpoint. It is unavailable in this packaged runtime; no recovery copy was created.")


def run_readback(destination, expected):
    """Bounded fresh-process check. Destination is an unpublished installation root.

    A frozen TLI executable cannot safely act as a Python interpreter. Until its
    launcher defines a dedicated worker entry point, report unavailable there.
    """
    try:
        ensure_available()
        root = _root(destination)
        expected = _expectation(expected)
        before = _snapshot(root, "cases" in expected)
        response = subprocess.run([sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--readback-child"],
            input=json.dumps(expected, separators=(",", ":")), text=True, encoding="utf-8",
            capture_output=True, timeout=TIMEOUT_SECONDS, cwd=root, env=_environment(root), shell=False,
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}))
        if response.returncode or len(response.stdout.encode("utf-8")) > MAX_RECEIPT_BYTES or response.stderr:
            raise ValueError("Readback process failed")
        receipt = _strict_json(response.stdout)
        if (not isinstance(receipt, dict) or set(receipt) != {"ok", "schema_version", "reader", "tli_version", "owner", "counts", "checks", "checked_at"}
                or receipt.get("ok") is not True or receipt.get("schema_version") != 1 or receipt.get("reader") != "current-application"
                or receipt.get("owner") != "local" or receipt.get("counts") != expected["counts"]
                or receipt.get("checks") != dict.fromkeys(CHECKS, True)
                or not isinstance(receipt.get("tli_version"), str) or len(receipt["tli_version"]) > 64
                or not isinstance(receipt.get("checked_at"), str) or len(receipt["checked_at"]) > 64):
            raise ValueError("Invalid readback receipt")
        datetime.fromisoformat(receipt["checked_at"])
        if _snapshot(root, "cases" in expected) != before:
            raise ValueError("Recovery files changed during readback")
        return receipt
    except ReadbackError:
        raise
    except subprocess.TimeoutExpired as exc:
        raise ReadbackError("Current-application recovery checking timed out. The copy was not verified; the original installation was not changed.") from exc
    except Exception as exc:
        raise ReadbackError("Current TLI readers could not verify this separate recovery copy. It was not approved for use; the original installation was not changed.") from exc


def _guard_child(root):
    import threading
    def blocked(*args, **kwargs):
        raise RuntimeError("Side effects are disabled during recovery readback")
    threading.Thread.start = blocked
    def audit(event, args):
        if (event.startswith(("socket.", "subprocess.", "os.exec", "os.spawn", "os.posix_spawn"))
                or event in {"os.system", "os.remove", "os.rename", "os.rmdir", "os.truncate", "os.link", "os.symlink", "os.chmod", "os.chown"}):
            blocked()
        if event == "open":
            flags = args[2] if len(args) > 2 else 0
            if isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                blocked()
        if event == "os.mkdir":
            path = Path(args[0])
            path = path if path.is_absolute() else root / path
            if path != root and path.relative_to(root).as_posix() not in DIRECTORIES:
                blocked()
        if event == "import" and args[0] in {"main", "ai.ai_manager", "uvicorn", "node_identity"}:
            blocked()
    sys.addaudithook(audit)


def _read_current(expected, root):
    import base64
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    import data_protection
    import tli_state as S
    from intelligence import memory, diagnostics, store
    if Path(S.DATA_DIR).resolve() != root / "data":
        raise ValueError("Reader persistence differs from destination")
    before = _snapshot(root, "cases" in expected)
    values = {}
    for kind in _kinds(expected):
        envelope = _strict_json(_read_bounded(root / (CASE_FILE if kind == "cases" else FILES[kind]), MAX_FILE_BYTES))
        if not isinstance(envelope, dict) or set(envelope) != {"_tli_enc", "data"} or type(envelope["_tli_enc"]) is not int or envelope["_tli_enc"] != 1:
            raise ValueError("Recovery data is not encrypted")
        key_name = "conversations_key.bin" if kind == "conversations" else "memory_key.bin"
        key = data_protection.load_existing_key(root / "data" / key_name)
        blob = base64.b64decode(envelope["data"], validate=True)
        aad = ("diagnostics:local" if kind == "diagnostics" else "cases:local" if kind == "cases" else "recovery-origin:local" if kind == "origin" else None)
        raw = AESGCM(key).decrypt(blob[:12], blob[12:], aad.encode() if aad else None)
        if len(raw) > MAX_JSON_BYTES:
            raise ValueError("Recovery area exceeds readback limit")
        values[kind] = _strict_json(raw)
        if canonical_digest(values[kind]) != expected[kind]:
            raise ValueError("Recovered data differs from reviewed data")
    counts = validate_values(values)
    if counts != expected["counts"]:
        raise ValueError("Recovery count mismatch")
    normalized = _normalized_notes(values["notebook"])
    if S.load_memory("local", strict=True) != normalized:
        raise ValueError("Current note reader changed supported metadata")
    visible = memory.list_facts("local")
    wanted = [{**row, "source": row.get("source", "user_memory")} for row in normalized["facts"] if not row["deleted"]]
    if [{key: value for key, value in row.items() if key != "revision"} for row in visible] != wanted:
        raise ValueError("Current note reader hid supported records")
    if S.load_conversations() != values["conversations"]:
        raise ValueError("Current conversation reader differs")
    if diagnostics.history("local") != values["diagnostics"]:
        raise ValueError("Current diagnostic reader differs")
    if values["diagnostics"] and diagnostics.get_report("local", values["diagnostics"][0]["id"]) != values["diagnostics"][0]:
        raise ValueError("Recovered report cannot be opened")
    if store.read_private("local", "recovery-origin", {}) != values["origin"]:
        raise ValueError("Current origin reader differs")
    if "cases" in values:
        from intelligence.cases import read_all
        if read_all("local") != values["cases"]:
            raise ValueError("Current troubleshooting reader differs")
    if _snapshot(root, "cases" in expected) != before:
        raise ValueError("Readback changed saved files")
    return {"ok": True, "schema_version": 1, "reader": "current-application", "tli_version": S.TLI_VERSION,
            "owner": "local", "counts": counts, "checks": dict.fromkeys(CHECKS, True),
            "checked_at": datetime.now(timezone.utc).isoformat()}


def _child():
    # -I keeps untrusted working-directory modules and inherited PYTHONPATH out.
    root = Path(os.environ["TLI_ROOT"]).resolve(strict=True)
    if Path.cwd().resolve() != root or "tli_state" in sys.modules:
        raise ValueError("Persistence must be isolated before application imports")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    expected = _expectation(_strict_json(sys.stdin.buffer.read(MAX_RECEIPT_BYTES + 1)))
    _guard_child(root)
    import contextlib
    class Discard:
        def write(self, text):
            return len(text)
        def flush(self):
            pass
    with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
        return _read_current(expected, root)


if __name__ == "__main__":
    try:
        if sys.argv[1:] != ["--readback-child"]:
            raise ValueError("Unsupported entry point")
        print(json.dumps(_child(), separators=(",", ":")))
    except Exception:
        # No exception details: third-party errors can contain decrypted text.
        print('{"ok":false,"error":"readback_failed"}')
        sys.exit(1)
