"""Create or verify a complete inactive JSON-root backup; never start a service."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.app.models.domain import DomainError  # noqa: E402
from server.app.services.backup import create_offline_backup, verify_backup  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("--data-root", required=True, type=Path)
    create.add_argument("--destination", required=True, type=Path)
    verify = commands.add_parser("verify")
    verify.add_argument("--backup", required=True, type=Path)
    args = parser.parse_args()
    try:
        manifest = (create_offline_backup(args.data_root, args.destination) if args.command == "create"
                    else verify_backup(args.backup))
    except (DomainError, OSError, RuntimeError) as error:
        print(json.dumps({"error": getattr(error, "code", "backup_failed"), "message": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps({"backupId": manifest["backupId"], "checksum": manifest["checksum"], "complete": True,
                      "fileCount": manifest["fileCount"], "totalBytes": manifest["totalBytes"],
                      "workspace": manifest["workspace"], "identity": manifest["identity"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
