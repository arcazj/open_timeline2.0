"""Validate a complete backup and prepare a new inactive root with revoked tokens."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.app.models.domain import DomainError  # noqa: E402
from server.app.services.backup import restore_backup  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--reason", required=True)
    args = parser.parse_args()
    try:
        result = restore_backup(args.backup, args.destination, reason=args.reason)
    except (DomainError, OSError, RuntimeError) as error:
        print(json.dumps({"error": getattr(error, "code", "restore_failed"), "message": str(error),
                          "nextStep": "Inspect any incomplete destination; the source was not replaced. Never activate a root with its staging marker present."}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
