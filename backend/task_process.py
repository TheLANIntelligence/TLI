"""Bounded, explicitly approved host execution. This is not an OS sandbox.

The caller owns task-scoped approval and work-area admission. No environment or
shell authority is accepted from the model. Process ownership is never inferred
from an arbitrary PID supplied by a client.
"""
from __future__ import annotations

import ctypes
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import signal
import stat
import subprocess
import threading
import time

from fastapi import HTTPException
from process_utils import hidden_process_kwargs

MAX_OUTPUT = 1024 * 1024
MAX_SECONDS = 600
SHELLS = {'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'dash', 'fish', 'wscript', 'cscript', 'mshta', 'rundll32'}


def _fail(message):
    raise HTTPException(422, message)


def _plain_path(raw, directory=False):
    if not isinstance(raw, str) or not raw or '\x00' in raw or len(raw) > 4096:
        _fail('Supply an absolute executable and working-directory path.')
    path = Path(raw)
    if not path.is_absolute() or '..' in path.parts:
        _fail('Command paths must be absolute without parent traversal.')
    for part in path.parts[1:]:
        if (part.endswith((' ', '.')) or any(c in part for c in ':<>|?*') or any(ord(c) < 32 for c in part)
                or re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part)):
            _fail('Device names, alternate streams and ambiguous command paths are unsupported.')
    if os.name == 'nt' and str(path).startswith('\\\\'):
        _fail('Network and device paths are not supported for host commands.')
    try:
        for parent in reversed((path, *path.parents)):
            info = parent.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                _fail('Command paths cannot contain links, junctions or cloud placeholders.')
        if directory and not stat.S_ISDIR(info.st_mode) or not directory and not stat.S_ISREG(info.st_mode):
            _fail('The executable or working directory has the wrong type.')
    except OSError as exc:
        raise HTTPException(422, 'The executable or working directory is unavailable.') from exc
    return path, info


def normalize_command(command):
    keys = {'executable', 'args', 'cwd', 'timeout_seconds', 'executable_sha256', 'cwd_identity'}
    if not isinstance(command, dict) or set(command) - keys:
        _fail('Use structured executable, args, cwd and timeout_seconds fields.')
    executable, info = _plain_path(command.get('executable'))
    cwd, cwd_info = _plain_path(command.get('cwd'), directory=True)
    if executable.stem.casefold() in SHELLS or (os.name == 'nt' and executable.suffix.casefold() != '.exe'):
        _fail('Shells, batch files and command wrappers are unavailable. Select a direct executable.')
    args = command.get('args', [])
    timeout = command.get('timeout_seconds', 120)
    if (not isinstance(args, list) or len(args) > 64
            or any(not isinstance(arg, str) or '\x00' in arg or len(arg) > 4096 for arg in args)
            or sum(len(arg) for arg in args) > 16000):
        _fail('Command arguments exceed the supported limits.')
    if type(timeout) is not int or not 1 <= timeout <= MAX_SECONDS:
        _fail('Command timeout must be one to 600 seconds.')
    if info.st_size > 256 * 1024 * 1024 or info.st_nlink != 1:
        _fail('Choose an ordinary executable under 256 MiB without hard links.')
    digest = hashlib.sha256()
    try:
        with executable.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
    except OSError as exc:
        raise HTTPException(422, 'The executable could not be fingerprinted.') from exc
    normalized = {'executable': str(executable), 'args': list(args), 'cwd': str(cwd), 'timeout_seconds': timeout,
                  'executable_sha256': digest.hexdigest(), 'cwd_identity': [cwd_info.st_dev, cwd_info.st_ino]}
    for field in ('executable_sha256', 'cwd_identity'):
        if field in command and command[field] != normalized[field]:
            raise HTTPException(409, 'The approved executable or working directory changed. Review the command again.')
    return normalized


def command_fingerprint(command):
    return hashlib.sha256(json.dumps(normalize_command(command), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _environment():
    # Explicit allowlist: never inherit API keys, tokens, Python startup hooks,
    # package-manager credentials or arbitrary TLI configuration.
    allowed = {'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
               'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES',
               'PROGRAMFILES(X86)', 'PROGRAMDATA'}
    result = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    result.update(PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1', PYTHONNOUSERSITE='1')
    return result


@contextmanager
def _pin_launch(command):
    """Prevent replacement of Windows command paths between review and launch."""
    handles = []
    try:
        if os.name == 'nt':
            from ctypes import wintypes as w
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
            kernel.CreateFileW.restype = w.HANDLE
            kernel.CloseHandle.argtypes, kernel.CloseHandle.restype = [w.HANDLE], w.BOOL
            executable, cwd = Path(command['executable']), Path(command['cwd'])
            directories = set(executable.parents) | {cwd, *cwd.parents}
            for path in sorted(directories, key=lambda p: len(p.parts)):
                handle = kernel.CreateFileW(str(path), 0x80, 3, None, 3, 0x02200000, None)
                if handle == w.HANDLE(-1).value:
                    raise HTTPException(409, 'A command directory changed or could not be pinned.')
                handles.append((kernel, handle))
            handle = kernel.CreateFileW(str(executable), 0x80000000, 1, None, 3, 0x00200000, None)
            if handle == w.HANDLE(-1).value:
                raise HTTPException(409, 'The approved executable changed or is being modified.')
            handles.append((kernel, handle))
        normalize_command(command)
        yield
    finally:
        for kernel, handle in reversed(handles):
            kernel.CloseHandle(handle)


class WindowsJob:
    """Private lifecycle/resource job. It does not restrict filesystem/network access."""
    def __init__(self):
        from ctypes import wintypes as w
        class Basic(ctypes.Structure):
            _fields_ = [('ProcessTime', ctypes.c_longlong), ('JobTime', ctypes.c_longlong), ('Flags', w.DWORD),
                        ('MinWorkingSet', ctypes.c_size_t), ('MaxWorkingSet', ctypes.c_size_t), ('ActiveProcesses', w.DWORD),
                        ('Affinity', ctypes.c_size_t), ('Priority', w.DWORD), ('Scheduling', w.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ('ReadOps', 'WriteOps', 'OtherOps', 'ReadBytes', 'WriteBytes', 'OtherBytes')]
        class Extended(ctypes.Structure):
            _fields_ = [('Basic', Basic), ('IO', IO), ('ProcessMemory', ctypes.c_size_t), ('JobMemory', ctypes.c_size_t),
                        ('PeakProcessMemory', ctypes.c_size_t), ('PeakJobMemory', ctypes.c_size_t)]
        class Accounting(ctypes.Structure):
            _fields_ = [(name, ctypes.c_longlong) for name in ('User', 'Kernel', 'PeriodUser', 'PeriodKernel')] + [
                (name, w.DWORD) for name in ('PageFaults', 'TotalProcesses', 'ActiveProcesses', 'TerminatedProcesses')]
        self.Accounting = Accounting
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        signatures = {
            'CreateJobObjectW': ([ctypes.c_void_p, w.LPCWSTR], w.HANDLE),
            'SetInformationJobObject': ([w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD], w.BOOL),
            'AssignProcessToJobObject': ([w.HANDLE, w.HANDLE], w.BOOL),
            'TerminateJobObject': ([w.HANDLE, w.UINT], w.BOOL),
            'CloseHandle': ([w.HANDLE], w.BOOL),
            'QueryInformationJobObject': ([w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD)], w.BOOL),
        }
        for name, (arguments, result) in signatures.items():
            method = getattr(self.kernel, name)
            method.argtypes, method.restype = arguments, result
        self.handle = self.kernel.CreateJobObjectW(None, None)
        limits = Extended()
        limits.Basic.Flags = 0x2000 | 0x200 | 0x8  # kill on close, job memory, active process limit
        limits.Basic.ActiveProcesses = 32
        limits.JobMemory = 2 * 1024 * 1024 * 1024
        if not self.handle or not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close()
            raise RuntimeError('Host-command process limits could not be established.')

    def attach(self, child):
        from ctypes import wintypes as w
        if not self.kernel.AssignProcessToJobObject(self.handle, w.HANDLE(int(child._handle))):
            raise RuntimeError('The command could not be placed in its private process job.')
        resume = ctypes.WinDLL('ntdll').NtResumeProcess
        resume.argtypes, resume.restype = [w.HANDLE], ctypes.c_long
        if resume(w.HANDLE(int(child._handle))) != 0:
            raise RuntimeError('The owned command could not be resumed.')

    def kill(self):
        if self.handle and not self.kernel.TerminateJobObject(self.handle, 1):
            raise RuntimeError('The owned command job could not be terminated.')

    def active(self):
        info = self.Accounting()
        if not self.kernel.QueryInformationJobObject(self.handle, 1, ctypes.byref(info), ctypes.sizeof(info), None):
            raise RuntimeError('Owned command process exit could not be confirmed.')
        return info.ActiveProcesses

    def finish(self):
        if self.active():
            self.kill()
        deadline = time.monotonic() + 5
        while self.active():
            if time.monotonic() >= deadline:
                raise RuntimeError('Owned command processes are still stopping.')
            time.sleep(.02)

    def close(self):
        if getattr(self, 'handle', None):
            self.kernel.CloseHandle(self.handle)
            self.handle = None


class PosixGroup:
    def __init__(self):
        self.pid = None

    def attach(self, child):
        self.pid = child.pid  # Popen(start_new_session=True) creates this owned group.

    def kill(self):
        if self.pid is not None:
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def finish(self):
        self.kill()

    def close(self):
        pass


def execute(command, check, on_output=None):
    """Execute only after caller approval; authorization/cancel exceptions propagate.

    ``on_output`` receives {stream, text}. Output-limit and timeout stops return a
    failed result. Ordinary child descendants are stopped with their owned job.
    Host-privileged code can use external brokers; this is not malicious-code containment.
    """
    check()
    command = normalize_command(command)
    child = None
    job = None
    readers = []
    chunks = {'stdout': [], 'stderr': []}
    events = queue.Queue(maxsize=64)
    reader_stop = threading.Event()
    total = 0
    reason = None
    started = time.monotonic()

    def read(stream, name):
        try:
            while not reader_stop.is_set():
                block = stream.read1(4096)
                if not block:
                    break
                while not reader_stop.is_set():
                    try:
                        events.put((name, block), timeout=.05)
                        break
                    except queue.Full:
                        continue
        finally:
            stream.close()

    try:
        job = WindowsJob() if os.name == 'nt' else PosixGroup()
        check()
        options = hidden_process_kwargs()
        if os.name == 'nt':
            options['creationflags'] = options.get('creationflags', 0) | 0x4  # suspend until job assignment
        else:
            options['start_new_session'] = True
        with _pin_launch(command):
            check()
            child = subprocess.Popen([command['executable'], *command['args']], cwd=command['cwd'],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     shell=False, env=_environment(), close_fds=True, **options)
            job.attach(child)
        for name in ('stdout', 'stderr'):
            reader = threading.Thread(target=read, args=(getattr(child, name), name), daemon=True)
            readers.append(reader)
            reader.start()
        while True:
            check()
            if time.monotonic() - started >= command['timeout_seconds']:
                reason = 'timeout'
                break
            try:
                name, block = events.get(timeout=.05)
            except queue.Empty:
                if child.poll() is not None:
                    # A surviving child may keep stdout open after its parent exits.
                    job.finish()
                    if not any(reader.is_alive() for reader in readers) and events.empty():
                        break
                continue
            remaining = MAX_OUTPUT - total
            total += len(block)
            selected = block[:max(0, remaining)]
            chunks[name].append(selected)
            if selected and on_output:
                on_output({'stream': name, 'text': selected.decode('utf-8', errors='replace')})
            if total > MAX_OUTPUT:
                reason = 'output_limit'
                break
        if reason:
            job.kill()
        child.wait(timeout=5)
        job.finish()
        check()
        return {'command': command, 'exit_code': child.returncode, 'stdout': b''.join(chunks['stdout']).decode('utf-8', errors='replace'),
                'stderr': b''.join(chunks['stderr']).decode('utf-8', errors='replace'), 'timed_out': reason == 'timeout',
                'output_truncated': reason == 'output_limit', 'status': 'failed' if reason or child.returncode else 'completed',
                'stop_reason': reason, 'runtime_ms': int((time.monotonic() - started) * 1000),
                'execution_scope': 'host_account', 'sandboxed': False}
    finally:
        reader_stop.set()
        try:
            if job and child:
                job.kill()
            if child:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=5)
            if job and child:
                job.finish()
        finally:
            if job:
                job.close()
            for reader in readers:
                reader.join(timeout=1)
            if child:
                for name in ('stdout', 'stderr'):
                    stream = getattr(child, name, None)
                    if stream and not stream.closed:
                        stream.close()
