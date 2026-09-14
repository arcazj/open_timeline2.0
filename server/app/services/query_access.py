from contextlib import contextmanager
from contextvars import ContextVar


_access = ContextVar("timeline_query_access", default=None)


def current_query_access():
    return _access.get()


@contextmanager
def query_access(value):
    token = _access.set(value)
    try:
        yield
    finally:
        _access.reset(token)
