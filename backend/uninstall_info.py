"""Read-only uninstall discovery. Removal belongs to the local native dialog."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import platform
import re


def registration_name(root: Path) -> str:
    # Fast path for ordinary paths; Windows' invariant Unicode casing can differ
    # from Python's casing, so discovery also checks exact installation locations.
    suffix = hashlib.sha256(str(root).lower().encode("utf-8")).hexdigest()[:12].upper()
    return "TLI-" + suffix


def windows_registered(root: Path) -> bool:
    """Never claim another installation's entry belongs to this one."""
    try:
        import winreg
        base = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
        def matches(name):
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base + "\\" + name, 0, winreg.KEY_READ) as handle:
                    location, _ = winreg.QueryValueEx(handle, "InstallLocation")
                return isinstance(location, str) and Path(location).resolve() == root
            except (OSError, ValueError):
                return False
        if matches(registration_name(root)):
            return True
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base, 0, winreg.KEY_READ) as parent:
            index = 0
            while True:
                try:
                    name = winreg.EnumKey(parent, index)
                except OSError:
                    break
                index += 1
                if re.fullmatch(r"TLI-[0-9A-F]{12}", name) and matches(name):
                    return True
        return False
    except (ImportError, OSError, ValueError):
        return False


def describe(root, *, system=None):
    root = Path(root).resolve()
    system = system or platform.system()
    checkout = any((parent / ".git").exists() for parent in (root, *root.parents))
    available = all((root / name).is_file() for name in ("TLI_Uninstall.ps1", "Uninstall_TLI.bat"))
    supported = system == "Windows" and available and not checkout
    if checkout:
        reason = "Automatic folder deletion is unavailable for a source checkout. Stop TLI and review its files before removing the project folder manually."
    elif system != "Windows":
        reason = "Automatic uninstall is currently available for Windows releases. Follow the manual removal steps on this host."
    elif not available:
        reason = "This copy does not include the Windows uninstaller. Use the manual removal steps below."
    else:
        reason = "Run the uninstaller on the computer hosting this TLI."
    return {
        "platform": system,
        "installation_path": str(root),
        "supported": supported,
        "entrypoint": str(root / "Uninstall_TLI.bat") if supported else None,
        "registered": windows_registered(root) if system == "Windows" and os.name == "nt" else False,
        "reason": reason,
    }
