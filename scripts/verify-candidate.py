"""Run implemented-surface checks and bind evidence to an unchanged working tree."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRS = ("client", "server", "shared", "scripts", "tests", ".github", "data", "yaml", "config")
SOURCE_FILES = ("package.json", "package-lock.json", "pyproject.toml", "uv.lock",
                "playwright.config.mjs", "playwright.matrix.config.mjs", "playwright.demo.config.mjs", "Dockerfile",
                ".dockerignore", ".gitignore", ".gitattributes", ".editorconfig", "README.md",
                "CONTRIBUTING.md", "SECURITY.md", "LICENSE", "OpenBEXI_Timeline_Rebuild_Prompt.md")


def stamp():
    return datetime.now(timezone.utc).isoformat()


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def source_inventory(root):
    files = [root / name for name in SOURCE_FILES if (root / name).is_file()]
    for directory in SOURCE_DIRS:
        files.extend(path for path in (root / directory).rglob("*") if path.is_file()
                     and "__pycache__" not in path.parts and path.suffix not in (".pyc", ".log")
                     and not path.relative_to(root).as_posix().startswith(("yaml/local/", "config/local/")))
    files.extend((root / "docs").rglob("*.md"))
    files.extend(path for path in (root / "docs/licenses").rglob("*") if path.is_file())
    hashes = {path.relative_to(root).as_posix(): sha256(path.read_bytes()) for path in sorted(set(files))}
    return {"sha256": sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()), "files": hashes}


def stop_tree(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False)
    else:
        import signal
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
    process.wait()


def run_step(name, command, root, output, *, timeout=1800, log_limit=64 * 1024**2):
    log_path = output / (name + ".log")
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith("OPENBEXI_") or key == "OPENBEXI_BROWSER"}
    started, clock = stamp(), time.monotonic()
    overflow, reader_error = threading.Event(), []
    process = subprocess.Popen(command, cwd=root, env=environment, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT,
                               creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
                               start_new_session=os.name != "nt")

    def collect():
        total = 0
        try:
            with log_path.open("xb") as destination:
                while chunk := process.stdout.read(65536):
                    remaining = max(0, log_limit - total)
                    destination.write(chunk[:remaining])
                    total += len(chunk)
                    if total > log_limit:
                        overflow.set()
        except Exception as error:
            reader_error.append(type(error).__name__)
            overflow.set()

    reader = threading.Thread(target=collect, daemon=True)
    reader.start()
    reason = None
    try:
        while process.poll() is None:
            if overflow.wait(0.05):
                reason = "log_limit_or_capture_failure"
                stop_tree(process)
                break
            if time.monotonic() - clock > timeout:
                reason = "timeout"
                stop_tree(process)
                break
    except BaseException:
        stop_tree(process)
        raise
    finally:
        reader.join()
        process.stdout.close()
    if overflow.is_set() and reason is None:
        reason = "log_limit_or_capture_failure"
    return {"name": name, "command": command, "startedAt": started, "seconds": time.monotonic() - clock,
            "exitCode": process.returncode, "status": "passed" if process.returncode == 0 and not reason else "failed",
            "reason": reason, "captureErrors": reader_error, "log": log_path.name,
            "logSha256": sha256(log_path.read_bytes()) if log_path.exists() else None}


def save(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def junit_summary(path):
    cases = ET.parse(path).getroot().findall(".//testcase")
    return {"tests": len(cases), "skipped": sum(item.find("skipped") is not None for item in cases),
            "failed": sum(item.find("failure") is not None or item.find("error") is not None for item in cases)}


def assess_junit(result, summary):
    result["tests"] = summary
    if summary["failed"]:
        result.update(status="failed", reason="reported_test_failures")
    elif not summary["tests"]:
        result.update(status="failed", reason="empty_test_report")
    elif result["status"] == "passed" and summary["skipped"]:
        result.update(status="incomplete", reason="skipped_cases")


def assess_browser(result, browser, expected_bundle):
    stats = browser.get("stats", {})
    result["tests"] = {key: stats.get(key, 0) for key in ("expected", "unexpected", "skipped", "flaky")}
    if browser.get("config", {}).get("metadata", {}).get("standaloneBundleSha256") != expected_bundle:
        result.update(status="failed", reason="browser_bundle_mismatch")
    elif stats.get("unexpected", 0) or browser.get("errors"):
        result.update(status="failed", reason="reported_browser_failures")
    elif not sum(result["tests"].values()):
        result.update(status="failed", reason="empty_browser_report")
    elif result["status"] == "passed" and (stats.get("skipped", 0) or stats.get("flaky", 0)):
        result.update(status="incomplete", reason="skipped_or_flaky_browser_cases")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New directory below artifacts/verification")
    parser.add_argument("--matrix", action="store_true", help="Also run focused Chromium/Firefox/Edge coverage")
    options = parser.parse_args()
    output = options.output.resolve()
    allowed = (ROOT / "artifacts/verification").resolve()
    if not output.is_relative_to(allowed) or output == allowed or output.exists():
        parser.error("Output must be a new child directory below artifacts/verification")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir()
    node = shutil.which("node")
    if node is None:
        parser.error("Node.js is required")
    python = str(ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))
    def node_tests(name, directory):
        return [node, "--test", "--test-concurrency=1", "--test-reporter=spec", "--test-reporter-destination=stdout",
                "--test-reporter=junit", f"--test-reporter-destination={output / (name + '.xml')}",
                *[str(path.relative_to(ROOT)) for path in sorted((ROOT / directory).glob("*.test.mjs"))]]
    checks = [
        ("ruff", [python, "-m", "ruff", "check", "server", "tests/server", "scripts"]),
        ("client", node_tests("client", "tests/client")),
        ("server", [python, "-m", "pytest", "tests/server", "-q", f"--junitxml={output / 'server.xml'}"]),
        ("parity", node_tests("parity", "tests/integration")),
        ("openapi", [python, "scripts/export-openapi.py", "--check"]),
        ("datasets", [python, "scripts/normalize-test-data.py", "--check"]),
        ("build", [node, "scripts/build-standalone.mjs"]),
        ("rebuild", [node, "scripts/build-standalone.mjs"]),
    ]
    if options.matrix:
        matrix = [node, "node_modules/@playwright/test/cli.js", "test", "--config", "playwright.matrix.config.mjs"]
        if sys.platform.startswith("linux"):
            matrix = ["xvfb-run", "-a", *matrix]
        checks.append(("matrix", matrix))
    checks.append(("browser", [node, "node_modules/@playwright/test/cli.js", "test"]))
    before = source_inventory(ROOT)
    report = {"format": "openbexi-candidate-verification", "formatVersion": 1, "startedAt": stamp(),
              "releaseApproved": False, "scope": "Implemented automated checks; not full G0-G5 or manual qualification",
              "environment": {"os": platform.platform(), "python": sys.version, "machine": platform.machine(),
                              "logicalCpus": os.cpu_count()}, "sourceBefore": before, "checks": [], "status": "running"}
    try:
        result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=False)
        report["commit"] = result.stdout.strip() if result.returncode == 0 else None
    except OSError:
        report["commit"] = None
    save(output / "manifest.json", report)
    first_build = None
    try:
        for name, command in checks:
            print(f"Running {name}...", flush=True)
            result = run_step(name, command, ROOT, output)
            report["checks"].append(result)
            if name in ("client", "server", "parity"):
                path = output / (name + ".xml")
                if path.exists():
                    assess_junit(result, junit_summary(path))
                elif result["status"] == "passed":
                    result.update(status="failed", reason="missing_test_report")
            if name in ("build", "rebuild") and result["status"] == "passed":
                built = (ROOT / "dist/index.html").read_bytes()
                if name == "build":
                    first_build = sha256(built)
                elif first_build != sha256(built):
                    result.update(status="failed", reason="nonreproducible_bundle")
                report["standaloneBundleSha256"] = sha256(built)
                shutil.copyfile(ROOT / "dist/build-manifest.json", output / "build-manifest.json")
            if name in ("browser", "matrix"):
                source = ROOT / "artifacts/browser" / ("results.json" if name == "browser" else "matrix.json")
                if source.exists():
                    browser = json.loads(source.read_text(encoding="utf-8"))
                    shutil.copyfile(source, output / (name + ".json"))
                    assess_browser(result, browser, first_build)
                elif result["status"] == "passed":
                    result.update(status="failed", reason="missing_browser_report")
            print(f"{name}: {result['status']} ({result['seconds']:.1f}s)", flush=True)
            save(output / "manifest.json", report)
            if result["status"] == "failed":
                break
    except BaseException as error:
        report["interruptedBy"] = type(error).__name__
        raise
    finally:
        report["sourceAfter"] = source_inventory(ROOT)
        report["sourceUnchanged"] = before["sha256"] == report["sourceAfter"]["sha256"]
        report["finishedAt"] = stamp()
        report["status"] = "passed-checks" if (len(report["checks"]) == len(checks) and report["sourceUnchanged"]
                            and all(item["status"] == "passed" for item in report["checks"])) else "incomplete"
        save(output / "manifest.json", report)
    print(f"Candidate checks: {report['status']}. Full release approval is not inferred. {output}")
    return 0 if report["status"] == "passed-checks" else 1


if __name__ == "__main__":
    raise SystemExit(main())
