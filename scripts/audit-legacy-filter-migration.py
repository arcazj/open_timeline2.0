"""Read-only inventory and fail-closed migration dry-run of local legacy presets."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.app.models.domain import DomainError, parse_json  # noqa: E402
from server.app.services.filters import FIELD_TYPES  # noqa: E402
from server.app.services.legacy_filter_migration import migrate_legacy_filter  # noqa: E402
from server.app.services.legacy_reader import safe_read  # noqa: E402
from server.app.services.legacy_sources import _SourceLoader, _guard_path  # noqa: E402


def audit(legacy_root):
    legacy_root = _guard_path(Path(legacy_root).absolute())
    candidates = sorted({*legacy_root.glob("filters/*.json"), *legacy_root.glob("yaml/*.yml"), *legacy_root.glob("yaml/*.yaml"), *legacy_root.glob("tests/yaml/*.yml")})
    fields = {**FIELD_TYPES, "/data/namespace": "string"}
    files, entries = [], []
    for path in candidates:
        relative = path.relative_to(legacy_root).as_posix()
        raw = safe_read(_guard_path(path), legacy_root, 2 * 1024 * 1024)
        digest = hashlib.sha256(raw).hexdigest()
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError(f"Configuration exceeds the 2 MiB audit bound: {relative}")
        record = {"path": relative, "sha256": digest, "entries": 0, "status": "inspected"}

        def entry(pointer, name, include, exclude, sort_by, shape):
            result = migrate_legacy_filter({"include": include, "exclude": exclude, "sortBy": sort_by}, field_types=fields)
            entries.append({"file": relative, "pointer": pointer, "name": name, "legacyShape": shape,
                            "originalSha256": digest, "original": {"include": include, "exclude": exclude, "sortBy": sort_by},
                            "fieldRegistry": "legacy-metadata-v1", "result": result})
            record["entries"] += 1

        def source_filters(sources, pointer):
            if not isinstance(sources, list):
                return
            for index, source in enumerate(sources):
                if not isinstance(source, dict) or "filter" not in source:
                    continue
                value = source["filter"]
                if isinstance(value, dict):
                    entry(f"{pointer}/{index}/filter", source.get("namespace", f"source-{index}"), value.get("include", ""), value.get("exclude", ""), "NONE", "source-include-exclude")
                else:
                    entry(f"{pointer}/{index}/filter", f"source-{index}", value, "", "NONE", "unsupported-source-filter")

        try:
            value = parse_json(raw) if path.suffix == ".json" else yaml.load(raw.decode("utf-8-sig"), Loader=_SourceLoader)
            if isinstance(value, dict):
                source_filters(value.get("data_sources"), "/data_sources")
                for index, timeline in enumerate(value.get("openbexi_timeline", [])):
                    pointer = f"/openbexi_timeline/{index}"
                    source_filters(timeline.get("sources"), pointer + "/sources")
                    for number, preset in enumerate(timeline.get("filters", [])):
                        entry(f"{pointer}/filters/{number}", preset.get("name", f"filter-{number}"), preset.get("filter_value", ""), "", preset.get("sortBy", timeline.get("sortBy", "NONE")), "unsplit-client-filter-value")
            if not record["entries"]:
                record["status"] = "no-filter-entries"
        except (DomainError, ValueError, TypeError, AttributeError, yaml.YAMLError) as error:
            record.update(status="parse-blocked", diagnostic=str(error)[:512])
        record["unchanged"] = hashlib.sha256(safe_read(path, legacy_root, 2 * 1024 * 1024)).hexdigest() == digest
        if not record["unchanged"]:
            raise RuntimeError(f"Legacy configuration changed during audit: {relative}")
        files.append(record)
    models = []
    for path in sorted({*legacy_root.glob("models/*.json"), *legacy_root.glob("tests/models/*.json")}):
        raw = safe_read(_guard_path(path), legacy_root, 2 * 1024 * 1024)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("Model exceeds the audit bound")
        models.append({"path": path.relative_to(legacy_root).as_posix(), "sha256": hashlib.sha256(raw).hexdigest(),
                       "fieldRegistry": "legacy-metadata-v1", "rule": "Rendering models do not declare additional filter field types; require published schema pins for custom fields."})
    return {"format": "openbexi-legacy-migration-ledger-v1", "scope": "Local filters/*.json, yaml/*.{yml,yaml}, tests/yaml/*.yml; no records, descriptors or remote connectors opened.",
            "method": "Structured parsing only; bounded RE2 compilation, never evaluation of legacy patterns against records; no acknowledgements or publications performed.",
            "files": files, "fieldRegistries": {"legacy-metadata-v1": fields}, "modelRegistries": models, "entries": entries,
            "summary": {"files": len(files), "entries": len(entries), "classifications": dict(Counter(item["result"]["classification"] for item in entries)),
                        "diagnostics": dict(Counter(issue["code"] for item in entries for issue in item["result"]["diagnostics"])), "allFilesUnchanged": all(item["unchanged"] for item in files)},
            "limitations": ["Empty predicates can be exact translations without qualifying their connector, source data or rendering.",
                            "Client filter_value is never guessed apart at a pipe; ambiguity is blocked for explicit review.",
                            "Grouping encounter-order changes require acknowledgement; naming a preset BY_NAMESPACE does not override its actual sortBy value.",
                            "Custom model fields are not inferred from labels or sample data.",
                            "No user approval, saved preset publication, full source equivalence test or performance claim is implied."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-root", type=Path, default=Path("C:/projects/openbexi_timeline"))
    parser.add_argument("--output", type=Path, default=ROOT / "docs/sorting-filtering/legacy-migration-ledger.json")
    arguments = parser.parse_args()
    result = audit(arguments.legacy_root)
    target = _guard_path(arguments.output.absolute())
    legacy_root = _guard_path(arguments.legacy_root.absolute())
    if target == legacy_root or target.is_relative_to(legacy_root):
        raise ValueError("Audit output must not be inside legacy authorities")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result["summary"], indent=2))


if __name__ == "__main__":
    main()
