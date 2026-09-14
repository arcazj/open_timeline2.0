"""Build measured, redistributable font variants without changing sample data."""
import hashlib
import json
import shutil
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]


def measured_glyphs(font):
    glyph_set = font.getGlyphSet()
    glyphs = {}
    for code, glyph in font.getBestCmap().items():
        pen = BoundsPen(glyph_set)
        glyph_set[glyph].draw(pen)
        left, bottom, right, top = pen.bounds or (0, 0, 0, 0)
        glyphs[str(code)] = {"advance": font["hmtx"][glyph][0], "xMin": left, "xMax": right, "yMin": bottom, "yMax": top}
    return glyphs


def main():
    css = []
    for weight, style in [(400, "normal"), (700, "normal"), (400, "italic"), (700, "italic")]:
        name = f"noto-sans-latin-{weight}-{style}"
        source = ROOT / "node_modules/@fontsource/noto-sans/files" / f"{name}.woff"
        font = TTFont(source)
        glyphs = measured_glyphs(font)
        extended_source = source.with_name(f"noto-sans-latin-ext-{weight}-{style}.woff")
        extended_font = TTFont(extended_source)
        assert extended_font["head"].unitsPerEm == font["head"].unitsPerEm
        extended = {code: value for code, value in measured_glyphs(extended_font).items() if code not in glyphs}
        glyphs.update(extended)
        # Restrict fallback CSS to exactly the added glyphs; existing metrics stay authoritative.
        coverage = ",".join(f"U+{int(code):X}" for code in sorted(extended, key=int))
        css.append(f"@font-face{{font-family:'Noto Sans';font-style:{style};font-weight:{weight};font-display:block;"
                   f"src:url('../../assets/{extended_source.name}') format('woff');unicode-range:{coverage}}}")
        document = {
            "profileId": "noto-sans-latin-v1" if (weight, style) == (400, "normal") else f"{name}-v1", "fontFamily": "Noto Sans",
            "fontWeight": weight, "fontStyle": style,
            "unitsPerEm": font["head"].unitsPerEm, "ascent": font["hhea"].ascent,
            "descent": font["hhea"].descent, "glyphs": glyphs,
            "fontSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "extendedFontSha256": hashlib.sha256(extended_source.read_bytes()).hexdigest(),
        }
        target = ROOT / "shared/fixtures" / ("font-metrics.json" if (weight, style) == (400, "normal") else f"font-metrics-{weight}-{style}.json")
        target.write_text(json.dumps(document, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        shutil.copyfile(source, ROOT / "client/assets" / source.name)
        shutil.copyfile(extended_source, ROOT / "client/assets" / extended_source.name)
        print(f"Prepared {name}: {len(glyphs)} measured glyphs")
    (ROOT / "client/src/styles/font-extended.css").write_text("\n".join(css) + "\n", encoding="ascii")


if __name__ == "__main__":
    main()
