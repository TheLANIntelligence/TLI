"""Bounded NTFS 3.x metadata parser and fragmented MFT acquisition prototype.

Pure Python; no application imports, raw device opens, or writes occur here.
The caller supplies a read-at function and a record sink. Windows handles live
in storage_ntfs_windows and must only be used in a separately owned process.
All structural errors have stable coverage codes; unsupported metadata never
becomes a complete inventory. Data streams are described, never executed/read.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
import struct
import time

MAX_RECORD = 64 * 1024
MAX_READ = 1024 * 1024
MAX_EXTENTS = 131_072
MAX_INTEGER = (1 << 63) - 1
REFERENCE_MASK = (1 << 48) - 1


class NtfsError(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def _require(condition, reason):
    if not condition:
        raise NtfsError(reason)


def _slice(data, offset, length, reason="truncated_structure"):
    _require(0 <= offset <= len(data) and 0 <= length <= len(data) - offset, reason)
    return data[offset:offset + length]


def _unpack(fmt, data, offset):
    return struct.unpack(fmt, _slice(data, offset, struct.calcsize(fmt)))


def _utf16(data):
    try:
        value = data.decode("utf-16-le", errors="strict")
    except UnicodeError:
        raise NtfsError("unsupported_unicode_name") from None
    _require("\x00" not in value, "invalid_name")
    return value


@dataclass(frozen=True)
class FileReference:
    record: int
    sequence: int

    @classmethod
    def decode(cls, raw):
        _require(0 <= raw < 1 << 64, "invalid_file_reference")
        return cls(raw & REFERENCE_MASK, raw >> 48)

    @property
    def value(self):
        return (self.sequence << 48) | self.record

    @property
    def key(self):
        return f"{self.record}:{self.sequence}"


@dataclass(frozen=True)
class Geometry:
    serial: int
    sectors: int
    clusters: int
    sector_bytes: int
    cluster_bytes: int
    record_bytes: int
    mft_bytes: int
    mft_start_lcn: int
    major: int = 3
    minor: int = 1

    def __post_init__(self):
        _require(0 <= self.serial < 1 << 64, "invalid_volume_identity")
        _require((self.major, self.minor) in {(3, 0), (3, 1)}, "unsupported_ntfs_version")
        _require(512 <= self.sector_bytes <= 4096 and self.sector_bytes & (self.sector_bytes - 1) == 0,
                 "unsupported_sector_size")
        _require(self.sector_bytes <= self.cluster_bytes <= 2 * 1024 * 1024 and
                 self.cluster_bytes & (self.cluster_bytes - 1) == 0, "invalid_cluster_size")
        _require(self.sector_bytes <= self.record_bytes <= MAX_RECORD and
                 self.record_bytes % self.sector_bytes == 0 and
                 self.record_bytes & (self.record_bytes - 1) == 0, "unsupported_record_size")
        _require(0 < self.clusters <= MAX_INTEGER // self.cluster_bytes and
                 self.clusters * self.cluster_bytes <= self.sectors * self.sector_bytes <= MAX_INTEGER,
                 "invalid_volume_bounds")
        _require(self.record_bytes <= self.mft_bytes <= self.clusters * self.cluster_bytes and
                 self.mft_bytes % self.record_bytes == 0, "invalid_mft_length")
        _require(0 <= self.mft_start_lcn < self.clusters, "invalid_mft_location")

    @property
    def identity(self):
        return f"ntfs:{self.serial:016x}"

    @classmethod
    def from_volume_data(cls, data):
        _require(len(data) >= 104, "missing_ntfs_version")
        serial, sectors, clusters = _unpack("<Qqq", data, 0)
        sector, cluster, record, _ = _unpack("<IIII", data, 40)
        mft_bytes, mft_start = _unpack("<qq", data, 56)
        ext_size, major, minor = _unpack("<IHH", data, 96)
        _require(8 <= ext_size <= len(data) - 96, "invalid_extended_geometry")
        return cls(serial, sectors, clusters, sector, cluster, record, mft_bytes, mft_start, major, minor)


@dataclass(frozen=True)
class Extent:
    vcn: int
    next_vcn: int
    lcn: int | None


def parse_retrieval_pointers(data, requested_vcn, total_clusters):
    """Parse an SDK RETRIEVAL_POINTERS_BUFFER, trimming a rounded-down start."""
    count, = _unpack("<I", data, 0)
    current, = _unpack("<q", data, 8)
    _require(0 < count <= MAX_EXTENTS and len(data) >= 16 + count * 16, "invalid_extent_count")
    _require(0 <= current <= requested_vcn, "invalid_extent_start")
    extents = []
    for index in range(count):
        next_vcn, lcn = _unpack("<qq", data, 16 + index * 16)
        _require(current < next_vcn <= MAX_INTEGER and lcn >= -1, "invalid_extent")
        _require(lcn == -1 or lcn + next_vcn - current <= total_clusters, "extent_outside_volume")
        if next_vcn > requested_vcn:
            start = max(current, requested_vcn)
            extents.append(Extent(start, next_vcn, None if lcn == -1 else lcn + start - current))
        current = next_vcn
    _require(extents and extents[0].vcn == requested_vcn, "extent_no_progress")
    return extents


class ExtentReader:
    """Read a logical MFT range across any number of physical extents."""
    def __init__(self, geometry, extents, read_at, checkpoint=None):
        self.geometry, self.extents, self.read_at = geometry, tuple(extents), read_at
        self.checkpoint = checkpoint or (lambda **_: None)
        self.bytes_read = 0
        _require(0 < len(self.extents) <= MAX_EXTENTS, "invalid_extent_count")
        expected = 0
        for extent in self.extents:
            _require(extent.vcn == expected and extent.next_vcn > extent.vcn, "mft_extent_gap_or_overlap")
            _require(extent.lcn is not None, "sparse_mft_unsupported")
            _require(0 <= extent.lcn and extent.lcn + extent.next_vcn - extent.vcn <= geometry.clusters,
                     "extent_outside_volume")
            expected = extent.next_vcn
        _require(expected * geometry.cluster_bytes >= geometry.mft_bytes, "mft_extent_incomplete")

    def read(self, offset, size):
        _require(0 <= offset <= self.geometry.mft_bytes and 0 <= size <= MAX_READ and
                 size <= self.geometry.mft_bytes - offset, "read_outside_mft")
        cluster = self.geometry.cluster_bytes
        end = offset + size
        parts = []
        # Binary search avoids rescanning the map for every file record.
        import bisect
        starts = getattr(self, "_starts", None)
        if starts is None:
            starts = self._starts = tuple(extent.vcn * cluster for extent in self.extents)
        index = max(0, bisect.bisect_right(starts, offset) - 1)
        while offset < end:
            self.checkpoint(phase="native_read", bytes_read=self.bytes_read)
            extent = self.extents[index]
            count = min(end - offset, extent.next_vcn * cluster - offset, MAX_READ)
            physical = extent.lcn * cluster + offset - extent.vcn * cluster
            data = self.read_at(physical, count)
            _require(isinstance(data, bytes) and len(data) == count, "short_volume_read")
            self.bytes_read += count
            parts.append(data)
            offset += count
            index += 1
        return b"".join(parts)


def apply_fixups(data, sector_bytes, *, restored=False):
    _require(512 <= sector_bytes <= 4096 and sector_bytes & (sector_bytes - 1) == 0,
             "unsupported_sector_size")
    _require(512 <= len(data) <= MAX_RECORD and len(data) % sector_bytes == 0, "invalid_record_boundary")
    _require(data[:4] == b"FILE", "invalid_record_signature")
    offset, count = _unpack("<HH", data, 4)
    _require(count == len(data) // sector_bytes + 1 and offset >= 42 and offset % 2 == 0 and
             offset + count * 2 <= min(len(data), sector_bytes - 2), "invalid_fixup_array")
    array = _slice(data, offset, count * 2)
    _require(array[:2] != b"\0\0", "invalid_fixup_sequence")
    # FSCTL can return the cache manager's already-restored FILE record. This
    # acceptance is explicit to that trusted transport and is never used for
    # raw volume bytes. Every tail must match its replacement, not a mixture.
    if restored and all(data[index * sector_bytes - 2:index * sector_bytes] == array[index * 2:index * 2 + 2]
                        for index in range(1, count)):
        return bytes(data)
    fixed = bytearray(data)
    for index in range(1, count):
        tail = index * sector_bytes - 2
        _require(data[tail:tail + 2] == array[:2], "torn_record_fixup")
        fixed[tail:tail + 2] = array[index * 2:index * 2 + 2]
    return bytes(fixed)


def parse_mapping_pairs(data, lowest_vcn, highest_vcn, total_clusters):
    _require(0 <= lowest_vcn <= highest_vcn < MAX_INTEGER, "invalid_attribute_vcn")
    vcn, lcn, offset, extents = lowest_vcn, 0, 0, []
    while offset < len(data):
        header = data[offset]
        offset += 1
        if header == 0:
            _require(vcn == highest_vcn + 1, "mapping_vcn_mismatch")
            return extents
        length_bytes, delta_bytes = header & 15, header >> 4
        _require(1 <= length_bytes <= 8 and delta_bytes <= 8, "invalid_mapping_pair")
        length = int.from_bytes(_slice(data, offset, length_bytes), "little", signed=False)
        offset += length_bytes
        _require(0 < length <= MAX_INTEGER - vcn and vcn + length <= highest_vcn + 1,
                 "invalid_mapping_length")
        if delta_bytes:
            lcn += int.from_bytes(_slice(data, offset, delta_bytes), "little", signed=True)
            _require(0 <= lcn and lcn + length <= total_clusters, "extent_outside_volume")
        extents.append(Extent(vcn, vcn + length, lcn if delta_bytes else None))
        _require(len(extents) <= MAX_EXTENTS, "extent_limit")
        vcn += length
        offset += delta_bytes
    raise NtfsError("unterminated_mapping_pairs")


def parse_attribute_list(value):
    entries, offset = [], 0
    while offset < len(value):
        _require(len(entries) < 2048, "attribute_list_limit")
        kind, length, chars, name_offset, vcn, reference, instance = _unpack("<IHBBQQH", value, offset)
        _require(kind not in {0, 0xffffffff} and length >= 26 and length % 8 == 0,
                 "invalid_attribute_list_entry")
        entry = _slice(value, offset, length)
        _require(not chars or name_offset >= 26, "invalid_attribute_list_name")
        name = _utf16(_slice(entry, name_offset, chars * 2)) if chars else ""
        entries.append({"type": kind, "name": name, "lowest_vcn": vcn,
                        "reference": FileReference.decode(reference), "instance": instance})
        offset += length
    return entries


@dataclass
class ParsedRecord:
    reference: FileReference
    in_use: bool
    directory: bool
    hard_links: int
    base_reference: FileReference | None = None
    names: list = field(default_factory=list)
    streams: list = field(default_factory=list)
    attribute_list: list = field(default_factory=list)
    limitations: list = field(default_factory=list)
    reparse: bool = False
    lsn: int = 0

    @property
    def complete(self):
        return self.in_use and not self.limitations

    @property
    def logical_size(self):
        streams = [s for s in self.streams if not s["name"]]
        return streams[0]["logical_size"] if len(streams) == 1 else (0 if self.directory else None)

    @property
    def allocated_size(self):
        streams = [s for s in self.streams if not s["name"]]
        return streams[0]["allocated_size"] if len(streams) == 1 else (0 if self.directory else None)


def parse_record(raw, geometry, record_number, *, expected_reference=None, source="raw"):
    _require(len(raw) == geometry.record_bytes, "invalid_record_boundary")
    _require(0 <= record_number <= REFERENCE_MASK, "invalid_file_reference")
    _require(source in {"raw", "ioctl"}, "invalid_record_source")
    data = apply_fixups(raw, geometry.sector_bytes, restored=source == "ioctl")
    sequence, links, attr_offset, flags, used, allocated, base = _unpack("<HHHHIIQ", data, 16)
    reference = FileReference(record_number, sequence)
    if expected_reference is not None:
        _require(reference.value == expected_reference, "wrong_record_identity")
    _require(flags & ~3 == 0, "unsupported_record_flags")
    fixup_offset, fixup_count = _unpack("<HH", data, 4)
    _require(allocated == len(data) and 48 <= used <= allocated and attr_offset % 8 == 0 and
             fixup_offset + fixup_count * 2 <= attr_offset <= used - 4, "invalid_record_layout")
    record = ParsedRecord(reference, bool(flags & 1), bool(flags & 2), links,
                          FileReference.decode(base) if base else None, lsn=_unpack("<Q", data, 8)[0])
    if not record.in_use:
        return record  # stale attributes in deleted records must never count.
    _require(sequence != 0, "invalid_sequence_number")
    if record.base_reference:
        record.limitations.append("extension_record_unresolved")
    seen_ids, data_names = set(), set()
    attributes = 0
    while attr_offset + 4 <= used:
        kind, = _unpack("<I", data, attr_offset)
        if kind == 0xffffffff:
            break
        attributes += 1
        _require(attributes <= 2048, "attribute_count_limit")
        kind, length, form, chars, name_offset, attr_flags, instance = _unpack("<IIBBHHH", data, attr_offset)
        _require(length >= 24 and length % 8 == 0 and attr_offset + length <= used and form in {0, 1},
                 "invalid_attribute_layout")
        _require(instance not in seen_ids, "duplicate_attribute_instance")
        seen_ids.add(instance)
        attr = _slice(data, attr_offset, length)
        minimum = 64 if form else 24
        _require(length >= minimum and (not chars or name_offset >= minimum), "invalid_attribute_name")
        name = _utf16(_slice(attr, name_offset, chars * 2)) if chars else ""
        if form == 0:
            value_size, value_offset = _unpack("<IH", attr, 16)
            _require(value_offset >= minimum and (not chars or name_offset + chars * 2 <= value_offset),
                     "overlapping_attribute_fields")
            value = _slice(attr, value_offset, value_size)
            # FILE_STANDARD_INFO reports resident value length on the validated
            # NTFS fixture. Keep that compatibility accounting separate from
            # external data-cluster occupancy (zero for a resident stream).
            logical, allocation, runs = value_size, value_size, []
            _require(attr_flags == 0, "unsupported_resident_flags")
        else:
            lowest, highest, pairs_offset = _unpack("<QQH", attr, 16)
            allocation_header, logical, initialized = _unpack("<qqq", attr, 40)
            _require(pairs_offset >= minimum and pairs_offset < length and
                     (not chars or name_offset + chars * 2 <= pairs_offset), "invalid_mapping_offset")
            runs = parse_mapping_pairs(attr[pairs_offset:], lowest, highest, geometry.clusters)
            if lowest:
                record.limitations.append("attribute_extent_unresolved")
                logical, allocation = None, None
            else:
                _require(0 <= initialized <= logical <= MAX_INTEGER and allocation_header >= 0 and
                         allocation_header % geometry.cluster_bytes == 0 and
                         logical <= (highest + 1) * geometry.cluster_bytes, "invalid_stream_size")
                allocation = sum(run.next_vcn - run.vcn for run in runs if run.lcn is not None) * geometry.cluster_bytes
                if attr_flags & 0x8001:
                    _require(pairs_offset >= 72, "missing_physical_allocation")
                    physical_allocation, = _unpack("<q", attr, 64)
                    if physical_allocation != allocation:
                        record.limitations.append("stream_allocation_mismatch")
                        allocation = None
                elif allocation_header != allocation:
                    record.limitations.append("stream_allocation_mismatch")
                    allocation = None
                if attr_flags & ~0x8001:
                    record.limitations.append("unsupported_stream_flags")
                    allocation = None
            value = None
        if kind == 0x30:
            _require(value is not None and not name and len(value) >= 66, "unsupported_file_name_attribute")
            parent, = _unpack("<Q", value, 0)
            name_length, namespace = _unpack("<BB", value, 64)
            filename = _utf16(_slice(value, 66, name_length * 2))
            _require(namespace <= 3 and filename and not any(c in filename for c in "\\/:\x00") and
                     (filename not in {".", ".."} or record_number == 5 and filename == "."), "invalid_file_name")
            record.names.append({"name": filename, "namespace": namespace,
                                 "parent": FileReference.decode(parent)})
        elif kind == 0x80:
            if name in data_names:
                record.limitations.append("duplicate_or_split_stream")
            data_names.add(name)
            record.streams.append({"name": name, "resident": not bool(form), "logical_size": logical,
                                   "allocated_size": allocation, "sparse": bool(attr_flags & 0x8000),
                                   "data_cluster_bytes": allocation if form else 0,
                                   "allocation_semantics": "ntfs_standard_info_compat_v1",
                                   "compressed": bool(attr_flags & 1), "encrypted": bool(attr_flags & 0x4000),
                                   "extent_count": len(runs)})
        elif kind == 0x20:
            record.limitations.append("attribute_list_unresolved")
            if value is not None:
                record.attribute_list.extend(parse_attribute_list(value))
            else:
                record.limitations.append("nonresident_attribute_list_unsupported")
        elif kind == 0xc0:
            record.reparse = True
            record.limitations.append("reparse_excluded")
        elif kind not in {0x10, 0x40, 0x50, 0x60, 0x70, 0x90, 0xa0, 0xb0, 0xd0, 0xe0, 0x100}:
            record.limitations.append("unsupported_attribute_type")
        attr_offset += length
    else:
        raise NtfsError("missing_attribute_terminator")
    if not record.base_reference:
        names = {(n["parent"].value, n["name"]) for n in record.names if n["namespace"] != 2}
        if not names:
            record.limitations.append("file_names_missing")
        if not record.directory and len(names) != links:
            record.limitations.append("hardlink_names_incomplete")
        if not record.directory and "" not in data_names:
            record.limitations.append("unnamed_stream_missing")
    if record.reparse:
        for stream in record.streams:
            stream["allocated_size"] = None
    record.limitations = sorted(set(record.limitations))
    return record


def validate_record_response(data, requested_reference, record_bytes):
    """Reject FSCTL's permitted lower-record fallback, never misattribute it."""
    returned, length = _unpack("<QI", data, 0)
    _require(returned == requested_reference, "wrong_record_identity")
    _require(length == record_bytes and len(data) >= 12 + length, "invalid_record_response_length")
    return data[12:12 + length]


def resolve_fixture_paths(records, root_reference, *, max_records=100_000, max_depth=128):
    """Bounded reference/sequence-aware oracle for controlled fixtures only.

    Production path reconstruction needs the disk-backed inventory's relation
    pass. This helper never turns unresolved names into guessed paths.
    """
    _require(len(records) <= max_records, "relationship_memory_limit")
    by_reference = {}
    for record in records:
        if record.in_use and not record.base_reference:
            _require(record.reference.value not in by_reference, "duplicate_record_identity")
            by_reference[record.reference.value] = record
    root = by_reference.get(root_reference)
    _require(root is not None and root.directory, "root_reference_missing")
    paths, errors, cache = {}, {}, {root_reference: [""]}

    def resolve(reference, visiting):
        if reference in cache:
            return cache[reference]
        _require(reference not in visiting, "parent_cycle")
        _require(len(visiting) < max_depth, "parent_depth_limit")
        record = by_reference.get(reference)
        _require(record is not None, "parent_reference_missing_or_stale")
        _require(not record.reparse, "reparse_parent_excluded")
        names = [n for n in record.names if n["namespace"] != 2]
        _require(names, "file_names_missing")
        values = []
        for name in names:
            parent = by_reference.get(name["parent"].value)
            _require(parent is not None, "parent_reference_missing_or_stale")
            _require(parent.directory, "parent_is_not_directory")
            for prefix in resolve(parent.reference.value, visiting | {reference}):
                values.append(f"{prefix}/{name['name']}".lstrip("/"))
                _require(len(values) <= 1024, "path_alias_limit")
        cache[reference] = sorted(set(values), key=lambda x: (x.casefold(), x))
        return cache[reference]

    for reference in by_reference:
        try:
            paths[reference] = resolve(reference, set())
        except NtfsError as error:
            errors[reference] = error.reason
    return paths, errors


def acquire(reader, sink, *, max_records=500_000, max_seconds=300, progress=None):
    """Emit parsed records with O(record + extents) reader memory.

    Reader exposes geometry, read_record(index), bytes_read, and revalidate().
    Coverage distinguishes record acquisition from inventory relationships.
    Caller cancellation propagates immediately, including BaseException-based
    worker cancellation; partial sinks must be discarded before fallback.
    """
    _require(type(max_records) is int and 1 <= max_records <= 2_000_000 and
             0 < max_seconds <= 3600, "invalid_acquisition_limit")
    progress = progress or (lambda **_: None)
    geometry = reader.geometry
    observed_started = datetime.now(timezone.utc).isoformat()
    started = time.monotonic()
    examined = retained = deleted = 0
    sink_seconds = 0.0
    reasons = Counter()
    total = geometry.mft_bytes // geometry.record_bytes
    for index in range(total):
        progress(phase="native_records", records_examined=examined, records_total=total,
                 bytes_read=reader.bytes_read)
        if examined >= max_records:
            reasons["record_limit"] += 1
            break
        if time.monotonic() - started >= max_seconds:
            reasons["time_limit"] += 1
            break
        examined += 1
        try:
            record = parse_record(reader.read_record(index), geometry, index)
        except (NtfsError, OSError) as error:
            reasons[error.reason if isinstance(error, NtfsError) else "record_read_failed"] += 1
            continue
        if not record.in_use:
            deleted += 1
            continue
        for reason in record.limitations:
            reasons[reason] += 1
        sink_started = time.monotonic()
        sink(record)
        sink_seconds += time.monotonic() - sink_started
        retained += 1
    try:
        if not reader.revalidate():
            reasons["volume_changed_during_acquisition"] += 1
    except (NtfsError, OSError):
        reasons["volume_revalidation_failed"] += 1
    elapsed = time.monotonic() - started
    return {"engine": "ntfs_prototype", "mft": True, "volume_identity": geometry.identity,
            "observed_started_at": observed_started, "observed_finished_at": datetime.now(timezone.utc).isoformat(),
            "observation_semantics": "live_non_atomic", "acquisition_complete": examined == total and not reasons,
            "inventory_complete": False, "relationship_validation": "required", "records_examined": examined,
            "records_total": total, "records_retained": retained, "deleted_records": deleted,
            "omitted_records": examined - retained - deleted, "bytes_read": reader.bytes_read,
            "coverage_reasons": dict(sorted(reasons.items())), "acquisition_seconds": max(0.0, elapsed - sink_seconds),
            "sink_seconds": sink_seconds, "elapsed_seconds": elapsed,
            "fallback_requires_discard": True}
