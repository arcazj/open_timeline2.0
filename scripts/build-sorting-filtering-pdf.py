"""Build the illustrated specification from its Markdown source, not a second text copy."""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
from html import escape
from pathlib import Path
from urllib.parse import quote

from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, A3, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    BaseDocTemplate, Frame, Image, KeepTogether, NextPageTemplate,
    PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "OpenBEXI_Timeline_Sorting_Filtering_Prompt.md"
OUTPUT = ROOT / "output/pdf/OpenBEXI_Timeline_Sorting_Filtering_Prompt.pdf"
SCRATCH = ROOT / "tmp/pdfs/sorting-filtering"
PORTRAIT = A4
WIDE = landscape(A3)
WIDTH = PORTRAIT[0] - 84
SOURCE_HASH = hashlib.sha256(SOURCE.read_bytes()).hexdigest()


def tokens():
    command = ["node", "--input-type=module", "-e",
               "import {marked} from 'marked'; import fs from 'node:fs'; "
               "console.log(JSON.stringify(marked.lexer(fs.readFileSync(process.argv[1],'utf8'))));", str(SOURCE)]
    return json.loads(subprocess.run(command, cwd=ROOT, check=True, capture_output=True, text=True, timeout=30).stdout)


def inline(items):
    result = []
    for item in items:
        kind = item["type"]
        if kind in {"text", "escape"}:
            result.append(inline(item["tokens"]) if item.get("tokens") else escape(item["text"]))
        elif kind in {"strong", "em", "del"}:
            tag = {"strong": "b", "em": "i", "del": "strike"}[kind]
            result.append(f"<{tag}>{inline(item['tokens'])}</{tag}>")
        elif kind == "codespan":
            result.append(f'<font name="Courier" size="8.4">{escape(item["text"])}</font>')
        elif kind == "link":
            href = item["href"]
            if not href.startswith(("https://", "http://")):
                href = "https://github.com/arcazj/open_timeline2.0/blob/docs/sorting-filtering-specification/" + quote(href, safe="/#")
            result.append(f'<a href="{escape(href, quote=True)}" color="#216650">{inline(item["tokens"])}</a>')
        elif kind == "br":
            result.append("<br/>")
        else:
            raise ValueError(f"Unsupported inline Markdown: {kind}")
    return "".join(result)


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    SCRATCH.mkdir(parents=True, exist_ok=True)
    body = ParagraphStyle("SpecBody", fontName="Helvetica", fontSize=9.5, leading=13.4,
                          spaceAfter=7, textColor=colors.HexColor("#25353c"), splitLongWords=True)
    small = ParagraphStyle("SpecSmall", parent=body, fontSize=8.5, leading=11.7)
    heading = {
        1: ParagraphStyle("SpecTitle", parent=body, fontName="Helvetica-Bold", fontSize=22, leading=27, spaceBefore=10, spaceAfter=15, keepWithNext=True),
        2: ParagraphStyle("SpecSection", parent=body, fontName="Helvetica-Bold", fontSize=14, leading=18, spaceBefore=14, spaceAfter=8, keepWithNext=True),
        3: ParagraphStyle("SpecSubsection", parent=body, fontName="Helvetica-Bold", fontSize=11, leading=15, spaceBefore=10, spaceAfter=7, keepWithNext=True),
    }
    cell = ParagraphStyle("SpecCell", parent=small, fontSize=8, leading=10.6, spaceAfter=0)
    code = ParagraphStyle("SpecCode", parent=small, fontName="Courier", fontSize=8, leading=11,
                          backColor=colors.HexColor("#f0f4f5"), borderPadding=9, spaceBefore=5, spaceAfter=12)

    def frame(size):
        return Frame(42, 43, size[0] - 84, size[1] - 89, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)

    def decorate(canvas, doc):
        width, height = canvas._pagesize
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#3e5b57"))
        canvas.drawString(42, height - 27, "OPENBEXI TIMELINE 2.0 / SORTING, FILTERING AND SEARCH")
        canvas.setStrokeColor(colors.HexColor("#c8d5d5"))
        canvas.line(42, 34, width - 42, 34)
        canvas.setFont("Helvetica", 7.5)
        canvas.drawString(42, 22, "Specification 1.0 / 2026-09-14 / Proposed features are not implemented")
        canvas.drawRightString(width - 42, 22, str(doc.page))
        canvas.restoreState()

    doc = BaseDocTemplate(str(OUTPUT), pagesize=PORTRAIT, leftMargin=42, rightMargin=42,
                          topMargin=46, bottomMargin=43, title="OpenBEXI Timeline 2.0 - Sorting, Filtering and Search",
                          author="OpenBEXI Timeline", pageCompression=1)
    doc.addPageTemplates([
        PageTemplate(id="portrait", pagesize=PORTRAIT, frames=frame(PORTRAIT), onPage=decorate),
        PageTemplate(id="wide", pagesize=WIDE, frames=frame(WIDE), onPage=decorate),
    ])
    story = []
    headings = []
    images = []

    def render(blocks):
        for token in blocks:
            kind = token["type"]
            if kind == "space":
                continue
            if kind == "heading":
                headings.append(token["text"])
                story.append(Paragraph(inline(token["tokens"]), heading[min(3, token["depth"])]))
            elif kind == "paragraph":
                paragraph_style = ParagraphStyle("CodeLead", parent=body, keepWithNext=True) if token.get("keepWithNext") else body
                story.append(Paragraph(inline(token["tokens"]), paragraph_style))
            elif kind == "list":
                for index, item in enumerate(token["items"], token.get("start") or 1):
                    prefix = f"{index}. " if token["ordered"] else "- "
                    parts = []
                    for block in item["tokens"]:
                        if block["type"] == "space":
                            continue
                        if block["type"] != "text":
                            raise ValueError(f"Unsupported nested list content: {block['type']}")
                        parts.append(inline(block["tokens"]))
                    story.append(Paragraph(prefix + "<br/>".join(parts), body))
            elif kind == "code":
                text = escape(token["text"]).replace(" ", "&#160;").replace("\n", "<br/>")
                story.append(KeepTogether([Paragraph(text, code)]))
            elif kind == "table":
                rows = [[Paragraph(inline(part["tokens"]), cell) for part in token["header"]]]
                rows.extend([[Paragraph(inline(part["tokens"]), cell) for part in row] for row in token["rows"]])
                columns = len(rows[0])
                widths = [WIDTH * .32, WIDTH * .68] if columns == 2 else [WIDTH / columns] * columns
                table = Table(rows, colWidths=widths, repeatRows=1, hAlign=TA_LEFT)
                table.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#dfece7")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LINEBELOW", (0, 0), (-1, -1), .35, colors.HexColor("#cbd5d8")),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ]))
                story.extend([table, Spacer(1, 10)])
            else:
                raise ValueError(f"Unsupported block Markdown: {kind}")

    blocks = tokens()
    index = 0
    after_figure = False
    while index < len(blocks):
        block = blocks[index]
        # Figures are a heading, standalone Markdown image and caption, kept on their own page.
        nonspace = [(i, t) for i, t in enumerate(blocks[index:index + 7], index) if t["type"] != "space"]
        is_figure = (block["type"] == "heading" and block["depth"] == 3 and len(nonspace) >= 3
                     and nonspace[1][1]["type"] == "paragraph"
                     and len(nonspace[1][1].get("tokens", [])) == 1
                     and nonspace[1][1]["tokens"][0]["type"] == "image")
        if is_figure:
            image_token = nonspace[1][1]["tokens"][0]
            filename = (ROOT / image_token["href"]).resolve()
            if not filename.is_relative_to(ROOT):
                raise ValueError("Image outside repository")
            width, height = ImageReader(str(filename)).getSize()
            template, size = ("wide", WIDE) if width > height else ("portrait", PORTRAIT)
            story.extend([NextPageTemplate(template), PageBreak(), Paragraph(inline(block["tokens"]), heading[2])])
            max_height = size[1] - 185
            ratio = min((size[0] - 84) / width, max_height / height)
            figure = Image(str(filename), width=width * ratio, height=height * ratio)
            figure.hAlign = "CENTER"
            story.extend([figure, Spacer(1, 12), Paragraph(inline(nonspace[2][1]["tokens"]), body)])
            images.append({"path": image_token["href"], "sha256": hashlib.sha256(filename.read_bytes()).hexdigest()})
            headings.append(block["text"])
            after_figure = True
            index = nonspace[2][0] + 1
        else:
            if after_figure and block["type"] != "space":
                story.extend([NextPageTemplate("portrait"), PageBreak()])
                after_figure = False
            if block["type"] == "paragraph" and len(nonspace) > 1 and nonspace[1][1]["type"] == "code":
                block = {**block, "keepWithNext": True}
            render([block])
            index += 1

    story.append(Spacer(1, 12))
    story.append(Paragraph("Source SHA-256: " + SOURCE_HASH, small))
    story.append(Paragraph("Generated from the Markdown specification. The separate analysis, evidence JSON and acceptance plan remain linked source documents, not claims of completed implementation.", small))
    doc.build(story)
    reader = PdfReader(OUTPUT)
    text = " ".join((page.extract_text() or "") for page in reader.pages)
    normalized = re.sub(r"\s+", " ", text)
    for title in headings:
        if re.sub(r"\s+", " ", title) not in normalized:
            raise ValueError(f"Heading absent from PDF: {title}")
    if len(images) != 4 or any(len((page.extract_text() or "").strip()) < 200 for page in reader.pages):
        raise ValueError("Missing figure or empty page")
    manifest = {"source": SOURCE.name, "sourceSha256": SOURCE_HASH, "pdfSha256": hashlib.sha256(OUTPUT.read_bytes()).hexdigest(),
                "pages": len(reader.pages), "headingsVerified": len(headings), "figures": images,
                "textVerification": "All Markdown headings found; visual rendering must be checked separately"}
    (SCRATCH / "build.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
