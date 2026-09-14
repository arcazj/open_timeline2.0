"""Curate real Playwright captures into a Markdown/PDF implementation preview."""

import hashlib
import json
import shutil
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
CAPTURES = [
    ("standalone-desktop.png", "Standalone timeline", "The complete embedded sample, two synchronized bands, measured rows and aligned zones."),
    ("search-findings.png", "Contextual search", "Matching labels are highlighted; the overview shows all findings, not just the current row page."),
    ("adaptive-navigation.png", "Adaptive time scale", "Local magnification expands dense intervals while pagination handles excess simultaneous rows."),
    ("split-selection.png", "Selection and Split view", "The selected record has a right-side descriptor; timeline rows and table records have independent pagination."),
    ("server-connected.png", "Python-connected mode", "The same application reads and writes a JSON-only Python service through the common provider interface."),
    ("model-library.png", "Versioned model library", "Draft editing, immutable publication and explicit version selection keep the active workspace stable."),
    ("model-editor.png", "Model definition editor", "Structured fields and strict JSON share validation; portable definitions are separate from complete history exports."),
    ("model-preview.png", "Independent model preview", "The candidate model renders a separate read-only query without changing the active timeline or its temporal focus."),
    ("table-local.png", "Complete-query table", "Stable sorting and page traversal cover the complete chosen scope, independent of timeline row capacity."),
    ("filters-local.png", "Structured filters", "Typed nested conditions and explicit search modes use matching Local and Python query semantics."),
    ("configuration-filter-desktop.png", "Saved configuration", "Versioned saved filters, sources, groups, schemas and views share the configuration catalog."),
    ("configuration-typed-columns.png", "Schema-driven table columns", "Published schema types govern custom columns and available scalar sort operations."),
    ("record-time-adaptive.png", "Explicit time editing", "A captured record edit projects through the fixed Adaptive map and commits with its original version."),
    ("server-pinned-changes.png", "Pinned server browsing", "Committed-change notices leave the current rows, geometry, counts and overview unchanged until Reload."),
    ("presentation-desktop.png", "Model-driven presentation", "Measured multiline styles, icons, original-time baselines, nested sessions and configured descriptor fields."),
    ("presentation-preview.png", "Presentation preview", "Band colors, date formats and label geometry render before explicit publication and application."),
    ("standalone-mobile.png", "Narrow viewport", "The main and overview bands remain visible at 390 x 844 CSS pixels, with bounded row pagination."),
    ("model-mobile.png", "Model library on a narrow screen", "The same model catalog and editor remain available in the standalone application at a narrow viewport."),
    ("presentation-mobile.png", "Styled timeline on a narrow screen", "The same measured presentation and synchronized overview remain available directly from the standalone file."),
    ("configuration-mobile.png", "Configuration on a narrow screen", "Configuration authoring and validation remain available within the narrow dialog layout."),
    ("record-time-mobile.png", "Accessible time-edit form", "Exact dates can be edited without a pointer drag, with an explicit confirmation step."),
    ("server-live-updates.png", "Live server browsing", "A coherent refresh retains the time range and filters; the overview contains all current search findings."),
]


def main():
    result = json.loads((ROOT / "artifacts/browser/results.json").read_text("utf-8"))
    if result.get("errors") or not result["stats"]["expected"] or result["stats"]["unexpected"] or result["stats"]["skipped"] or result["stats"].get("flaky", 0):
        raise SystemExit("A complete passing browser run is required before publishing screenshots.")
    bundle = ROOT / "dist/index.html"
    digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    if result.get("config", {}).get("metadata", {}).get("standaloneBundleSha256") != digest:
        raise SystemExit("The browser report does not verify the current standalone bundle. Rebuild and rerun the full browser suite.")
    captures = {}
    for filename, _, _ in CAPTURES:
        matches = list((ROOT / "artifacts/browser/results").rglob(filename))
        if len(matches) != 1:
            raise SystemExit(f"Expected exactly one current screenshot: {filename}")
        ImageReader(str(matches[0])).getSize()
        captures[filename] = matches[0]
    target = ROOT / "docs/ui/implementation-preview"
    target.mkdir(parents=True, exist_ok=True)
    pdf = ROOT / "output/pdf/OpenBEXI_Timeline_Implementation_Preview.pdf"
    pdf.parent.mkdir(parents=True, exist_ok=True)
    width, height = landscape(A3)
    document = canvas.Canvas(str(pdf), pagesize=(width, height), pageCompression=1)
    document.setTitle("OpenBEXI Timeline 2.0 - Implementation Checkpoint Preview")
    document.setAuthor("OpenBEXI Timeline development workspace")
    run_date = result["stats"]["startTime"]
    markdown = [
        "# Actual Implementation Preview", "",
        "These are screenshots of the implemented application, captured by Playwright. They are not design mockups or a promise that the full modernization specification is complete.", "",
        f"Browser run: `{run_date}`. Passed browser cases: {result['stats']['expected']}.", "",
        f"Standalone bundle SHA-256: `{digest}`.", "",
        "The browser run used Windows and Microsoft Edge, a 1600 x 900 desktop viewport and a 390 x 844 narrow viewport. See [implementation status](implementation-status.md) and [testing](testing.md) for remaining features and certification gaps.", "",
        "[PDF preview](../output/pdf/OpenBEXI_Timeline_Implementation_Preview.pdf)", "",
    ]
    for index, (filename, title, caption) in enumerate(CAPTURES, 1):
        destination = target / filename
        shutil.copy2(captures[filename], destination)
        reader = ImageReader(str(destination))
        image_width, image_height = reader.getSize()
        ratio = min((width - 96) / image_width, (height - 175) / image_height)
        draw_width, draw_height = image_width * ratio, image_height * ratio
        document.setFillColor(colors.HexColor("#183b48"))
        document.setFont("Helvetica-Bold", 24)
        document.drawString(48, height - 48, f"OpenBEXI Timeline 2.0 / {title}")
        document.setFont("Helvetica", 12)
        document.setFillColor(colors.HexColor("#45565e"))
        document.drawString(48, height - 74, caption)
        document.drawImage(reader, (width - draw_width) / 2, 76 + (height - 175 - draw_height) / 2,
                           width=draw_width, height=draw_height)
        document.setStrokeColor(colors.HexColor("#c9d4d8"))
        document.line(48, 59, width - 48, 59)
        document.setFont("Helvetica", 10)
        document.drawString(48, 41, f"Implementation checkpoint, not full release certification | Real browser capture | {run_date[:10]}")
        document.drawRightString(width - 48, 41, f"{index} / {len(CAPTURES)}")
        document.showPage()
        markdown.extend([f"## {title}", "", caption, "", f"![{title}](ui/implementation-preview/{filename})", ""])
    document.save()
    (ROOT / "docs/implementation-preview.md").write_text("\n".join(markdown), encoding="utf-8")
    print(f"Created {pdf.relative_to(ROOT)} ({len(CAPTURES)} pages) and docs/implementation-preview.md")


if __name__ == "__main__":
    main()
