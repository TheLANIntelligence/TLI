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


def read_json(path, area: str, limit: int = 1024 * 1024):
    """Missing is distinct from unreadable; bounded reads never create directories."""
    try:
        with Path(path).open("rb") as stream:
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("Oversized saved state")
        return json.loads(raw.decode("utf-8"))
    except FileNotFoundError:
        raise
    except Exception as exc:
        raise SecurityStateUnavailable(area) from exc


def write_json(path, value, area: str, *, new: bool = False):
    """Atomic replacement; exclusive creation supports removable filesystems."""
    path = Path(path)
    temporary = None
    created = False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if new:
            payload = json.dumps(value, indent=2).encode("utf-8")
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
        os.replace(temporary, path)
        temporary = None
    except Exception as exc:
        if created:
            try:
                path.unlink()
            except OSError:
                pass
        raise SecurityStateUnavailable(area) from exc
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


def companion_dependencies(data_dir) -> bool:
    try:
        value = read_json(Path(data_dir) / "companion" / "credentials.json", "Companion credentials")
    except FileNotFoundError:
        return False
    if not isinstance(value, dict) or value.get("version") != 1 or any(not isinstance(value.get(k), dict) for k in ("devices", "pairings", "preferences")):
        raise SecurityStateUnavailable("Companion credentials")
    # Even revoked devices prove that this installation previously had a PIN.
    return bool(value["devices"] or value["pairings"])


def node_dependencies(data_dir) -> bool:
    if companion_dependencies(data_dir):
        return True
    root = Path(data_dir)
    for relative in ("mesh/mesh_directory.json", "mesh/agent_state.json", "mesh/agent_tasks.json", "intelligence/device_context.json"):
        try:
            value = read_json(root / relative, "node configuration")
        except FileNotFoundError:
            continue
        if not isinstance(value, dict):
            raise SecurityStateUnavailable("node configuration")
        if value:
            return True
    return False


def validate_existing_security() -> None:
    """Validate before any identities, workers, sessions or listeners initialize."""
    import tli_state as S
    import node_identity
    import vault_security

    S.read_pin_config()
    S.read_node_config()
    node_identity.read_existing(S.DATA_DIR)
    vault_security.read_existing_meta(data_dir=S.DATA_DIR)
