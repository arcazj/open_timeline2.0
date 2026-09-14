"""Bounded rolling checks against admitted JSON bytes, without a lossy event queue."""
from __future__ import annotations

import hashlib
import os
import re
import stat
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from ..models.domain import DomainError, json_bytes

REGISTRY_BYTES = 128 * 1024**2
FILES_PER_SLICE = 128
BYTES_PER_SLICE = 4 * 1024**2
PAUSE_SECONDS = 0.1
_DIRECTORIES = ("records", "shards", "outcomes", "audit")
_FILES = {"workspace.json", "storage-layout.json", "audit-state.json", "restore-provenance.json", "transaction.json"}
_MEMBER = re.compile(r"(?:records/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json|shards/[a-f0-9]{1,32}\.json|outcomes/[a-f0-9]{64}\.json|audit/[0-9]{16}\.json)")

if os.name == "nt":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _create_file = _kernel.CreateFileW
    _create_file.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    _create_file.restype = wintypes.HANDLE
    _close_handle = _kernel.CloseHandle
    _close_handle.argtypes = [wintypes.HANDLE]
    _close_handle.restype = wintypes.BOOL


def open_observation(path):
    """Read without blocking atomic replacement or following a substituted leaf link."""
    if os.name == "nt":
        # GENERIC_READ; share read/write/delete; OPEN_EXISTING; OPEN_REPARSE_POINT.
        handle = _create_file(str(path), 0x80000000, 0x7, None, 3, 0x00200000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        except BaseException:
            _close_handle(handle)
            raise
    else:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise


def file_stamp(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns,
            value.st_mode, getattr(value, "st_file_attributes", 0))


def _regular(value, directory=False):
    return (stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode)) and not (getattr(value, "st_file_attributes", 0) & 0x400)


def _cost(relative):
    # Includes an intentionally conservative allowance for Python objects and indexes.
    return 1024 + 4 * len(relative.encode("utf-8"))


def validate_root_path(root):
    root = Path(root).absolute()
    for path in (*reversed(root.parents), root):
        try:
            information = path.lstat()
        except FileNotFoundError:
            continue
        if not _regular(information, directory=True):
            raise DomainError("storage_integrity", "Workspace root ancestry cannot contain links or reparse points.", 503)


@dataclass(frozen=True, slots=True)
class ExpectedFile:
    digest: bytes
    stamp: tuple


class WorkspaceIntegrity:
    def __init__(self, repository):
        self.repository = repository
        self.root = repository.root
        self.expected = {}
        self.capture_lock = threading.Lock()
        self.observation_lock = threading.Lock()
        self.registry_bytes = 512
        self.paths = deque()
        self.directories = {}
        self.directory_queue = deque()
        self.directory_iterators = {}
        self.stop = threading.Event()
        self.thread = None
        self.failure = None
        self.checked_files = 0
        self.checked_bytes = 0
        self.completed_sweeps = 0
        self.last_sweep_seconds = None
        self._sweep_remaining = 0
        self._sweep_started = time.monotonic()
        self.writer_identity = None

    def relative(self, path):
        try:
            return Path(path).relative_to(self.root).as_posix()
        except ValueError:
            return Path(path).absolute().relative_to(self.root.absolute()).as_posix()

    def capture(self, path, digest, information):
        relative = self.relative(path)
        with self.capture_lock:
            if relative not in self.expected:
                if self.registry_bytes + _cost(relative) > REGISTRY_BYTES:
                    raise DomainError("integrity_capacity", "Integrity registry admission exceeds 128 MiB.", 413)
                self.registry_bytes += _cost(relative)
            self.expected[relative] = ExpectedFile(digest, file_stamp(information))

    def _freeze(self, relative, reason):
        self.failure = {"code": "external_change", "path": relative, "reason": reason}
        self.repository.available = False
        raise DomainError("external_change", f"Workspace integrity failed at {relative}: {reason}.", 503)

    def _register_directories(self, initial=False, owned_directories=()):
        absolute = self.root.absolute()
        for path in (*reversed(absolute.parents), absolute):
            if not _regular(path.lstat(), directory=True):
                self._freeze(".", "root ancestry is not a regular directory")
        for relative in (".", *_DIRECTORIES):
            path = self.root if relative == "." else self.root / relative
            if path.exists():
                information = path.lstat()
                if not _regular(information, directory=True):
                    self._freeze(relative, "directory is a link or reparse point")
                identity = information.st_dev, information.st_ino
                if not initial and relative in self.directories and self.directories[relative] != identity:
                    self._freeze(relative, "directory was replaced outside the owner")
                if relative not in self.directories:
                    if not initial and relative != "." and relative not in owned_directories:
                        self._freeze(relative, "unregistered workspace directory appeared")
                    self.directory_queue.append(relative)
                self.directories[relative] = identity
            elif relative in self.directories:
                if relative not in owned_directories:
                    self._freeze(relative, "directory disappeared outside the owner")
                del self.directories[relative]
                iterator = self.directory_iterators.pop(relative, None)
                if iterator is not None:
                    iterator.close()
                self.directory_queue.remove(relative)

    def _check_directories(self):
        for relative, expected in self.directories.items():
            path = self.root if relative == "." else self.root / relative
            try:
                information = path.lstat()
            except OSError:
                self._freeze(relative, "directory disappeared or became unreadable")
            if not _regular(information, directory=True) or (information.st_dev, information.st_ino) != expected:
                self._freeze(relative, "directory was replaced or became unsafe")
        for parent in self.root.absolute().parents:
            if not _regular(parent.lstat(), directory=True):
                self._freeze(".", "root ancestry became unsafe")
        try:
            information = (self.root / ".writer.lock").lstat()
        except OSError:
            self._freeze(".writer.lock", "writer ownership path disappeared")
        if not _regular(information) or (information.st_dev, information.st_ino) != self.writer_identity:
            self._freeze(".writer.lock", "writer ownership path became unsafe")

    def _inspect_member(self, directory, entry):
        relative = entry.name if directory == "." else directory + "/" + entry.name
        try:
            information = entry.stat(follow_symlinks=False)
        except FileNotFoundError:
            return
        if directory == "." and entry.name == "control":
            if not _regular(information, directory=True):
                self._freeze(relative, "control root became unsafe")
            return
        if directory == "." and entry.name in _DIRECTORIES:
            if entry.name not in self.directories:
                if not Path(entry.path).exists():
                    return
                self._freeze(relative, "unregistered workspace directory appeared")
            return
        if entry.name == ".writer.lock" and directory == ".":
            information = Path(entry.path).lstat()
            if not _regular(information) or (information.st_dev, information.st_ino) != self.writer_identity:
                self._freeze(relative, "writer ownership path became unsafe")
            return
        if relative not in self.expected:
            if not Path(entry.path).exists():
                return
            self._freeze(relative, "unregistered workspace authority appeared")
        if relative not in _FILES and not _MEMBER.fullmatch(relative):
            self._freeze(relative, "invalid authority path")
        if not _regular(information):
            self._freeze(relative, "authority is not a regular file")

    def initialize(self):
        self._register_directories(initial=True)
        lock = (self.root / ".writer.lock").lstat()
        self.writer_identity = lock.st_dev, lock.st_ino
        for relative in self.directories:
            path = self.root if relative == "." else self.root / relative
            with os.scandir(path) as entries:
                for entry in entries:
                    self._inspect_member(relative, entry)
        self.paths.extend(self.expected)
        self._sweep_remaining = len(self.paths)
        self._sweep_started = time.monotonic()

    def start(self):
        if self.thread is not None and self.thread.is_alive():
            raise RuntimeError("The workspace integrity monitor is already running.")
        self.thread = threading.Thread(target=self._run, name="timeline-integrity", daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        if self.thread is not None and self.thread.ident is not None and self.thread is not threading.current_thread():
            self.thread.join()
        for iterator in self.directory_iterators.values():
            iterator.close()
        self.directory_iterators.clear()

    def admit(self, after):
        proposed = self.registry_bytes
        for relative, document in after.items():
            if document is not None and relative not in self.expected:
                proposed += _cost(relative)
            elif document is None and relative in self.expected:
                proposed -= _cost(relative)
        if "transaction.json" not in self.expected:
            proposed += _cost("transaction.json")
        if proposed > REGISTRY_BYTES:
            raise DomainError("integrity_capacity", "Integrity registry admission exceeds 128 MiB.", 413)

    def committed(self, after, journal_document=None):
        for relative, document in after.items():
            if document is None:
                if self.expected.pop(relative, None) is not None:
                    self.registry_bytes -= _cost(relative)
                    try:
                        self.paths.remove(relative)
                    except ValueError:
                        pass
            else:
                if relative not in self.expected:
                    self.registry_bytes += _cost(relative)
                    self.paths.append(relative)
                self.expected[relative] = ExpectedFile(hashlib.sha256(json_bytes(document)).digest(), file_stamp((self.root / relative).lstat()))
        # A known committed journal may remain after a failed cleanup; it is still owned authority.
        journal = self.root / "transaction.json"
        if journal.exists():
            if journal_document is None:
                self._freeze("transaction.json", "unexpected pending journal")
            relative = "transaction.json"
            if relative not in self.expected:
                self.paths.append(relative)
                self.registry_bytes += _cost(relative)
            self.expected[relative] = ExpectedFile(hashlib.sha256(json_bytes(journal_document)).digest(), file_stamp(journal.lstat()))
        else:
            if self.expected.pop("transaction.json", None) is not None:
                self.registry_bytes -= _cost("transaction.json")
            try:
                self.paths.remove("transaction.json")
            except ValueError:
                pass
        self._register_directories(owned_directories={relative.partition("/")[0] for relative in after if "/" in relative})

    def check_receipt(self, path, digest, information):
        relative = self.relative(path)
        expected = self.expected.get(relative)
        if expected is None or expected.digest != digest or expected.stamp != file_stamp(information):
            self._freeze(relative, "bytes or file identity differ from the admitted state")

    def check_file(self, relative):
        if not self.repository.mutex.acquire(timeout=0.05):
            return 0
        try:
            expected = self.expected.get(relative)
            if expected is None or self.stop.is_set() or not self.repository.available:
                return 0
        finally:
            self.repository.mutex.release()
        error, raw, current = None, b"", None
        if not self.observation_lock.acquire(timeout=0.05):
            return 0
        try:
            path = self.root / relative
            validate_root_path(path.parent)
            initial = path.lstat()
            if not _regular(initial) or file_stamp(initial) != expected.stamp:
                raise OSError("File metadata changed")
            with open_observation(path) as stream:
                descriptor = os.fstat(stream.fileno())
                if not _regular(descriptor) or (descriptor.st_dev, descriptor.st_ino, descriptor.st_size, descriptor.st_mtime_ns) != expected.stamp[:4]:
                    raise OSError("File changed while opening")
                raw = stream.read(expected.stamp[2] + 1)
                current = path.lstat()
                validate_root_path(path.parent)
            if len(raw) != expected.stamp[2] or file_stamp(current) != expected.stamp or hashlib.sha256(raw).digest() != expected.digest:
                raise OSError("File bytes changed")
        except (OSError, DomainError) as caught:
            error = caught
        finally:
            self.observation_lock.release()
        if not self.repository.mutex.acquire(timeout=0.05):
            return 0
        try:
            if self.expected.get(relative) is not expected or self.stop.is_set() or not self.repository.available:
                return 0
            if error is not None:
                self._freeze(relative, "file disappeared or differs from its admitted bytes")
            self.checked_files += 1
            self.checked_bytes += len(raw)
            return len(raw)
        finally:
            self.repository.mutex.release()

    def _directory_slice(self):
        if not self.repository.mutex.acquire(timeout=0.05):
            return
        try:
            self._check_directories()
            for relative in _FILES:
                expected = self.expected.get(relative)
                if expected is not None:
                    try:
                        information = (self.root / relative).lstat()
                    except OSError:
                        self._freeze(relative, "metadata file disappeared or became unreadable")
                    if file_stamp(information) != expected.stamp:
                        self._freeze(relative, "metadata file differs from admitted identity")
            if self.directory_queue:
                relative = self.directory_queue.popleft()
                self.directory_queue.append(relative)
                iterator = self.directory_iterators.get(relative)
                if iterator is None:
                    iterator = os.scandir(self.root if relative == "." else self.root / relative)
                    self.directory_iterators[relative] = iterator
                for _ in range(FILES_PER_SLICE):
                    entry = next(iterator, None)
                    if entry is None:
                        iterator.close()
                        del self.directory_iterators[relative]
                        break
                    self._inspect_member(relative, entry)
        finally:
            self.repository.mutex.release()

    def scan_slice(self):
        used = 0
        for _ in range(FILES_PER_SLICE):
            if self.stop.is_set() or not self.repository.available or not self.paths:
                break
            if not self.repository.mutex.acquire(timeout=0.05):
                break
            try:
                relative = self.paths.popleft()
                present = relative in self.expected
                if present:
                    self.paths.append(relative)
            finally:
                self.repository.mutex.release()
            if present:
                used += self.check_file(relative)
            self._sweep_remaining -= 1
            if self._sweep_remaining <= 0:
                self.completed_sweeps += 1
                self.last_sweep_seconds = time.monotonic() - self._sweep_started
                self._sweep_started = time.monotonic()
                self._sweep_remaining = len(self.paths)
            if used >= BYTES_PER_SLICE:
                break
        self._directory_slice()

    def _run(self):
        try:
            while not self.stop.wait(PAUSE_SECONDS):
                if not self.repository.available:
                    break
                self.scan_slice()
        except BaseException as error:
            self.failure = self.failure or {"code": "integrity_monitor_failed", "path": ".", "reason": type(error).__name__}
            self.repository.available = False
