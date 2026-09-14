"""Build a screenshot PDF from successful real-browser legacy captures."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas


ROOT = Path(__file__).resolve().parents[1]
CAPTURES = ROOT / "docs/ui/legacy"
OUTPUT = ROOT / "output/pdf/OpenBEXI_Legacy_JSON_Preview.pdf"
PAGES = [
    ("production-source1", "legacy-namespace-desktop", "Date-partitioned server archive",
     "Actual C:/data/SOURCES1 JSON, loaded through the legacy YAML and namespace model. "
     "The main timeline and broader overview share one pinned query; row pages do not change its time map."),
    ("authored-test-source1", "legacy-search", "Search and matching overview",
     "Actual legacy test SOURCE1 data, exported for 18 March 2024, 19:00-21:00 UTC. "
     "The selected row page contains the yellow 5_1 and 0_3 findings; the overview contains only search matches."),
    ("production-source1", "legacy-descriptor", "Selection and descriptor",
     "The selected session retains its start, end and namespace. The descriptor stays beside the timeline; "
     "record edits are disabled for the linked read-only authority."),
    ("production-source1", "legacy-namespace-mobile", "Mobile timeline",
     "The same JavaScript/Three.js application at a mobile viewport. "
     "The overview and vertical-page controls remain available; the page does not expand to fit the archive."),
]


def main():
    verified = []
    bundle_hash = hashlib.sha256((ROOT / "dist/index.html").read_bytes()).hexdigest()
    for directory, name, title, caption in PAGES:
        report = json.loads((CAPTURES / directory / "verification.json").read_text(encoding="utf-8"))
        if report.get("status") != "passed" or report.get("errors"):
            raise ValueError(f"Capture verification has not passed: {directory}")
        if any(report.get(key) != bundle_hash for key in ("standaloneBundleSha256", "loadedBundleSha256")):
            raise ValueError(f"Capture does not match the current standalone build: {directory}")
        observation = next(item for item in report["observations"] if item["name"] == name)
        if observation.get("overlaps") or observation.get("horizontalOverflow"):
            raise ValueError(f"Capture has a layout defect: {name}")
        path = CAPTURES / directory / (name + ".png")
        verified.append((path, title, caption, report["capturedAt"], observation))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    width, height = landscape(A3)
    canvas = Canvas(str(OUTPUT), pagesize=(width, height), pageCompression=1)
    canvas.setTitle("OpenBEXI Timeline 2.0 - Read-Only Legacy JSON Preview")
    canvas.setAuthor("OpenBEXI Timeline project")
    for number, (path, title, caption, captured, observation) in enumerate(verified, 1):
        canvas.setFillColor(HexColor("#146653"))
        canvas.setFont("Helvetica", 10)
        canvas.drawString(30, height - 27, "OPENBEXI TIMELINE 2.0 / LEGACY JSON VERIFICATION")
        canvas.setFillColor(HexColor("#15252b"))
        canvas.setFont("Helvetica-Bold", 21)
        canvas.drawString(30, height - 55, title)
        canvas.setFont("Helvetica", 11)
        words, line, lines = caption.split(), "", []
        for word in words:
            candidate = (line + " " + word).strip()
            if canvas.stringWidth(candidate, "Helvetica", 11) > width - 60:
                lines.append(line)
                line = word
            else:
                line = candidate
        lines.append(line)
        for index, line in enumerate(lines):
            canvas.drawString(30, height - 77 - index * 15, line)
        image = ImageReader(str(path))
        source_width, source_height = image.getSize()
        available_height = height - 155
        scale = min((width - 60) / source_width, available_height / source_height)
        draw_width, draw_height = source_width * scale, source_height * scale
        x = (width - draw_width) / 2
        y = 51 + (available_height - draw_height) / 2
        canvas.drawImage(image, x, y, draw_width, draw_height)
        canvas.setStrokeColor(HexColor("#c8d4d8"))
        canvas.rect(x, y, draw_width, draw_height, stroke=1, fill=0)
        canvas.setFillColor(HexColor("#445d68"))
        canvas.setFont("Helvetica", 9)
        canvas.drawString(30, 31, f"Captured {captured} | SHA-256 {hashlib.sha256(path.read_bytes()).hexdigest()[:16]}")
        canvas.drawRightString(width - 30, 31, f"{number} / {len(verified)}")
        canvas.setFont("Helvetica", 8)
        canvas.drawString(30, 17, "Actual application captures, not design mockups. No exact historical screenshot equivalence is claimed. See docs/legacy-json-preview.md.")
        canvas.showPage()
    canvas.save()
    print(OUTPUT)


if __name__ == "__main__":
    main()
