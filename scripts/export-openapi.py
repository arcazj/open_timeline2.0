"""Generate or verify the checked-in implemented API contract without opening a store."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.app.api.openapi import build_contract  # noqa: E402
from server.app.main import create_app  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "shared" / "openapi.json")
    args = parser.parse_args()
    app = create_app(token="contract-generation-only-not-a-runtime-credential")
    content = json.dumps(build_contract(app), ensure_ascii=True, indent=2, sort_keys=True) + "\n"
    if args.check:
        if not args.output.exists() or args.output.read_text(encoding="utf-8") != content:
            raise SystemExit("OpenAPI artifact is stale: run python scripts/export-openapi.py")
        print("OpenAPI artifact matches registered handlers and shared schemas.")
    else:
        args.output.write_text(content, encoding="utf-8", newline="\n")
        print(f"Generated {args.output.relative_to(ROOT) if args.output.is_relative_to(ROOT) else args.output}")


if __name__ == "__main__":
    main()
