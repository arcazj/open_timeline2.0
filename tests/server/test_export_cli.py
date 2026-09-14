import copy
import importlib.util
import io
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError

import pytest

from conftest import ROOT
from server.app.models.domain import DomainError, json_bytes

SPEC = importlib.util.spec_from_file_location("export_dataset", ROOT / "scripts" / "export-dataset.py")
CLI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLI)


class FakeOpener:
    def __init__(self, raw):
        self.raw = raw
        self.request = None

    def open(self, request, timeout):
        self.request = request
        assert timeout == 30
        return io.BytesIO(self.raw)


def test_export_uses_complete_endpoint_and_validates_full_schema(bundle):
    opener = FakeOpener(json_bytes(bundle))
    raw, validated = CLI.download_snapshot("http://127.0.0.1:8765", "default", "test-token", opener)
    assert opener.request.full_url.endswith("/workspaces/default/snapshot")
    assert "query-sessions" not in opener.request.full_url
    assert validated["manifest"]["recordCount"] == len(validated["records"]) == 48
    assert raw == json_bytes(bundle)
    incomplete = {"format": "timeline-snapshot", "manifest": {"completeness": "complete-for-declared-universe", "recordCount": 0}, "records": []}
    with pytest.raises(DomainError):
        CLI.download_snapshot("http://127.0.0.1:8765", "default", "test-token", FakeOpener(json_bytes(incomplete)))


@pytest.mark.parametrize("defect", ["missing_model", "wrong_source", "duplicate_id", "count", "missing_filters"])
def test_export_rejects_incomplete_references(bundle, defect):
    value = copy.deepcopy(bundle)
    if defect == "missing_model":
        value["settings"]["modelId"] = "absent"
    elif defect == "wrong_source":
        value["records"][0]["sourceId"] = "undeclared"
    elif defect == "duplicate_id":
        value["records"][1]["id"] = value["records"][0]["id"]
    elif defect == "count":
        value["manifest"]["recordCount"] += 1
    else:
        del value["filters"]
    with pytest.raises(DomainError):
        CLI.download_snapshot("http://127.0.0.1:8765", "default", "test-token", FakeOpener(json_bytes(value)))


def test_export_rejects_redirect_without_forwarding_bearer():
    received = []

    class Destination(BaseHTTPRequestHandler):
        def do_GET(self):
            received.append(self.headers.get("Authorization"))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *_):
            pass

    destination = ThreadingHTTPServer(("127.0.0.1", 0), Destination)

    class Redirect(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{destination.server_port}/capture")
            self.end_headers()

        def log_message(self, *_):
            pass

    source = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
    threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (destination, source)]
    for thread in threads:
        thread.start()
    try:
        with pytest.raises(HTTPError) as error:
            CLI.download_snapshot(f"http://127.0.0.1:{source.server_port}", "default", "private-export-token")
        assert error.value.code == 302
        assert received == []
    finally:
        for server in (source, destination):
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join(timeout=2)


def test_export_never_overwrites_and_removes_own_failed_output(tmp_path, monkeypatch):
    existing = tmp_path / "existing.json"
    existing.write_bytes(b"original")
    with pytest.raises(FileExistsError):
        CLI.write_new_snapshot(existing, b"replacement")
    assert existing.read_bytes() == b"original"
    fresh = tmp_path / "failed.json"

    def fail_sync(_):
        raise OSError("Simulated fsync failure")

    monkeypatch.setattr(CLI.os, "fsync", fail_sync)
    with pytest.raises(OSError, match="fsync failure"):
        CLI.write_new_snapshot(fresh, b"partial export")
    assert not fresh.exists()
    assert existing.read_bytes() == b"original"
