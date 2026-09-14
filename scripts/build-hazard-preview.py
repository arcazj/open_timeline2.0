"""Create the hazard comparison PDF from verified, current-build captures."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output/pdf/OpenBEXI_Hazard_Comparison.pdf"
PAGES = [
    ("output/hazard-parity/legacy/legacy-hazard-initial.png", "Original renderer reference",
     "Original earthquake HTML, JavaScript and assets at 12 September 2026, 12:00-16:00 UTC. "
     "Read-only request-fixture comparison, not a running Java backend. This initial legacy view has its overview hidden."),
    ("docs/ui/hazards/current-server/legacy-namespace-desktop.png", "Current Python-backed timeline",
     "The same four-hour interval contains 42 actual records from the earthquake and volcano sources. "
     "Colored hazard icons, measured labels and quarter-hour grid divisions appear above a 383-record overview."),
    ("docs/ui/hazards/current-local/legacy-search.png", "Standalone search and overview",
     "The offline snapshot includes all 383 records in its declared two-day range, not the entire server archive. "
     "Kilauea is highlighted in yellow; only its finding remains in the overview. Other main-band records retain context."),
    ("docs/ui/hazards/current-server/legacy-descriptor.png", "Selection and read-only descriptor",
     "Selecting an actual event opens its descriptor beside the timeline. Source JSON remains unchanged, "
     "and write controls are disabled. Label layout is recalculated for the available width."),
    ("docs/ui/hazards/current-local/legacy-namespace-mobile.png", "Mobile standalone view",
     "The same embedded JavaScript, font subsets and hazard images operate without HTTP or Python. "
     "Vertical row pages keep the selected interval and overview visible; the complete chosen snapshot remains browseable."),
]


def main():
    bundle_hash = hashlib.sha256((ROOT / "dist/index.html").read_bytes()).hexdigest()
    for mode in ("current-server", "current-local"):
        report = json.loads((ROOT / f"docs/ui/hazards/{mode}/verification.json").read_text(encoding="utf-8"))
        if report.get("status") != "passed" or report.get("errors"):
            raise ValueError(f"Unverified capture: {mode}")
        if any(report.get(key) != bundle_hash for key in ("standaloneBundleSha256", "loadedBundleSha256")):
            raise ValueError(f"Outdated capture: {mode}")
    parity = json.loads((ROOT / "output/hazard-parity/data-verification.json").read_text(encoding="utf-8"))
    if parity.get("status") != "passed" or parity.get("buildSha256") != bundle_hash:
        raise ValueError("Data parity has not passed for this build")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    width, height = landscape(A3)
    canvas = Canvas(str(OUTPUT), pagesize=(width, height), pageCompression=1)
    canvas.setTitle("OpenBEXI Timeline 2.0 - Hazard Rendering Comparison")
    for number, (filename, title, caption) in enumerate(PAGES, 1):
        canvas.setFillColor(HexColor("#146653"))
        canvas.setFont("Helvetica", 10)
        canvas.drawString(30, height - 27, "OPENBEXI TIMELINE 2.0 / READ-ONLY HAZARD COMPARISON")
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
        image = ImageReader(str(ROOT / filename))
        source_width, source_height = image.getSize()
        available_height = height - 165
        scale = min((width - 60) / source_width, available_height / source_height)
        w, h = source_width * scale, source_height * scale
        x, y = (width - w) / 2, 54 + (available_height - h) / 2
        canvas.drawImage(image, x, y, w, h)
        canvas.setStrokeColor(HexColor("#c8d4d8"))
        canvas.rect(x, y, w, h)
        canvas.setFillColor(HexColor("#445d68"))
        canvas.setFont("Helvetica", 9)
        canvas.drawString(30, 31, f"Current build SHA-256: {bundle_hash[:24]} | Reference and limitations: docs/hazard-rendering-parity.md")
        canvas.drawRightString(width - 30, 31, f"{number} / {len(PAGES)}")
        canvas.setFont("Helvetica", 8)
        canvas.drawString(30, 17, "Actual renderer captures, not mockups. No exact pixel equivalence or complete release certification is claimed.")
        canvas.showPage()
    canvas.save()
    print(OUTPUT)


if __name__ == "__main__":
    main()
