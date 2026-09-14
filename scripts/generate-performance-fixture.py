"""Generate a complete, validated performance fixture without modifying application data."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.performance_fixture import TIERS, build_snapshot, fixture_summary  # noqa: E402
from server.app.models.domain import json_bytes  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", choices=TIERS, default="typical")
    parser.add_argument("--output", type=Path, required=True, help="New directory below artifacts/performance/fixtures")
    args = parser.parse_args()
    output = args.output.resolve()
    allowed = (ROOT / "artifacts/performance/fixtures").resolve()
    if output == allowed or not output.is_relative_to(allowed) or output.exists():
        parser.error("Output must be a new child directory below artifacts/performance/fixtures")
    bundle = build_snapshot(args.tier)
    report = fixture_summary(bundle, args.tier)
    if report["averageRecordBytes"] > 2048:
        raise ValueError("Fixture exceeds the specified average serialized record size")
    output.mkdir(parents=True, exist_ok=False)
    with (output / "snapshot.json").open("xb") as stream:
        stream.write(json_bytes(bundle))
    with (output / "manifest.json").open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
        stream.write("\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
