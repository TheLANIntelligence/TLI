"""Read-only Windows transport for the isolated NTFS validation prototype.

No elevation, process creation, volume locking, dismount, or write operation.
Use only in a controlled probe process, never in a FastAPI request handler.
"""
from __future__ import annotations

import ctypes
import ntpath
import os
import struct

from storage_ntfs import (ExtentReader, Geometry, MAX_EXTENTS, MAX_READ, NtfsError,
                          parse_retrieval_pointers, validate_record_response)

FSCTL_GET_NTFS_VOLUME_DATA = 0x00090064
FSCTL_GET_RETRIEVAL_POINTERS = 0x00090073
FSCTL_GET_NTFS_FILE_RECORD = 0x00090068


def canonical_volume(path):
    text = str(path).replace("/", "\\")
    drive, tail = ntpath.splitdrive(text)
    if (len(drive) != 2 or not drive[0].isascii() or not drive[0].isalpha() or drive[1] != ":" or
            tail != "\\"):
        raise NtfsError("explicit_drive_root_required")
    return drive.upper() + "\\"


class WindowsVolumeReader:
    def __init__(self, volume, *, checkpoint=None):
        self.volume = canonical_volume(volume)
        if os.name != "nt":
            raise NtfsError("platform_not_windows")
        from ctypes import wintypes
        self.wintypes = wintypes
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self._handle = self._mft_handle = None
        self._cache_offset, self._cache = -1, b""
        self.checkpoint = checkpoint or (lambda **_: None)
        self._bind()
        try:
            if self.kernel.GetDriveTypeW(self.volume) != 3:
                raise NtfsError("unsupported_drive_type")
            self._handle = self._open("\\\\.\\" + self.volume[:2], "volume_access_denied")
            self.geometry = self._geometry()
            self._mft_handle = self._open(self.volume + "$MFT", "mft_access_denied")
            self.extents = self._extents()
            self.reader = ExtentReader(self.geometry, self.extents, self._read_at, self.checkpoint)
        except BaseException:
            self.close()
            raise

    def _bind(self):
        w, k = self.wintypes, self.kernel
        k.GetDriveTypeW.argtypes = [w.LPCWSTR]
        k.GetDriveTypeW.restype = w.UINT
        k.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
        k.CreateFileW.restype = w.HANDLE
        k.DeviceIoControl.argtypes = [w.HANDLE, w.DWORD, ctypes.c_void_p, w.DWORD, ctypes.c_void_p,
                                     w.DWORD, ctypes.POINTER(w.DWORD), ctypes.c_void_p]
        k.DeviceIoControl.restype = w.BOOL
        k.SetFilePointerEx.argtypes = [w.HANDLE, ctypes.c_longlong, ctypes.POINTER(ctypes.c_longlong), w.DWORD]
        k.SetFilePointerEx.restype = w.BOOL
        k.ReadFile.argtypes = [w.HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.c_void_p]
        k.ReadFile.restype = w.BOOL
        k.CloseHandle.argtypes = [w.HANDLE]
        k.CloseHandle.restype = w.BOOL

    def _open(self, path, denied_reason):
        # GENERIC_READ, share READ|WRITE|DELETE, OPEN_EXISTING. No mutations.
        handle = self.kernel.CreateFileW(path, 0x80000000, 7, None, 3, 0x02000000, None)
        if handle == ctypes.c_void_p(-1).value:
            error = ctypes.get_last_error()
            raise NtfsError(denied_reason if error in {5, 1314} else "native_open_failed")
        return handle

    def _ioctl(self, handle, code, payload=b"", size=128, *, allow_more=False):
        self.checkpoint(phase="native_control")
        output = ctypes.create_string_buffer(size)
        input_buffer = ctypes.create_string_buffer(payload) if payload else None
        returned = self.wintypes.DWORD()
        ok = self.kernel.DeviceIoControl(handle, code, input_buffer, len(payload), output, size,
                                        ctypes.byref(returned), None)
        error = 0 if ok else ctypes.get_last_error()
        if not ok and not (allow_more and error == 234):
            if error in {5, 1314}:
                raise NtfsError("native_access_denied")
            if error in {1, 50, 87}:
                raise NtfsError("unsupported_filesystem_or_control")
            raise NtfsError("native_control_failed")
        if returned.value > size:
            raise NtfsError("invalid_control_output_length")
        return output.raw[:returned.value], bool(error == 234)

    def _geometry(self):
        raw, _ = self._ioctl(self._handle, FSCTL_GET_NTFS_VOLUME_DATA, size=128)
        return Geometry.from_volume_data(raw)

    def _extents(self):
        result, vcn = [], 0
        while len(result) < MAX_EXTENTS:
            raw, more = self._ioctl(self._mft_handle, FSCTL_GET_RETRIEVAL_POINTERS,
                                    struct.pack("<q", vcn), 64 * 1024, allow_more=True)
            page = parse_retrieval_pointers(raw, vcn, self.geometry.clusters)
            result.extend(page)
            if len(result) > MAX_EXTENTS:
                raise NtfsError("extent_limit")
            vcn = page[-1].next_vcn
            if not more:
                return tuple(result)
        raise NtfsError("extent_limit")

    def _read_at(self, offset, size):
        geometry = self.geometry
        if (not 0 < size <= MAX_READ or offset < 0 or offset % geometry.sector_bytes or
                size % geometry.sector_bytes or offset + size > geometry.clusters * geometry.cluster_bytes):
            raise NtfsError("invalid_volume_read_bounds")
        if not self.kernel.SetFilePointerEx(self._handle, offset, None, 0):
            raise NtfsError("volume_seek_failed")
        output, returned = ctypes.create_string_buffer(size), self.wintypes.DWORD()
        if not self.kernel.ReadFile(self._handle, output, size, ctypes.byref(returned), None):
            raise NtfsError("volume_read_failed")
        if returned.value != size:
            raise NtfsError("short_volume_read")
        return output.raw[:returned.value]

    @property
    def bytes_read(self):
        return self.reader.bytes_read

    def read_record(self, index):
        offset = index * self.geometry.record_bytes
        if offset < 0 or offset + self.geometry.record_bytes > self.geometry.mft_bytes:
            raise NtfsError("read_outside_mft")
        if not self._cache_offset <= offset < self._cache_offset + len(self._cache):
            self._cache_offset = offset - offset % MAX_READ
            size = min(MAX_READ, self.geometry.mft_bytes - self._cache_offset)
            self._cache = self.reader.read(self._cache_offset, size)
        local = offset - self._cache_offset
        return self._cache[local:local + self.geometry.record_bytes]

    def get_record_response(self, requested_reference):
        """Request a 48-bit segment number; reject any lower returned number.

        A caller holding an MFT_SEGMENT_REFERENCE must separately compare its
        sequence against the parsed FILE header. The sequence is not part of
        the segment position used for this descending-record control request.
        """
        if not 0 <= requested_reference < 1 << 48:
            raise NtfsError("invalid_file_reference")
        raw, _ = self._ioctl(self._handle, FSCTL_GET_NTFS_FILE_RECORD,
                             struct.pack("<Q", requested_reference), self.geometry.record_bytes + 16)
        return validate_record_response(raw, requested_reference, self.geometry.record_bytes)

    def revalidate(self):
        # This detects volume/MFT geometry and mapping changes. It cannot detect
        # every concurrent file rename/write and does not make a VSS snapshot.
        return self._geometry() == self.geometry and self._extents() == self.extents

    def close(self):
        for field in ("_mft_handle", "_handle"):
            handle = getattr(self, field, None)
            if handle is not None:
                self.kernel.CloseHandle(handle)
                setattr(self, field, None)
        self._cache = b""

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class WindowsRecordProbe(WindowsVolumeReader):
    """Exact caller-owned file-ID probe, with no MFT mapping/enumeration/read.

    Exists to validate individual controlled files without inspecting metadata
    for unrelated files. This is not a production scanner or a replacement for
    fragmented MFT acquisition acceptance.
    """
    def __init__(self, volume, *, checkpoint=None):
        self.volume = canonical_volume(volume)
        if os.name != "nt":
            raise NtfsError("platform_not_windows")
        from ctypes import wintypes
        self.wintypes = wintypes
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self._handle = self._mft_handle = None
        self._response_bytes = 0
        self.checkpoint = checkpoint or (lambda **_: None)
        self._bind()
        try:
            if self.kernel.GetDriveTypeW(self.volume) != 3:
                raise NtfsError("unsupported_drive_type")
            self._handle = self._open("\\\\.\\" + self.volume[:2], "volume_access_denied")
            self.geometry = self._geometry()
        except BaseException:
            self.close()
            raise

    def get_record_response(self, requested_reference):
        raw = super().get_record_response(requested_reference)
        self._response_bytes += len(raw)
        return raw

    @property
    def bytes_read(self):
        return self._response_bytes

    def revalidate(self):
        return self._geometry() == self.geometry

    def read_record(self, index):
        raise NtfsError("record_probe_requires_exact_reference")
