"""Pinned directory operations for the private transfer store only."""
import os
from pathlib import Path
import stat


def identity(info):
    return info.st_dev, info.st_ino


def ordinary(info, directory=False):
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("Linked transfer path")
    if directory and not stat.S_ISDIR(info.st_mode):
        raise ValueError("Transfer parent is not a directory")


class Directory:
    """Pin every ancestor before any path-based Windows access.

    POSIX operations use the opened parent's descriptor, so a rename cannot
    redirect writes into a replacement directory. Windows handles deny delete
    sharing through the entire operation, including cleanup/publication.
    """
    def __init__(self, path):
        self.path = Path(os.path.abspath(path))
        self.handles = []
        self.fd = None

    def __enter__(self):
        try:
            if os.name == "nt":
                import ctypes
                from ctypes import wintypes
                self.ctypes = ctypes
                self.api = ctypes.WinDLL("kernel32", use_last_error=True)
                self.api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
                self.api.CreateFileW.restype = wintypes.HANDLE
                self.api.CloseHandle.argtypes = [wintypes.HANDLE]
                self.api.CloseHandle.restype = wintypes.BOOL
                for parent in reversed((self.path, *self.path.parents)):
                    before = parent.lstat(); ordinary(before, True)
                    handle = self.api.CreateFileW(str(parent), 0x1, 0x1 | 0x2, None, 3, 0x02000000 | 0x00200000, None)
                    if handle == ctypes.c_void_p(-1).value:
                        raise OSError(ctypes.get_last_error(), "Could not pin transfer parent")
                    self.handles.append(handle)
                    after = parent.lstat(); ordinary(after, True)
                    if identity(before) != identity(after):
                        raise ValueError("Transfer parent changed while opening")
            else:
                if not all(x in os.supports_dir_fd for x in (os.open, os.stat, os.unlink, os.mkdir)) or not hasattr(os, "O_NOFOLLOW"):
                    raise OSError("Descriptor-relative transfer storage unavailable")
                parent_fd = None
                for parent in reversed((self.path, *self.path.parents)):
                    before = parent.lstat(); ordinary(before, True)
                    fd = os.open(str(parent) if parent_fd is None else parent.name,
                                 os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
                    self.handles.append(fd)
                    if identity(os.fstat(fd)) != identity(before):
                        raise ValueError("Transfer parent changed while opening")
                    parent_fd = fd
                self.fd = parent_fd
            return self
        except Exception:
            self.__exit__(None, None, None)
            raise

    def target(self, name):
        if not isinstance(name, str) or name != Path(name).name or name in {"", ".", ".."}:
            raise ValueError("Invalid store component")
        return self.path / name if self.fd is None else name

    def info(self, name):
        return os.stat(self.target(name), dir_fd=self.fd, follow_symlinks=False)

    def open(self, name, flags):
        target = self.target(name)
        if os.name == "nt" and flags & os.O_CREAT == 0:
            # OPEN_REPARSE_POINT is mandatory even if a checked final file is
            # replaced between lstat and open. Deny deletion while reading.
            import msvcrt
            from ctypes import wintypes
            handle = self.api.CreateFileW(str(target), 0x80000000, 0x1, None, 3, 0x00200000, None)
            if handle == self.ctypes.c_void_p(-1).value:
                raise OSError(self.ctypes.get_last_error(), "Could not open transfer file")
            class Attributes(self.ctypes.Structure):
                _fields_ = [("attributes", wintypes.DWORD), ("tag", wintypes.DWORD)]
            self.api.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, self.ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
            self.api.GetFileInformationByHandleEx.restype = wintypes.BOOL
            attributes = Attributes()
            if not self.api.GetFileInformationByHandleEx(handle, 9, self.ctypes.byref(attributes), self.ctypes.sizeof(attributes)) or attributes.attributes & (0x400 | 0x10):
                self.api.CloseHandle(handle)
                raise ValueError("Linked or nonregular transfer file")
            try:
                return msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            except Exception:
                self.api.CloseHandle(handle)
                raise
        return os.open(target, flags | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0), 0o600, dir_fd=self.fd)

    def replace(self, source, target):
        os.replace(self.target(source), self.target(target), src_dir_fd=self.fd, dst_dir_fd=self.fd)

    def unlink(self, name):
        os.unlink(self.target(name), dir_fd=self.fd)

    def mkdir(self, name):
        os.mkdir(self.target(name), 0o700, dir_fd=self.fd)

    def names(self):
        names = []
        with os.scandir(self.path if self.fd is None else self.fd) as entries:
            for entry in entries:
                if len(names) >= 70000:
                    raise ValueError("Transfer store entry limit exceeded")
                names.append(entry.name)
        return names

    def sync(self):
        if self.fd is not None:
            os.fsync(self.fd)

    def __exit__(self, *_):
        for handle in reversed(self.handles):
            if os.name == "nt": self.api.CloseHandle(handle)
            else: os.close(handle)
        self.handles = []
        self.fd = None


def make_directory(path):
    path = Path(path)
    if not path.parent.exists():
        make_directory(path.parent)
    with Directory(path.parent) as directory:
        directory.mkdir(path.name)
        ordinary(directory.info(path.name), True)
        directory.sync()
