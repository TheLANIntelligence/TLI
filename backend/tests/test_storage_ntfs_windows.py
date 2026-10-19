"""Mocked Win32 transport checks; no raw volume handles are acquired."""
import ctypes
from ctypes import wintypes
import struct
from types import SimpleNamespace

import pytest

from storage_ntfs import Extent, NtfsError
from storage_ntfs_benchmark import SyntheticReader, file_record
from storage_ntfs_windows import WindowsVolumeReader, FSCTL_GET_RETRIEVAL_POINTERS


def transport():
    reader = object.__new__(WindowsVolumeReader)
    reader.geometry = SyntheticReader(32).geometry
    reader._handle, reader._mft_handle = 100, 101
    reader.checkpoint = lambda **_: None
    reader.wintypes = wintypes
    return reader


def test_extent_discovery_paginates_from_next_vcn():
    reader = transport()
    calls = []
    def ioctl(handle, code, payload, size, allow_more=False):
        calls.append((handle, code, struct.unpack("<q", payload)[0], size, allow_more))
        if len(calls) == 1:
            return struct.pack("<I4xqqq", 1, 0, 4, 32), True
        return struct.pack("<I4xqqq", 1, 4, 8, 96), False
    reader._ioctl = ioctl
    assert reader._extents() == (Extent(0, 4, 32), Extent(4, 8, 96))
    assert calls == [(101, FSCTL_GET_RETRIEVAL_POINTERS, 0, 65536, True),
                     (101, FSCTL_GET_RETRIEVAL_POINTERS, 4, 65536, True)]


def test_extent_discovery_rejects_a_repeated_page():
    reader = transport()
    reader._ioctl = lambda *_args, **_kwargs: (struct.pack("<I4xqqq", 1, 0, 4, 32), True)
    with pytest.raises(NtfsError, match="extent_no_progress"):
        reader._extents()


def test_close_releases_only_owned_handles_and_is_idempotent():
    reader = transport()
    closed = []
    reader.kernel = SimpleNamespace(CloseHandle=closed.append)
    reader.close()
    reader.close()
    assert closed == [101, 100] and reader._cache == b""


def test_native_read_rejects_unaligned_and_oversize_requests_before_call():
    reader = transport()
    for offset, size in ((1, 1024), (0, 5), (-512, 512), (0, 2 * 1024 * 1024)):
        with pytest.raises(NtfsError, match="invalid_volume_read_bounds"):
            reader._read_at(offset, size)


def test_native_read_short_response_is_not_padded():
    reader = transport()
    def read(_handle, _output, _size, returned, _overlapped):
        ctypes.cast(returned, ctypes.POINTER(wintypes.DWORD))[0] = 512
        return True
    reader.kernel = SimpleNamespace(SetFilePointerEx=lambda *_: True, ReadFile=read)
    with pytest.raises(NtfsError, match="short_volume_read"):
        reader._read_at(4096, 1024)


def test_ioctl_denial_is_explicit(monkeypatch):
    reader = transport()
    reader.kernel = SimpleNamespace(DeviceIoControl=lambda *_: False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 5, raising=False)
    with pytest.raises(NtfsError, match="native_access_denied"):
        reader._ioctl(100, 1)


def test_get_record_diagnostic_rejects_lower_returned_reference():
    reader = transport()
    raw = file_record()
    reader._ioctl = lambda *_args: (struct.pack("<QI", 15, len(raw)) + raw, False)
    with pytest.raises(NtfsError, match="wrong_record_identity"):
        reader.get_record_response(16)


def test_open_failure_closes_partial_owned_handle(monkeypatch):
    import storage_ntfs_windows as windows
    closed = []
    fake_kernel = SimpleNamespace(GetDriveTypeW=lambda _: 3, CloseHandle=closed.append)
    monkeypatch.setattr(windows.os, "name", "nt")
    monkeypatch.setattr(ctypes, "WinDLL", lambda *_args, **_kwargs: fake_kernel, raising=False)
    monkeypatch.setattr(WindowsVolumeReader, "_bind", lambda _: None)
    monkeypatch.setattr(WindowsVolumeReader, "_geometry", lambda _: SyntheticReader(32).geometry)
    def open_(self, path, reason):
        if path.endswith("$MFT"):
            raise NtfsError(reason)
        return 123
    monkeypatch.setattr(WindowsVolumeReader, "_open", open_)
    with pytest.raises(NtfsError, match="mft_access_denied"):
        WindowsVolumeReader("R:\\")
    assert closed == [123]
