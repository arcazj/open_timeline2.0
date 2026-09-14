"""Build the source-path preview from verified current-build browser captures."""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / "docs/ui/local-source-paths"
OUTPUT = ROOT / "output/pdf/OpenBEXI_Local_Source_Paths.pdf"
PAGES = [
    ("fixtures/three-namespaces.png", "NAMESPACE: three selected paths",
     "Verified Python-backed test fixture: six records in three namespaces, translucent zones and a synchronized overview. "
     "Grouping uses each record's namespace. These are synthetic test records, not production March 18 data."),
    ("fixtures/combined-sources.png", "ALL: combined selected sources",
     "The same test fixture after deselecting SOURCE3. ALL combines SOURCE1 and SOURCE2 without separate namespace headers. "
     "Favorite paths remain available in the toolbar. Local server access does not require entering a bearer token."),
    ("fixtures/mobile-path-picker.png", "Server paths and favorites on mobile",
     "The browser selects approved source IDs; Python reads the corresponding paths. Checkboxes support multiple selections "
     "and stars add toolbar shortcuts. The temporary filesystem paths shown here belong to the isolated test server."),
    ("production/source2-detail.png", "Actual SOURCE2: March 18, 2024",
     "19:00-22:00 UTC, from an unmodified production-data export. This Local snapshot includes every record in its declared "
     "March 17-25 range, not the entire server archive. Production SOURCE1 has no March 18 sample records."),
    ("production/source1-detail.png", "Actual SOURCE1: March 24, 2024",
     "19:00-22:00 UTC. The source's legacy black background is retained. Vertical pages preserve readable labels and the "
     "broader overview; dense namespaces can span pages. No dates were shifted to populate additional lanes."),
]


def main():
    bundle = hashlib.sha256((ROOT / "dist/index.html").read_bytes()).hexdigest()
    focused = json.loads((ROOT / "artifacts/browser/local-paths-layout-fix-results.json").read_text(encoding="utf-8"))
    if (focused["config"]["metadata"]["standaloneBundleSha256"] != bundle
            or focused["errors"] or focused["stats"]["expected"] != 13
            or any(focused["stats"][key] for key in ("skipped", "unexpected", "flaky"))):
        raise ValueError("Focused browser captures are not verified for the current build.")
    production = json.loads((IMAGES / "production/verification.json").read_text(encoding="utf-8"))
    if production["htmlSha256"] != bundle or production["status"] != "passed" or production["errors"]:
        raise ValueError("Production captures are not verified for the current build.")
    fixtures = IMAGES / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=True)
    for filename, _, _ in PAGES:
        if filename.startswith("fixtures/"):
            matches = list((ROOT / "artifacts/browser/local-paths-layout-fix").glob("local-paths-*/" + Path(filename).name))
            if len(matches) != 1:
                raise ValueError(f"Expected one current fixture capture: {filename}")
            shutil.copyfile(matches[0], IMAGES / filename)
    (fixtures / "verification.json").write_text(json.dumps({
        "htmlSha256": bundle, "report": "artifacts/browser/local-paths-layout-fix-results.json",
        "status": "passed", "testData": "synthetic", "stats": focused["stats"],
    }, indent=2) + "\n", encoding="utf-8")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    width, height = landscape(A3)
    canvas = Canvas(str(OUTPUT), pagesize=(width, height), pageCompression=1)
    canvas.setTitle("OpenBEXI Timeline 2.0 - Local Server Paths")
    for number, (filename, title, caption) in enumerate(PAGES, 1):
        canvas.setFillColor(HexColor("#146653"))
        canvas.setFont("Helvetica", 10)
        canvas.drawString(30, height - 27, "OPENBEXI TIMELINE 2.0 / LOCAL SERVER PATHS")
        canvas.setFillColor(HexColor("#15252b"))
        canvas.setFont("Helvetica-Bold", 21)
        canvas.drawString(30, height - 56, title)
        lines, line = [], ""
        for word in caption.split():
            candidate = (line + " " + word).strip()
            if canvas.stringWidth(candidate, "Helvetica", 11) > width - 60:
                lines.append(line)
                line = word
            else:
                line = candidate
        lines.append(line)
        canvas.setFont("Helvetica", 11)
        for index, line in enumerate(lines):
            canvas.drawString(30, height - 78 - index * 15, line)
        image = ImageReader(str(IMAGES / filename))
        iw, ih = image.getSize()
        available_height = height - 165
        scale = min((width - 60) / iw, available_height / ih)
        w, h = iw * scale, ih * scale
        x, y = (width - w) / 2, 54 + (available_height - h) / 2
        canvas.drawImage(image, x, y, w, h)
        canvas.setStrokeColor(HexColor("#c8d4d8"))
        canvas.rect(x, y, w, h)
        canvas.setFillColor(HexColor("#445d68"))
        canvas.setFont("Helvetica", 9)
        canvas.drawString(30, 31, f"Build SHA-256: {bundle[:24]} | Setup and limitations: docs/local-source-paths.md")
        canvas.drawRightString(width - 30, 31, f"{number} / {len(PAGES)}")
        canvas.setFont("Helvetica", 8)
        canvas.drawString(30, 17, "Actual renderer captures, not mockups. Read-only legacy data. No complete release certification is claimed.")
        canvas.showPage()
    canvas.save()
    print(OUTPUT)


if __name__ == "__main__":
    main()
