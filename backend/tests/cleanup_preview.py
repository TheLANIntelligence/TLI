"""Disposable reviewed-cleanup UI. All moves use a fake Trash within TEST_ROOT."""
import conftest as isolation
import pytest
import uvicorn
from pathlib import Path
from types import SimpleNamespace
import psutil
import tli_state as S
from routers import dashboard_presence as dp, system_routes, visualizer, file_routes


if __name__ == "__main__":
    patches = pytest.MonkeyPatch()
    isolation.isolated_background_services.__wrapped__(patches)
    system_routes._ONBOARDING_COMPLETE_FILE.write_text("{}")
    home = isolation.TEST_ROOT / "demo-files"
    home.mkdir()
    trash = isolation.TEST_ROOT / "fake-trash"
    trash.mkdir()
    for name, content in [("Archive copy A.bin", b"duplicate" * 8192), ("Archive copy B.bin", b"duplicate" * 8192),
                          ("Old installer.bin", b"installer" * 2048), ("Locked recording.wav", b"recording" * 2048)]:
        (home / name).write_bytes(content)
    protected = home / "Protected application file.txt"
    protected.write_text("Simulated protected file")
    S.BASE_DIR = str(isolation.TEST_ROOT / "installation")
    file_routes._safe_delete_roots = lambda: [home]
    check_path = file_routes._is_protected_path
    file_routes._is_protected_path = lambda p: "Protected application file (preview)" if p == protected else check_path(p)
    def fake_trash(raw):
        source = Path(raw).resolve()
        assert source.is_relative_to(home.resolve())
        if source.name == "Locked recording.wav":
            raise PermissionError("Simulated file-in-use failure. Nothing moved for this file.")
        target = (trash / source.name).resolve()
        assert target.is_relative_to(isolation.TEST_ROOT.resolve())
        source.rename(target)
    file_routes.send2trash = fake_trash
    psutil.cpu_percent = lambda **kw: 15
    psutil.virtual_memory = lambda: SimpleNamespace(total=16*1024**3, used=6*1024**3, available=10*1024**3, percent=37)
    psutil.disk_partitions = lambda **kw: []
    dp._probe_metrics = lambda: {"cpu_pct": 15, "ram_pct": 37, "disk_pct_by_drive": {"C:\\": 40}}
    dp._score_disk_actions = lambda _: None
    visualizer._expand_user_path = lambda raw: home  # every scanner stays in demo files
    visualizer.get_cleanup_targets = lambda: []
    visualizer._enumerate_drives = lambda: []
    print(f"Disposable cleanup files and fake Trash: {isolation.TEST_ROOT}", flush=True)
    uvicorn.run(isolation._main.app, host="127.0.0.1", port=8766, log_level="warning")
