import normal from '../../../shared/fixtures/font-metrics.json' with { type: 'json' };
import bold from '../../../shared/fixtures/font-metrics-700-normal.json' with { type: 'json' };
import italic from '../../../shared/fixtures/font-metrics-400-italic.json' with { type: 'json' };
import boldItalic from '../../../shared/fixtures/font-metrics-700-italic.json' with { type: 'json' };

const profiles = { '400-normal': normal, '700-normal': bold, '400-italic': italic, '700-italic': boldItalic };

export function measureText(text, fontSize = 13, fontWeight = 400, fontStyle = 'normal') {
  const metrics = profiles[`${fontWeight}-${fontStyle}`];
  if (!metrics) throw Object.assign(new Error('Unsupported measured font variant'), { code: 'unsupported_profile', status: 422 });
  let advance = 0, min = 0, max = 0;
  for (const character of text) {
    const glyph = metrics.glyphs[String(character.codePointAt(0))];
    if (!glyph) throw Object.assign(new Error(`Unsupported glyph U+${character.codePointAt(0).toString(16).toUpperCase()} in render profile`), { code: 'unsupported_glyph', status: 422 });
    min = Math.min(min, advance + glyph.xMin);
    max = Math.max(max, advance + glyph.xMax);
    advance += glyph.advance;
  }
  const scale = fontSize / metrics.unitsPerEm;
  return { width: (Math.max(advance, max) - min) * scale, inkOffset: min * scale, advance: advance * scale };
}

export function wrapLabel(fullLabel, style, availableWidth, maxLines = 1) {
  const measured = text => measureText(text, style.fontSize, style.fontWeight, style.fontStyle).width;
  const fits = text => measured(text) <= availableWidth + 1e-9;
  if (!(availableWidth > 0) || !fits('...')) throw Object.assign(new Error('Label cannot fit the admitted render profile'), { code: 'label_width_limit', status: 422 });
  const paragraphs = fullLabel.split('\n');
  const lines = [];
  let overflow = false;
  for (let p = 0; p < paragraphs.length; p++) {
    let remaining = paragraphs[p];
    if (!remaining && lines.length < maxLines) lines.push('');
    while (remaining.length) {
      if (lines.length === maxLines) { overflow = true; break; }
      if (fits(remaining)) { lines.push(remaining); remaining = ''; break; }
      const characters = Array.from(remaining);
      let lo = 0, hi = characters.length;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(characters.slice(0, mid).join(''))) lo = mid; else hi = mid - 1; }
      if (!lo) throw Object.assign(new Error('A glyph cannot fit the label region'), { code: 'label_width_limit', status: 422 });
      let cut = lo;
      const space = characters.slice(0, cut).lastIndexOf(' ');
      if (space > 0) cut = space;
      lines.push(characters.slice(0, cut).join('').replace(/ +$/u, ''));
      remaining = characters.slice(cut).join('').replace(/^ +/u, '');
    }
    if (overflow || (lines.length === maxLines && p < paragraphs.length - 1)) { overflow = true; break; }
  }
  if (!lines.length) lines.push('');
  if (overflow) {
    const last = Array.from(lines.at(-1));
    while (last.length && !fits(last.join('') + '...')) last.pop();
    lines[lines.length - 1] = last.join('') + '...';
  }
  return { labelLines: lines, labelWidth: Math.max(...lines.map(measured)), labelInkOffsets: lines.map(text => measureText(text, style.fontSize, style.fontWeight, style.fontStyle).inkOffset), displayTitle: lines.join('\n'), overflow, fullLabel };
}
