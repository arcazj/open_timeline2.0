"""One isolated 100k shard integrity sweep; diagnostic evidence, not qualification."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

specification = importlib.util.spec_from_file_location("server_benchmark", ROOT / "scripts/benchmark-server.py")
benchmark = importlib.util.module_from_spec(specification)
specification.loader.exec_module(benchmark)


def worker(directory, count):
    from server.app.repositories.json_repository import JsonRepository

    report = {"qualification": "One diagnostic sample under current host load; no percentile or release qualification.",
              "platform": platform.platform(), "python": platform.python_version(), "recordCount": count,
              "sourceSha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in
                               ("server/app/repositories/integrity_monitor.py", "server/app/repositories/json_repository.py")}}
    started = time.perf_counter()
    report["fixture"] = benchmark.build_fixture(directory, count, storage_layout="shards")
    report["fixtureSeconds"] = time.perf_counter() - started
    started = time.perf_counter()
    repository = JsonRepository(directory / "data", directory / "seed.json").open()
    report["startupSeconds"] = time.perf_counter() - started
    try:
        monitor = repository.integrity
        started = time.perf_counter()
        while monitor.completed_sweeps < 1 and repository.available:
            if time.perf_counter() - started > 120:
                raise TimeoutError("Integrity sweep exceeded 120 seconds")
            time.sleep(0.01)
        if not repository.available:
            raise RuntimeError("Healthy fixture failed integrity monitoring")
        report["initialSweepSeconds"] = monitor.last_sweep_seconds
        report["registryEstimatedBytes"] = monitor.registry_bytes
        report["authorityFileCount"] = len(monitor.expected)
        report["checkedFiles"] = monitor.checked_files
        report["checkedBytes"] = monitor.checked_bytes
        report["memoryAfterSweep"] = benchmark.memory_bytes()
        relative = repository.layout["buckets"][-1]["path"]
        started = time.perf_counter()
        # This is an intentionally corrupted disposable fixture, never a repair or production edit.
        with (repository.root / relative).open("ab") as stream:
            stream.write(b" ")
        while repository.available:
            if time.perf_counter() - started > 120:
                raise TimeoutError("Integrity detection exceeded 120 seconds")
            time.sleep(0.01)
        report["driftDetectionSeconds"] = time.perf_counter() - started
        report["failure"] = monitor.failure
        if monitor.failure.get("path") != relative:
            raise RuntimeError("Detection did not identify the corrupted shard")
    finally:
        repository.close()
    report["monitorJoined"] = not monitor.thread.is_alive()
    report["status"] = "passed"
    print(json.dumps(report), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=100000)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/performance/integrity-shards-100k.json")
    parser.add_argument("--worker", type=Path)
    args = parser.parse_args()
    if not 1 <= args.count <= 100000:
        parser.error("count must be 1..100000")
    if args.worker:
        worker(args.worker, args.count)
        return 0
    directory = Path(tempfile.mkdtemp(prefix="openbexi-benchmark-"))
    (directory / ".benchmark-owner").write_text("isolated integrity fixture\n", encoding="ascii")
    try:
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--worker", str(directory), "--count", str(args.count)],
                                capture_output=True, text=True, timeout=300,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        if result.returncode != 0:
            raise RuntimeError(result.stderr or result.stdout or "Integrity benchmark worker failed")
        report = json.loads(result.stdout)
    finally:
        benchmark.cleanup(directory)
    report["temporaryDataRemoved"] = not directory.exists()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
