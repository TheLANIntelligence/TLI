"""Pure launch inspection and bounded telemetry for harness-owned processes."""
from __future__ import annotations

import ast
from contextlib import contextmanager
import importlib.util
import os
from pathlib import Path
import threading


def source_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def catalogue(source):
    """Read literal legacy metadata without importing the lifecycle manager."""
    tree = ast.parse((Path(source) / 'backend/ai/ai_manager.py').read_text(encoding='utf-8'))
    legacy = next(ast.literal_eval(node.value) for node in tree.body
                  if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == 'MODEL_PRESETS')
    extra = source_module('evaluation_model_catalog', Path(source) / 'backend/ai/model_catalog.py').QWEN3_PRESETS
    return {**legacy, **extra}


def launch_options(source, ident, model, context):
    if not ident:
        return [], None
    preset = catalogue(source).get(ident)
    if not preset or preset.get('is_vision') or preset.get('mmproj_filename'):
        raise ValueError('Choose an existing text preset for this comparison')
    if Path(model).name != preset['filename'] or context != preset['ctx_size']:
        raise ValueError('The evaluation artifact or context does not match its selected preset')
    helper = source_module('evaluation_preset_launch', Path(source) / 'backend/ai/preset_launch.py')
    return helper.preset_runtime_args(preset), preset


@contextmanager
def evaluation_lease(path):
    """One coordinator/runtime per explicit evaluation workspace, across processes."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as stream:
        if path.stat().st_size == 0:
            stream.write(b'0'); stream.flush()
        stream.seek(0)
        acquired = False
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
            yield
        except (OSError, BlockingIOError) as error:
            if not acquired:
                raise RuntimeError('Another isolated model evaluation owns this workspace; no runtime started') from error
            raise
        finally:
            if acquired:
                stream.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


class ProcessMetrics:
    """Read only the launched child plus aggregate host pressure, at 2 Hz."""
    def __init__(self, pid, *, psutil_module=None, interval=.5):
        if psutil_module is None:
            import psutil as psutil_module
        self.psutil = psutil_module
        self.process = psutil_module.Process(pid)
        self.interval = interval
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.thread = None
        self.total = self._empty()
        self.active = None

    @staticmethod
    def _empty():
        return {'samples': 0, 'rss_peak_bytes': None, 'host_cpu_samples': 0, 'host_cpu_sum': 0.,
                'host_cpu_peak_percent': None, 'available_ram_min_bytes': None, 'probe_failures': 0}

    def _sample(self, primed=True):
        try:
            if not self.process.is_running():
                return
            rss = self.process.memory_info().rss
            cpu = self.psutil.cpu_percent(interval=None) if primed else None
            available = self.psutil.virtual_memory().available
            if not self.process.is_running():
                return
            with self.lock:
                for item in (self.total, self.active):
                    if item is None:
                        continue
                    item['samples'] += 1
                    item['rss_peak_bytes'] = max(item['rss_peak_bytes'] or 0, rss)
                    previous = item['available_ram_min_bytes']
                    item['available_ram_min_bytes'] = min(previous, available) if previous is not None else available
                    if cpu is not None:
                        item['host_cpu_samples'] += 1; item['host_cpu_sum'] += cpu
                        item['host_cpu_peak_percent'] = max(item['host_cpu_peak_percent'] or 0, cpu)
        except Exception:
            with self.lock:
                self.total['probe_failures'] += 1
                if self.active is not None:
                    self.active['probe_failures'] += 1

    def _loop(self):
        try:
            self.psutil.cpu_percent(interval=None)  # establish baseline in this thread
        except Exception:
            with self.lock:
                self.total['probe_failures'] += 1
        self._sample(False)
        while not self.stop_event.wait(self.interval):
            self._sample()

    def start(self):
        self.thread = threading.Thread(target=self._loop, name='tli-evaluation-metrics', daemon=True)
        self.thread.start()

    def begin_case(self):
        with self.lock:
            self.active = self._empty()

    def _public(self, item):
        value = dict(item)
        total = value.pop('host_cpu_sum')
        value['host_cpu_mean_percent'] = total / value['host_cpu_samples'] if value['host_cpu_samples'] else None
        value['sampling_interval_seconds'] = self.interval
        value['scope'] = 'Harness child RSS and aggregate host CPU/RAM; sampled peaks may miss shorter spikes.'
        return value

    def end_case(self):
        with self.lock:
            result = self._public(self.active or self._empty()); self.active = None
            return result

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=3)
        with self.lock:
            return self._public(self.total)
