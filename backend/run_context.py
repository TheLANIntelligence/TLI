"""An execution checkpoint shared by existing services and detached host runs."""
from contextvars import ContextVar

current = ContextVar("tli_host_run", default=None)


def checkpoint():
    run = current.get()
    if run is not None:
        run.check()


def run_id():
    run = current.get()
    return run.ident if run is not None else None
