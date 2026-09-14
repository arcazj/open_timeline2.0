"""Thread-safe, sanitized startup progress shared by HTTP health and the loader."""

import logging
import threading
import time

from ..models.domain import DomainError

log = logging.getLogger("uvicorn.error")


class StartupStatus:
    def __init__(self):
        self.cancel = threading.Event()
        self._lock = threading.Lock()
        self._started = time.monotonic()
        self._phase_started = self._started
        self._state, self._phase = "starting", "configuration"
        self._counts = {}
        self._elapsed = None

    @property
    def ready(self):
        with self._lock:
            return self._state == "ready"

    def update(self, phase, **counts):
        if self.cancel.is_set():
            raise DomainError("startup_cancelled", "Server startup was cancelled.", 503)
        now = time.monotonic()
        with self._lock:
            if phase != self._phase:
                log.info("Startup: %s completed in %.2fs; %s", self._phase, now - self._phase_started, phase)
                self._phase_started = now
            self._phase = phase
            self._counts.update({key: value for key, value in counts.items()
                                 if key in ("filesRead", "recordsRead") and type(value) is int and value >= 0})

    def complete(self):
        self.update("ready")
        with self._lock:
            self._elapsed = time.monotonic() - self._started
            self._state = "ready"
            log.info("Timeline data ready in %.2fs (%s files, %s records).", self._elapsed,
                     self._counts.get("filesRead", "-"), self._counts.get("recordsRead", "-"))

    def fail(self):
        with self._lock:
            self._state = "failed"
            self._elapsed = time.monotonic() - self._started

    def snapshot(self):
        with self._lock:
            return {"status": self._state, "phase": self._phase,
                    "elapsedMs": round((self._elapsed if self._elapsed is not None else time.monotonic() - self._started) * 1000),
                    **self._counts}
