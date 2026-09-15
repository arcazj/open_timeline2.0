import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

const bundled = await build({ stdin: { contents: `
  import { TimelineRenderer } from './client/src/timeline/renderer.js';
  import { buildPresentationLayout } from './client/src/timeline/layout-presentation.js';
  import { previewProjector, extendPreviewSessions } from './client/src/timeline/navigation-preview-projection.js';
  import { toMs, toIso } from './client/src/timeline/time-scale.js';
  Object.assign(window, { TimelineRenderer, buildPresentationLayout, previewProjector, extendPreviewSessions, toMs, toIso });`,
  resolveDir: process.cwd(), sourcefile: 'preview-baseline-fixture.js' }, bundle: true, write: false, format: 'iife',
  loader: { '.css': 'empty', '.png': 'dataurl' }, minify: true });

for (const mode of ['uniform', 'adaptive']) test(`${mode} frozen baselines remain visible beyond both original map edges`, async ({ page }, info) => {
  await page.setContent('<!doctype html><style>body{margin:0}#plot{position:relative;width:400px;height:300px;overflow:hidden}.record-label-layer{position:absolute;inset:0;pointer-events:none}.record-label,.record-hit{position:absolute;pointer-events:auto}</style><div id="plot"></div>');
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const initial = await page.evaluate(mode => {
    const start = window.toMs('2026-01-01T00:00:00Z'), hour = 3600000, stamp = value => window.toIso(start + value * hour);
    const map = { mode, knots: mode === 'uniform' ? [{ timeMs: start, u: '0' }, { timeMs: start + 3 * hour, u: '1' }]
      : [{ timeMs: start, u: '0' }, { timeMs: start + hour, u: '0.2' }, { timeMs: start + 2 * hour, u: '0.8' }, { timeMs: start + 3 * hour, u: '1' }] };
    const records = [
      { id: 'long', title: 'Long session', kind: 'session', end: stamp(7) },
      { id: 'event', title: 'Point event', kind: 'event', end: null },
      { id: 'zero', title: 'Zero-duration session', kind: 'session', end: stamp(.5) },
    ].map(record => ({ ...record, sourceId: 'operations', start: stamp(.5), originalStart: stamp(-3), originalEnd: stamp(10) }));
    window.canonical = window.buildPresentationLayout(records, map, { from: stamp(0), to: stamp(1), width: 400, availableHeight: 248,
      rowHeight: 64, fontSize: 13, presentation: { version: 1, baseline: { enabled: true, color: '#ff00ff' } } }, new Set(), () => true);
    window.canonicalBefore = JSON.stringify(window.canonical);
    window.project = window.previewProjector({ map, fromMs: start, toMs: start + hour, width: 400 });
    window.extended = window.extendPreviewSessions(window.canonical, window.project);
    window.renderer = new window.TimelineRenderer(document.getElementById('plot'));
    window.renderer.render({ rows: { ...window.extended, startRow: 0, endRow: window.extended.totalRows }, width: 400, height: 300,
      rowHeight: window.extended.rowHeight, fontSize: 13, project: window.project, presentation: window.extended.presentation, preview: true });
    window.offsetFor = value => 200 - window.project(start + value * hour);
    return { rows: window.extended.totalRows, geometry: window.extended.items.map((item, index) => ({
      baselineStart: item.baselineStart, baselineEnd: item.baselineEnd, expectedStart: window.project(start - 3 * hour), expectedEnd: window.project(start + 10 * hour),
      row: item.row, originalRow: window.canonical.items[index].row, labelX: item.labelX, originalLabelX: window.canonical.items[index].labelX })) };
  }, mode);
  expect(initial.rows).toBe(3);
  for (const item of initial.geometry) {
    expect(item.baselineStart).toBeCloseTo(item.expectedStart, 6); expect(item.baselineEnd).toBeCloseTo(item.expectedEnd, 6);
    expect(item.row).toBe(item.originalRow); expect(item.labelX).toBe(item.originalLabelX);
  }
  for (const focus of [-1.5, 4.5]) {
    const bands = await page.evaluate(focus => {
      window.renderer.previewOffset(window.offsetFor(focus));
      const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl2'), rgba = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      const scale = canvas.width / 400;
      return window.extended.items.map(item => {
        const y = 52 + item.row * window.extended.rowHeight + item.baselineOffsetY;
        let colored = 0;
        for (let x = 20; x < 400; x += 40) {
          let hit = false;
          for (let dy = -2; dy <= 2; dy++) {
            const index = (Math.floor(canvas.height - (y + dy) * scale - 1) * canvas.width + Math.floor(x * scale)) * 4;
            if (rgba[index] > 150 && rgba[index + 1] < 190 && rgba[index + 2] > 150) hit = true;
          }
          if (hit) colored++;
        }
        return colored;
      });
    }, focus);
    expect(bands).toEqual([10, 10, 10]);
    expect(await page.evaluate(() => JSON.stringify(window.canonical))).toBe(await page.evaluate(() => window.canonicalBefore));
    expect(await page.locator('.record-label').count()).toBe(3);
    expect(await page.locator('#plot').evaluate(node => node.scrollLeft)).toBe(0);
  }
  await page.screenshot({ path: info.outputPath(`preview-baselines-${mode}.png`) });
  await page.evaluate(() => window.renderer.dispose());
});
