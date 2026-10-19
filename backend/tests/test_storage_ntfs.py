"""Synthetic metadata fixtures only. Never opens a real device/volume."""
from dataclasses import replace
import struct

import pytest

import storage_ntfs as ntfs
from storage_ntfs_benchmark import (SyntheticReader, file_record, filename_attribute,
                                    nonresident_attribute, resident_attribute, synthetic_benchmark)


@pytest.fixture
def geometry():
    return SyntheticReader(32).geometry


def parse(geometry, attrs=None, **kwargs):
    if attrs is None:
        attrs = [filename_attribute("hello.bin"), nonresident_attribute(123)]
    index = kwargs.pop("index", 16)
    return ntfs.parse_record(file_record(attrs, index=index, **kwargs), geometry, index)


def patched_record(raw, offset, fmt, *values):
    # Edits below intentionally do not touch sector tails; this preserves fixups.
    changed = bytearray(raw)
    struct.pack_into(fmt, changed, offset, *values)
    return bytes(changed)


def test_geometry_identity_and_extended_buffer(geometry):
    raw = bytearray(128)
    struct.pack_into("<Qqq", raw, 0, geometry.serial, geometry.sectors, geometry.clusters)
    struct.pack_into("<IIII", raw, 40, geometry.sector_bytes, geometry.cluster_bytes, geometry.record_bytes, 1)
    struct.pack_into("<qq", raw, 56, geometry.mft_bytes, geometry.mft_start_lcn)
    struct.pack_into("<IHH", raw, 96, 32, 3, 1)
    assert ntfs.Geometry.from_volume_data(raw) == geometry
    assert geometry.identity == "ntfs:00544c4954455354"
    with pytest.raises(ntfs.NtfsError, match="missing_ntfs_version"):
        ntfs.Geometry.from_volume_data(raw[:96])


@pytest.mark.parametrize("changes, reason", [
    ({"sector_bytes": 0}, "unsupported_sector_size"),
    ({"cluster_bytes": 6000}, "invalid_cluster_size"),
    ({"record_bytes": 1536}, "unsupported_record_size"),
    ({"mft_bytes": 1025}, "invalid_mft_length"),
    ({"clusters": 1 << 63}, "invalid_volume_bounds"),
    ({"mft_start_lcn": -1}, "invalid_mft_location"),
    ({"major": 4}, "unsupported_ntfs_version"),
])
def test_geometry_rejects_unsafe_bounds(geometry, changes, reason):
    with pytest.raises(ntfs.NtfsError, match=reason):
        replace(geometry, **changes)


def test_extent_pages_trim_rounded_down_start():
    raw = struct.pack("<I4xq", 2, 4) + struct.pack("<qqqq", 10, 100, 14, 300)
    assert ntfs.parse_retrieval_pointers(raw, 7, 1000) == [ntfs.Extent(7, 10, 103), ntfs.Extent(10, 14, 300)]
    with pytest.raises(ntfs.NtfsError, match="extent_no_progress"):
        ntfs.parse_retrieval_pointers(raw, 14, 1000)
    with pytest.raises(ntfs.NtfsError, match="extent_outside_volume"):
        ntfs.parse_retrieval_pointers(raw, 4, 200)
    with pytest.raises(ntfs.NtfsError, match="invalid_extent_count"):
        ntfs.parse_retrieval_pointers(raw[:-1], 4, 1000)


def test_fragmented_reader_crosses_extents_and_has_strict_limits(geometry):
    geometry = replace(geometry, mft_bytes=8192)
    volume = bytearray(50000)
    volume[4096:8192] = b"a" * 4096
    volume[32768:36864] = b"b" * 4096
    reads = []
    def read(offset, size):
        reads.append((offset, size))
        return bytes(volume[offset:offset + size])
    reader = ntfs.ExtentReader(geometry, [ntfs.Extent(0, 1, 1), ntfs.Extent(1, 2, 8)], read)
    assert reader.read(3584, 1024) == b"a" * 512 + b"b" * 512
    assert reads == [(7680, 512), (32768, 512)]
    assert reader.bytes_read == 1024
    with pytest.raises(ntfs.NtfsError, match="read_outside_mft"):
        reader.read(8000, 1024)
    with pytest.raises(ntfs.NtfsError, match="sparse_mft_unsupported"):
        ntfs.ExtentReader(geometry, [ntfs.Extent(0, 2, None)], read)
    with pytest.raises(ntfs.NtfsError, match="mft_extent_gap_or_overlap"):
        ntfs.ExtentReader(geometry, [ntfs.Extent(1, 2, 1)], read)
    with pytest.raises(ntfs.NtfsError, match="mft_extent_incomplete"):
        ntfs.ExtentReader(geometry, [ntfs.Extent(0, 1, 1)], read)


def test_short_volume_reads_never_produce_padded_records(geometry):
    reader = ntfs.ExtentReader(geometry, [ntfs.Extent(0, 8, 32)], lambda *_: b"x")
    with pytest.raises(ntfs.NtfsError, match="short_volume_read"):
        reader.read(0, 1024)
    assert reader.bytes_read == 0


def test_record_fixups_and_resident_streams(geometry):
    record = parse(geometry, [filename_attribute("hello.bin"), resident_attribute(0x80, b"hello", instance=1)])
    assert record.reference == ntfs.FileReference(16, 1)
    assert record.logical_size == 5 and record.allocated_size == 5 and record.complete
    assert record.streams[0]["data_cluster_bytes"] == 0
    assert record.names[0]["parent"] == ntfs.FileReference(5, 1)
    raw = file_record([filename_attribute("a"), resident_attribute(0x80, b"x", instance=1)])
    broken = bytearray(raw)
    broken[510:512] = b"xx"
    with pytest.raises(ntfs.NtfsError, match="torn_record_fixup"):
        ntfs.parse_record(bytes(broken), geometry, 16)
    with pytest.raises(ntfs.NtfsError, match="invalid_record_boundary"):
        ntfs.parse_record(raw[:-1], geometry, 16)
    with pytest.raises(ntfs.NtfsError, match="wrong_record_identity"):
        ntfs.parse_record(raw, geometry, 16, expected_reference=ntfs.FileReference(16, 2).value)


def test_restored_control_records_require_explicit_transport_and_consistent_tails(geometry):
    raw = file_record([filename_attribute("a"), nonresident_attribute(12)])
    restored = ntfs.apply_fixups(raw, 512)
    with pytest.raises(ntfs.NtfsError, match="torn_record_fixup"):
        ntfs.parse_record(restored, geometry, 16)
    assert ntfs.parse_record(restored, geometry, 16, source="ioctl").logical_size == 12
    mixed = bytearray(restored)
    mixed[510:512] = raw[510:512]
    with pytest.raises(ntfs.NtfsError, match="torn_record_fixup"):
        ntfs.parse_record(bytes(mixed), geometry, 16, source="ioctl")


@pytest.mark.parametrize("offset,fmt,values,reason", [
    (4, "HH", (1020, 3), "invalid_fixup_array"),
    (20, "H", (48,), "invalid_record_layout"),
    (24, "I", (2048,), "invalid_record_layout"),
    (28, "I", (512,), "invalid_record_layout"),
    (22, "H", (0x11,), "unsupported_record_flags"),
    (60, "I", (0,), "invalid_attribute_layout"),
    (64, "B", (2,), "invalid_attribute_layout"),
])
def test_record_structural_corruption_is_rejected(geometry, offset, fmt, values, reason):
    raw = file_record([filename_attribute("a"), nonresident_attribute(12)])
    with pytest.raises(ntfs.NtfsError, match=reason):
        ntfs.parse_record(patched_record(raw, offset, fmt, *values), geometry, 16)


def test_deleted_records_do_not_parse_stale_attributes(geometry):
    record = parse(geometry, [b"not an attribute"], in_use=False, links=0)
    assert not record.in_use and not record.names and not record.streams


def test_sparse_and_compressed_streams_use_physical_runs(geometry):
    # one allocated cluster at LCN 100, one sparse cluster: 8192 logical / 4096 physical.
    runs = b"\x11\x01\x64\x01\x01\0"
    for flags in (0x8000, 1):
        record = parse(geometry, [filename_attribute("data"), nonresident_attribute(
            8192, clusters=2, flags=flags, runs=runs, physical=4096)])
        assert record.complete and record.logical_size == 8192 and record.allocated_size == 4096
    mismatch = parse(geometry, [filename_attribute("data"), nonresident_attribute(
        8192, clusters=2, flags=0x8000, runs=runs, physical=8192)])
    assert mismatch.allocated_size is None and "stream_allocation_mismatch" in mismatch.limitations


def test_mapping_pairs_signed_deltas_and_malformed_bounds():
    runs = b"\x11\x02\x64\x11\x01\xf6\0"
    assert ntfs.parse_mapping_pairs(runs, 0, 2, 1000) == [ntfs.Extent(0, 2, 100), ntfs.Extent(2, 3, 90)]
    for malformed in (b"\x10", b"\x91\1", b"\x11\0\1\0", b"\x11\1\xff\0", b"\x11\1\1"):
        with pytest.raises(ntfs.NtfsError):
            ntfs.parse_mapping_pairs(malformed, 0, 0, 1000)


def test_alternate_streams_and_hardlinks_preserve_distinct_semantics(geometry):
    record = parse(geometry, [filename_attribute("first.bin"),
                              filename_attribute("alias.bin", instance=2), nonresident_attribute(22),
                              resident_attribute(0x80, b"alternate", name="meta", instance=3)], links=2)
    assert record.complete and len(record.names) == 2
    assert record.logical_size == 22 and record.allocated_size == 4096
    assert record.streams[1]["name"] == "meta" and record.streams[1]["logical_size"] == 9
    missing_alias = parse(geometry, links=2)
    assert "hardlink_names_incomplete" in missing_alias.limitations
    dos = parse(geometry, [filename_attribute("first.bin"), filename_attribute("FIRST~1.BIN", namespace=2, instance=2),
                           nonresident_attribute(22)])
    assert dos.complete


def test_attribute_lists_extension_and_reparse_are_explicit_partial(geometry):
    value = struct.pack("<IHBBQQH6x", 0x80, 32, 0, 0, 0, ntfs.FileReference(17, 2).value, 1)
    record = parse(geometry, [filename_attribute("first.bin"), nonresident_attribute(22),
                              resident_attribute(0x20, value, instance=2)])
    assert not record.complete and record.attribute_list[0]["reference"] == ntfs.FileReference(17, 2)
    assert "attribute_list_unresolved" in record.limitations
    with pytest.raises(ntfs.NtfsError):
        ntfs.parse_attribute_list(value[:-1])
    extension = parse(geometry, base=ntfs.FileReference(15, 2).value)
    assert "extension_record_unresolved" in extension.limitations
    reparse = parse(geometry, [filename_attribute("link"), nonresident_attribute(22),
                               resident_attribute(0xc0, b"reparse", instance=2)])
    assert reparse.reparse and reparse.allocated_size is None and "reparse_excluded" in reparse.limitations
    encrypted = parse(geometry, [filename_attribute("secret"), nonresident_attribute(22, flags=0x4000)])
    assert not encrypted.complete and encrypted.allocated_size is None


def test_duplicate_stream_and_missing_names_never_claim_complete(geometry):
    record = parse(geometry, [filename_attribute("a"), nonresident_attribute(22),
                              resident_attribute(0x80, b"x", instance=2)])
    assert not record.complete and record.logical_size is None and "duplicate_or_split_stream" in record.limitations
    no_name = parse(geometry, [nonresident_attribute(12)])
    assert "file_names_missing" in no_name.limitations


def test_ioctl_wrong_returned_identity_is_rejected(geometry):
    raw = file_record()
    desired = ntfs.FileReference(16, 2).value
    response = struct.pack("<QI", desired, len(raw)) + raw
    assert ntfs.validate_record_response(response, desired, 1024) == raw
    with pytest.raises(ntfs.NtfsError, match="wrong_record_identity"):
        ntfs.validate_record_response(response, desired + 1, 1024)
    with pytest.raises(ntfs.NtfsError, match="invalid_record_response_length"):
        ntfs.validate_record_response(response[:-1], desired, 1024)


def test_parent_sequences_cycles_and_stable_alias_order(geometry):
    root = parse(geometry, [filename_attribute(".")], index=5, directory=True)
    file = parse(geometry, [filename_attribute("z.bin"), filename_attribute("a.bin", instance=2),
                            nonresident_attribute(22)], links=2)
    stale = parse(geometry, [filename_attribute("stale", parent=ntfs.FileReference(5, 2)),
                             nonresident_attribute(12)], index=17)
    cycle = parse(geometry, [filename_attribute("cycle", parent=ntfs.FileReference(18, 1))], index=18, directory=True)
    paths, errors = ntfs.resolve_fixture_paths([root, file, stale, cycle], root.reference.value)
    assert paths[file.reference.value] == ["a.bin", "z.bin"]
    assert errors[stale.reference.value] == "parent_reference_missing_or_stale"
    assert errors[cycle.reference.value] == "parent_cycle"
    with pytest.raises(ntfs.NtfsError, match="relationship_memory_limit"):
        ntfs.resolve_fixture_paths([root, file], root.reference.value, max_records=1)


def test_acquisition_boundaries_partial_sink_and_live_changes():
    records, events = [], []
    reader = SyntheticReader(32)
    meta = ntfs.acquire(reader, records.append, max_records=20, progress=lambda **p: events.append(p))
    assert meta["records_examined"] == 20 and meta["coverage_reasons"] == {"record_limit": 1}
    assert not meta["acquisition_complete"] and meta["fallback_requires_discard"]
    assert events[-1]["records_examined"] == 20 and "bytes_read" in events[-1]
    reader = SyntheticReader(32)
    reader.revalidate = lambda: False
    meta = ntfs.acquire(reader, lambda _: None)
    assert "volume_changed_during_acquisition" in meta["coverage_reasons"]
    assert not meta["inventory_complete"] and meta["observation_semantics"] == "live_non_atomic"


def test_unreadable_and_corrupt_records_are_not_retained():
    reader = SyntheticReader(32)
    read = reader.read_record
    def faulty(index):
        if index == 16:
            raise PermissionError("denied")
        if index == 17:
            return b"x" * 1024
        return read(index)
    reader.read_record = faulty
    records = []
    meta = ntfs.acquire(reader, records.append)
    assert meta["omitted_records"] == 2 and len(records) == 15
    assert meta["coverage_reasons"] == {"invalid_record_signature": 1, "record_read_failed": 1}
    assert not meta["acquisition_complete"]


def test_cancellation_propagates_without_reading_next_record():
    class Cancelled(BaseException):
        pass
    reader = SyntheticReader(32)
    def progress(**values):
        if values.get("records_examined", 0) == 7:
            raise Cancelled()
    with pytest.raises(Cancelled):
        ntfs.acquire(reader, lambda _: None, progress=progress)
    assert reader.bytes_read == 7 * 1024


def test_synthetic_benchmark_has_fixture_oracle_and_no_live_claim():
    result = synthetic_benchmark(32)
    assert result["correct"] and result["totals"] == result["expected"]
    assert result["acquisition"]["records_examined"] == 32
    assert result["acquisition"]["bytes_read"] == 32768
    assert result["scope"] == "generated_records_only"
    assert result["indexing_seconds"] is None
