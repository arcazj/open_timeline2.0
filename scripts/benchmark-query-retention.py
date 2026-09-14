"""One bounded 100k retained-graph measurement, not a release percentile gate."""
import argparse
import copy
import json
import platform
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.app.models.domain import instant_ms, iso_from_ms, read_json  # noqa: E402
from server.app.services.query import QueryEngine  # noqa: E402
from server.app.services.identity import IdentityStore  # noqa: E402
from server.app.services.workspace_access import WorkspaceAccess  # noqa: E402
from server.app.services.query_preparation import QueryPreparationCoordinator  # noqa: E402


class SnapshotRepository:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.meta = {key: value for key, value in snapshot.items() if key != "records"}
        self.records = {record["id"]: record for record in snapshot["records"]}
        self.mutex = threading.RLock()

    def query_snapshot(self):
        return copy.deepcopy(self.snapshot)

    def capture_query_snapshot(self):
        return {**copy.deepcopy(self.meta), "records": list(self.records.values())}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=100000)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/performance/query-retention-100k.json")
    parser.add_argument("--async-preparation", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.count <= 100000:
        parser.error("count must be 1-100000")
    snapshot = read_json(ROOT / "data/default-dataset.json")
    template = snapshot["records"][0]
    base = instant_ms("2026-01-01T00:00:00.000Z")
    records = []
    for index in range(args.count):
        record = copy.deepcopy(template)
        record.update(id=str(uuid.UUID(int=index + 1)), title=f"Record {index}", kind="event", end=None, parentSessionId=None,
                      start=iso_from_ms(base + index * 30000), originalStart=None, originalEnd=None, groupIds=[], tags=[], data={"status": "ready"}, extensions={})
        records.append(record)
    snapshot["records"] = records
    engine = QueryEngine(SnapshotRepository(snapshot), ROOT / "shared/fixtures/font-metrics.json", cleanup_interval_seconds=0)
    report = {"python": platform.python_version(), "platform": platform.platform(), "recordCount": args.count,
              "qualification": "single in-memory diagnostic sample; no real JSON-store/HTTP, percentile, RSS, preparation-scratch or release claim", "reservations": [],
              "asyncPreparation": args.async_preparation}
    reserve = engine.resources.reserve

    def timed_reserve(key, root, overhead=0):
        started = time.perf_counter()
        reserve(key, root, overhead)
        report["reservations"].append({"kind": key[0] if isinstance(key, tuple) else "replacement", "milliseconds": (time.perf_counter() - started) * 1000, **engine.resources.stats()})

    engine.resources.reserve = timed_reserve
    coordinator = access = identities = temporary = None
    try:
        if args.async_preparation:
            temporary = tempfile.TemporaryDirectory(prefix="timeline-query-diagnostic-")
            identities = IdentityStore(Path(temporary.name) / "control", "benchmark-local-identity-only")
            identities.open()
            access = WorkspaceAccess(identities, engine.repository, engine)
            coordinator = QueryPreparationCoordinator(engine, access)
            identity = identities.authenticate("benchmark-local-identity-only")

        def prepare(operation, *inputs):
            if coordinator is None:
                return getattr(engine, operation)(*inputs)
            admission = time.perf_counter()
            result = coordinator.dispatch(identity, operation, *inputs, prefer_async=True)
            report.setdefault("admissions", []).append({"kind": operation, "milliseconds": (time.perf_counter() - admission) * 1000, "state": result.get("state", "ready")})
            deadline = time.monotonic() + 35
            while result.get("state") == "preparing" and time.monotonic() < deadline:
                time.sleep(0.01)
                result = coordinator.dispatch(identity, "get_query", result["queryId"]) if operation == "create_query" else coordinator.dispatch(identity, "get_layout", inputs[0], result["layoutId"])
            if result.get("state", "ready") != "ready":
                raise RuntimeError(f"Preparation did not succeed: {result}")
            return result

        domain = {"from": "2026-01-01T00:00:00.000Z", "to": "2026-03-01T00:00:00.000Z"}
        started = time.perf_counter()
        query = prepare("create_query", {"domain": domain})
        report["queryMilliseconds"] = (time.perf_counter() - started) * 1000
        started = time.perf_counter()
        layout = prepare("create_layout", query["queryId"], {"from": domain["from"], "to": "2026-01-01T12:00:00.000Z",
            "mapId": query["mapId"], "width": 1000, "availableHeight": 480})
        report["layoutMilliseconds"] = (time.perf_counter() - started) * 1000
        report["layoutRecords"] = layout["detailTotal"]
        before = engine.resources.graph_visits
        timings = []
        for _ in range(100):
            started = time.perf_counter()
            call = (lambda operation, *inputs: coordinator.dispatch(identity, operation, *inputs)) if coordinator else (lambda operation, *inputs: getattr(engine, operation)(*inputs))
            call("get_query", query["queryId"])
            call("get_layout", query["queryId"], layout["layoutId"])
            call("rows", query["queryId"], layout["layoutId"])
            timings.append((time.perf_counter() - started) * 1000)
        report["cachedReads"] = {"samples": len(timings), "meanMilliseconds": sum(timings) / len(timings), "maxMilliseconds": max(timings),
                                 "additionalGraphVisits": engine.resources.graph_visits - before}
        assert report["cachedReads"]["additionalGraphVisits"] == 0
        started = time.perf_counter()
        call("release_query", query["queryId"])
        report["releaseMilliseconds"] = (time.perf_counter() - started) * 1000
        report["afterRelease"] = engine.resources.stats()
        assert report["afterRelease"]["retainedBytes"] == 0
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["error"] = {"type": type(error).__name__, "code": getattr(error, "code", None), "message": str(error)}
    finally:
        if coordinator:
            coordinator.close()
        if access:
            access.close()
        engine.close()
        if identities:
            identities.close()
        if temporary:
            temporary.cleanup()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
