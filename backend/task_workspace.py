"""Owner-scoped work areas and bounded, reversible text-file tools.

These checks constrain TLI's file tools. They are not an OS sandbox for commands.
Runtime state is private, versioned JSON; unreadable state is never reset.
"""
from __future__ import annotations

import ast
import base64
import codecs
import configparser
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import threading
import time
import uuid
import xml.etree.ElementTree as ET

from fastapi import HTTPException
import security_state
import tli_state as S

MAX_FILE = 512 * 1024
MAX_RESULT = 32 * 1024
MAX_ENTRIES = 4000
MAX_OPERATIONS = 100
MAX_STATE = 32 * 1024 * 1024
LOCK = threading.RLock()
TEXT_EXTENSIONS = {'.txt', '.log', '.md', '.json', '.jsonl', '.ini', '.cfg', '.conf', '.toml', '.yaml', '.yml',
                   '.xml', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.css', '.scss', '.lua',
                   '.gd', '.cs', '.c', '.cpp', '.h', '.hpp', '.rs', '.go', '.java', '.sh', '.ps1', '.bat', '.cmd',
                   '.properties', '.settings', '.sql', '.csv', '.tsv', '.godot', '.gdshader', '.tscn', '.tres',
                   '.shader', '.hlsl', '.glsl', '.uplugin', '.uproject', '.sln', '.csproj', '.fs', '.fsproj',
                   '.gradle', '.kt', '.kts', '.svg', '.vue', '.svelte'}
TEXT_NAMES = {'readme', 'license', 'dockerfile', 'makefile', '.gitignore', '.gitattributes', '.editorconfig'}
PRIVATE_NAMES = {'.env', 'secrets.json', 'credentials.json', 'id_rsa', 'id_ed25519', 'id_ecdsa'}
EXCLUDED_DIRS = {'.git', '.hg', '.svn', '.venv', 'venv', 'node_modules', '__pycache__', 'saves', 'save',
                 'saved games', 'savegames', 'savegame', 'profiles', 'profile', 'userdata'}
LAUNCHER_NAMES = {'libraryfolders.vdf', 'installedapps.json', 'launcherinstalled.dat'}


def _error(code, message):
    raise HTTPException(code, message)


def _store(owner):
    if not isinstance(owner, str) or not owner or len(owner) > 512:
        _error(401, 'An authenticated work-area owner is required.')
    return Path(S.DATA_DIR) / 'task_workspaces' / (hashlib.sha256(owner.encode()).hexdigest() + '.json')


def _load(owner):
    try:
        value = security_state.read_json(_store(owner), 'task work areas', MAX_STATE)
    except FileNotFoundError:
        return {'version': 1, 'areas': {}, 'operations': {}}
    valid = isinstance(value, dict) and value.get('version') == 1
    valid = valid and isinstance(value.get('areas'), dict) and isinstance(value.get('operations'), dict)
    if valid:
        for ident, area in value['areas'].items():
            valid = (isinstance(area, dict) and area.get('id') == ident and isinstance(area.get('name'), str)
                     and type(area.get('revision')) is int and area['revision'] > 0
                     and all(isinstance(area.get(k), list) and all(isinstance(p, str) and Path(p).is_absolute()
                             for p in area[k]) for k in ('read_roots', 'write_roots'))
                     and isinstance(area.get('identities'), dict))
            if not valid:
                break
        for ident, operation in value['operations'].items():
            valid = valid and (isinstance(operation, dict) and operation.get('id') == ident
                              and operation.get('status') in {'prepared', 'applied', 'undo_prepared', 'undone'}
                              and all(isinstance(operation.get(k), str) for k in ('area_id', 'path', 'after_sha256'))
                              and all(k in operation for k in ('before_sha256', 'task_id', 'created_at'))
                              and isinstance(operation.get('before'), (str, type(None))))
            if not valid:
                break
    if not valid:
        raise security_state.SecurityStateUnavailable('task work areas')
    return value


def _save(owner, value):
    if len(json.dumps(value).encode()) > MAX_STATE:
        _error(409, 'Work-area snapshot storage is full. Existing snapshots were preserved.')
    security_state.write_json(_store(owner), value, 'task work areas')


def _absolute(raw):
    if not isinstance(raw, str) or not raw or len(raw) > 4096 or '\x00' in raw:
        _error(422, 'Use an absolute file or folder path.')
    path = Path(raw)
    if not path.is_absolute() or '..' in path.parts:
        _error(422, 'Use an absolute path without parent traversal.')
    for part in path.parts[1:]:
        if (part.endswith((' ', '.')) or ':' in part or any(ord(c) < 32 for c in part)
                or re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part)):
            _error(422, 'Device names, alternate streams and ambiguous paths are unsupported.')
    if os.name == 'nt' and (str(path).startswith('\\\\') or str(path).startswith('\\?')):
        _error(422, 'Choose a local folder; network and device paths are unsupported.')
    return Path(os.path.abspath(path))


def _inspect(path, *, missing=False):
    """Check every component, including ancestors above a granted folder."""
    for component in reversed((path, *path.parents)):
        try:
            info = component.lstat()
        except FileNotFoundError:
            if missing and component == path:
                return None
            _error(404, 'A work-area file or parent folder no longer exists.')
        except OSError:
            _error(403, 'A work-area path could not be inspected.')
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            _error(403, 'Links, junctions and cloud placeholders are excluded from work areas.')
        if component != path and not stat.S_ISDIR(info.st_mode):
            _error(403, 'A work-area parent is not an ordinary directory.')
    return info


def _identity(info):
    if not info.st_ino:
        _error(403, 'This filesystem does not supply a stable file identity.')
    return [info.st_dev, info.st_ino]


def _under(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _sensitive(path):
    lower = path.name.casefold()
    return (lower in PRIVATE_NAMES or lower.startswith('.env.') or lower.endswith(('.key', '.pem', '.pfx', '.p12'))
            or any(part.casefold() in EXCLUDED_DIRS for part in path.parts))


def _is_text_path(path):
    return path.suffix.casefold() in TEXT_EXTENSIONS or path.name.casefold() in TEXT_NAMES


def _installed_game_root(path):
    """Recognize a concrete game below a launcher layout, never its library root."""
    containers = [Path(os.environ.get(key, fallback)) for key, fallback in
                  (('ProgramFiles', r'C:\Program Files'), ('ProgramFiles(x86)', r'C:\Program Files (x86)'))]
    parent = next((base for base in containers if _under(path, base)), None)
    if parent is None:
        return None
    parts = path.relative_to(parent).parts
    lower = [part.casefold() for part in parts]
    layouts = [('steamapps', 'common'), ('epic games',), ('gog galaxy', 'games'), ('gog games',)]
    for layout in layouts:
        for offset in range(len(parts) - len(layout)):
            end = offset + len(layout)
            if tuple(lower[offset:end]) == layout:
                game = lower[end]
                if game not in {'launcher', 'epicgameslauncher', 'steam', 'common', 'games', 'support', 'redist'}:
                    return parent.joinpath(*parts[:end + 1])
    return None


def _grant_root(raw, *, write=False):
    path = _absolute(raw)
    info = _inspect(path)
    if not stat.S_ISDIR(info.st_mode) or path == Path(path.anchor) or _sensitive(path):
        _error(422, 'Choose an ordinary project, mod, log or configuration folder.')
    for protected in (Path(S.DATA_DIR), Path(S.VAULT_DIR)):
        if _under(path, protected.absolute()) or _under(protected.absolute(), path):
            _error(403, 'Work areas cannot include TLI private saved data.')
    if S.is_protected_system_path(path):
        game = _installed_game_root(path)
        if game is None or write and path == game:
            _error(403, 'System and launcher folders are excluded. Select a specific installed game for reading and its mod, source or configuration subfolder for edits.')
    return str(path), _identity(info)


def list_areas(owner):
    with LOCK:
        return list(_load(owner)['areas'].values())


def get_area(owner, area_id):
    with LOCK:
        area = _load(owner)['areas'].get(area_id)
        if not area:
            _error(404, 'This work area was removed or does not belong to this account.')
        return area


def list_operation_receipts(owner, area_id, task_id):
    """Recover this task's bounded journal identities, never snapshot content."""
    if not isinstance(task_id, str) or not task_id or len(task_id) > 100:
        _error(422, 'A task identity is required for snapshot recovery.')
    with LOCK:
        value = _load(owner)
        if area_id not in value['areas']:
            _error(404, 'This work area was removed or does not belong to this account.')
        return [_receipt(op) for op in value['operations'].values()
                if op['area_id'] == area_id and op['task_id'] == task_id][:MAX_OPERATIONS]


def save_area(owner, *, name, read_roots, write_roots, area_id=None, expected_revision=None):
    if not isinstance(name, str) or not name.strip() or len(name) > 100:
        _error(422, 'Name the work area using at most 100 characters.')
    if not isinstance(read_roots, list) or not 1 <= len(read_roots) <= 8 or not isinstance(write_roots, list) or len(write_roots) > 8:
        _error(422, 'Choose one to eight read folders and at most eight write folders.')
    roots = [_grant_root(raw) for raw in read_roots] + [_grant_root(raw, write=True) for raw in write_roots]
    reads = list(dict.fromkeys(path for path, _ in roots[:len(read_roots)]))
    writes = list(dict.fromkeys(path for path, _ in roots[len(read_roots):]))
    if any(not any(_under(Path(path), Path(root)) for root in reads) for path in writes):
        _error(422, 'Each write folder must be inside a selected read folder.')
    with LOCK:
        value = _load(owner)
        old = value['areas'].get(area_id) if area_id else None
        if area_id and not old:
            _error(404, 'Work area not found.')
        if old and (type(expected_revision) is not int or expected_revision != old['revision']):
            _error(409, 'This work area changed. Reload its permissions before saving.')
        if not old and len(value['areas']) >= 32:
            _error(409, 'Remove an unused work area before adding another.')
        area = {'id': area_id or 'area_' + uuid.uuid4().hex, 'name': name.strip(), 'read_roots': reads,
                'write_roots': writes, 'revision': old['revision'] + 1 if old else 1,
                'identities': dict(roots)}
        value['areas'][area['id']] = area
        _save(owner, value)
        return area


def revoke_area(owner, area_id, expected_revision=None):
    with LOCK:
        value = _load(owner)
        area = value['areas'].get(area_id)
        if not area:
            _error(404, 'Work area not found.')
        if expected_revision is not None and expected_revision != area['revision']:
            _error(409, 'This work area changed. Reload before removing it.')
        del value['areas'][area_id]
        _save(owner, value)
        return {'id': area_id, 'revoked': True}


def _path(area, raw, *, write=False, create=False):
    path = _absolute(raw)
    roots = area['write_roots' if write else 'read_roots']
    matching = [Path(root) for root in roots if _under(path, Path(root))]
    if not matching:
        _error(403, 'This path is outside the approved work-area folders.')
    for root in matching:
        if _identity(_inspect(root)) != area['identities'].get(str(root)):
            _error(409, 'An approved root was replaced. Review this work area again.')
    if _sensitive(path):
        _error(403, 'Private files, saves, profiles and dependency folders are excluded.')
    info = _inspect(path, missing=create)
    if write and not (info and stat.S_ISDIR(info.st_mode)) and (not _is_text_path(path) or path.name.casefold() in LAUNCHER_NAMES
                  or path.name.casefold().startswith('appmanifest_') or path.suffix.casefold() in {'.item', '.acf', '.vdf'}):
        _error(403, 'Only source and configuration text may be edited; binaries, archives and launcher manifests are excluded.')
    if info and stat.S_ISREG(info.st_mode) and (info.st_nlink != 1 or info.st_size > MAX_FILE):
        _error(403, 'Choose an ordinary text file under 512 KiB with no hard links.')
    return path


def authorize_path(owner, area_id, path, *, write=False):
    """Public helper for checking a command working directory, not a sandbox."""
    return str(_path(get_area(owner, area_id), path, write=write))


@contextmanager
def _pinned_file(path, *, write=False, create=False, delete=False, verify=None):
    """Pin Windows ancestors and target against rename/reparse replacement.

    Target writes use the retained handle. POSIX reads use O_NOFOLLOW; callers
    recheck ancestry and identity immediately before effects.
    """
    handles = []
    fd = None
    try:
        _inspect(path, missing=create)
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes as w
            import msvcrt
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
            kernel.CreateFileW.restype = w.HANDLE
            kernel.CloseHandle.argtypes = [w.HANDLE]
            kernel.CloseHandle.restype = w.BOOL
            for parent in reversed(path.parents):
                handle = kernel.CreateFileW(str(parent), 0x80, 3, None, 3, 0x02200000, None)
                if handle == w.HANDLE(-1).value:
                    _error(409, 'A work-area parent is busy or could not be pinned.')
                handles.append((kernel, handle))
            _inspect(path, missing=create)
            if verify:
                verify()
            access = 0x80000000 | (0x40000000 if write else 0) | (0x10000 if delete else 0)
            handle = kernel.CreateFileW(str(path), access, 1 if write or delete else 3, None,
                                        1 if create else 3, 0x00200000, None)
            if handle == w.HANDLE(-1).value:
                _error(409, 'This file changed, is busy, or cannot be opened safely.')
            fd = msvcrt.open_osfhandle(handle, os.O_BINARY | (os.O_RDWR if write else os.O_RDONLY))
        else:
            if verify:
                verify()
            flags = (os.O_RDWR if write else os.O_RDONLY) | getattr(os, 'O_NOFOLLOW', 0)
            if create:
                flags |= os.O_CREAT | os.O_EXCL
            fd = os.open(path, flags, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_FILE:
            _error(403, 'Only bounded ordinary files with one link are supported.')
        if _identity(info) != _identity(_inspect(path)):
            _error(409, 'This file changed during inspection.')
        with os.fdopen(fd, 'r+b' if write else 'rb') as stream:
            fd = None
            yield stream
    except OSError as exc:
        raise HTTPException(409, 'The file could not be accessed safely; review it before retrying.') from exc
    finally:
        if fd is not None:
            os.close(fd)
        for kernel, handle in reversed(handles):
            kernel.CloseHandle(handle)


def _decode(raw):
    if raw.startswith(codecs.BOM_UTF16_LE):
        encoding, bom = 'utf-16-le', codecs.BOM_UTF16_LE
    elif raw.startswith(codecs.BOM_UTF16_BE):
        encoding, bom = 'utf-16-be', codecs.BOM_UTF16_BE
    elif raw.startswith(codecs.BOM_UTF8):
        encoding, bom = 'utf-8', codecs.BOM_UTF8
    else:
        encoding, bom = 'utf-8', b''
    try:
        text = raw[len(bom):].decode(encoding)
    except UnicodeError:
        _error(422, 'This file is not supported UTF-8 or BOM-marked UTF-16 text.')
    if '\x00' in text:
        _error(422, 'Binary content is excluded from text tools.')
    newline = '\r\n' if '\r\n' in text else '\r' if '\r' in text else '\n'
    return text, encoding, bom, newline


def _bytes(path, verify=None):
    with _pinned_file(path, verify=verify) as stream:
        before = os.fstat(stream.fileno())
        raw = stream.read(MAX_FILE + 1)
        after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            _error(409, 'The file changed while it was read. Retry the bounded read.')
    if len(raw) > MAX_FILE:
        _error(413, 'The text file grew beyond the 512 KiB limit.')
    return raw


def _hash(raw):
    return hashlib.sha256(raw).hexdigest()


def _receipt(operation):
    return {key: operation[key] for key in ('id', 'task_id', 'area_id', 'path', 'before_sha256', 'after_sha256', 'status', 'created_at')}


def _uncertain(operation):
    # The prepared snapshot was saved before the effect. Keep its identity in
    # the task receipt so an explicit recovery can still use that snapshot.
    return {'path': operation['path'], 'receipt': _receipt(operation), 'outcome': 'unknown',
            'undo_available': True,
            'detail': 'The file operation could not be fully recorded. Inspect the file and explicitly recover this snapshot before further edits. Recovery refuses to overwrite unrecognized content.'}


def _remove_pinned(path, stream):
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes as w
        import msvcrt
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.SetFileInformationByHandle.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        kernel.SetFileInformationByHandle.restype = w.BOOL
        delete = w.BOOL(True)
        if not kernel.SetFileInformationByHandle(w.HANDLE(msvcrt.get_osfhandle(stream.fileno())), 4,
                                                 ctypes.byref(delete), ctypes.sizeof(delete)):
            _error(409, 'The new file could not be removed safely.')
    else:
        if _identity(os.fstat(stream.fileno())) != _identity(_inspect(path)):
            _error(409, 'The new file changed before undo.')
        path.unlink()


def _validate(path, text):
    suffix = path.suffix.casefold()
    kind = {'.json': 'json', '.ini': 'ini', '.cfg': 'ini', '.xml': 'xml', '.py': 'python', '.toml': 'toml'}.get(suffix)
    if not kind:
        return {'valid': None, 'validator': 'none', 'detail': 'No built-in syntax validator for this file type. No project code executed.'}
    try:
        if kind == 'json':
            json.loads(text)
        elif kind == 'ini':
            configparser.ConfigParser(interpolation=None).read_string(text)
        elif kind == 'xml':
            if re.search(r'<!\s*(DOCTYPE|ENTITY)\b', text, re.I):
                raise ValueError('XML document types and entities are unsupported')
            ET.fromstring(text)
        elif kind == 'python':
            ast.parse(text, filename=path.name)
        else:
            import tomllib
            tomllib.loads(text)
        return {'valid': True, 'validator': kind, 'detail': 'Syntax check passed. No project code or game was executed.'}
    except (ValueError, SyntaxError, configparser.Error, ET.ParseError) as exc:
        return {'valid': False, 'validator': kind, 'detail': str(exc)[:1200]}
    except ImportError:
        return {'valid': None, 'validator': kind, 'detail': 'This host Python does not include the requested validator.'}


def _walk(area, root, check, bounds):
    """Stream directory entries: even one huge directory is bounded."""
    count, started, pending = 0, time.monotonic(), [root]
    while pending:
        directory = pending.pop()
        try:
            iterator = os.scandir(directory)
        except OSError:
            bounds['truncated'] = True
            continue
        with iterator:
            for entry in iterator:
                count += 1
                check()
                if count > MAX_ENTRIES or time.monotonic() - started > 10:
                    bounds['truncated'] = True
                    return
                path = Path(entry.path)
                try:
                    _path(area, str(path))
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(path)
                    elif _is_text_path(path):
                        yield path
                except (HTTPException, OSError):
                    continue


def dispatch(owner, area_id, name, args, check, task_id=None):
    if not isinstance(args, dict):
        _error(422, 'Tool arguments must be an object.')
    check()
    area = get_area(owner, area_id)
    revision = area['revision']

    def current():
        check()
        if get_area(owner, area_id)['revision'] != revision:
            _error(409, 'Work-area permissions changed. Remaining steps stopped.')

    if name == 'workspace_undo':
        return _undo(owner, area, args.get('operation_id'), current)
    if name not in {'workspace_list', 'workspace_search', 'workspace_read', 'workspace_write', 'workspace_validate'}:
        _error(422, 'Unknown work-area tool.')
    path = _path(area, args.get('path'), write=name == 'workspace_write', create=bool(args.get('create')))
    if name == 'workspace_write':
        return _write(owner, area, path, args, current, task_id)
    if name in {'workspace_read', 'workspace_validate'}:
        if not _is_text_path(path):
            _error(403, 'Only source, logs and configuration text can be read with this tool.')
        raw = _bytes(path, verify=lambda: _path(area, str(path)))
        text, encoding, _, newline = _decode(raw)
        result = {'path': str(path), 'sha256': _hash(raw), 'encoding': encoding, 'newline': repr(newline)}
        if name == 'workspace_validate':
            result.update(_validate(path, text))
        else:
            start, count = args.get('start_line', 1), args.get('max_lines', 200)
            if type(start) is not int or start < 1 or type(count) is not int or not 1 <= count <= 400:
                _error(422, 'Use a positive starting line and one to 400 lines.')
            lines = text.splitlines(keepends=True)
            content = ''.join(lines[start - 1:start - 1 + count])
            result.update(content=content[:MAX_RESULT], start_line=start, total_lines=len(lines),
                          truncated=len(content) > MAX_RESULT or start - 1 + count < len(lines))
        current()
        return result
    if not path.is_dir():
        _error(422, 'Choose a folder for listing or searching.')
    if name == 'workspace_list':
        entries = []
        with os.scandir(path) as iterator:
            for index, entry in enumerate(iterator):
                current()
                if index >= 200:
                    break
                try:
                    candidate = _path(area, entry.path)
                    entries.append({'path': str(candidate), 'kind': 'directory' if candidate.is_dir() else 'file'})
                except HTTPException:
                    continue
        current()
        return {'path': str(path), 'entries': entries, 'truncated': index >= 200 if 'index' in locals() else False}
    query = args.get('query')
    if not isinstance(query, str) or not 1 <= len(query) <= 300:
        _error(422, 'Search for one to 300 characters of literal text.')
    matches, size, inspected, bounds = [], 0, 0, {'truncated': False}
    for candidate in _walk(area, path, current, bounds):
        inspected += 1
        if query.casefold() in candidate.name.casefold():
            item = {'path': str(candidate), 'line': 0, 'text': candidate.name, 'kind': 'filename'}
            size += len(json.dumps(item))
            if len(matches) >= 80 or size > MAX_RESULT:
                current()
                return {'matches': matches, 'truncated': True, 'files_inspected': inspected}
            matches.append(item)
        try:
            text, _, _, _ = _decode(_bytes(candidate, verify=lambda: _path(area, str(candidate))))
        except HTTPException:
            continue
        for line, content in enumerate(text.splitlines(), 1):
            if query.casefold() in content.casefold():
                item = {'path': str(candidate), 'line': line, 'text': content[:400]}
                size += len(json.dumps(item))
                if len(matches) >= 80 or size > MAX_RESULT:
                    current()
                    return {'matches': matches, 'truncated': True, 'files_inspected': inspected}
                matches.append(item)
    current()
    return {'matches': matches, 'truncated': bounds['truncated'], 'files_inspected': inspected,
            'scope': 'Bounded text search; unavailable, excluded and non-text files may be omitted.'}


def _write(owner, area, path, args, check, task_id):
    content, create, expected = args.get('content'), args.get('create', False), args.get('expected_sha256')
    if not isinstance(content, str) or len(content) > MAX_FILE or '\x00' in content or type(create) is not bool:
        _error(422, 'Supply bounded text and a boolean create flag.')
    if create and expected not in (None, '') or not create and (not isinstance(expected, str) or not re.fullmatch('[a-f0-9]{64}', expected)):
        _error(422, 'Updates require the SHA-256 from a current read; new files require create=true and no prior hash.')
    with LOCK:
        check()
        value = _load(owner)
        if len(value['operations']) >= MAX_OPERATIONS:
            _error(409, 'Snapshot history is full. Existing undo records were preserved.')
        pending = next((op for op in value['operations'].values() if op['path'] == str(path) and op['status'] in {'prepared', 'undo_prepared'}), None)
        if pending:
            _error(409, 'This file has an interrupted operation. Resolve workspace_undo for ' + pending['id'] + ' before editing again.')
        path = _path(area, str(path), write=True, create=create)
        before = None if create else _bytes(path, verify=lambda: _path(area, str(path), write=True))
        if not create and _hash(before) != expected:
            _error(409, 'This file changed since it was read. Read it again before writing.')
        if create and path.exists():
            _error(409, 'New-file creation never overwrites an existing file.')
        _, encoding, bom, newline = _decode(before or b'')
        normalized = content.replace('\r\n', '\n').replace('\r', '\n').replace('\n', newline)
        after = bom + normalized.encode(encoding)
        if len(after) > MAX_FILE:
            _error(413, 'The encoded text exceeds 512 KiB.')
        operation = {'id': 'op_' + uuid.uuid4().hex, 'task_id': task_id or '', 'area_id': area['id'],
                     'path': str(path), 'before': base64.b64encode(before).decode() if before is not None else None,
                     'before_sha256': _hash(before) if before is not None else None,
                     'after_sha256': _hash(after), 'status': 'prepared', 'created_at': S.now_iso()}
        value['operations'][operation['id']] = operation
        _save(owner, value)  # A durable recovery record is mandatory before any target write.
        check()
        def verify():
            check()
            _path(area, str(path), write=True, create=create)
        attempted = False
        try:
            with _pinned_file(path, write=True, create=create, verify=verify) as stream:
                attempted = create
                original = stream.read(MAX_FILE + 1)
                if not create and _hash(original) != expected:
                    value['operations'].pop(operation['id'])
                    _save(owner, value)
                    _error(409, 'This file changed before writing. No edit was applied.')
                # verify checked authority immediately before opening this
                # retained handle; creation plus contents form one file effect.
                attempted = True
                stream.seek(0)
                stream.write(after)
                stream.truncate()
                stream.flush()
                os.fsync(stream.fileno())
                operation['file_identity'] = _identity(os.fstat(stream.fileno()))
        except HTTPException as exc:
            if attempted and exc.status_code not in (401, 403):
                return _uncertain(operation)
            raise
        operation['status'] = 'applied'
        try:
            _save(owner, value)
        except HTTPException:
            operation['status'] = 'prepared'
            return _uncertain(operation)
        return {'path': str(path), 'sha256': operation['after_sha256'], 'receipt': _receipt(operation), 'undo_available': True}


def _undo(owner, area, operation_id, check):
    with LOCK:
        value = _load(owner)
        operation = value['operations'].get(operation_id)
        if not operation or operation['area_id'] != area['id']:
            _error(404, 'No undo record belongs to this work area.')
        if operation['status'] == 'undone':
            return {'receipt': _receipt(operation), 'already_undone': True}
        path = _path(area, operation['path'], write=True, create=operation['before'] is None)
        before = None
        if operation['before'] is not None:
            try:
                before = base64.b64decode(operation['before'], validate=True)
                if _hash(before) != operation['before_sha256']:
                    raise ValueError()
            except (ValueError, TypeError):
                raise security_state.SecurityStateUnavailable('task snapshot') from None
        check()
        if before is None and not path.exists() and operation['status'] in {'prepared', 'undo_prepared'}:
            operation['status'] = 'undone'
            _save(owner, value)
            return {'path': str(path), 'receipt': _receipt(operation), 'already_restored': True}
        def verify():
            check()
            _path(area, str(path), write=True)
        attempted = False
        try:
            with _pinned_file(path, write=True, delete=before is None, verify=verify) as stream:
                current = stream.read(MAX_FILE + 1)
                if (before is not None and _hash(current) == operation['before_sha256']
                        and operation['status'] in {'prepared', 'undo_prepared'}):
                    operation['status'] = 'undone'
                    _save(owner, value)
                    return {'path': str(path), 'sha256': operation['before_sha256'], 'receipt': _receipt(operation), 'already_restored': True}
                if (_hash(current) != operation['after_sha256']
                        or operation.get('file_identity') not in (None, _identity(os.fstat(stream.fileno())))):
                    _error(409, 'The file changed after this task. Undo will not overwrite newer work.')
                operation['status'] = 'undo_prepared'
                _save(owner, value)
                check()
                attempted = True
                if before is None:
                    _remove_pinned(path, stream)
                else:
                    stream.seek(0)
                    stream.write(before)
                    stream.truncate()
                    stream.flush()
                    os.fsync(stream.fileno())
        except HTTPException as exc:
            if attempted and exc.status_code not in (401, 403):
                return _uncertain(operation)
            raise
        operation['status'] = 'undone'
        try:
            _save(owner, value)
        except HTTPException:
            operation['status'] = 'undo_prepared'
            return _uncertain(operation)
        return {'path': str(path), 'sha256': operation['before_sha256'], 'receipt': _receipt(operation)}
