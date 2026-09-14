"""Read legacy folders and produce a NEW read-only snapshot, never legacy write-back."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.app.models.domain import DomainError, json_bytes
from server.app.services.legacy_reader import LegacyLimits, LegacyReader, LegacySource, safe_read


def apply_presentation_to_validated_scan(result, adapted):
    """The reader validated records already; presentation changes metadata only."""
    from server.app.services.legacy_presentation import apply_legacy_presentation
    records = result.snapshot["records"]
    metadata = {key: copy.deepcopy(value) for key, value in result.snapshot.items() if key != "records"}
    metadata["records"] = []
    metadata["manifest"]["recordCount"] = 0
    snapshot = apply_legacy_presentation(metadata, adapted)
    snapshot["records"] = records
    snapshot["manifest"]["recordCount"] = len(records)
    result.snapshot = snapshot
    result.report["presentationDiagnostics"] = copy.deepcopy(adapted["diagnostics"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--source", action="append", metavar="ID=ROOT")
    inputs.add_argument("--legacy-yaml", type=Path, help="Legacy YAML containing enabled JSON-file sources")
    parser.add_argument("--legacy-root", type=Path, help="Approved legacy project root for relative YAML paths")
    parser.add_argument("--model", type=Path, help="Legacy visual model inside --legacy-root (YAML mode only)")
    parser.add_argument("--namespace-grouping", action=argparse.BooleanOptionalAction, default=None,
                        help="Override the selected model's grouping with legacy record namespaces")
    parser.add_argument("--path-map", action="append", default=[], metavar="LEGACY_PREFIX=LOCAL_ROOT")
    parser.add_argument("--data-model", choices=("yyyy", "yyyy/mm", "yyyy/mm/dd"),
                        help="Calendar partition suffix for explicit --source roots")
    parser.add_argument("--allow-root", action="append", required=True)
    parser.add_argument("--timezone", help="Explicit IANA zone for offset-free legacy dates")
    parser.add_argument("--dialect", choices=("strict", "legacy-json"), default="strict")
    parser.add_argument("--abbreviation", action="append", default=[], metavar="NAME=OFFSET_MINUTES")
    parser.add_argument("--from", dest="start")
    parser.add_argument("--to", dest="end")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--max-seconds", type=float, default=180)
    parser.add_argument("--max-records", type=int, default=250000)
    args = parser.parse_args()
    if bool(args.start) != bool(args.end):
        parser.error("--from and --to must be provided together")
    if args.legacy_yaml and not args.legacy_root:
        parser.error("--legacy-yaml requires --legacy-root")
    if args.model and not args.legacy_yaml:
        parser.error("--model requires --legacy-yaml and --legacy-root")
    if args.namespace_grouping is not None and not args.model:
        parser.error("--namespace-grouping requires --model")
    if args.source and (args.legacy_root or args.path_map):
        parser.error("--legacy-root and --path-map require --legacy-yaml")
    if args.legacy_yaml and args.data_model:
        parser.error("YAML sources already define their data model")
    mappings = {}
    for value in args.path_map:
        prefix, separator, target = value.partition("=")
        if not separator or not prefix or not target or prefix in mappings:
            parser.error("--path-map requires a unique LEGACY_PREFIX=LOCAL_ROOT")
        mappings[prefix] = target
    abbreviations = {}
    for value in args.abbreviation:
        name, separator, offset = value.partition("=")
        try:
            minutes = int(offset)
        except ValueError:
            parser.error("--abbreviation requires NAME=OFFSET_MINUTES")
        if not separator or not name or not -1439 <= minutes <= 1439 or name in abbreviations:
            parser.error("--abbreviation requires a unique name and offset between -1439 and 1439 minutes")
        abbreviations[name] = minutes
    sources = []
    configuration = None
    if args.legacy_yaml:
        from server.app.services.legacy_sources import load_legacy_sources
        configuration = load_legacy_sources(args.legacy_yaml, legacy_root=args.legacy_root,
                                            allow_roots=args.allow_root, path_maps=mappings,
                                            timezone=args.timezone or "UTC", dialect=args.dialect)
        if any(item.get("severity") == "error" for item in configuration.diagnostics):
            raise DomainError("legacy_configuration", "Enabled legacy sources have unsupported or unavailable configuration; no snapshot was exported.")
        sources = [replace(source, abbreviations=abbreviations) for source in configuration.sources]
    for value in args.source or []:
        identity, separator, root = value.partition("=")
        if not separator:
            parser.error("--source requires ID=ROOT")
        sources.append(LegacySource(identity, Path(root), timezone=args.timezone, dialect=args.dialect,
                                    abbreviations=abbreviations, data_model=args.data_model))
    if args.output and args.report and args.output.resolve() == args.report.resolve():
        parser.error("Snapshot and report output paths must differ")
    for output in (args.output, args.report):
        if output is None:
            continue
        target = output.resolve()
        if target.exists():
            parser.error("Output files must be new; refusing to overwrite an existing file")
        if any(target == Path(root).resolve() or target.is_relative_to(Path(root).resolve()) for root in args.allow_root):
            parser.error("Output must be outside all allowlisted legacy source roots")
    reader = LegacyReader(sources, allow_roots=args.allow_root,
                          limits=LegacyLimits(max_seconds=args.max_seconds, max_records=args.max_records))
    result = reader.scan(time_range={"from": args.start, "to": args.end} if args.start else None)
    if configuration is not None:
        result.report["configuration"] = configuration.metadata()
        result.snapshot["manifest"]["legacy"]["configuration"] = configuration.metadata()
    if args.model and result.report["status"] != "incomplete":
        from server.app.services.legacy_json import parse_legacy_json
        from server.app.services.legacy_presentation import adapt_legacy_presentation
        legacy_root = args.legacy_root.resolve()
        model_path = args.model if args.model.is_absolute() else legacy_root / args.model
        model, _ = parse_legacy_json(safe_read(model_path, legacy_root, 1024 * 1024), "strict")
        adapted = adapt_legacy_presentation(model, source_bindings=configuration.render_sources,
                                            namespace_grouping=args.namespace_grouping)
        apply_presentation_to_validated_scan(result, adapted)
    for output, value in ((args.output, result.snapshot), (args.report, result.report)):
        if output is not None:
            if output == args.output and result.report["status"] == "incomplete":
                continue
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("xb") as handle:
                handle.write(json_bytes(value))
    summary = {key: value for key, value in result.report.items() if key not in ("inventory", "diagnostics", "configurationFiles")}
    summary["snapshotBytes"] = len(json_bytes(result.snapshot))
    summary["snapshotExported"] = bool(args.output and result.report["status"] != "incomplete")
    print(json.dumps(summary, indent=2))
    return 2 if result.report["status"] == "incomplete" else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except DomainError as error:
        print(json.dumps({"code": error.code, "message": error.message}), file=sys.stderr)
        raise SystemExit(1)
