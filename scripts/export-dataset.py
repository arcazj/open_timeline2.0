"""Download and validate a complete authorized source snapshot, never a query page."""
import argparse
import os
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.app.models.domain import DomainError, parse_json, validate_snapshot  # noqa: E402

MAX_BYTES = 64 * 1024 * 1024


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # Never forward an operator's bearer token to a redirect destination.
        return None


def download_snapshot(url, workspace, token, opener=None):
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Server URL must be an HTTP(S) base URL without credentials, query or fragment.")
    request = Request(f"{url.rstrip('/')}/api/v1/workspaces/{quote(workspace, safe='')}/snapshot",
                      headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    client = opener or build_opener(NoRedirect())
    with client.open(request, timeout=30) as response:
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("Snapshot exceeds the initial Local import byte limit; no partial output was written.")
    snapshot = validate_snapshot(parse_json(raw))
    if len(snapshot["records"]) > 25000:
        raise ValueError("Snapshot exceeds the initial 25,000-record Local import limit.")
    return raw, snapshot


def write_new_snapshot(output, raw):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    created_stat = None
    try:
        with output.open("xb") as handle:
            created_stat = os.fstat(handle.fileno())
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        if created_stat is not None:
            try:
                if os.path.samestat(created_stat, output.stat()):
                    output.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                print("Export failed; its incomplete output could not be removed. Do not use it as a snapshot.", file=sys.stderr)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--workspace", default="default")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    token = os.environ.get("OPENBEXI_API_TOKEN")
    if not token:
        parser.error("Set OPENBEXI_API_TOKEN in the environment; do not put secrets in command arguments.")
    if args.output.exists():
        raise SystemExit("Output already exists. Choose a new path to avoid overwriting a snapshot.")
    try:
        raw, snapshot = download_snapshot(args.url, args.workspace, token)
        write_new_snapshot(args.output, raw)
    except (DomainError, OSError, ValueError) as error:
        raise SystemExit(f"Export failed: {error}") from error
    print(f"Exported {len(snapshot['records'])} records at {snapshot['manifest']['snapshotAt']} to {args.output}")


if __name__ == "__main__":
    main()
