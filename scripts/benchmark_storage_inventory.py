"""Reproducible controlled-folder acquisition/index benchmark; no drive scans.

Run with the backend's Python environment. Only a new temporary fixture is read.
No application startup, user state, model or cleanup service is imported.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import storage_scan_algorithms as algorithms
import storage_scan_process as transport
from storage_engines import select_engine
from storage_inventory import StorageInventory
from storage_scan_worker import validate_request


def run(count):
    import psutil
    report = {"fixture_only": True, "python": sys.version, "platform": platform.platform(),
              "engine_comparison": "Raw NTFS is gated; timings below measure directory acquisition and indexing only.",
              "atomic_snapshot": False}
    with tempfile.TemporaryDirectory(prefix="tli-inventory-benchmark-") as temporary:
        base = Path(temporary)
        root = base / "fixture"
        root.mkdir()
        expected = 0
        for i in range(count):
            folder = root / f"folder-{i % 50:02}"
            folder.mkdir(exist_ok=True)
            payload = bytes([i % 251]) * (32 + i % 481)
            (folder / f"item-{i:06}.bin").write_bytes(payload)
            expected += len(payload)
        deep = root
        for i in range(12):
            deep = deep / f"depth-{i}"
            deep.mkdir()
        (deep / "small.txt").write_bytes(b"depth")
        expected += 5
        (root / "empty").mkdir()
        aliases = 0
        try:
            os.link(root / "folder-00" / "item-000000.bin", root / "alias.bin")
            aliases = 1
        except OSError:
            pass
        # Streams deliberately outside the directory engine's data contract.
        streams_created = False
        if os.name == "nt":
            try:
                Path(str(root / "alias.bin" if aliases else root / "folder-00" / "item-000000.bin") + ":fixture-stream").write_bytes(b"stream")
                streams_created = True
            except OSError:
                pass
        own = psutil.Process()
        peak = [own.memory_info().rss]
        sample_stop = threading.Event()
        def sample():
            while not sample_stop.wait(.01):
                peak[0] = max(peak[0], own.memory_info().rss)
        sampler = threading.Thread(target=sample, daemon=True)
        sampler.start()
        store = StorageInventory(base / "indexes")
        writer = store.begin("controlled-benchmark", str(root))
        ingest = [0.0]
        batch = []
        def flush():
            if batch:
                started = time.perf_counter()
                writer.add_rows(batch)
                ingest[0] += time.perf_counter() - started
                batch.clear()
        def sink(row):
            batch.append(row)
            if len(batch) == 128:
                flush()
        started = time.perf_counter()
        tree, largest, meta = select_engine(root).scan(root, max_entries=count + 200,
            max_depth=30, max_seconds=300, max_nodes=25000, noisy_names=set(), inventory_sink=sink)
        flush()
        wall = time.perf_counter() - started
        assert not meta["partial"], meta
        assert tree["size"] == expected, (tree["size"], expected)
        started = time.perf_counter()
        summary = writer.finalize(meta)
        finalization = time.perf_counter() - started
        assert summary["acquisition_complete"] and summary["logical_bytes"] == expected
        assert summary["indexed_files"] == count + 1 + aliases
        queries = []
        for mode, options in (("children", {}), ("search", {"search": "item-"}),
                              ("extension", {"extension": ".bin"}), ("largest", {}),
                              ("item", {"path": str(deep / "small.txt")})):
            started = time.perf_counter()
            page = store.query("controlled-benchmark", writer.scan_id, mode=mode, **options)
            queries.append({"mode": mode, "seconds": time.perf_counter() - started,
                            "rows": len(page["rows"]), "total": page["total"],
                            "response_bytes": len(json.dumps(page).encode("utf-8"))})
        sample_stop.set()
        sampler.join(1)
        # Exercise the real isolation and streaming protocol against exactly the
        # same fixture. This result is not used as the primary correctness oracle.
        streamed = [0]
        request = validate_request({"operation": "scan", "path": str(root), "profile": "deep",
                                    "include_excluded": True, "inventory_version": 1})
        def receive(frame):
            if frame["type"] == "inventory_rows":
                streamed[0] += len(frame["rows"])
        started = time.perf_counter()
        worker = transport.run(request, threading.Event(), lambda _: None, lambda: True, inventory=receive)
        worker_seconds = time.perf_counter() - started
        assert worker["type"] == "result", worker
        assert worker["result"]["tree"]["size"] == expected
        assert streamed[0] == summary["indexed_count"]
        cancel = threading.Event()
        cancel_requested = []
        def progress(value):
            if not cancel_requested:
                cancel_requested.append(time.perf_counter())
                cancel.set()
        cancelled = transport.run(request, cancel, progress, lambda: True)
        cancel_latency = time.perf_counter() - cancel_requested[0] if cancel_requested else None
        assert cancelled["worker_stopped"] and cancelled["type"] in {"cancelled", "result"}, cancelled
        def nodes(node):
            return 1 + sum(nodes(child) for child in node.get("children", []))
        report.update({"generated_files": count + 1 + aliases, "hardlink_aliases": aliases,
            "alternate_stream_fixture": streams_created, "expected_logical_bytes": expected,
            "measured_logical_bytes": tree["size"], "measured_allocated_bytes": tree["allocated_size"],
            "acquisition_seconds_excluding_index_callbacks": round(wall - ingest[0], 6),
            "index_ingest_seconds": round(ingest[0], 6), "index_finalize_seconds": round(finalization, 6),
            "combined_seconds": round(wall + finalization, 6), "sampled_parent_peak_rss_bytes": peak[0],
            "entries_examined": meta.get("entries_seen"), "retained_tree_nodes": nodes(tree),
            "display_truncated": meta.get("representation_limited"), "indexed_count": summary["indexed_count"],
            "index_bytes": summary["index_bytes"], "acquisition_complete": summary["acquisition_complete"],
            "scanner": meta["scanner"], "query_metrics": queries,
            "worker_seconds_without_index_writer": round(worker_seconds, 6),
            "worker_streamed_rows": streamed[0], "cancellation_seconds": round(cancel_latency, 6) if cancel_latency is not None else None,
            "worker_stop_confirmed": cancelled["worker_stopped"],
            "limitations": ["Peak RSS is sampled for the benchmark parent; it is not the worker Job Object memory peak.",
                "Allocated totals exclude named streams and filesystem metadata; logical expected totals use unnamed file data only.",
                "Acquisition time excludes measured index callbacks but includes sink serialization preparation.",
                "This is a warm-cache controlled fixture, not a whole-drive or raw-NTFS performance claim."]})
        store.delete("controlled-benchmark", writer.scan_id)
        assert not list((base / "indexes").rglob("*.sqlite"))
        report["index_cleanup_confirmed"] = True
    assert "main" not in sys.modules and "tli_state" not in sys.modules
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--files", type=int, default=3000)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.files <= 100000:
        parser.error("--files must be between 1 and 100000")
    report = run(args.files)
    rendered = json.dumps(report, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
