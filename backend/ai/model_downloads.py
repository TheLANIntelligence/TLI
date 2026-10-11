"""One cancellable, staged installation. Downloads never select a model."""
import threading
import time
import uuid
import hashlib
from pathlib import Path
import requests
from .model_library import validate_gguf, resource_snapshot, GIB


class ModelDownloads:
    def __init__(self):
        self.lock = threading.RLock()
        self.cancelled = threading.Event()
        self.state = {"in_progress": False, "status": "idle", "bytes_done": 0, "bytes_total": 0,
                      "error": "", "url": "", "preset_id": "", "filename": "",
                      "started_at": None, "finished_at": None}

    def status(self):
        with self.lock:
            return dict(self.state)

    def update(self, **values):
        with self.lock:
            self.state.update(values)

    def reserve(self, preset_id, components):
        with self.lock:
            if self.state.get("in_progress"):
                raise ValueError("An installation is still in progress. Wait for completion or cancellation.")
            self.cancelled.clear()
            self.state = {"in_progress": True, "status": "starting", "preset_id": preset_id,
                          "bytes_done": 0, "bytes_total": sum(c[2] for c in components),
                          "filename": components[0][1].name, "error": "", "url": components[0][0],
                          "started_at": time.time(), "finished_at": None}

    def cancel(self):
        with self.lock:
            if self.state.get("in_progress"):
                self.cancelled.set()
                self.state["status"] = "cancelling"
            return dict(self.state)

    def run(self, components, manager, checksums=None):
        from event_bus import emit_event
        emit_event("ai", "info", "Model installation started", "Downloading required files. This does not select or run the model.")
        checksums = checksums or {}
        token = uuid.uuid4().hex
        staged, backups, published = [], [], []
        done = 0
        terminal = {"status": "error", "error": "Installation did not finish."}
        try:
            for url, target, expected in components:
                checksum = checksums.get(target.name)
                digest = hashlib.sha256() if checksum else None
                tmp = target.with_name(target.name + ".downloading-" + token)
                staged.append((tmp, target))
                target.parent.mkdir(parents=True, exist_ok=True)
                if self.cancelled.is_set():
                    raise RuntimeError("Download cancelled")
                self.update(status="downloading", filename=target.name)
                with requests.get(url, stream=True, timeout=(10, 15)) as response:
                    response.raise_for_status()
                    total = int(response.headers.get("content-length") or 0)
                    free = resource_snapshot(target.parent)["free_disk_bytes"]
                    if free is None or free < max(total, expected) + GIB:
                        raise ValueError("Insufficient or unknown free disk space.")
                    count = 0
                    with tmp.open("wb") as output:
                        for chunk in response.iter_content(chunk_size=1024 * 1024):
                            if self.cancelled.is_set():
                                raise RuntimeError("Download cancelled")
                            if chunk:
                                output.write(chunk)
                                if digest is not None:
                                    digest.update(chunk)
                                count += len(chunk)
                                done += len(chunk)
                                self.update(bytes_done=done)
                    if total and count != total:
                        raise ValueError("Incomplete download; previous files retained.")
                    if checksum and (count != expected or digest.hexdigest() != checksum):
                        raise ValueError("Publisher checksum or file size did not match. Previous files retained.")
                if not validate_gguf(tmp):
                    raise ValueError("Downloaded file is not a valid GGUF model header.")
            # Cancellation and commit have a single ordering. Cancellation cannot
            # claim success halfway through publishing a two-component model.
            with manager.operation_lock, self.lock:
                if self.cancelled.is_set():
                    raise RuntimeError("Download cancelled")
                for tmp, target in staged:
                    if target.exists() and target.resolve() == manager.cfg.model_path.resolve():
                        raise ValueError("Cannot replace the selected model. Select another model first.")
                    backup = target.with_name(target.name + ".previous-" + token)
                    if target.exists():
                        target.replace(backup)
                        backups.append((backup, target))
                    tmp.replace(target)
                    published.append(target)
                terminal = {"status": "done", "error": "", "bytes_total": done, "installed": True}
        except Exception as exc:
            restore_errors = []
            with manager.operation_lock:
                for target in published:
                    try:
                        target.unlink(missing_ok=True)
                    except OSError as error:
                        restore_errors.append(str(error))
                for backup, target in reversed(backups):
                    try:
                        backup.replace(target)
                    except OSError as error:
                        # Preserve the backup for recovery; never delete it on failure.
                        restore_errors.append(f"Previous file retained at {backup}: {error}")
            terminal = {"status": "cancelled" if self.cancelled.is_set() and not restore_errors else "error",
                        "error": str(exc) + (" Recovery: " + "; ".join(restore_errors) if restore_errors else "")}
        finally:
            for tmp, _ in staged:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
            if terminal["status"] == "done":
                for backup, _ in backups:
                    try:
                        backup.unlink(missing_ok=True)
                    except OSError:
                        pass
            level, title, body = {
                "done": ("ok", "Model installation finished", "All required files validated. Open the model library to review or select the model; installation did not change the selection."),
                "cancelled": ("info", "Model installation cancelled", "The download stopped. Previously installed files were retained."),
                "error": ("warn", "Model installation failed", "The installation did not complete. Open the model library for the error and any file recovery details."),
            }[terminal["status"]]
            with self.lock:
                self.update(**terminal, in_progress=False, finished_at=time.time())
                emit_event("ai", level, title, body)


downloads = ModelDownloads()
