"""Explicit inactive-root identity recovery; prints one new token, never stores it."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    from server.app.services.identity import recover_identity

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--reason", required=True, help="Audited non-secret reason for local recovery")
    parser.add_argument("--principal-id", help="Existing administrator UUID; default is the first canonical administrator ID")
    args = parser.parse_args()
    try:
        result = recover_identity(args.data_root, args.reason, args.principal_id)
    except Exception as error:
        print(json.dumps({"error": getattr(error, "code", type(error).__name__), "message": str(error),
                          "note": "No token secret is recoverable from storage. If commit status was uncertain, inspect the inactive root and explicitly recover again."}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
