"""Manual browser QA against a disposable installation with inert integrations.

Run: backend/.venv/Scripts/python backend/tests/anniversary_preview.py
Serves only loopback port 8766. All application data goes to the test temp root.
"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import conftest as isolation
from routers import dashboard_presence as dp, system_routes
import pytest
import uvicorn


if __name__ == "__main__":
    patches = pytest.MonkeyPatch()
    isolation.isolated_background_services.__wrapped__(patches)
    system_routes._ONBOARDING_COMPLETE_FILE.write_text("{}")
    from intelligence import diagnostics, devices, models
    from types import SimpleNamespace
    patches.setattr(diagnostics, "gateway", lambda: "192.0.2.1")
    patches.setattr(diagnostics, "ping", lambda ip: ("pass", "Demo gateway answered (simulated)."))
    patches.setattr(diagnostics, "tcp", lambda *a: ("fail", "Demo service is unavailable (simulated)."))
    patches.setattr(diagnostics, "resolve_hostname", lambda host: "192.0.2.10")
    patches.setattr(diagnostics.psutil, "net_if_stats", lambda: {})
    patches.setattr(diagnostics.psutil, "net_if_addrs", lambda: {})
    patches.setattr(diagnostics.psutil, "cpu_percent", lambda **kw: 15)
    patches.setattr(diagnostics.psutil, "virtual_memory", lambda: SimpleNamespace(percent=35, total=16*1024**3, used=6*1024**3, available=10*1024**3))
    patches.setattr(diagnostics.psutil, "disk_partitions", lambda **kw: [])

    from routers import visualizer
    patches.setattr(visualizer, "_enumerate_drives", lambda: [{
        "mountpoint": "C:\\", "device": "C:\\", "label": "Preview drive", "drive_type": "fixed",
        "percent_used": 96, "free_human": "20 GB", "used_human": "480 GB", "total_human": "500 GB",
    }])
    patches.setattr(visualizer, "get_cleanup_targets", lambda: [{
        "label": "Downloads", "path": "C:\\Users", "exists": True, "size_bytes": 3 * 1024**3,
        "size_partial": True, "size_meta": {"partial": True, "time_limited": True},
        "safety": "manual", "tip": "Simulated downloads for layout review.", "how": "Review files you no longer need.",
    }, {
        "label": "Unreadable preview folder", "path": "C:\\Preview\\Long folder name used to check phone layout\\Unavailable",
        "exists": None, "size_bytes": 0, "size_partial": True, "size_meta": {"partial": True, "denied": 1},
        "safety": "manual", "tip": "Simulated access failure; no real files are read.", "how": "Check access before retrying.",
    }])
    def preview_scan(root, **kwargs):
        base = str(root)
        children = [
            {"name": "hiberfil.sys", "path": base + "\\hiberfil.sys", "size": 25 * 1024**3, "protected": True},
            {"name": "Downloads", "path": base + "\\Downloads", "size": 4 * 1024**3, "children": [
                {"name": "Instrument Library 1.bin", "path": base + "\\Downloads\\Instrument Library 1.bin", "size": 2 * 1024**3},
                {"name": "Project archive.zip", "path": base + "\\Downloads\\Project archive.zip", "size": 1024**3},
                {"name": "Recording session.wav", "path": base + "\\Downloads\\Recording session.wav", "size": 1024**3},
            ]},
        ]
        return ({"name": base, "path": base, "size": 29 * 1024**3, "children": children}, [],
                {"root": base, "files": 4, "partial": True, "denied": 3, "skipped": 2})
    patches.setattr(visualizer, "_scan_tree", preview_scan)
    def preview_large_files(root, min_bytes, limit):
        from fastapi import HTTPException
        if min_bytes >= 500 * 1024**2:
            raise HTTPException(503, "Simulated large-file search failure")
        return ([{"name": "Preview recording with a long descriptive name.wav",
                  "path": "C:\\Preview\\Recording sessions and archives\\Preview recording with a long descriptive name.wav",
                  "size": 1024**3}],
                {"root": str(root), "partial": True, "time_limited": True, "denied": 1,
                 "found": 3, "returned": 1, "total_bytes": 1024**3, "seconds": 15})
    patches.setattr(visualizer, "_collect_large_files", preview_large_files)
    patches.setattr(visualizer, "_find_duplicates", lambda root: ([{
        "size": 8192, "count": 2, "wasted_bytes": 8192, "verified": True,
        "paths": ["C:\\Preview\\Original\\demo.bin", "C:\\Preview\\Backup\\demo.bin"],
    }], {"verification": "full_sha256", "partial": True, "time_limited": True,
         "groups_found": 1, "total_wasted_bytes": 8192, "total_wasted_mb": 0.008, "seconds": 15}))

    patches.setattr(dp, "_probe_metrics", lambda: {
        "cpu_pct": 15, "ram_pct": 35, "disk_pct_by_drive": {"C:\\": 40}})
    patches.setattr(dp, "_score_disk_actions", lambda _: None)
    dp._action_queue.append(dp._make_action("Review storage", "Preview action: opens the storage panel.",
                                           "Review", "open_visualizer", 100))
    dp._action_queue.append(dp._make_action("Retry unavailable device", "Preview action: returns a controlled failure.",
                                           "Try", "preview_unavailable", 50))
    print(f"Disposable preview data: {isolation.TEST_ROOT}", flush=True)
    uvicorn.run(isolation._main.app, host="127.0.0.1", port=8766, log_level="warning")
