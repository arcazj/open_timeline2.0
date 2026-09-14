"""Validate an inactive legacy root and stage JSON shards in a new inactive root."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    from server.app.repositories.storage_migration import migrate_storage

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = migrate_storage(args.source, args.destination, ROOT / "data/default-dataset.json")
    except Exception as error:
        print(json.dumps({"error": getattr(error, "code", type(error).__name__), "message": str(error),
                          "activated": False, "sourceModifiedByMigration": False,
                          "note": "An incomplete destination is retained for inspection and cannot start. A source needing journal recovery must be recovered separately before migration."}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
