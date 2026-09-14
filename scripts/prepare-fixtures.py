"""Regenerate deterministic example data and font/search conformance assets."""
from pathlib import Path
from datetime import datetime, timedelta, timezone
from uuid import uuid5, NAMESPACE_URL
import hashlib
import json
import shutil

from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "shared/fixtures"
ASSETS = ROOT / "client/assets"
FONT = ROOT / "node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def uid(name):
    return str(uuid5(NAMESPACE_URL, f"https://openbexi.local/initial/{name}"))


def instant(minutes):
    return (datetime(2026, 9, 12, tzinfo=timezone.utc) + timedelta(minutes=minutes)).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")


def main():
    FIXTURES.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(FONT, ASSETS / "noto-sans-latin-400-normal.woff")
    shutil.copyfile(ROOT / "node_modules/@fontsource/noto-sans/LICENSE", ASSETS / "FONT-LICENSE.txt")
    font = TTFont(FONT)
    glyph_set = font.getGlyphSet()
    glyphs = {}
    for code, name in font.getBestCmap().items():
        pen = BoundsPen(glyph_set)
        glyph_set[name].draw(pen)
        x0, y0, x1, y1 = pen.bounds or (0, 0, 0, 0)
        glyphs[str(code)] = dict(advance=font["hmtx"][name][0], xMin=x0, xMax=x1, yMin=y0, yMax=y1)
    write_json(FIXTURES / "font-metrics.json", {
        "profileId": "noto-sans-latin-v1", "fontFamily": "Noto Sans",
        "unitsPerEm": font["head"].unitsPerEm, "ascent": font["hhea"].ascent,
        "descent": font["hhea"].descent, "glyphs": glyphs,
        "fontSha256": hashlib.sha256(FONT.read_bytes()).hexdigest(),
    })
    folding = {}
    for line in (FIXTURES / "CaseFolding-15.1.0.txt").read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        code, status, mapped, *_ = (part.strip() for part in line.split(";"))
        if status in ("C", "F"):
            folding[str(int(code, 16))] = "".join(chr(int(part, 16)) for part in mapped.split())
    write_json(FIXTURES / "casefold.json", folding)

    reference = json.loads((ROOT / "docs/ui/v2.4/design-fixture.json").read_text(encoding="utf-8"))
    records = []
    for index, item in enumerate(reference["records"]):
        records.append({
            "id": uid(item["id"]), "workspaceId": "default", "kind": item["kind"],
            "title": item["title"], "start": instant(item["start"]),
            "end": instant(item["end"]) if item["end"] is not None else None,
            "parentSessionId": None, "order": index, "sourceId": "operations" if index % 3 else "verification",
            "groupIds": [], "tags": ["sample"], "data": {"status": "Nominal", "description": "Generic operational sample record."},
            "render": {"color": item["color"]}, "extensions": {"alias": item["id"]},
            "schemaId": None, "schemaVersion": None, "originalStart": None, "originalEnd": None,
            "version": 1, "createdAt": instant(0), "updatedAt": instant(0),
            "createdBy": "sample", "updatedBy": "sample", "deletedAt": None,
        })
    zones = [{**z, "id": uid(z["id"]), "start": instant(z["start"]), "end": instant(z["end"])} for z in reference["zones"]]
    models = [
        {"id": "light", "name": "Light timeline", "theme": "light", "version": 1, "rowHeight": 32, "fontSize": 13, "groupBy": "none"},
        {"id": "classic", "name": "Classic blue", "theme": "classic", "version": 1, "rowHeight": 32, "fontSize": 13, "groupBy": "kind"},
        {"id": "dark", "name": "Dark timeline", "theme": "dark", "version": 1, "rowHeight": 32, "fontSize": 13, "groupBy": "sourceId"},
    ]
    snapshot = {
        "format": "timeline-snapshot", "formatVersion": 1,
        "manifest": {"bundleId": uid("bundle"), "workspaceId": "default", "generation": uid("generation"),
                     "revision": 1, "snapshotAt": instant(0), "sourceName": "Operations sample", "sourceKind": "sample",
                     "completeness": "complete-for-declared-universe", "recordCount": len(records),
                     "scope": {"workspaceId": "default", "sourceIds": ["operations", "verification"]}},
        "records": records, "zones": zones, "models": models, "filters": [],
        "settings": {"range": {"from": instant(480), "to": instant(1020)},
                     "overview": {"from": instant(0), "to": instant(1440)}, "referenceTime": instant(750),
                     "modelId": "light", "scaleMode": "uniform", "ratio": 4, "bins": 128},
    }
    # Runtime datasets are owned by normalize-test-data.py; this is a test fixture.
    write_json(FIXTURES / "initial-snapshot.json", snapshot)
    print(f"Prepared {len(records)} records, {len(glyphs)} glyph metrics, {len(folding)} case-fold mappings.")


if __name__ == "__main__":
    main()
