"""Ephemeral, owner-scoped inventory evidence, separate from bounded UI trees.

SQLite is a stdlib, local derived index, not an application database or service.
The parent process writes rows acquired by the read-only worker. Completed files
are atomically published; unfinished files are never queried. Each connection
uses a bounded page cache and disk-backed temporary tables. No scanned file is
opened by this module and none of this evidence authorizes cleanup.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA_VERSION = 1
ACCOUNTING = "lexicographic_path_identity_v1"
MAX_PAGE = 200
MAX_RESPONSE = 768 * 1024
MAX_PATH = 4096
_ID = re.compile(r"^[0-9a-f]{32}$")
_OWNER = re.compile(r"^[0-9a-f]{64}$")
_LOCK = threading.RLock()
_ACTIVE = set()


class InventoryError(ValueError):
    pass


class InventoryNotFound(InventoryError):
    pass


class InventoryLimit(InventoryError):
    pass


class InventoryInvalid(InventoryError):
    pass


def _text(value, maximum=MAX_PATH):
    if not isinstance(value, str) or not value or len(value) > maximum or "\x00" in value:
        raise InventoryInvalid("Inventory text is unavailable or exceeds its bound")
    return value


def _path(value):
    # Lexical only: resolving would follow links and probe the scanned tree.
    return os.path.normpath(os.path.abspath(_text(value)))


def _inside(root, value):
    result = _path(value)
    try:
        if os.path.commonpath([os.path.normcase(root), os.path.normcase(result)]) != os.path.normcase(root):
            raise InventoryInvalid("The indexed path is outside this scan")
    except ValueError:
        raise InventoryInvalid("The indexed path is outside this scan") from None
    return result


def _bytes(value):
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 2**60:
        raise InventoryInvalid("Invalid inventory byte count")
    return value


def _connect(path, *, readonly=False, max_bytes=128 * 1024**2):
    conn = None
    try:
        if readonly:
            conn = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5, check_same_thread=False)
        else:
            conn = sqlite3.connect(str(path), timeout=5, check_same_thread=False)
            conn.execute("PRAGMA journal_mode=DELETE")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA max_page_count=" + str(max(8, max_bytes // 4096)))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA cache_size=-2048")
        conn.execute("PRAGMA temp_store=FILE")
        conn.execute("PRAGMA mmap_size=0")
        return conn
    except BaseException:
        if conn is not None:
            conn.close()
        raise


class StorageInventory:
    def __init__(self, directory, *, max_bytes=512 * 1024**2,
                 max_scan_bytes=128 * 1024**2, ttl_seconds=1800):
        self.directory = Path(directory).absolute()
        self.max_bytes = int(max_bytes)
        self.max_scan_bytes = int(max_scan_bytes)
        self.ttl_seconds = float(ttl_seconds)
        self.directory.mkdir(parents=True, exist_ok=True)
        if self.directory.is_symlink() or (hasattr(self.directory, "is_junction") and self.directory.is_junction()):
            raise InventoryInvalid("Inventory directory must not be linked")
        # Jobs have process-local owners: no staging file survives a backend
        # restart as a resumable job. Preserve writers active in this process.
        with _LOCK:
            for item in self._files():
                base = Path(str(item).removesuffix("-journal"))
                if base.suffix == ".building" and str(base) not in _ACTIVE:
                    item.unlink(missing_ok=True)
        self.prune()

    def _owner_dir(self, owner, *, create=False):
        digest = hashlib.sha256(_text(owner, 8192).encode("utf-8")).hexdigest()
        target = self.directory / digest
        if target.is_symlink() or (hasattr(target, "is_junction") and target.is_junction()):
            raise InventoryInvalid("Inventory owner directory must not be linked")
        if create:
            target.mkdir(exist_ok=True)
        return target

    def _filename(self, owner, scan_id, *, building=False):
        if not isinstance(scan_id, str) or not _ID.fullmatch(scan_id):
            raise InventoryNotFound("Scan inventory is unavailable")
        target = self._owner_dir(owner) / (scan_id + (".building" if building else ".sqlite"))
        if target.is_symlink() or (hasattr(target, "is_junction") and target.is_junction()):
            raise InventoryNotFound("Scan inventory is unavailable")
        return target

    def _files(self):
        for owner_dir in self.directory.iterdir():
            if not _OWNER.fullmatch(owner_dir.name) or owner_dir.is_symlink() or not owner_dir.is_dir():
                continue
            if hasattr(owner_dir, "is_junction") and owner_dir.is_junction():
                continue
            for item in owner_dir.iterdir():
                if item.is_symlink() or not item.is_file():
                    continue
                if re.fullmatch(r"[0-9a-f]{32}\.(sqlite|building)(-journal)?", item.name):
                    yield item

    def prune(self):
        """Expire published scans; recover abandoned staging files after one hour."""
        now = time.time()
        with _LOCK:
            completed = []
            total = 0
            for item in self._files():
                try:
                    info = item.stat()
                    base = Path(str(item).removesuffix("-journal"))
                    stale = now - info.st_mtime > (self.ttl_seconds if item.suffix == ".sqlite" else 3600)
                    if stale and str(base) not in _ACTIVE:
                        item.unlink(missing_ok=True)
                        continue
                    total += info.st_size
                    if item.suffix == ".sqlite":
                        completed.append((info.st_mtime, item, info.st_size))
                except OSError:
                    continue
            # Small bounded catalogue (64 completed scans globally, 12 per owner).
            owners = {}
            for _, item, _ in completed:
                owners[item.parent] = owners.get(item.parent, 0) + 1
            count = len(completed)
            for _, item, size in sorted(completed):
                if total <= self.max_bytes and count <= 64 and owners[item.parent] <= 12:
                    continue
                try:
                    item.unlink(missing_ok=True)
                    total -= size
                    count -= 1
                    owners[item.parent] -= 1
                except OSError:
                    pass
            return {"bytes": total, "scans": count}

    def begin(self, owner, root, scan_id=None):
        scan_id = scan_id or secrets.token_hex(16)
        with _LOCK:
            self.prune()
            self._owner_dir(owner, create=True)
            path = self._filename(owner, scan_id, building=True)
            if path.exists() or self._filename(owner, scan_id).exists():
                raise InventoryInvalid("An inventory already exists for this scan")
            # Exclusive creation protects against accidentally replacing another writer.
            with path.open("xb"):
                pass
            _ACTIVE.add(str(path))
            try:
                return InventoryWriter(self, owner, scan_id, _path(root), path)
            except BaseException as exc:
                _ACTIVE.discard(str(path))
                path.unlink(missing_ok=True)
                Path(str(path) + "-journal").unlink(missing_ok=True)
                if isinstance(exc, sqlite3.Error):
                    raise InventoryLimit("Inventory storage could not be initialized within its resource limits") from exc
                raise

    def _read(self, owner, scan_id):
        path = self._filename(owner, scan_id)
        conn = None
        try:
            if time.time() - path.stat().st_mtime > self.ttl_seconds:
                self.delete(owner, scan_id)
                raise InventoryNotFound("Scan inventory expired")
            conn = _connect(path, readonly=True)
            value = conn.execute("SELECT substr(value,1,65537) FROM metadata WHERE key='summary'").fetchone()[0]
            if len(value) > 65536:
                raise InventoryNotFound("Scan inventory metadata exceeds its format bound")
            meta = json.loads(value)
            if (not isinstance(meta, dict) or meta.get("schema_version") != SCHEMA_VERSION
                    or meta.get("scan_id") != scan_id or not isinstance(meta.get("root"), str)
                    or not os.path.isabs(meta["root"]) or len(meta["root"]) > MAX_PATH
                    or type(meta.get("acquisition_complete")) is not bool
                    or type(meta.get("expires_at")) not in (int, float)):
                raise InventoryNotFound("Scan inventory has an unsupported format")
            if time.time() >= meta["expires_at"]:
                conn.close()
                conn = None
                self.delete(owner, scan_id)
                raise InventoryNotFound("Scan inventory expired")
            return conn, meta
        except InventoryNotFound:
            if conn is not None:
                conn.close()
            raise
        except (OSError, sqlite3.Error, TypeError, json.JSONDecodeError):
            if conn is not None:
                conn.close()
            raise InventoryNotFound("Scan inventory is unavailable") from None

    def summary(self, owner, scan_id):
        conn, meta = self._read(owner, scan_id)
        conn.close()
        return meta

    def delete(self, owner, scan_id):
        with _LOCK:
            for building in (False, True):
                path = self._filename(owner, scan_id, building=building)
                if str(path) in _ACTIVE:
                    continue
                path.unlink(missing_ok=True)
                Path(str(path) + "-journal").unlink(missing_ok=True)

    def query(self, owner, scan_id, *, mode="children", path=None, search="", extension="",
              sort="size", descending=True, offset=0, limit=100):
        if mode not in {"children", "search", "extension", "largest", "item"}:
            raise InventoryInvalid("Unsupported inventory query")
        sorts = {"size": "counted_size", "logical_size": "logical_size", "allocated_size": "allocated_size",
                 "name": "name COLLATE NOCASE", "path": "path", "modified_at": "modified_at", "kind": "kind"}
        if sort not in sorts:
            raise InventoryInvalid("Unsupported inventory sort")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0 or offset > 1_000_000:
            raise InventoryInvalid("Invalid inventory offset")
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise InventoryInvalid("Invalid inventory page size")
        if not isinstance(descending, bool):
            raise InventoryInvalid("Invalid inventory sort direction")
        limit = min(limit, MAX_PAGE)
        conn, meta = self._read(owner, scan_id)
        query_deadline = time.monotonic() + 5
        conn.set_progress_handler(lambda: int(time.monotonic() >= query_deadline), 2000)
        try:
            clauses, params = [], []
            if mode in {"children", "item"}:
                selected = _inside(meta["root"], path or meta["root"])
                selected_row = conn.execute("SELECT kind FROM items WHERE path_key=?", (os.path.normcase(selected),)).fetchone()
                if not selected_row or (mode == "children" and selected_row[0] != "directory"):
                    raise InventoryNotFound("The selected indexed item is unavailable")
                clauses.append(("parent_key" if mode == "children" else "path_key") + "=?")
                params.append(os.path.normcase(selected))
            if mode == "search":
                _text(search, 256)
                clauses.append("instr(lower(path), lower(?)) > 0")
                params.append(search)
            if mode == "extension":
                if not isinstance(extension, str) or len(extension) > 80:
                    raise InventoryInvalid("Invalid extension")
                clauses.extend(["kind='file'", "extension=?"])
                params.append(extension.lower())
            if mode == "largest":
                clauses.extend(["kind='file'", "canonical=1", "size_known=1"])
            condition = " AND ".join(clauses) or "1"
            total = conn.execute("SELECT count(*) FROM items WHERE " + condition, params).fetchone()[0]
            direction = " DESC" if descending else " ASC"
            # Every ordering has a stable unique tiebreaker. SQL identifiers are whitelisted.
            sql = "SELECT * FROM items WHERE " + condition + " ORDER BY " + sorts[sort] + direction + ",path_key ASC LIMIT ? OFFSET ?"
            rows, encoded_bytes, response_limited = [], 0, False
            for raw in conn.execute(sql, [*params, limit, offset]):
                row = self._public_row(raw)
                size = len(json.dumps(row, ensure_ascii=True).encode("utf-8"))
                if rows and encoded_bytes + size > MAX_RESPONSE:
                    response_limited = True
                    break
                rows.append(row)
                encoded_bytes += size
            return {"schema_version": SCHEMA_VERSION, "scan_id": scan_id, "rows": rows,
                    "total": total, "offset": offset, "limit": limit, "next_offset": offset + len(rows),
                    "has_more": offset + len(rows) < total, "query_truncated": offset + len(rows) < total,
                    "response_bytes": encoded_bytes, "response_limited": response_limited, "summary": meta}
        except sqlite3.Error as exc:
            raise InventoryLimit("Inventory query exceeded its resource limit") from exc
        finally:
            conn.close()

    @staticmethod
    def _public_row(raw):
        row = dict(raw)
        for name in ("path_key", "parent_key", "depth"):
            row.pop(name, None)
        row["size"] = row.pop("counted_size")
        row["hardlink_duplicate"] = row["kind"] == "file" and not bool(row.pop("canonical"))
        for name in ("size_known", "size_partial", "allocated_partial", "protected", "excluded"):
            row[name] = bool(row[name])
        row["children_loaded"] = False
        row["has_children"] = bool(row["children_count"]) if row["kind"] == "directory" else False
        row["child_count"] = row["children_count"]
        row["children_complete"] = row["kind"] == "directory" and not row["size_partial"]
        row["children_state"] = ("partial" if row["size_partial"] else "unloaded" if row["children_count"] else "empty") if row["kind"] == "directory" else None
        row["evidence_only"] = True
        return row

    def compare(self, owner, older_id, newer_id, *, limit=100):
        """Bounded file identity comparison. Folder deltas intentionally remain withheld."""
        limit = min(MAX_PAGE, max(1, int(limit)))
        older, before = self._read(owner, older_id)
        newer = None
        try:
            newer, after = self._read(owner, newer_id)
            reasons = []
            for key in ("root", "accounting", "volume_identity", "volume_observation", "scan_filters", "engine"):
                if before.get(key) != after.get(key):
                    reasons.append(key + "_differs")
            if not before.get("acquisition_complete") or not after.get("acquisition_complete"):
                reasons.append("incomplete_acquisition")
            if before.get("identity_unknown") or after.get("identity_unknown"):
                reasons.append("identity_unknown")
            if not before.get("volume_identity") or not after.get("volume_identity"):
                reasons.append("volume_identity_unknown")
            if any(value.get("volume_observation") is not None and value["volume_observation"].get("status") != "known" for value in (before, after)):
                reasons.append("volume_identity_unknown")
            incompatible = any(reason.endswith("_differs") or reason == "volume_identity_unknown" for reason in reasons)
            complete = bool(before.get("acquisition_complete") and after.get("acquisition_complete"))
            # ATTACH uses the owner-checked local file and cannot accept arbitrary paths.
            newer.execute("ATTACH DATABASE ? AS previous", (self._filename(owner, older_id).as_uri() + "?mode=ro",))
            comparison_deadline = time.monotonic() + 5
            newer.set_progress_handler(lambda: int(time.monotonic() >= comparison_deadline), 2000)
            condition = ("n.kind='file' AND o.kind='file' AND n.canonical=1 AND o.canonical=1 "
                         "AND n.excluded=0 AND o.excluded=0 AND n.size_known=1 AND o.size_known=1 "
                         "AND n.file_identity=o.file_identity AND n.file_identity IS NOT NULL "
                         "AND n.created_at IS o.created_at")
            changes, encoded_bytes, results_limited = [], 0, False
            sql = ("SELECT n.path,n.file_identity,n.logical_size,o.path AS previous_path,o.logical_size AS previous_logical_size "
                   "FROM items n JOIN previous.items o ON n.file_identity=o.file_identity WHERE " + condition +
                   " AND (n.logical_size!=o.logical_size OR n.path_key!=o.path_key) ORDER BY abs(n.logical_size-o.logical_size) DESC,n.path LIMIT ?")
            for raw in ([] if incompatible else newer.execute(sql, (limit + 1,))):
                if len(changes) >= limit:
                    results_limited = True
                    break
                row = dict(raw)
                row["logical_delta"] = row["logical_size"] - row["previous_logical_size"] if row["logical_size"] is not None and row["previous_logical_size"] is not None else None
                row["observation"] = "same_filesystem_identity"
                row["status"] = "observed_growth" if (row["logical_delta"] or 0) > 0 else "observed_reduction" if (row["logical_delta"] or 0) < 0 else "path_changed"
                size = len(json.dumps(row, ensure_ascii=True).encode("utf-8"))
                if changes and encoded_bytes + size > MAX_RESPONSE:
                    results_limited = True
                    break
                changes.append(row)
                encoded_bytes += size
            return {"schema_version": SCHEMA_VERSION, "older_scan_id": older_id, "newer_scan_id": newer_id,
                    "available": True, "complete": False,
                    "acquisition_complete": complete and not incompatible,
                    "comparison_scope": "matched_file_identities", "changes_complete": False,
                    "added_removed_supported": False,
                    "comparable": not reasons, "reasons": reasons, "changes": changes,
                    "reason": "Scopes or accounting differ; file changes are withheld." if incompatible else "Matched identities only; some scope was not inspected. Added or removed names and folder deltas are not assessed." if reasons else "Matched filesystem identities only. Added or removed names and folder deltas are not assessed.",
                    "results_limited": results_limited, "folder_deltas_supported": False,
                    "atomic_snapshot": False, "identity_caveat": "Filesystem identifiers can be reused after deletion; live observations do not prove a rename or causal change."}
        except sqlite3.Error as exc:
            raise InventoryLimit("Inventory comparison exceeded its resource limit") from exc
        finally:
            older.close()
            if newer is not None:
                newer.close()


class InventoryWriter:
    def __init__(self, store, owner, scan_id, root, path):
        self.store, self.owner, self.scan_id, self.root, self.path = store, owner, scan_id, root, path
        self._lock = threading.RLock()
        self._closed = False
        self.started = time.time()
        self.indexing_seconds = 0.0
        self.conn = _connect(path, max_bytes=store.max_scan_bytes)
        try:
            self.conn.executescript("""
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE items(
              path_key TEXT PRIMARY KEY,path TEXT NOT NULL,parent_key TEXT,parent_path TEXT,
              name TEXT NOT NULL,kind TEXT NOT NULL,depth INTEGER NOT NULL,
              file_identity TEXT,volume_identity TEXT,logical_size INTEGER,allocated_size INTEGER,
              counted_size INTEGER NOT NULL,allocated_known_bytes INTEGER NOT NULL,
              size_known INTEGER NOT NULL,size_partial INTEGER NOT NULL,allocated_partial INTEGER NOT NULL,
              canonical INTEGER NOT NULL,modified_at TEXT,created_at TEXT,extension TEXT,category TEXT,
              protected INTEGER NOT NULL,excluded INTEGER NOT NULL,coverage_reason TEXT,
              children_count INTEGER NOT NULL DEFAULT 0,files INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX by_parent ON items(parent_key);
            CREATE INDEX by_identity ON items(file_identity);
            CREATE INDEX by_extension ON items(extension);
            CREATE INDEX by_size ON items(counted_size DESC);
            CREATE INDEX by_depth ON items(depth);
            """)
            self.conn.commit()
        except BaseException:
            self.conn.close()
            self._closed = True
            raise

    def _normalize(self, row):
        for name in ("size_known", "size_partial", "allocated_partial", "protected", "excluded", "hardlink_duplicate"):
            if name in row and not isinstance(row[name], bool):
                raise InventoryInvalid("Invalid inventory boolean: " + name)
        if row.get("root_path") is not None and os.path.normcase(_path(row["root_path"])) != os.path.normcase(self.root):
            raise InventoryInvalid("Inventory row root does not match this scan")
        path = _inside(self.root, row.get("path"))
        key = os.path.normcase(path)
        root_key = os.path.normcase(self.root)
        parent = None if key == root_key else os.path.dirname(path)
        if row.get("parent_path") and parent and os.path.normcase(_path(row["parent_path"])) != os.path.normcase(parent):
            raise InventoryInvalid("Inventory parent does not match the observed path")
        kind = row.get("kind", "unknown")
        if kind not in {"file", "directory", "link", "unknown"}:
            raise InventoryInvalid("Invalid inventory item kind")
        logical = _bytes(row.get("logical_size", row.get("size") if kind == "file" else None))
        allocated = _bytes(row.get("allocated_size"))
        known = bool(row.get("size_known", logical is not None if kind == "file" else True))
        partial = bool(row.get("size_partial", not known))
        if not known and not partial:
            raise InventoryInvalid("Unknown sizes must retain partial coverage")
        if kind == "file" and allocated is None and row.get("allocated_partial") is False:
            raise InventoryInvalid("Unknown allocation cannot be reported complete")
        excluded = bool(row.get("excluded"))
        identity = row.get("file_identity")
        volume = row.get("volume_identity")
        if identity is not None:
            _text(identity, 256)
        if volume is not None:
            _text(volume, 256)
        # Python's ordering and SQLite BINARY ordering agree for these normalized paths.
        depth = 0 if key == root_key else len(Path(os.path.relpath(path, self.root)).parts)
        if depth > 128:
            raise InventoryLimit("Inventory directory depth exceeds its safety bound")
        optional = lambda value, bound: value[:bound] if isinstance(value, str) else None
        return (key, path, os.path.normcase(parent) if parent else None, parent,
                _text(row.get("name") or os.path.basename(path) or path, MAX_PATH), kind, depth, identity, volume,
                logical, allocated, logical or 0 if kind == "file" and not excluded else 0,
                allocated or 0 if kind == "file" and not excluded else 0,
                int(known), int(partial), int(row.get("allocated_partial", allocated is None)), 1,
                optional(row.get("modified_at"), 80), optional(row.get("created_at"), 80),
                optional(row.get("extension", ""), 80), optional(row.get("category", "other"), 80),
                int(bool(row.get("protected"))), int(excluded), optional(row.get("coverage_reason", row.get("size_reason")), 256),
                0, int(kind == "file"))

    def add_rows(self, rows, checkpoint=None):
        """Commit bounded batches; no scan-sized collection is retained in memory."""
        with self._lock:
            if self._closed:
                raise InventoryInvalid("Inventory writer is closed")
            started = time.monotonic()
            batch = []
            interrupted = []

            def check():
                if checkpoint:
                    try:
                        checkpoint()
                    except BaseException as exc:
                        interrupted.append(exc)
                        raise

            def progress():
                try:
                    check()
                    return 0
                except BaseException:
                    return 1

            self.conn.set_progress_handler(progress, 2000)
            try:
                check()
                for row in rows:
                    if not isinstance(row, dict):
                        raise InventoryInvalid("Invalid inventory row")
                    batch.append(self._normalize(row))
                    if len(batch) == 128:
                        check()
                        self._insert(batch)
                        check()
                        batch.clear()
                if batch:
                    check()
                    self._insert(batch)
                    check()
            except BaseException as exc:
                if interrupted:
                    self.abort()
                    raise interrupted[0]
                if isinstance(exc, sqlite3.Error):
                    self.conn.rollback()
                    raise InventoryLimit("Inventory disk or database resource limit reached") from exc
                raise
            finally:
                if not self._closed:
                    self.conn.set_progress_handler(None, 0)
                self.indexing_seconds += time.monotonic() - started

    def _insert(self, rows):
        self.conn.executemany("INSERT OR REPLACE INTO items VALUES(" + ",".join("?" for _ in range(26)) + ")", rows)
        self.conn.commit()
        if self.path.stat().st_size > self.store.max_scan_bytes:
            raise InventoryLimit("Scan inventory disk limit reached")
        with _LOCK:
            usage = self.store.prune()
            if usage["bytes"] > self.store.max_bytes:
                raise InventoryLimit("Inventory cache disk limit reached")

    def finalize(self, meta, checkpoint=None):
        with self._lock:
            if self._closed:
                raise InventoryInvalid("Inventory writer is closed")
            if not isinstance(meta, dict):
                raise InventoryInvalid("Invalid inventory completion metadata")
            for name in ("entries_seen", "inventory_rows_emitted", "omitted_records", "denied", "skipped", "depth_limited"):
                if name in meta and (not isinstance(meta[name], int) or isinstance(meta[name], bool) or meta[name] < 0):
                    raise InventoryInvalid("Invalid inventory completion counter: " + name)
            for name in ("partial", "cancelled", "entry_limited", "time_limited", "representation_limited"):
                if name in meta and not isinstance(meta[name], bool):
                    raise InventoryInvalid("Invalid inventory completion flag: " + name)
            started = time.monotonic()
            failure = []

            def progress():
                if checkpoint:
                    try:
                        checkpoint()
                    except BaseException as exc:
                        failure.append(exc)
                        return 1
                return 0

            self.conn.set_progress_handler(progress, 2000)
            try:
                # Deterministic hard-link attribution without retaining a Python identity set.
                self.conn.execute("""UPDATE items SET canonical=0,counted_size=0,allocated_known_bytes=0
                  WHERE kind='file' AND file_identity IS NOT NULL AND path_key!=(
                    SELECT min(alias.path_key) FROM items alias
                    WHERE alias.kind='file' AND alias.excluded=0 AND alias.file_identity=items.file_identity)""")
                max_depth = self.conn.execute("SELECT coalesce(max(depth),0) FROM items").fetchone()[0]
                # One disk aggregation per depth. No recursive path list or Python row graph.
                for depth in range(max_depth, -1, -1):
                    if checkpoint:
                        checkpoint()
                    self.conn.execute("""UPDATE items SET
                      counted_size=coalesce((SELECT sum(c.counted_size) FROM items c WHERE c.parent_key=items.path_key),0),
                      allocated_known_bytes=coalesce((SELECT sum(c.allocated_known_bytes) FROM items c WHERE c.parent_key=items.path_key),0),
                      allocated_partial=max(size_partial,coalesce((SELECT max(c.allocated_partial) FROM items c WHERE c.parent_key=items.path_key AND (c.kind!='file' OR c.canonical=1)),0)),
                      children_count=(SELECT count(*) FROM items c WHERE c.parent_key=items.path_key),
                      files=coalesce((SELECT sum(c.files) FROM items c WHERE c.parent_key=items.path_key),0)
                      WHERE kind='directory' AND depth=?""", (depth,))
                self.conn.execute("UPDATE items SET allocated_size=CASE WHEN allocated_partial=0 THEN allocated_known_bytes ELSE NULL END WHERE kind='directory'")
                count = dict(self.conn.execute("""SELECT count(*) AS indexed_entries,
                  coalesce(sum(kind='file'),0) AS indexed_files,coalesce(sum(kind='directory'),0) AS indexed_directories,
                  coalesce(sum(kind='file' AND file_identity IS NULL AND excluded=0),0) AS identity_unknown,
                  coalesce(sum(kind='file' AND canonical=0),0) AS hardlink_aliases,
                  coalesce(sum(excluded),0) AS excluded_entries,
                  coalesce(sum(size_partial),0) AS incomplete_entries,
                  coalesce(sum(kind='file' AND size_known=0),0) AS unreadable_entries,
                  coalesce(sum(kind='file' AND canonical=1 AND excluded=0 AND allocated_size IS NULL),0) AS allocation_unknown,
                  coalesce(sum(CASE WHEN kind='file' THEN counted_size ELSE 0 END),0) AS logical_bytes,
                  coalesce(sum(CASE WHEN kind='file' THEN allocated_known_bytes ELSE 0 END),0) AS allocated_known_bytes
                  FROM items""").fetchone())
                orphaned = self.conn.execute("SELECT count(*) FROM items n WHERE n.parent_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM items p WHERE p.path_key=n.parent_key AND p.kind='directory')").fetchone()[0]
                identity_conflicts = self.conn.execute("""SELECT count(*) FROM (
                  SELECT file_identity FROM items WHERE kind='file' AND file_identity IS NOT NULL
                  GROUP BY file_identity HAVING min(logical_size)!=max(logical_size)
                    OR min(allocated_size)!=max(allocated_size) OR min(modified_at)!=max(modified_at)
                    OR min(created_at)!=max(created_at))""").fetchone()[0]
                root_row = self.conn.execute("SELECT * FROM items WHERE path_key=?", (os.path.normcase(self.root),)).fetchone()
                if root_row is not None and root_row["kind"] != "directory":
                    raise InventoryInvalid("Scan inventory root must be a directory")
                if "inventory_rows_emitted" in meta and meta["inventory_rows_emitted"] != count["indexed_entries"]:
                    raise InventoryInvalid("Inventory transport row count does not match acquisition")
                volumes = self.conn.execute("SELECT DISTINCT volume_identity FROM items WHERE volume_identity IS NOT NULL LIMIT 2").fetchall()
                volume_observation = meta.get("volume_observation")
                if volume_observation is not None and (not isinstance(volume_observation, dict) or volume_observation.get("status") not in {"known", "changed", "unknown"}):
                    raise InventoryInvalid("Invalid volume observation evidence")
                uncertain_volume = volume_observation is not None and volume_observation["status"] != "known"
                complete = not (meta.get("partial") or meta.get("cancelled") or orphaned or identity_conflicts or uncertain_volume or not root_row or count["excluded_entries"] or count["incomplete_entries"] or count["unreadable_entries"] or count["identity_unknown"] or meta.get("omitted_records"))
                scanner = meta.get("scanner") or {}
                summary = {"schema_version": SCHEMA_VERSION, "scan_id": self.scan_id, "root": self.root,
                           "accounting": ACCOUNTING, "folder_deltas_supported": False,
                           "available": True, "status": "complete" if complete else "partial",
                           "indexed_count": count["indexed_entries"],
                           "atomic_snapshot": False, "observed_from": self.started, "observed_to": time.time(),
                           "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                           "expires_at": time.time() + self.store.ttl_seconds,
                           "acquisition_complete": complete, "indexed_scope_complete": complete,
                           "inspected_entries": int(meta.get("entries_seen", max(0, count["indexed_entries"] - 1))),
                           "orphaned_entries": orphaned, "omitted_records": int(meta.get("omitted_records", 0)),
                           "identity_conflicts": identity_conflicts,
                           "engine": scanner.get("engine", "scandir"), "fallback_reason": scanner.get("fallback_reason", meta.get("fallback_reason")),
                           "volume_identity": volumes[0][0] if len(volumes) == 1 else None,
                           "volume_observation": volume_observation,
                           "scan_filters": meta.get("scan_filters", {}),
                           "display_truncated": bool(meta.get("representation_limited")),
                           "acquisition_seconds": meta.get("seconds"),
                           "indexing_seconds": round(self.indexing_seconds + time.monotonic() - started, 6),
                           "coverage": {key: meta.get(key, 0) for key in ("denied", "skipped", "depth_limited", "entry_limited", "time_limited", "cancelled")},
                           **count}
                if len(json.dumps(summary, ensure_ascii=True).encode("utf-8")) > 65536:
                    raise InventoryLimit("Inventory summary exceeds its response bound")
                self.conn.execute("INSERT INTO metadata VALUES('summary',?)", (json.dumps(summary, separators=(",", ":")),))
                self.conn.commit()
                summary["index_bytes"] = self.path.stat().st_size
                self.conn.execute("UPDATE metadata SET value=? WHERE key='summary'", (json.dumps(summary, separators=(",", ":")),))
                self.conn.commit()
                if checkpoint:
                    checkpoint()
                self.conn.close()
                self._closed = True
                with _LOCK:
                    os.replace(self.path, self.store._filename(self.owner, self.scan_id))
                    _ACTIVE.discard(str(self.path))
                    self.store.prune()
                return summary
            except BaseException as exc:
                self.abort()
                if failure:
                    raise failure[0]
                if isinstance(exc, sqlite3.Error):
                    raise InventoryLimit("Inventory finalization exceeded its disk, query or database limit") from exc
                raise

    def abort(self):
        with self._lock:
            if not self._closed:
                self.conn.close()
                self._closed = True
            with _LOCK:
                _ACTIVE.discard(str(self.path))
                self.path.unlink(missing_ok=True)
                Path(str(self.path) + "-journal").unlink(missing_ok=True)
