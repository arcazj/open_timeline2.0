"""Cooperative cancellation is checked in bounded preparation loops."""
from contextlib import contextmanager
from contextvars import ContextVar
import time

from ..models.domain import DomainError


_control = ContextVar("timeline_preparation_control", default=None)


def checkpoint():
    control = _control.get()
    if control is not None:
        cancelled, deadline = control
        if cancelled.is_set():
            raise DomainError("preparation_cancelled", "Preparation was cancelled.", 409)
        if time.monotonic() >= deadline:
            raise DomainError("preparation_timeout", "Preparation exceeded its 30-second publication deadline.", 408)


def checked(values):
    for index, value in enumerate(values):
        if index % 64 == 0:
            checkpoint()
        yield value
    checkpoint()


@contextmanager
def preparation_control(cancelled, deadline):
    token = _control.set((cancelled, deadline))
    try:
        checkpoint()
        yield
        checkpoint()
    finally:
        _control.reset(token)
