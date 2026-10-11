"""Explicit, bounded host/process observations. No tuning, inference or background discovery."""
from __future__ import annotations

import copy
import hashlib
import math
import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import psutil
from fastapi import HTTPException
from intelligence import devices, diagnostics

PROTOCOL = "tli-performance-v1"
DURATION = 30
INTERVAL = 1
TTL = 600
MAX_RESULTS = 20
METRICS = ("host_cpu_percent", "host_ram_percent", "host_ram_used_bytes", "host_ram_total_bytes", "process_cpu_percent", "process_rss_bytes")


def stamp():
    return datetime.now(timezone.utc).isoformat()


def number(value, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return min(float(value), maximum) if maximum is not None else float(value)


def executable_key(exe):
    return os.path.normcase(os.path.normpath(exe)) if isinstance(exe, str) and exe and os.path.isabs(exe) else None


def identity(pid):
    proc = psutil.Process(pid)
    created = number(proc.create_time())
    if created is None:
        raise psutil.AccessDenied(pid)
    try:
        name = str(proc.name())[:200] or f"Process {pid}"
    except psutil.AccessDenied:
        name = f"Process {pid}"
    try:
        exe = proc.exe() or None
        if not isinstance(exe, str) or len(exe) > 4096:
            exe = None
    except (psutil.AccessDenied, psutil.ZombieProcess):
        exe = None
    return proc, {"pid": pid, "create_time": created, "name": name, "exe": exe}


def process_list(query="", limit=100):
    """No CPU sampling, command lines, usernames or window titles in the picker."""
    rows, denied, inspected = [], 0, 0
    try:
        pids = psutil.pids()
    except Exception as exc:
        raise HTTPException(503, "The host process list is unavailable.") from exc
    for pid in sorted(pids)[:1024]:
        inspected += 1
        try:
            _, row = identity(pid)
            if query.casefold() in row["name"].casefold() or query == str(pid):
                rows.append(row)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
            denied += 1
    rows.sort(key=lambda row: (row["name"].casefold(), row["pid"]))
    return {"host": devices.node(), "processes": rows[:limit], "checked_at": stamp(),
            "coverage": {"inspected": inspected, "unavailable": denied, "returned": min(len(rows), limit),
                         "limited": len(pids) > 1024 or len(rows) > limit},
            "scope": "Running processes on the TLI host. No performance observation has started."}


class ProcessChanged(Exception):
    def __init__(self, reason):
        self.reason = reason


class Probe:
    def __init__(self, selected):
        self.selected = selected
        try:
            self.cpus = number(psutil.cpu_count(logical=True))
        except Exception:
            self.cpus = None
        self.previous = None
        self.previous_time = time.monotonic()
        try:
            psutil.cpu_percent(interval=None)  # Prime this worker's own counter.
        except Exception:
            pass
        proc = self._process()
        try:
            cpu = proc.cpu_times()
            self.previous = cpu.user + cpu.system
        except psutil.NoSuchProcess:
            raise ProcessChanged("process_exited")
        except (psutil.AccessDenied, OSError):
            pass

    def _process(self):
        try:
            proc, current = identity(self.selected["pid"])
        except (psutil.NoSuchProcess, psutil.ZombieProcess):
            raise ProcessChanged("process_exited")
        except (psutil.AccessDenied, OSError):
            raise ProcessChanged("process_identity_unavailable")
        if not math.isclose(current["create_time"], self.selected["create_time"], rel_tol=0, abs_tol=0.0001):
            raise ProcessChanged("process_reused")
        before, after = executable_key(self.selected.get("exe")), executable_key(current.get("exe"))
        if before and after and before != after:
            raise ProcessChanged("process_executable_changed")
        return proc

    def sample(self):
        proc = self._process()
        values = dict.fromkeys(METRICS)
        try:
            values["host_cpu_percent"] = number(psutil.cpu_percent(interval=None), 100)
        except Exception:
            pass
        try:
            ram = psutil.virtual_memory()
            values.update(host_ram_percent=number(ram.percent, 100), host_ram_used_bytes=number(ram.used), host_ram_total_bytes=number(ram.total))
        except Exception:
            pass
        try:
            cpu = proc.cpu_times()
            total, now = cpu.user + cpu.system, time.monotonic()
            if self.previous is not None and self.cpus and now > self.previous_time:
                values["process_cpu_percent"] = number(100 * (total - self.previous) / (now - self.previous_time) / self.cpus, 100)
            self.previous, self.previous_time = total, now
        except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
            self.previous = None
        try:
            values["process_rss_bytes"] = number(proc.memory_info().rss)
        except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
            pass
        return values


def summarize(samples):
    result = {}
    for metric in METRICS:
        values = [s[metric] for s in samples if number(s.get(metric)) is not None]
        result[metric] = {"min": min(values), "max": max(values), "mean": sum(values) / len(values), "samples": len(values)} if values else {"min": None, "max": None, "mean": None, "samples": 0}
    return result


class Observations:
    def __init__(self, probe_factory=Probe, clock=time.monotonic, duration=DURATION, interval=INTERVAL, thread_factory=threading.Thread):
        self.lock = threading.RLock()
        self.rows = {}
        self.active = None
        self.probe_factory, self.clock = probe_factory, clock
        self.duration, self.interval, self.thread_factory = duration, interval, thread_factory

    def _clean(self):
        now = self.clock()
        for ident, row in list(self.rows.items()):
            if row.get("finished_clock") is not None and now - row["finished_clock"] >= TTL:
                del self.rows[ident]

    def _owned(self, user, ident):
        self._clean()
        row = self.rows.get(ident)
        if row is None or row["owner"] != user:
            raise HTTPException(404, "This observation is unavailable or its ten-minute retention has expired.")
        return row

    def _view(self, row):
        result = copy.deepcopy(row["result"])
        result["sample_count"] = len(result["samples"])
        result["summary"] = summarize(result["samples"])
        result["saved_report_id"] = row.get("saved_report_id")
        return result

    def listing(self, user):
        with self.lock:
            self._clean()
            return [self._view(row) for row in reversed(list(self.rows.values())) if row["owner"] == user]

    def get(self, user, ident):
        with self.lock:
            return self._view(self._owned(user, ident))

    def by_request(self, user, request_id):
        with self.lock:
            self._clean()
            row = next((r for r in self.rows.values() if r["owner"] == user and r["request_id"] == request_id), None)
            if row is None:
                raise HTTPException(404, "No retained observation matches this request. No new observation was started.")
            return self._view(row)

    def start(self, user, request_id, pid, create_time):
        with self.lock:
            self._clean()
            previous = next((r for r in self.rows.values() if r["owner"] == user and r["request_id"] == request_id), None)
            if previous:
                if previous["requested"] != (pid, create_time):
                    raise HTTPException(409, "This request already identifies a different process. Review the process and start a new request.")
                return self._view(previous), True
            if self.active is not None:
                raise HTTPException(409, "A performance observation is already running on this TLI host. Try after it finishes.")
            try:
                _, selected = identity(pid)
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError) as exc:
                raise HTTPException(409, "The selected process can no longer be identified. Refresh the process list.") from exc
            if not math.isclose(selected["create_time"], create_time, rel_tol=0, abs_tol=0.0001):
                raise HTTPException(409, "This process ID now belongs to a different launch. Refresh and select it again.")
            while len(self.rows) >= MAX_RESULTS:
                del self.rows[next(iter(self.rows))]
            ident = uuid.uuid4().hex
            row = {"owner": user, "request_id": request_id, "requested": (pid, create_time), "stop": threading.Event(), "finished_clock": None,
                   "result": {"id": ident, "observation_id": ident, "schema_version": 1, "host": devices.node(), "process": selected,
                              "status": "running", "reason": None, "started_at": stamp(), "finished_at": None, "expires_at": None,
                              "duration_seconds": 0, "requested_duration_seconds": self.duration, "sample_interval_seconds": self.interval,
                              "expected_samples": int(self.duration / self.interval), "samples": [],
                              "scope": "Host CPU/RAM and this process only. Process CPU is normalized to total logical CPU capacity. RSS includes shared resident pages. No FPS, GPU, temperature or fault cause is measured."}}
            self.rows[ident] = row
            self.active = ident
            try:
                worker = self.thread_factory(target=self._run, args=(ident,), daemon=True, name="tli-performance-observation")
                worker.start()
            except Exception as exc:
                self.active = None
                del self.rows[ident]
                raise HTTPException(503, "The observation could not start. No sampling worker is running.") from exc
            return self._view(row), False

    def _run(self, ident):
        with self.lock:
            row = self.rows[ident]
            selected, stop = copy.deepcopy(row["result"]["process"]), row["stop"]
        start, reason, status = self.clock(), None, "completed"
        try:
            probe = self.probe_factory(selected)
            for index in range(int(self.duration / self.interval)):
                if stop.wait(max(0, start + (index + 1) * self.interval - self.clock())):
                    reason, status = "stopped_by_user", "stopped"
                    break
                if self.clock() - start > self.duration + self.interval:
                    reason, status = "sampling_delayed", "partial"
                    break
                values = probe.sample()
                sample = {key: number(values.get(key), 100 if key.endswith("percent") else None) for key in METRICS}
                sample.update(elapsed_seconds=round(self.clock() - start, 3), observed_at=stamp())
                with self.lock:
                    row["result"]["samples"].append(sample)
                    row["result"]["duration_seconds"] = round(self.clock() - start, 3)
            if status == "completed" and any(s[key] is None for s in row["result"]["samples"] for key in METRICS):
                status, reason = "partial", "some_metrics_unavailable"
        except ProcessChanged as exc:
            status, reason = "partial", exc.reason
        except Exception:
            status, reason = "failed", "observation_unavailable"
        finally:
            with self.lock:
                row["result"].update(status=status, reason=reason, finished_at=stamp(), duration_seconds=round(self.clock() - start, 3),
                                     expires_at=(datetime.now(timezone.utc) + timedelta(seconds=TTL)).isoformat())
                row["finished_clock"] = self.clock()
                if self.active == ident:
                    self.active = None

    def stop(self, user, ident):
        with self.lock:
            row = self._owned(user, ident)
            if row["result"]["status"] == "running":
                row["stop"].set()
            return self._view(row)

    def save(self, user, ident, request_id):
        with self.lock:
            row = self._owned(user, ident)
            if row["result"]["status"] == "running":
                raise HTTPException(409, "Wait for observation completion or stop it before saving the results.")
            if "report" not in row:
                row["report"] = make_report(self._view(row), diagnostics.history(user))
            report = diagnostics.save_report(user, copy.deepcopy(row["report"]), request_id=request_id)
            row["saved_report_id"] = report["id"]
            return report


def make_report(observation, previous_reports):
    summary = observation["summary"]
    labels = {"host_cpu_percent": "Host CPU", "host_ram_percent": "Host RAM", "process_cpu_percent": "App CPU (whole host capacity)", "process_rss_bytes": "App resident memory"}
    checks = []
    for key, label in labels.items():
        values = summary[key]
        detail = (f"Mean {values['mean']:.1f}%, maximum {values['max']:.1f}%" if key.endswith("percent") else f"Mean {values['mean'] / 1048576:.1f} MiB, maximum {values['max'] / 1048576:.1f} MiB") if values["samples"] else "No usable samples."
        checks.append({"id": key, "label": label, "status": "pass" if values["samples"] == observation["expected_samples"] else "unavailable",
                       "detail": f"{detail} Recorded {values['samples']} of {observation['expected_samples']} planned samples; this is an observation, not a health verdict."})
    exe = executable_key(observation["process"].get("exe"))
    previous = next((r for r in previous_reports if r.get("kind") == "performance" and r.get("host", {}).get("id") == observation["host"]["id"]
                     and exe and executable_key(r.get("performance", {}).get("process", {}).get("exe")) == exe), None)
    comparison = None
    if previous:
        old = previous.get("performance", {}).get("summary", {})
        comparison = {"report_id": previous["id"], "scope": "Same host and known executable; workloads and observation coverage may differ.",
                      "changes": [{"check": key, "before": old.get(key, {}).get("mean"), "after": summary[key]["mean"]} for key in labels
                                  if number(old.get(key, {}).get("mean")) is not None and summary[key]["mean"] is not None]}
    report_id = hashlib.sha256(("tli-performance:" + observation["id"]).encode()).hexdigest()[:32]
    return {"id": report_id, "created_at": observation["finished_at"], "kind": "performance", "host": observation["host"], "target": None,
            "internet_checks": False, "checks": checks, "findings": [{"certainty": "confirmed" if observation["sample_count"] else "uncertain", "text": f"{observation['sample_count']} samples recorded for {observation['process']['name']}. State: {observation['status']}. CPU or memory use alone does not establish the cause of a slowdown."}],
            "next_steps": ["Compare the same app on this host during a similar workload.", "Review this report before asking AI or linking it to a Troubleshooting case."],
            "verified_fix": None, "scope": observation["scope"], "comparison": comparison, "performance": observation}


manager = Observations()
