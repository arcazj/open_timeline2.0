"""Repeatable, offline conversion of the bundled historical timeline fixtures."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
import uuid
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.app.models.domain import DomainError, instant_ms, iso_from_ms, validate_snapshot  # noqa: E402
from server.app.services.legacy_json import legacy_instant, parse_legacy_json  # noqa: E402
from server.app.models.model_catalog import normalize_metadata, DEFINITION_FIELDS  # noqa: E402

STAMP = "2026-09-13T00:00:00.000Z"
IDS = ("default-dataset", "ephemeris", "jfk", "monet", "religions", "space_exploration")


class EventParser(HTMLParser):
    """The archived event markup permits HTML inside events, not well-formed XML."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.events, self.current, self.parts, self.ignored = [], None, [], 0

    def handle_starttag(self, tag, attrs):
        if tag == "event":
            if self.current is not None:
                raise ValueError("Nested/unclosed event")
            keys = [key for key, _ in attrs]
            if len(set(keys)) != len(keys):
                raise ValueError("Duplicate event attribute")
            self.current, self.parts = dict(attrs), []
        elif tag in ("script", "style"):
            self.ignored += 1
        elif tag in ("br", "p", "li") and self.current is not None:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.ignored = max(0, self.ignored - 1)
        elif tag == "event":
            if self.current is None:
                raise ValueError("Unexpected closing event")
            self.events.append({**self.current, "description": " ".join("".join(self.parts).split())})
            self.current = None

    def handle_data(self, data):
        if self.current is not None and not self.ignored:
            self.parts.append(data)


def parse_events(raw):
    text = raw.decode("utf-8-sig")
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.I):
        raise ValueError("DTD and entity declarations are not supported")
    parser = EventParser()
    parser.feed(text)
    parser.close()
    if parser.current is not None:
        raise ValueError("Unclosed final event")
    return parser.events


def date(value):
    text = str(value).strip()
    if re.fullmatch(r"\d{1,4}\?", text):
        text = text[:-1]
    match = re.fullmatch(r"(\d{1,4})(?:\s*(BC|BCE|AD|CE))?", text, re.I)
    if match:
        year = int(match[1])
        if match[2] and match[2].upper() in ("BC", "BCE"):
            if year == 0:
                raise ValueError("There is no historical year 0 BC")
            year = 1 - year
        prefix = f"{year:04d}" if year >= 0 else f"-{abs(year):06d}"
        return iso_from_ms(instant_ms(f"{prefix}-01-01T00:00:00.000Z"))
    # Older event markup omits the weekday that the Java-style parser expects.
    if re.fullmatch(r"[A-Z][a-z]{2} \d{1,2} \d{4}", text):
        text += " 00:00:00 GMT"
    short_year = re.fullmatch(r"(.+ \d{2}:\d{2}:\d{2} (?:EST|EDT|UTC|GMT) )(\d{1,3})", text)
    if short_year:
        text = short_year[1] + short_year[2].zfill(4)
    if re.match(r"^[A-Z][a-z]{2} \d{1,2} \d{4} ", text):
        text = "Mon " + text
    try:
        return legacy_instant(text, default_timezone="UTC", abbreviations={"EST": -300, "EDT": -240})
    except (ValueError, DomainError) as error:
        raise ValueError(f"Unsupported source date {value!r}") from error


def identity(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "openbexi:test-data:" + name))


def normalize_record(item, dataset, index, markup, source):
    original = copy.deepcopy(item)
    title = item.get("title") or item.get("data", {}).get("title") or item.get("text")
    if not title:
        title = f"Untitled source event {index + 1}"
    start = date(item["start"])
    duration = str(item.get("isduration", item.get("isDuration", ""))).lower() == "true" if markup else bool(item.get("end"))
    end = date(item["end"]) if item.get("end") and duration else None
    data = item.get("data", {})
    if not isinstance(data, dict):
        raise ValueError("Event data must be an object")
    color = item.get("color") or item.get("render", {}).get("color") or ("#00aa00" if "green-circle" in item.get("icon", "") else "#658fe3" if duration else "#7464cf")
    color = {"red": "#ff0000", "green": "#008000", "blue": "#0000ff", "black": "#000000"}.get(color.lower(), color)
    if re.fullmatch(r"#[0-9a-fA-F]{3}", color):
        color = "#" + "".join(char * 2 for char in color[1:])
    uncertainty = {key: date(item[key]) for key in ("lateststart", "earliestend") if item.get(key)}
    if markup and item.get("end") and not duration:
        uncertainty["lateststart"] = date(item["end"])
    if any(str(item.get(key, "")).endswith("?") for key in ("start", "end")):
        uncertainty["approximateYear"] = True
    record = {
        "id": identity(f"{dataset}:{index}:{item.get('id', '')}"), "workspaceId": "default",
        "kind": "session" if duration else "event", "title": title, "start": start, "end": end,
        "parentSessionId": None, "order": index, "sourceId": source, "groupIds": [], "tags": [],
        "data": {"description": item.get("description", data.get("description", ""))},
        "render": {"color": color},
        "extensions": {"sourceRecord": original, "uncertainty": uncertainty},
        "schemaId": None, "schemaVersion": None, "originalStart": None, "originalEnd": None,
        "version": 1, "createdAt": STAMP, "updatedAt": STAMP, "createdBy": "fixture-converter", "updatedBy": "fixture-converter", "deletedAt": None,
    }
    return record


def convert(dataset, profile, *, check=False):
    folder = ROOT / "data"
    archived = folder / "original" / f"{dataset}.json"
    if not archived.is_file():
        raise ValueError(f"Missing preserved input: {archived}")
    raw = archived.read_bytes()
    markup = raw.lstrip().startswith(b"<")
    diagnostics = []
    if markup:
        items = parse_events(raw)
    else:
        parsed, diagnostics = parse_legacy_json(raw, "legacy-json")
        if any(entry["code"] == "legacy_duplicate_members" for entry in diagnostics):
            raise ValueError("Duplicate JSON keys require an explicit repair before conversion")
        items = parsed.get("events", parsed.get("records"))
        if not isinstance(items, list):
            raise ValueError("Expected events or records array")
    if dataset == "default-dataset":
        snapshot = parsed
    else:
        template = json.loads((folder / "original" / "default-dataset.json").read_text(encoding="utf-8"))
        snapshot = {key: copy.deepcopy(value) for key, value in template.items() if key not in ("records", "zones")}
        records, source = [], dataset
        if dataset == "religions":
            source = "christianity"
        for index, item in enumerate(items):
            if dataset == "religions" and item.get("title") == "Canonicalization of Tanakh":
                source = "judaism"
            records.append(normalize_record(item, dataset, index, markup, source))
        if dataset == "religions" and source != "judaism":
            raise ValueError("The explicit namespace section boundary was not found")
        snapshot.update(records=records, zones=profile.get("zones", []))
        snapshot["manifest"].update(bundleId=identity(dataset), generation=identity(dataset + hashlib.sha256(raw).hexdigest()),
                                    snapshotAt=STAMP, sourceName=profile["title"], sourceKind="imported", recordCount=len(records),
                                    scope={"workspaceId": "default", "sourceIds": sorted({record["sourceId"] for record in records})})
        snapshot["settings"] = {**template["settings"], **profile["settings"]}
        for model in snapshot["models"]:
            model.update(fontSize=11, groupBy="none")
    # Test fixtures are complete local sources. Opening them explicitly never edits the originals.
    snapshot["manifest"]["testDataset"] = {"id": dataset, "reference": profile.get("reference"), "referenceStatus": "provided" if profile.get("reference") else "unapproved-baseline"}
    if dataset != "default-dataset":
        snapshot["manifest"]["legacy"] = {"readOnly": True, "status": "current", "allRecordCount": len(items)}
        metadata = normalize_metadata({key: value for key, value in snapshot.items() if key != "records"})
        snapshot.update(metadata)
        reference = next(model for model in snapshot["models"] if model["id"] == snapshot["settings"]["modelId"])
        reference["name"] = profile["title"] + " reference"
        definition = reference["versions"][0]["definition"]
        definition.update({key: value for key, value in snapshot["settings"].items() if key in DEFINITION_FIELDS or key == "presentation"})
    records = snapshot["records"]
    assets = sorted({str(item[key]) for item in items for key in ("image", "icon") if item.get(key)})
    report = {"id": dataset, "inputFormat": "html-event-markup" if markup else "json", "inputSha256": hashlib.sha256(raw).hexdigest(),
              "inputRecords": len(items), "outputRecords": len(records), "droppedRecords": 0,
              "datePolicy": "Proleptic Gregorian; 1 BC = astronomical 0000; year-only = January 1 UTC; explicit EST=-05:00/EDT=-04:00; trailing ? retained as approximateYear with nominal year position",
              "sourceAssignment": "Section beginning at Canonicalization of Tanakh is judaism; preceding section is christianity" if dataset == "religions" else dataset,
              "diagnostics": diagnostics, "unbundledOriginalAssets": assets,
              "uncertainRecords": sum(bool(record["extensions"].get("uncertainty")) for record in records),
              "generatedTitles": [{"recordId": record["id"], "title": record["title"]} for record in records if record["title"].startswith("Untitled source event ")],
              "dateReview": [{"recordId": record["id"], "title": record["title"], "start": record["start"], "reason": "Literal source year retained; possible source typo"} for record in records if dataset == "space_exploration" and instant_ms(record["start"]) < instant_ms("1800-01-01T00:00:00.000Z")],
              "referenceStatus": snapshot["manifest"]["testDataset"]["referenceStatus"],
              "domain": {"from": min((record["start"] for record in records), key=instant_ms), "to": max((record["end"] or record["start"] for record in records), key=instant_ms)}}
    validate_snapshot(snapshot)
    for target, value in ((folder / f"{dataset}.json", snapshot), (folder / "reports" / f"{dataset}.json", report)):
        encoded = json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True) + "\n"
        if check:
            if not target.exists() or target.read_text(encoding="utf-8") != encoded:
                raise ValueError(f"Generated fixture is out of date: {target}")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(encoded, encoding="utf-8")
    print(f"{dataset}: {len(items)} input / {len(records)} output; {report['uncertainRecords']} uncertain; {report['referenceStatus']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    catalog = json.loads((ROOT / "data/catalog.json").read_text(encoding="utf-8"))
    for profile in catalog["datasets"]:
        convert(profile["id"], profile, check=args.check)
