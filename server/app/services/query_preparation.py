"""Bounded in-memory preparation; all retained payloads use the engine ledger."""
from __future__ import annotations

import copy
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field

from ..models.domain import DomainError, json_bytes
from .identity import scope_fingerprint
from .preparation_control import checkpoint, preparation_control
from .query_access import query_access


def retained_query(query):
    return {key: value for key, value in query.items() if key not in ("layouts", "tables")}


class _CapturedRepository:
    def __init__(self, bundle):
        self.bundle = bundle

    def query_snapshot(self):
        return self.bundle


class _WorkingResources:
    def __init__(self, engine, key):
        self.engine, self.key, self.keys = engine, key, set()

    def reserve(self, key, root, overhead=0):
        with self.engine.mutex:
            self.engine.resources.reserve(("working", self.key, key), root, overhead)
            self.keys.add(key)

    def release(self, key):
        with self.engine.mutex:
            self.engine.resources.release(("working", self.key, key))
            self.keys.discard(key)

    def clear(self):
        with self.engine.mutex:
            for key in list(self.keys):
                self.release(key)


@dataclass
class _Preparation:
    kind: str
    key: str
    query_id: str
    scope: dict
    identity: dict
    request: dict
    captured: dict
    placeholder: dict
    deadline: float
    preferences: dict | None = None
    cancelled: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    active: bool = False


class QueryPreparationCoordinator:
    def __init__(self, engine, access, *, workers=2, queue_capacity=8, deadline_seconds=30,
                 ready_wait_seconds=0.1, release_wait_seconds=5,
                 preparation_allowance_bytes=8 * 1024 * 1024, preferences=None):
        self.engine, self.access = engine, access
        self.preferences = preferences
        self.worker_limit, self.queue_capacity = workers, queue_capacity
        self.deadline_seconds, self.ready_wait_seconds = deadline_seconds, ready_wait_seconds
        self.release_wait_seconds = release_wait_seconds
        self.preparation_allowance_bytes = preparation_allowance_bytes
        self.condition = threading.Condition(engine.mutex)
        self.jobs, self.queue, self.active_principals = {}, [], set()
        self.synchronous = {}
        self.closed = False
        previous_release = self.engine.on_release
        self.engine.on_release = self._released
        self.workers = [threading.Thread(target=self._worker, name=f"timeline-preparation-{index}", daemon=True) for index in range(workers)]
        try:
            for worker in self.workers:
                worker.start()
        except BaseException:
            with self.condition:
                self.closed = True
                self.condition.notify_all()
            for worker in self.workers:
                if worker.ident is not None:
                    worker.join()
            self.engine.on_release = previous_release
            raise

    def dispatch(self, identity, operation, *args, prefer_async=False):
        with self.condition:
            self._expire_queued()
        if operation == "query_records":
            return self._table(identity, *args)
        if operation in ("release_query", "release_layout", "release_snapshot"):
            return self._release(identity, operation, args)
        started = operation in ("create_query", "create_layout")
        if started:
            job = self._submit(identity, operation, args)
            if not prefer_async:
                job.done.wait(self.ready_wait_seconds)
            operation = "get_query" if job.kind == "query" else "get_layout"
            args = (job.query_id,) if job.kind == "query" else (job.query_id, job.key)
        result = self.access.query(identity, operation, *args)
        if started and not prefer_async and result.get("state") == "failed":
            failure = result["error"]
            self._release(identity, "release_query" if job.kind == "query" else "release_layout", args)
            error = DomainError(failure["code"], failure["message"], failure["status"])
            if 'diagnostic' in failure:
                error.diagnostic = copy.deepcopy(failure['diagnostic'])
            raise error
        return result

    def _release(self, identity, operation, args):
        try:
            result = self.access.query(identity, operation, *args)
        except DomainError as error:
            if error.status in (404, 410):
                self._wait_released(identity, operation, args)
            raise
        self._wait_released(identity, operation, args)
        return result

    def _wait_released(self, identity, operation, args):
        def matches(query_id, layout_id, snapshot_id):
            if operation == "release_snapshot":
                return snapshot_id == args[0]
            return query_id == args[0] and (operation == "release_query" or layout_id == args[1])

        # A removed handle can still own a running job. Retain only completion
        # events, then release all authority/engine locks before waiting.
        with self.condition:
            completions = [job.done for job in self.jobs.values()
                           if job.scope["principalId"] == identity["id"] and
                           matches(job.query_id, job.key if job.kind == "layout" else None,
                                   (job.placeholder if job.kind == "query" else job.captured)["manifest"]["snapshotId"])]
            completions.extend(work["done"] for work in self.synchronous.values()
                               if work["principalId"] == identity["id"] and
                               matches(work["queryId"], None, work["snapshotId"]))
        deadline = time.monotonic() + self.release_wait_seconds
        for done in completions:
            if not done.wait(max(0, deadline - time.monotonic())):
                raise DomainError("preparation_release_timeout",
                                  "The handle is released but preparation cleanup is still running; retry the same DELETE.", 503)

    def _table(self, identity, query_id, request):
        if not isinstance(request, dict) or len(json_bytes(request)) > 64 * 1024:
            raise DomainError("query_request_limit", "Table preparation requires an object of at most 64 KiB.", 413)
        with self.access.identities.mutex, self.condition:
            if self.closed:
                raise DomainError("query_service_closed", "Query service is closed.", 503)
            scope = self.access._scope(self.access._current(identity, "records.read"))
            with query_access(scope):
                snapshot_id = self.engine._query(query_id)["manifest"]["snapshotId"]
                if self.engine.has_table(query_id, request):
                    # The lock covers lookup and read, so another request cannot evict this index between them.
                    return self.engine.query_records(query_id, request)
            principal = scope["principalId"]
            if principal in self.active_principals or len(self.active_principals) >= self.worker_limit or self.queue:
                raise DomainError("preparation_capacity", "Preparation capacity is in use; retry after the current preparation.", 429)
            key, cancelled, done = str(uuid.uuid4()), threading.Event(), threading.Event()
            self.engine.resources.reserve(("table-preparation", key), {"request": request, "scope": scope}, overhead=self.preparation_allowance_bytes)
            self.active_principals.add(principal)
            self.synchronous[key] = {"queryId": query_id, "snapshotId": snapshot_id,
                                     "principalId": principal, "cancelled": cancelled, "done": done}
        try:
            with preparation_control(cancelled, time.monotonic() + self.deadline_seconds):
                return self.access.query(identity, "query_records", query_id, request)
        finally:
            with self.condition:
                self.engine.resources.release(("table-preparation", key))
                self.synchronous.pop(key, None)
                self.active_principals.discard(principal)
                done.set()
                self.condition.notify_all()

    def _submit(self, identity, operation, args):
        request = args[-1]
        if not isinstance(request, dict):
            raise DomainError("invalid_query", "Preparation input must be an object.", 422)
        if len(json_bytes(request)) > 64 * 1024:
            raise DomainError("query_request_limit", "Preparation requests are limited to 64 KiB.", 413)
        kind = "query" if operation == "create_query" else "layout"
        with self.access.identities.mutex, self.access.repository.mutex, self.condition:
            if self.closed or self.engine.closed:
                raise DomainError("query_service_closed", "Query service is closed.", 503)
            current = self.access._current(identity, "records.read")
            scope = self.access._scope(current)
            self.engine._expire()
            self._expire_queued()
            if len(self.queue) >= self.queue_capacity:
                raise DomainError("preparation_capacity", "Preparation queue is full; retry after releasing unneeded handles.", 429)
            key = str(uuid.uuid4())
            preferences = None
            if kind == "query":
                self.engine.invalidate_principal(scope["principalId"], scope["fingerprint"])
                owned = sum(value.get("access", {}).get("principalId") == scope["principalId"] for value in self.engine.queries.values())
                if owned >= self.engine.max_queries:
                    raise DomainError("query_capacity", "Release an existing query before creating another.", 429)
                query_id = key
                # Charge bounded request/container space before copying metadata or record references.
                preference_source, preference_copy_allowance = self.preferences.capture_admission() if self.preferences else (None, 0)
                self.engine.resources.reserve(("capture", key), {"scope": scope, "request": request, "metadata": self.access.repository.meta, "preferences": preference_source},
                                              overhead=self.preparation_allowance_bytes + 16 * len(self.access.repository.records) + preference_copy_allowance)
                try:
                    repository = self.access.repository
                    captured = (repository.capture_query_snapshot() if getattr(repository, "deferred_capture", False)
                                else repository.capture_query_domain(request) if hasattr(repository, "capture_query_domain")
                                else repository.capture_query_snapshot())
                    if self.preferences:
                        preferences = self.preferences.capture()
                        captured = self.preferences.apply(captured, preferences)
                    if hasattr(repository, "project_scope"):
                        captured = repository.project_scope(captured, scope["sourceIds"])
                    self.engine.resources.replace(("capture", key), {"captured": captured, "preferences": preferences, "scope": scope, "request": request},
                                                  overhead=self.preparation_allowance_bytes)
                except BaseException:
                    self.engine.resources.release(("capture", key))
                    raise
                manifest = {"queryId": key, "snapshotId": str(uuid.uuid4()), "mapId": str(uuid.uuid4()),
                            "generation": captured["manifest"]["generation"], "revision": captured["manifest"]["revision"], "state": "preparing"}
                if "preferencesRevision" in captured["manifest"]:
                    manifest["preferencesRevision"] = captured["manifest"]["preferencesRevision"]
                placeholder = {"manifest": manifest, "access": copy.deepcopy(scope), "expires": time.monotonic() + self.engine.ttl_seconds,
                               "layouts": {}, "tables": OrderedDict()}
            else:
                query_id = args[0]
                with query_access(scope):
                    query = self.engine._query(query_id)
                if len(query["layouts"]) >= 2:
                    raise DomainError("layout_capacity", "Release an existing layout before creating another.", 429)
                captured = retained_query(query)
                manifest = {"queryId": query_id, "layoutId": key, "mapId": query["manifest"]["mapId"],
                            "generation": query["manifest"]["generation"], "revision": query["manifest"]["revision"], "state": "preparing"}
                placeholder = {"manifest": manifest}
            job = _Preparation(kind, key, query_id, scope, copy.deepcopy(identity), copy.deepcopy(request), captured, placeholder,
                               time.monotonic() + self.deadline_seconds, preferences=preferences)
            root_key = ("query", key) if kind == "query" else ("layout", query_id, key)
            try:
                if kind == "query":
                    self.engine.resources.replace(("capture", key), {"captured": captured, "preferences": preferences, "request": job.request, "scope": scope},
                                                  overhead=self.preparation_allowance_bytes)
                    self.engine.resources.roots[("preparation", key)] = self.engine.resources.roots.pop(("capture", key))
                else:
                    self.engine.resources.reserve(("preparation", key), {"captured": captured, "request": job.request, "scope": scope},
                                                  overhead=self.preparation_allowance_bytes)
            except BaseException:
                self.engine.resources.release(("capture", key))
                raise
            try:
                self.engine.resources.reserve(root_key, retained_query(placeholder) if kind == "query" else placeholder, overhead=8192)
            except BaseException:
                self.engine.resources.release(("preparation", key))
                raise
            if kind == "query":
                self.engine.queries[key] = placeholder
            else:
                query["layouts"][key] = placeholder
            self.jobs[key] = job
            self.queue.append(job)
            self.condition.notify_all()
            return job

    def _released(self, query_id, layout_id):
        if layout_id is None:
            for operation in self.synchronous.values():
                if operation["queryId"] == query_id:
                    operation["cancelled"].set()
        for job in list(self.jobs.values()):
            if job.query_id == query_id and (layout_id is None or job.key == layout_id):
                job.cancelled.set()
                if not job.active:
                    self._finish(job)
        self.condition.notify_all()

    def _expire_queued(self):
        for job in list(self.jobs.values()):
            if time.monotonic() >= job.deadline and self._present(job):
                self._record_failure(job, DomainError("preparation_timeout", "Preparation exceeded its publication deadline.", 408))
                job.cancelled.set()
                if not job.active:
                    self._finish(job)

    def _finish(self, job):
        if job in self.queue:
            self.queue.remove(job)
        self.jobs.pop(job.key, None)
        self.engine.resources.release(("preparation", job.key))
        if job.active:
            self.active_principals.discard(job.scope["principalId"])
        job.done.set()
        self.condition.notify_all()

    def _present(self, job):
        query = self.engine.queries.get(job.query_id)
        return query is job.placeholder if job.kind == "query" else query is not None and query["layouts"].get(job.key) is job.placeholder

    def _failed(self, job, error):
        if not self._present(job):
            return
        manifest = {**job.placeholder["manifest"], "state": "failed", "error": {"code": error.code[:128], "message": error.message[:256], "status": error.status}}
        if hasattr(error, 'diagnostic'):
            manifest['error']['diagnostic'] = copy.deepcopy(error.diagnostic)
        replacement = {**job.placeholder, "manifest": manifest}
        root_key = ("query", job.query_id) if job.kind == "query" else ("layout", job.query_id, job.key)
        self.engine.resources.replace(root_key, retained_query(replacement) if job.kind == "query" else replacement)
        if job.kind == "query":
            self.engine.queries[job.query_id] = replacement
        else:
            self.engine.queries[job.query_id]["layouts"][job.key] = replacement

    def _record_failure(self, job, failure):
        try:
            self._failed(job, failure)
        except Exception:
            if job.kind == "query":
                self.engine._forget(job.query_id, "preparation_failed")
            else:
                query = self.engine.queries.get(job.query_id)
                if query is not None:
                    query["layouts"].pop(job.key, None)
                self.engine.resources.release(("layout", job.query_id, job.key))

    def _fork(self, job, resources):
        worker = copy.copy(self.engine)
        worker.mutex, worker.resources, worker.queries = threading.RLock(), resources, {}
        worker.tombstones, worker.metric_variants = OrderedDict(), dict(self.engine.metric_variants)
        worker.on_release, worker._maintenance = None, None
        worker.assigned_query_ids = None
        worker.assigned_layout_id = None
        if job.kind == "query":
            worker.repository = _CapturedRepository(job.captured)
            manifest = job.placeholder["manifest"]
            worker.assigned_query_ids = (job.query_id, manifest["snapshotId"], manifest["mapId"])
        else:
            worker.queries[job.query_id] = {**job.captured, "layouts": {}, "tables": OrderedDict()}
            worker.assigned_layout_id = job.key
        return worker

    def _calculate(self, job, resources):
        with query_access(job.scope), preparation_control(job.cancelled, job.deadline):
            if job.kind == "query" and getattr(self.access.repository, "deferred_capture", False):
                repository = self.access.repository
                captured = repository.capture_query_domain(job.request)
                if self.preferences:
                    captured = self.preferences.apply(captured, job.preferences)
                job.captured = repository.project_scope(captured, job.scope["sourceIds"])
                # Allocation identity remains fixed while file coverage is exposed
                # separately on the ready query's coverage/indexVersion metadata.
                job.captured["manifest"].update({key: job.placeholder["manifest"][key] for key in ("generation", "revision")})
                resources.reserve(("window", job.key), job.captured)
                checkpoint()
            worker = self._fork(job, resources)
            if job.kind == "query":
                worker.create_query(job.request)
                result = worker.queries[job.query_id]
            else:
                worker.create_layout(job.query_id, job.request)
                result = worker.queries[job.query_id]["layouts"][job.key]
            checkpoint()
            return result

    def _publish(self, job, result):
        # Never acquire identity authority while holding the engine mutex.
        with self.access.identities.mutex, self.condition:
            current = self.access._current(job.identity, "records.read")
            if scope_fingerprint(current, self.access.workspace_id) != job.scope["fingerprint"]:
                raise DomainError("permission_scope_changed", "Permissions changed; prepare a new query.", 409)
            if not self._present(job) or job.cancelled.is_set() or self.closed:
                raise DomainError("preparation_cancelled", "Preparation was cancelled.", 409)
            if time.monotonic() >= job.deadline:
                raise DomainError("preparation_timeout", "Preparation exceeded its publication deadline.", 408)
            root_key = ("query", job.query_id) if job.kind == "query" else ("layout", job.query_id, job.key)
            if job.kind == "query":
                result = {**result, "expires": job.placeholder["expires"]}
            self.engine.resources.replace(root_key, retained_query(result) if job.kind == "query" else result, overhead=1024)
            if job.kind == "query":
                self.engine.queries[job.query_id] = result
            else:
                self.engine.queries[job.query_id]["layouts"][job.key] = result

    def _worker(self):
        while True:
            with self.condition:
                self._expire_queued()
                job = next((item for item in self.queue if item.scope["principalId"] not in self.active_principals), None) if len(self.active_principals) < self.worker_limit else None
                if job is None:
                    if self.closed:
                        return
                    self.condition.wait(0.05)
                    continue
                self.queue.remove(job)
                job.active = True
                self.active_principals.add(job.scope["principalId"])
            resources = _WorkingResources(self.engine, job.key)
            result = None
            try:
                result = self._calculate(job, resources)
                self._publish(job, result)
            except Exception as error:
                failure = error if isinstance(error, DomainError) else DomainError("preparation_failed", "Preparation failed; no result was published.", 500)
                with self.condition:
                    resources.clear()
                    self._record_failure(job, failure)
            finally:
                with self.condition:
                    result = None
                    resources.clear()
                    self._finish(job)
                job, resources = None, None

    def stats(self):
        with self.condition:
            return {"active": len(self.active_principals), "queued": len(self.queue), "workerLimit": self.worker_limit,
                    "queueCapacity": self.queue_capacity, "deadlineSeconds": self.deadline_seconds,
                    "preparationAllowanceBytes": self.preparation_allowance_bytes}

    def close(self):
        with self.condition:
            self.closed = True
            for operation in self.synchronous.values():
                operation["cancelled"].set()
            for job in list(self.jobs.values()):
                job.cancelled.set()
                if not job.active:
                    self._finish(job)
            self.condition.notify_all()
        for worker in self.workers:
            if worker is not threading.current_thread():
                worker.join()
        with self.condition:
            while self.synchronous:
                self.condition.wait(0.05)
            if self.engine.on_release == self._released:
                self.engine.on_release = None
