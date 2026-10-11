"""Disposable model-library UI fixture. No real models, probes or downloads."""
import conftest as isolation  # isolation must precede application imports
from pathlib import Path
import uvicorn
from ai import ai_manager as am, ai_routes
from ai.model_library import GIB


if __name__ == "__main__":
    from routers import dashboard_presence as dp
    from types import SimpleNamespace
    import psutil
    isolation._main.start_background_loops = lambda: None
    isolation._main._cleanup_start = lambda: None
    isolation._main._cleanup_stop = lambda: None
    isolation._main.lan_discovery.start = lambda: None
    isolation._main.lan_discovery.stop = lambda: None
    async def no_ambient(): return
    isolation._main.run_ambient_loop = no_ambient
    psutil.cpu_percent = lambda **kwargs: 15
    psutil.virtual_memory = lambda: SimpleNamespace(total=16*GIB, available=10*GIB, used=6*GIB, percent=37)
    psutil.disk_partitions = lambda **kwargs: []
    dp._probe_metrics = lambda: {"cpu_pct": 15, "ram_pct": 37, "disk_pct_by_drive": {"C:\\": 40}}
    mgr = am.BundledAIManager.get()
    mgr._active_preset = "standard"
    mgr.cfg.model_path = isolation.TEST_ROOT / "example.gguf"
    def compatibility(pid):
        p = am.MODEL_PRESETS[pid]
        state = {"lite": "compatible", "standard": "compatible", "power": "insufficient_resources", "vision": "unknown"}.get(pid, "unsupported" if pid == "qwen3_8b" else "compatible")
        return {"state": state, "selectable": state == "compatible", "download_allowed": state != "unsupported",
                "runtime": {"reason": "Preview runtime: required controls available."},
                "download_reason": "Preview: this runtime is too old for this model." if state == "unsupported" else "",
                "download_bytes": p["size_bytes"], "context_size": 4096, "execution_mode": "CPU",
                "required_total_ram_gb": p["min_ram_gb"], "required_available_ram_bytes": 5 * GIB,
                "reasons": [{"compatible": "Meets conservative resource estimates.", "insufficient_resources": "Needs more available RAM. Close other apps and recheck.", "unknown": "Memory probe unavailable. Explicit compatibility check required.", "unsupported": "Preview runtime does not support this model."}[state]],
                "installation": {"complete": True, "components": [{"filename": p["filename"], "valid": True, "size_bytes": p["size_bytes"]}]}}
    mgr.compatibility = compatibility
    mgr.switch_model = lambda *args, **kwargs: {"ok": False, "error": "Simulated startup failure.",
        "recovery": {"attempted": True, "restored": True}}
    def no_download(*args, **kwargs):
        raise RuntimeError("Downloads are disabled in this preview")
    ai_routes.downloads.run = no_download
    print(f"Disposable model preview: {isolation.TEST_ROOT}", flush=True)
    uvicorn.run(isolation._main.app, host="127.0.0.1", port=8766, log_level="warning")
