"""Create a screenshot guide from current-build, verified local dataset captures."""

import hashlib
import json
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'output/pdf/local-test-data.pdf'


def main():
    catalog = json.loads((ROOT / 'data/catalog.json').read_text())['datasets']
    build_hash = hashlib.sha256((ROOT / 'dist/index.html').read_bytes()).hexdigest()
    pages = []
    captions = {
        'default-dataset': 'Complete 48-record operations sample. Existing editing, timeline and overview behavior is retained. No reference PNG was supplied; this is an unapproved baseline.',
        'ephemeris': 'Complete 127-record snapshot with hourly detail and a broader overview. No reference PNG was supplied; this is an unapproved baseline.',
        'jfk': 'Complete 130-record source. The initial view uses America/Chicago time, a translucent time zone and a magnified overview. Row packing and typography are not pixel-identical to the reference.',
        'monet': 'Complete 27-record source. One detail band retains the absolute decade axis and a separate age axis. Uncertain dates and source artwork references are preserved in metadata.',
        'religions': 'Complete 730-record source. Four bands separate source-specific context and detail. BC dates, magnified intervals and contrast-aware duration labels use shared time mappings.',
        'space_exploration': 'Complete 1,287-record source. The initial window is 1957-1977. One literal source year of 201 is preserved and flagged for review. No reference PNG was supplied.',
    }
    for entry in catalog:
        name = entry['id']
        verification = json.loads((ROOT / f'docs/ui/test-data/{name}.verification.json').read_text())
        if verification['status'] != 'passed' or verification['buildSha256'] != build_hash:
            raise ValueError(f'Unverified or outdated capture: {name}')
        if entry.get('reference'):
            pages.append((entry['title'] + ' / Supplied reference', entry['reference'],
                          'User-provided comparison image. This page is a reference, not a capture of the new application. Original asset attribution and redistribution rights remain unverified.'))
        pages.append((entry['title'] + ' / Current timeline', f'docs/ui/test-data/{name}-timeline.png', captions[name]))
    for name in ('monet', 'religions'):
        verification = json.loads((ROOT / f'docs/ui/test-data/{name}-mobile.verification.json').read_text())
        if verification['status'] != 'passed' or verification['buildSha256'] != build_hash:
            raise ValueError(f'Outdated mobile capture: {name}')
        pages.append((name.title() + ' / Mobile', f'docs/ui/test-data/{name}-mobile.png',
                      'Actual 390 x 844 browser capture. The same standalone build keeps navigation and row pagination available without a Python process, HTTP requests or a CDN.'))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    width, height = landscape(A3)
    pdf = Canvas(str(OUTPUT), pagesize=(width, height), pageCompression=1)
    pdf.setTitle('OpenBEXI Timeline 2.0 - Local Test Datasets')
    pdf.setAuthor('OpenBEXI Timeline')
    for number, (title, filename, caption) in enumerate(pages, 1):
        pdf.setFillColor(HexColor('#146653'))
        pdf.setFont('Helvetica', 10)
        pdf.drawString(30, height - 28, 'OPENBEXI TIMELINE 2.0 / LOCAL DATASET LIBRARY')
        pdf.setFillColor(HexColor('#182c34'))
        pdf.setFont('Helvetica-Bold', 21)
        pdf.drawString(30, height - 57, title)
        lines, line = [], ''
        for word in caption.split():
            candidate = (line + ' ' + word).strip()
            if pdf.stringWidth(candidate, 'Helvetica', 11) > width - 60:
                lines.append(line)
                line = word
            else:
                line = candidate
        lines.append(line)
        pdf.setFont('Helvetica', 11)
        for index, line in enumerate(lines):
            pdf.drawString(30, height - 82 - index * 15, line)
        image = ImageReader(str(ROOT / filename))
        source_width, source_height = image.getSize()
        available = height - 170
        ratio = min((width - 60) / source_width, available / source_height)
        w, h = source_width * ratio, source_height * ratio
        x, y = (width - w) / 2, 55 + (available - h) / 2
        pdf.drawImage(image, x, y, w, h)
        pdf.setStrokeColor(HexColor('#c9d2d6'))
        pdf.rect(x, y, w, h)
        pdf.setFillColor(HexColor('#445a64'))
        pdf.setFont('Helvetica', 9)
        pdf.drawString(30, 32, 'Open: dist/index.html > Help and sharing > Test local data | Full guide: docs/local-test-data.md')
        pdf.drawRightString(width - 30, 32, f'{number} / {len(pages)}')
        pdf.setFont('Helvetica', 8)
        pdf.drawString(30, 18, f'Build SHA-256: {build_hash[:24]} | Actual captures; no pixel-equivalence or full-release certification claim.')
        pdf.showPage()
    pdf.save()
    print(OUTPUT)


if __name__ == '__main__':
    main()
