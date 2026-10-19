"""Synthetic correctness benchmark; optional explicit single-record live probe.

Default work creates in-memory fixture records only. No attached drive is
enumerated. The CLI intentionally has no whole-live-volume acquisition mode.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import struct
import sys
import tempfile
import time
import tracemalloc

from storage_ntfs import (Extent, ExtentReader, FileReference, Geometry, NtfsError,
                          acquire, parse_record)


def resident_attribute(kind, value, *, name="", instance=0):
    encoded = name.encode("utf-16-le")
    value_offset = (24 + len(encoded) + 7) & ~7
    length = (value_offset + len(value) + 7) & ~7
    data = bytearray(length)
    struct.pack_into("<IIBBHHH", data, 0, kind, length, 0, len(encoded) // 2, 24 if name else 0, 0, instance)
    struct.pack_into("<IH", data, 16, len(value), value_offset)
    data[24:24 + len(encoded)] = encoded
    data[value_offset:value_offset + len(value)] = value
    return bytes(data)


def filename_attribute(name, *, parent=FileReference(5, 1), namespace=1, instance=0):
    encoded = name.encode("utf-16-le")
    value = bytearray(66 + len(encoded))
    struct.pack_into("<Q", value, 0, parent.value)
    struct.pack_into("<BB", value, 64, len(encoded) // 2, namespace)
    value[66:] = encoded
    return resident_attribute(0x30, value, instance=instance)


def nonresident_attribute(logical, *, name="", lcn=1024, clusters=1, flags=0,
                          instance=1, runs=None, lowest=0, physical=None):
    encoded = name.encode("utf-16-le")
    header = 72 if flags & 0x8001 else 64
    pairs_offset = (header + len(encoded) + 7) & ~7
    if runs is None:
        # Fixed-width positive LCN keeps the fixture encoding transparent.
        runs = b"\x44" + struct.pack("<Ii", clusters, lcn) + b"\0"
    length = (pairs_offset + len(runs) + 7) & ~7
    data = bytearray(length)
    struct.pack_into("<IIBBHHH", data, 0, 0x80, length, 1, len(encoded) // 2,
                     header if name else 0, flags, instance)
    struct.pack_into("<QQH", data, 16, lowest, lowest + clusters - 1, pairs_offset)
    struct.pack_into("<qqq", data, 40, clusters * 4096, logical, logical)
    if header == 72:
        struct.pack_into("<q", data, 64, physical if physical is not None else clusters * 4096)
    data[header:header + len(encoded)] = encoded
    data[pairs_offset:pairs_offset + len(runs)] = runs
    return bytes(data)


def file_record(attributes=(), *, index=16, sequence=1, links=1, directory=False,
                in_use=True, base=0, record_bytes=1024, sector_bytes=512):
    data = bytearray(record_bytes)
    count = record_bytes // sector_bytes + 1
    attr_offset = (48 + count * 2 + 7) & ~7
    body = b"".join(attributes) + struct.pack("<I", 0xffffffff)
    if attr_offset + len(body) > record_bytes:
        raise ValueError("Fixture record is too large")
    data[:4] = b"FILE"
    struct.pack_into("<HH", data, 4, 48, count)
    struct.pack_into("<HHHHIIQ", data, 16, sequence, links, attr_offset,
                     int(in_use) | (2 if directory else 0), attr_offset + len(body), record_bytes, base)
    struct.pack_into("<I", data, 44, index)
    data[attr_offset:attr_offset + len(body)] = body
    sequence_word = b"\xa5\x5a"
    data[48:50] = sequence_word
    for sector in range(1, count):
        tail = sector * sector_bytes - 2
        data[48 + 2 * sector:50 + 2 * sector] = data[tail:tail + 2]
        data[tail:tail + 2] = sequence_word
    return bytes(data)


class SyntheticReader:
    """Virtual volume holding two fragmented MFT extents, generated on demand."""
    def __init__(self, records=10_000):
        if not 32 <= records <= 100_000:
            raise ValueError("Use 32 through 100000 synthetic records")
        self.count = records
        clusters = (records * 1024 + 4095) // 4096
        split = max(1, clusters // 2)
        self.geometry = Geometry(0x544c4954455354, 4_000_000, 500_000, 512, 4096, 1024, records * 1024, 32)
        self.extents = (Extent(0, split, 32), Extent(split, clusters, 32 + clusters + 7))
        self.reader = ExtentReader(self.geometry, self.extents, self._physical_read)

    def _record(self, index):
        if index == 5:
            return file_record([filename_attribute(".")], index=5, directory=True)
        if index < 16:
            return file_record(index=index, in_use=False, links=0)
        names = [filename_attribute(f"file-{index:06}.bin")]
        links = 1
        if index == 16:
            names.append(filename_attribute("alias.bin", instance=2))
            links = 2
        attrs = names + [nonresident_attribute(100 + index % 1000, lcn=100_000 + index)]
        if index == 17:
            attrs.append(resident_attribute(0x80, b"alternate", name="notes", instance=2))
        return file_record(attrs, index=index, links=links)

    def _physical_read(self, offset, size):
        for extent in self.extents:
            start = extent.lcn * 4096
            if start <= offset and offset + size <= start + (extent.next_vcn - extent.vcn) * 4096:
                logical = extent.vcn * 4096 + offset - start
                first, last = logical // 1024, (logical + size + 1023) // 1024
                data = b"".join(self._record(i) for i in range(first, last))
                local = logical % 1024
                return data[local:local + size]
        raise NtfsError("fixture_read_outside_extent")

    @property
    def bytes_read(self):
        return self.reader.bytes_read

    def read_record(self, index):
        return self.reader.read(index * 1024, 1024)

    def revalidate(self):
        return True


def synthetic_benchmark(records=10_000):
    reader = SyntheticReader(records)
    totals = {"files": 0, "logical_bytes": 0, "allocated_bytes": 0, "named_stream_bytes": 0, "names": 0}
    def sink(record):
        if record.directory:
            return
        totals["files"] += 1
        totals["names"] += len([n for n in record.names if n["namespace"] != 2])
        totals["logical_bytes"] += record.logical_size
        totals["allocated_bytes"] += record.allocated_size
        totals["named_stream_bytes"] += sum(s["logical_size"] for s in record.streams if s["name"])
    tracemalloc.start()
    started = time.perf_counter()
    meta = acquire(reader, sink, max_records=records, max_seconds=3600)
    elapsed = time.perf_counter() - started
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    peak_process = None
    try:
        import psutil
        peak_process = getattr(psutil.Process().memory_info(), "peak_wset", None)
    except (ImportError, OSError):
        pass
    expected = {"files": records - 16, "names": records - 15,
                "logical_bytes": sum(100 + i % 1000 for i in range(16, records)),
                "allocated_bytes": (records - 16) * 4096, "named_stream_bytes": 9}
    passed = totals == expected and meta["acquisition_complete"] and meta["records_retained"] == records - 15
    return {"benchmark": "synthetic_ntfs_parser_v1", "correct": passed,
            "environment": {"python": platform.python_version(), "platform": platform.platform()},
            "scope": "generated_records_only", "records": records, "totals": totals, "expected": expected,
            "wall_seconds": elapsed, "peak_python_bytes": peak, "peak_process_rss_bytes": peak_process,
            "memory_scope": "Python allocations during fixture; process peak is process lifetime when available",
            "acquisition": meta,
            "indexing_seconds": None, "index_bytes": None,
            "comparison": "No live filesystem speed or inventory completeness claim."}


def owned_files_probe():
    """Create two files and one alias; request only those exact file IDs.

    No elevation, drive discovery, $MFT mapping or unrelated record reads.
    TemporaryDirectory removes the owned fixture even on access denial.
    """
    if os.name != "nt":
        return {"probe": "owned_files_only", "reason": "platform_not_windows", "production_accepted": False}
    import ctypes
    from storage_ntfs_windows import WindowsRecordProbe
    from storage_scan_algorithms import _scan_tree
    admin = bool(ctypes.windll.shell32.IsUserAnAdmin())
    result = {"probe": "owned_files_only", "administrator": admin, "production_accepted": False,
              "observed_at": datetime.now(timezone.utc).isoformat(),
              "environment": {"python": platform.python_version(), "platform": platform.platform()},
              "requested_records": 0, "parsed_records": 0, "bytes_read": 0,
              "whole_volume_enumeration": False}
    with tempfile.TemporaryDirectory(prefix="tli-ntfs-owned-fixture-") as directory:
        folder = Path(directory)
        files = [folder / "small.bin", folder / "large.bin"]
        files[0].write_bytes(b"s" * 128)
        files[1].write_bytes(b"l" * 8192)
        os.link(files[1], folder / "large-alias.bin")
        with open(str(files[0]) + ":notes", "wb") as stream:
            stream.write(b"alternate")
        expected = {path.stat().st_ino: path.stat().st_size for path in files}
        result.update(fixture_files=len(expected), expected_logical_bytes=sum(expected.values()))
        directory_started = time.perf_counter()
        tree, _, directory_meta = _scan_tree(folder, noisy_names=set(), max_entries=32, max_depth=4, max_seconds=10)
        result["directory"] = {"seconds": time.perf_counter() - directory_started, "logical_bytes": tree["size"],
                               "allocated_bytes": tree.get("allocated_size"), "names": tree["files"],
                               "partial": directory_meta["partial"], "hardlinks_skipped": directory_meta["hardlinks_skipped"]}
        native_started = time.perf_counter()
        try:
            with WindowsRecordProbe(folder.anchor) as reader:
                observed = allocation = names = named_stream_bytes = 0
                for reference, size in expected.items():
                    result["requested_records"] += 1
                    raw = reader.get_record_response(reference & ((1 << 48) - 1))
                    result["bytes_read"] = reader.bytes_read
                    record = parse_record(raw, reader.geometry, reference & ((1 << 48) - 1),
                                          expected_reference=reference, source="ioctl")
                    if record.logical_size != size or not record.complete:
                        raise NtfsError("owned_fixture_record_mismatch")
                    observed += record.logical_size
                    allocation += record.allocated_size
                    names += len([name for name in record.names if name["namespace"] != 2])
                    named_stream_bytes += sum(stream["logical_size"] for stream in record.streams if stream["name"])
                    result["parsed_records"] += 1
                result.update(bytes_read=reader.bytes_read, observed_logical_bytes=observed,
                              observed_allocated_bytes=allocation, observed_names=names,
                              named_stream_bytes=named_stream_bytes, expected_named_stream_bytes=9,
                              geometry_unchanged=reader.revalidate(), reason=None,
                              correctness=observed == sum(expected.values()) == tree["size"] and
                                          allocation == tree.get("allocated_size") and names == tree["files"] and
                                          named_stream_bytes == 9 and not directory_meta["partial"])
                if not result["correctness"]:
                    result["reason"] = "fixture_accounting_mismatch"
        except (NtfsError, OSError) as error:
            result["reason"] = getattr(error, "reason", "native_io_failed")
        result["native_control_seconds"] = time.perf_counter() - native_started
        result["comparison_scope"] = "Same two controlled file identities, three aliases; unnamed-stream bytes deduplicated."
        result["validation_limit"] = "Exact-record control probe; fragmented raw MFT acquisition and filesystem-wide speed remain unvalidated."
    result["fixture_removed"] = True
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--synthetic", action="store_true", help="Run generated metadata fixture (the default).")
    parser.add_argument("--records", type=int, default=10000)
    parser.add_argument("--probe-volume", help="Explicit disposable fixture drive root, for a single-record probe only.")
    parser.add_argument("--probe-owned-files", action="store_true", help="Create temporary fixture; probe only its exact file IDs.")
    parser.add_argument("--record", type=int, default=5, help="Fixture record index; default 5 is the NTFS root.")
    parser.add_argument("--confirm-fixture-volume", action="store_true")
    args = parser.parse_args(argv)
    if args.probe_owned_files:
        if args.probe_volume or args.synthetic:
            parser.error("Choose one probe/benchmark mode.")
        result = owned_files_probe()
    elif args.probe_volume:
        if not args.confirm_fixture_volume or args.synthetic or not 0 <= args.record < 1 << 48:
            parser.error("A live probe requires --confirm-fixture-volume and a valid record index.")
        from storage_ntfs_windows import WindowsVolumeReader
        try:
            with WindowsVolumeReader(args.probe_volume) as reader:
                record = parse_record(reader.read_record(args.record), reader.geometry, args.record)
                result = {"probe": "single_record_only", "geometry": asdict(reader.geometry),
                          "record": asdict(record), "bytes_read": reader.bytes_read,
                          "geometry_unchanged": reader.revalidate(), "production_accepted": False}
        except (NtfsError, OSError) as error:
            result = {"probe": "unavailable", "reason": getattr(error, "reason", "native_io_failed"),
                      "production_accepted": False}
            print(json.dumps(result, indent=2))
            return 2
    else:
        result = synthetic_benchmark(args.records)
    print(json.dumps(result, indent=2))
    return 0 if result.get("correct", result.get("correctness", True)) else 1


if __name__ == "__main__":
    sys.exit(main())
