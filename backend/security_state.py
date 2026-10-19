"""Read-only security preflight and safe recovery errors. Never reset saved state."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from fastapi import HTTPException


class SecurityStateUnavailable(HTTPException):
    def __init__(self, area: str):
        self.area = area
        self.code = "security_state_unavailable"
        super().__init__(503, f"The saved {area} is unavailable or incomplete. Existing files were preserved. Stop TLI and restore the matching files from a backup, or use the original operating-system account. Do not run setup over this installation.")


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate saved state key")
        value[key] = item
    return value


def _read_access(check):
    if check is not None:
        try:
            check()
        except Exception as error:
            error.security_read_authority_failure = True
            raise


def read_json(path, area: str, limit: int = 1024 * 1024, *, reject_duplicates: bool = False, check=None):
    """Missing is distinct from unreadable; bounded reads never create directories."""
    _read_access(check)
    try:
        with Path(path).open("rb") as stream:
            _read_access(check)
            raw = stream.read(limit + 1)
        _read_access(check)
        if len(raw) > limit:
            raise ValueError("Oversized saved state")
        result = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object if reject_duplicates else None)
        _read_access(check)
        return result
    except FileNotFoundError as exc:
        if getattr(exc, "security_read_authority_failure", False):
            raise
        _read_access(check)
        raise
    except Exception as exc:
        if getattr(exc, "security_read_authority_failure", False):
            raise
        _read_access(check)
        raise SecurityStateUnavailable(area) from exc


def write_json(path, value, area: str, *, new: bool = False, before_commit=None):
    """Atomic replacement; exclusive creation supports removable filesystems."""
    path = Path(path)
    temporary = None
    created = False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if new:
            payload = json.dumps(value, indent=2).encode("utf-8")
            if before_commit is not None:
                before_commit()
            with path.open("xb") as stream:
                created = True
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            return
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=".tli-security-", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        if before_commit is not None:
            before_commit()
        os.replace(temporary, path)
        temporary = None
    except Exception as exc:
        if created:
            try:
                path.unlink()
            except OSError:
                pass
        if isinstance(exc, HTTPException):
            raise
        raise SecurityStateUnavailable(area) from exc
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


def companion_dependencies(data_dir, *, check=None) -> bool:
    _read_access(check)
    try:
        value = read_json(Path(data_dir) / "companion" / "credentials.json", "Companion credentials", check=check)
    except FileNotFoundError as exc:
        if getattr(exc, "security_read_authority_failure", False):
            raise
        _read_access(check)
        return False
    except Exception as exc:
        if getattr(exc, "security_read_authority_failure", False):
            raise
        _read_access(check)
        raise
    try:
        _read_access(check)
        if not isinstance(value, dict) or value.get("version") != 1 or any(not isinstance(value.get(k), dict) for k in ("devices", "pairings", "preferences")):
            raise SecurityStateUnavailable("Companion credentials")
        # Even revoked devices prove that this installation previously had a PIN.
        result = bool(value["devices"] or value["pairings"])
        _read_access(check)
        return result
    except Exception as exc:
        if getattr(exc, "security_read_authority_failure", False):
            raise
        _read_access(check)
        raise


def node_dependencies(data_dir, *, check=None) -> bool:
    _read_access(check)
    try:
        if companion_dependencies(data_dir, check=check):
            _read_access(check)
            return True
        root = Path(data_dir)
        for relative in ("mesh/mesh_directory.json", "mesh/agent_state.json", "mesh/agent_tasks.json", "intelligence/device_context.json"):
            _read_access(check)
            try:
                value = read_json(root / relative, "node configuration", check=check)
            except FileNotFoundError as exc:
                if getattr(exc, "security_read_authority_failure", False):
                    raise
                _read_access(check)
                continue
            _read_access(check)
            if not isinstance(value, dict):
                raise SecurityStateUnavailable("node configuration")
            if value:
                _read_access(check)
                return True
        _read_access(check)
        return False
    except Exception as exc:
        if getattr(exc, "security_read_authority_failure", False):
            raise
        _read_access(check)
        raise


def validate_existing_security() -> None:
    """Validate before any identities, workers, sessions or listeners initialize."""
    import tli_state as S
    import node_identity
    import vault_security

    S.read_pin_config()
    S.read_node_config()
    node_identity.read_existing(S.DATA_DIR)
    vault_security.read_existing_meta(data_dir=S.DATA_DIR)
