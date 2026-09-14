"""Bounded reproducible JSON-repository and query-service benchmark.

Run from the repository root. The supervisor terminates a worker if any phase
exceeds its deadline. All data lives in one marked temporary directory.
"""
from __future__ import annotations

import argparse
import copy
import ctypes
import hashlib
import json
import os
import platform
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def memory_bytes(pid=None):
    if os.name == "nt":
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        *[(name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                          "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]]

        value = Counters()
        value.cb = ctypes.sizeof(value)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        handle = kernel.OpenProcess(0x0410, False, pid) if pid is not None else kernel.GetCurrentProcess()
        try:
            if not handle or not psapi.GetProcessMemoryInfo(handle, ctypes.byref(value), value.cb):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            if pid is not None and handle:
                kernel.CloseHandle(handle)
        return {"rss": value.WorkingSetSize, "processPeakRss": value.PeakWorkingSetSize}
    import resource
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {"rss": None, "processPeakRss": peak if sys.platform == "darwin" else peak * 1024}


def emit(value):
    print(json.dumps(value, ensure_ascii=True, allow_nan=False), flush=True)


def phase(name, operation):
    emit({"event": "phase-start", "name": name})
    before = memory_bytes()
    sampled = before["rss"] or 0
    stop = threading.Event()

    def sample():
        nonlocal sampled
        while not stop.wait(0.05):
            sampled = max(sampled, memory_bytes()["rss"] or 0)

    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    started = time.perf_counter()
    result = None
    status, error = "ok", None
    try:
        result = operation()
    except Exception as caught:
        status = "error"
        error = {"type": type(caught).__name__, "code": getattr(caught, "code", None), "message": str(caught)}
    finally:
        elapsed = time.perf_counter() - started
        stop.set()
        sampler.join(timeout=1)
    after = memory_bytes()
    measurement = {"event": "phase-result", "name": name, "status": status, "seconds": elapsed,
                   "rssBefore": before["rss"], "rssAfter": after["rss"],
                   "sampledPeakRss": max(sampled, after["rss"] or 0), "processPeakRss": after["processPeakRss"]}
    if error:
        measurement["error"] = error
    if isinstance(result, dict):
        measurement["details"] = result
    emit(measurement)
    return status == "ok"


def build_release_fixture(directory, count, tier, seed_only=False, storage_layout="records"):
    from scripts.performance_fixture import build_snapshot, fixture_summary
    from server.app.models.domain import json_bytes

    bundle = build_snapshot(tier)
    if len(bundle["records"]) != count:
        raise ValueError("Record count must match the selected versioned fixture tier")
    report = fixture_summary(bundle, tier)
    (directory / "seed.json").write_bytes(json_bytes(bundle))
    data = directory / "data"
    data.mkdir()
    files = 0
    if not seed_only:
        metadata = copy.deepcopy({key: value for key, value in bundle.items() if key != "records"})
        metadata["manifest"]["sourceKind"] = "server"
        metadata["manifest"].pop("contentSha256", None)
        if storage_layout == "shards":
            from server.app.repositories.json_shards import build_layout
            layout, documents = build_layout(bundle["records"], metadata["manifest"])
            (data / "shards").mkdir()
            for prefix, document in documents.items():
                (data / "shards" / (prefix + ".json")).write_bytes(json_bytes(document))
            (data / "storage-layout.json").write_bytes(json_bytes(layout))
            files = len(documents) + 2
        else:
            (data / "records").mkdir()
            for record in bundle["records"]:
                (data / "records" / (record["id"] + ".json")).write_bytes(json_bytes(record))
            files = len(bundle["records"]) + 1
        (data / "workspace.json").write_bytes(json_bytes(metadata))
    return {**report, "files": files, "storageLayout": storage_layout, "seedBytes": report["snapshotBytes"],
            "overviewDays": 30, "detailHours": 6, "groupingExercised": "sourceId",
            "fixtureWrites": "isolated fixture construction, not a production transaction/durability benchmark"}


def build_fixture(directory, count, seed_only=False, storage_layout="records", fixture_tier=None):
    if fixture_tier is not None:
        return build_release_fixture(directory, count, fixture_tier, seed_only, storage_layout)
    from server.app.models.domain import instant_ms, iso_from_ms, json_bytes, read_json, validate_record

    bundle = read_json(ROOT / "data" / "default-dataset.json")
    template = bundle["records"][0]
    base = instant_ms("2026-08-01T00:00:00.000Z")
    span = 30 * 86400000
    records = []
    for index in range(count):
        record = copy.deepcopy(template)
        start = base + index * span // count
        point = index % 5 == 0
        long_session = not point and index % 97 == 1
        end = None if point else start + (7 * 86400000 if long_session else (10 + index % 110) * 60000)
        record.update(id=str(uuid.UUID(int=index + 1)), kind="event" if point else "session",
                      title=f"{'Checkpoint' if point else 'Processing session'} {index:06d}",
                      start=iso_from_ms(start), end=iso_from_ms(end) if end is not None else None,
                      sourceId=f"source-{index % 10:02d}", order=index, tags=["benchmark", "priority" if index % 9 == 0 else "routine"],
                      data={"status": ("Ready", "Running", "Complete")[index % 3], "system": f"System {index % 8}",
                            "description": "Deterministic operational benchmark record with complete canonical metadata."},
                      extensions={"alias": f"BENCH-{index:06d}"}, originalStart=None, originalEnd=None, parentSessionId=None)
        validate_record(record)
        records.append(record)
    bundle["records"] = records
    bundle["zones"] = []
    bundle["manifest"].update(recordCount=count, sourceName="Deterministic server benchmark", sourceKind="server")
    bundle["manifest"].pop("contentSha256", None)
    bundle["manifest"]["scope"]["sourceIds"] = [f"source-{index:02d}" for index in range(10)]
    bundle["settings"]["overview"] = {"from": iso_from_ms(base), "to": iso_from_ms(base + span)}
    bundle["settings"]["range"] = {"from": iso_from_ms(base + 15 * 86400000), "to": iso_from_ms(base + 15 * 86400000 + 6 * 3600000)}
    bundle["settings"]["referenceTime"] = bundle["settings"]["range"]["from"]
    encoded = json_bytes(bundle)
    (directory / "seed.json").write_bytes(encoded)
    data = directory / "data"
    data.mkdir(parents=True)
    files = 0
    if not seed_only:
        if storage_layout == "shards":
            from server.app.repositories.json_shards import build_layout
            layout, documents = build_layout(records, bundle["manifest"])
            (data / "shards").mkdir()
            for prefix, document in documents.items():
                (data / "shards" / (prefix + ".json")).write_bytes(json_bytes(document))
            (data / "storage-layout.json").write_bytes(json_bytes(layout))
            files = len(documents) + 2
        else:
            record_dir = data / "records"
            record_dir.mkdir()
            for record in records:
                (record_dir / (record["id"] + ".json")).write_bytes(json_bytes(record))
            files = count + 1
        metadata = {key: value for key, value in bundle.items() if key != "records"}
        (data / "workspace.json").write_bytes(json_bytes(metadata))
    return {"recordCount": count, "seedBytes": len(encoded), "pointCount": sum(record["kind"] == "event" for record in records),
            "sourceCount": 10, "overviewDays": 30, "detailHours": 6, "files": files, "storageLayout": storage_layout,
            "fixtureWrites": "isolated fixture construction, not a production transaction/durability benchmark"}


@contextmanager
def startup_profile(enabled):
    if not enabled:
        yield
        return
    import server.app.models.domain as domain
    import server.app.models.model_catalog as catalog
    import server.app.repositories.json_repository as repository_module

    statistics = {}
    statistics_lock = threading.Lock()
    stop = threading.Event()
    replacements = []

    def measure(name, operation, *args, **kwargs):
        started = time.perf_counter()
        thread_id = threading.get_ident()
        with statistics_lock:
            row = statistics.setdefault(name, {"calls": 0, "seconds": 0.0, "active": {}})
            row["active"][thread_id] = started
        try:
            return operation(*args, **kwargs)
        finally:
            elapsed = time.perf_counter() - started
            with statistics_lock:
                row["seconds"] += elapsed
                row["calls"] += 1
                row["active"].pop(thread_id, None)

    def replace(module, name, label):
        original = getattr(module, name)

        def wrapper(*args, **kwargs):
            selected = label(args, kwargs) if callable(label) else label
            return measure(selected, original, *args, **kwargs)

        replacements.append((module, name, original))
        setattr(module, name, wrapper)

    def report():
        now = time.perf_counter()
        with statistics_lock:
            snapshot = {name: {"calls": row["calls"], "seconds": row["seconds"],
                               "activeCount": len(row["active"]),
                               "activeSeconds": max((now - start for start in row["active"].values()), default=0)}
                        for name, row in statistics.items()}
        emit({"event": "startup-profile", "statistics": snapshot})

    def periodic_report():
        while not stop.wait(10):
            report()

    replace(repository_module, "read_json", "repository-read-parse-json")
    replace(repository_module, "_read_bounded_json", "bounded-descriptor-read-parse")
    replace(repository_module, "parse_json", "strict-json-parse")
    replace(Path, "read_bytes", "filesystem-read-bytes")
    replace(domain, "parse_json", "strict-json-parse")
    replace(repository_module, "validate_record", "repository-record-validation")
    replace(repository_module, "validate_snapshot", "snapshot-validation-inclusive")
    replace(domain, "validate_record", lambda args, kwargs: "snapshot-record-relationships" if len(args) > 1 or kwargs.get("records") is not None else "snapshot-record-local")
    if hasattr(domain, "_validate_record_fields"):
        replace(domain, "_validate_record_fields", "snapshot-record-fields")
    if hasattr(domain, "_validate_record_relationships"):
        replace(domain, "_validate_record_relationships", "record-relationships-only")
    replace(catalog, "normalize_metadata", "catalog-normalization")
    factory_module, factory_name = (domain, "Draft7Validator") if hasattr(domain, "Draft7Validator") else (domain.jsonschema_rs, "validator_for")
    factory = getattr(factory_module, factory_name)

    class ValidatorProxy:
        def __init__(self, validator):
            self.validator = validator

        def iter_errors(self, value):
            def first_error():
                errors = self.validator.iter_errors(value)
                return next(errors, None), errors

            error, errors = measure("snapshot-jsonschema", first_error)
            while True:
                if error is None:
                    return
                yield error
                error = measure("snapshot-jsonschema", next, errors, None)

    replacements.append((factory_module, factory_name, factory))
    setattr(factory_module, factory_name, lambda *args, **kwargs: ValidatorProxy(factory(*args, **kwargs)))
    reporter = threading.Thread(target=periodic_report, daemon=True)
    reporter.start()
    try:
        yield
    finally:
        stop.set()
        reporter.join(timeout=1)
        report()
        for module, name, original in reversed(replacements):
            setattr(module, name, original)


def service_worker(directory, service_only, skip_full_layout=False, startup_only=False, profile_startup=False, read_workers=32):
    import portalocker
    import rfc8785

    from server.app.models.domain import json_bytes, read_json
    from server.app.repositories.json_repository import JsonRepository
    import server.app.repositories.json_repository as repository_module
    from server.app.services.query import QueryEngine

    repository = JsonRepository(directory / "data", directory / "seed.json")
    repository_module._READ_WORKERS = read_workers
    hydrated = None
    if service_only:
        def hydrate():
            nonlocal hydrated
            hydrated = read_json(directory / "seed.json")
            repository.owner = portalocker.Lock(str(repository.root / ".writer.lock"), mode="a+b", timeout=0,
                                                flags=portalocker.LOCK_EX | portalocker.LOCK_NB)
            repository.owner.acquire()
            repository.meta = {key: value for key, value in hydrated.items() if key != "records"}
            repository.records = {record["id"]: record for record in hydrated["records"]}
            repository.available = True
            return {"recordCount": len(repository.records), "qualification": "service-only hydration; production startup validation bypassed"}
        if not phase("service-only-json-hydration", hydrate):
            return
    else:
        with startup_profile(profile_startup):
            if not phase("repository-startup", lambda: {"recordCount": len(repository.open().records), "readWorkers": read_workers,
                                                        "storageLayoutVersion": 2 if repository.layout is not None else 1,
                                                        "shardCount": len(repository.shards)}):
                return
    if startup_only:
        repository.close()
        return
    engine = QueryEngine(repository, ROOT / "shared" / "fixtures" / "font-metrics.json", ttl_seconds=3600)
    metadata = repository.meta
    state = {}

    def prepare_query():
        state["query"] = engine.create_query({"domain": metadata["settings"]["overview"], "scaleMode": "adaptive", "bins": 128,
                                              "ratio": 4, "search": "Running", "searchMode": "any"})
        return state["query"]

    try:
        if not phase("query-adaptive-full-snapshot", prepare_query):
            return
        query_id = state["query"]["queryId"]
        def density():
            result = engine.density(query_id)
            return {"bins": len(result["bins"]), "total": result["total"]}
        phase("density-manifest-read", density)
        phase("map-manifest-read", lambda: {"knots": len(engine.mapping(query_id, state["query"]["mapId"])["knots"])})

        def overview():
            result = engine.overview(query_id)
            return {"items": len(result["items"]), "total": result["total"], "matched": result["matched"], "aggregated": result["aggregated"]}
        phase("overview-search-aggregation", overview)

        def table_first():
            result = engine.query_records(query_id, {"sort": [{"field": "title", "direction": "desc"}], "limit": 100})
            state["nextCursor"] = result["nextCursor"]
            return {"total": result["total"], "items": len(result["items"]), "pageCount": result["pageCount"], "responseBytes": len(rfc8785.dumps(result))}
        if phase("table-full-sort-first-page", table_first):
            def table_next():
                result = engine.query_records(query_id, {"sort": [{"field": "title", "direction": "desc"}], "limit": 100, "cursor": state["nextCursor"]})
                return {"items": len(result["items"]), "pageIndex": result["pageIndex"], "responseBytes": len(rfc8785.dumps(result))}
            phase("table-next-page", table_next)

        def layout(window, presentation=None):
            request = {**window, "mapId": state["query"]["mapId"], "width": 1200, "availableHeight": 600,
                       "rowHeight": 32, "fontSize": 13, "groupBy": "sourceId"}
            if presentation is not None:
                request["presentation"] = presentation
            result = engine.create_layout(query_id, request)
            page = engine.rows(query_id, result["layoutId"])
            details = {"detailTotal": result["detailTotal"], "totalRows": result["totalRows"], "pageItems": len(page["items"]),
                       "pageCount": page["pageCount"], "rowHeight": result["rowHeight"]}
            state["layoutId"] = result["layoutId"]
            return details
        if phase("layout-detail-six-hours", lambda: layout(metadata["settings"]["range"])):
            phase("row-page-cached", lambda: {"items": engine.rows(query_id, state["layoutId"])["loadedCount"]})
            engine.release_layout(query_id, state["layoutId"])
        if phase("layout-styled-six-hours", lambda: layout(metadata["settings"]["range"], {"version": 1, "labels": {"maxLines": 2}})):
            engine.release_layout(query_id, state["layoutId"])

        def export():
            result = repository.snapshot()
            encoded = json_bytes(result)
            path = directory / "export.json"
            with path.open("xb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            return {"records": len(result["records"]), "bytes": len(encoded), "contentSha256": result["manifest"]["contentSha256"]}
        phase("complete-json-export", export)
        if not skip_full_layout:
            phase("layout-full-thirty-days", lambda: layout(metadata["settings"]["overview"]))
    finally:
        engine.close()
        repository.close()


def supervise(mode, directory, count, timeout, skip_full_layout=False, seed_only=False, startup_only=False, profile_startup=False,
              read_workers=32, storage_layout="records", fixture_tier=None):
    arguments = [str(Path(__file__).resolve()), "--worker", mode, "--directory", str(directory), "--records", str(count)]
    if skip_full_layout:
        arguments.append("--skip-full-layout")
    if seed_only:
        arguments.append("--seed-only")
    if startup_only:
        arguments.append("--startup-only")
    if profile_startup:
        arguments.append("--profile-startup")
    arguments.extend(["--read-workers", str(read_workers)])
    arguments.extend(["--storage-layout", storage_layout])
    if fixture_tier is not None:
        arguments.extend(["--fixture-tier", fixture_tier])
    # Windows venv executables are launchers: use the real interpreter so the
    # supervised PID is the worker, preserving the active venv import paths.
    bootstrap = ("import runpy,sys;sys.path=" + repr(sys.path) + ";sys.argv=" + repr(arguments)
                 + ";runpy.run_path(" + repr(arguments[0]) + ",run_name='__main__')")
    command = [getattr(sys, "_base_executable", sys.executable), "-c", bootstrap]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8")
    messages = queue.Queue()

    def read_output():
        for line in process.stdout:
            messages.put(line)
        messages.put(None)

    threading.Thread(target=read_output, daemon=True).start()
    measurements, profiles, active, sampled_peak = [], [], "worker-start", 0
    deadline = time.monotonic() + timeout
    timed_out = False
    while True:
        if os.name == "nt" and process.poll() is None:
            try:
                sampled_peak = max(sampled_peak, memory_bytes(process.pid)["rss"] or 0)
            except OSError:
                pass
        try:
            line = messages.get(timeout=min(0.25, max(0.01, deadline - time.monotonic())))
        except queue.Empty:
            line = ""
        if line is None:
            break
        if line:
            try:
                event = json.loads(line)
            except ValueError:
                emit({"event": "worker-output", "mode": mode, "text": line.rstrip()})
            else:
                emit({**event, "lane": mode})
                if event["event"] == "phase-start":
                    active, deadline, sampled_peak = event["name"], time.monotonic() + timeout, 0
                elif event["event"] == "phase-result":
                    measurements.append(event)
                    active, deadline = "between-phases", time.monotonic() + timeout
                elif event["event"] == "startup-profile":
                    profiles.append(event["statistics"])
        if time.monotonic() >= deadline:
            process.kill()
            process.wait(timeout=10)
            result = {"event": "phase-result", "name": active, "status": "timeout", "secondsLowerBound": timeout,
                      "supervisorSampledPeakRss": sampled_peak or None}
            emit({**result, "lane": mode})
            measurements.append(result)
            timed_out = True
            break
    process.wait(timeout=10)
    return {"lane": mode, "exitCode": process.returncode, "timedOut": timed_out, "phases": measurements, "startupProfiles": profiles}


def cleanup(directory):
    resolved = directory.resolve()
    temporary_root = Path(tempfile.gettempdir()).resolve()
    if not resolved.is_relative_to(temporary_root) or not resolved.name.startswith("openbexi-benchmark-") or not (resolved / ".benchmark-owner").is_file():
        raise RuntimeError("Refusing cleanup outside the verified benchmark temporary root.")
    shutil.rmtree(resolved)


def source_evidence():
    paths = [ROOT / "scripts/benchmark-server.py", ROOT / "scripts/performance_fixture.py",
             ROOT / "data/default-dataset.json", ROOT / "shared/fixtures/font-metrics.json", ROOT / "uv.lock"]
    paths.extend(sorted((ROOT / "server/app").rglob("*.py")))
    paths.extend(sorted((ROOT / "shared/schemas").rglob("*.json")))
    return {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--records", type=int, help="Historical fixture count; a versioned tier fixes its own count")
    parser.add_argument("--fixture-tier", choices=("small", "typical", "stress"), help="Use the versioned release-mixture fixture")
    parser.add_argument("--phase-timeout", type=float, default=120)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--worker", choices=("fixture", "production", "service-only"))
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--service-only", action="store_true", help="Explicitly measure JSON-hydrated services, not startup")
    parser.add_argument("--skip-full-layout", action="store_true", help="Do not repeat full-analysis-range layout")
    parser.add_argument("--startup-only", action="store_true", help="Stop after normal repository initialization")
    parser.add_argument("--profile-startup", action="store_true", help="Report benchmark-only startup stage counters")
    parser.add_argument("--read-workers", type=int, choices=(16, 32), default=32, help="Bounded startup read-worker comparison")
    parser.add_argument("--storage-layout", choices=("records", "shards"), default="records", help="Authoritative JSON fixture layout")
    parser.add_argument("--seed-only", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.fixture_tier is not None:
        from scripts.performance_fixture import TIERS
        if args.records is not None and args.records != TIERS[args.fixture_tier]:
            parser.error("--records must match the selected fixture tier")
        args.records = TIERS[args.fixture_tier]
    else:
        args.records = 100000 if args.records is None else args.records
        if not 1 <= args.records <= 100000:
            parser.error("Historical fixture records must be 1..100000")
    if not 1 <= args.phase_timeout <= 120:
        parser.error("Phase timeout must be 1..120 seconds")
    if args.worker:
        if args.worker == "fixture":
            phase("fixture-generation-and-json-files", lambda: build_fixture(args.directory, args.records, args.seed_only, args.storage_layout, args.fixture_tier))
        else:
            service_worker(args.directory, args.worker == "service-only", args.skip_full_layout, args.startup_only, args.profile_startup, args.read_workers)
        return
    directory = Path(tempfile.mkdtemp(prefix="openbexi-benchmark-"))
    (directory / ".benchmark-owner").write_text("isolated benchmark fixture\n", encoding="ascii")
    report = {"formatVersion": 1, "recordCount": args.records, "phaseTimeoutSeconds": args.phase_timeout,
              "environment": {"platform": platform.platform(), "python": sys.version, "logicalCpuCount": os.cpu_count(),
                              "processor": platform.processor()}, "lanes": [], "temporaryDirectory": str(directory)}
    if args.fixture_tier is not None:
        report.update(fixtureTier=args.fixture_tier, sourceSha256=source_evidence(),
                      qualification="Single diagnostic sample; host and OS cache are not controlled reference hardware",
                      groupLayoutQualification=False, stressTierSupported=False, queryEntryPoint="direct QueryEngine, not HTTP preparation coordinator")
    try:
        fixture = supervise("fixture", directory, args.records, args.phase_timeout, seed_only=args.service_only,
                            storage_layout=args.storage_layout, fixture_tier=args.fixture_tier)
        report["lanes"].append(fixture)
        if not fixture["timedOut"] and fixture["phases"] and fixture["phases"][-1]["status"] == "ok":
            if args.service_only:
                report["lanes"].append(supervise("service-only", directory, args.records, args.phase_timeout, args.skip_full_layout,
                                               startup_only=args.startup_only, profile_startup=args.profile_startup,
                                               read_workers=args.read_workers, fixture_tier=args.fixture_tier))
            else:
                production = supervise("production", directory, args.records, args.phase_timeout, args.skip_full_layout,
                                       startup_only=args.startup_only, profile_startup=args.profile_startup,
                                       read_workers=args.read_workers, fixture_tier=args.fixture_tier)
                report["lanes"].append(production)
                startup = next((phase for phase in production["phases"] if phase["name"] == "repository-startup"), {})
                if startup.get("status") != "ok" and not args.startup_only:
                    report["lanes"].append(supervise("service-only", directory, args.records, args.phase_timeout, args.skip_full_layout,
                                                   fixture_tier=args.fixture_tier))
    finally:
        cleanup(directory)
        report["temporaryDataRemoved"] = not directory.exists()
        if args.fixture_tier is not None:
            report["sourceSha256After"] = source_evidence()
            report["sourceStateStable"] = report["sourceSha256After"] == report["sourceSha256"]
    if args.output:
        with args.output.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2, allow_nan=False)
            stream.write("\n")
    emit({"event": "benchmark-complete", "report": report})


if __name__ == "__main__":
    main()
