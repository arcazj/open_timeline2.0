import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

const bundled = await build({ stdin: { contents: `import { TimelineRenderer } from './client/src/timeline/renderer.js'; window.TimelineRenderer = TimelineRenderer;`,
  resolveDir: process.cwd(), sourcefile: 'renderer-preview-fixture.js' }, bundle: true, write: false, format: 'iife',
  loader: { '.css': 'empty', '.png': 'dataurl' }, minify: true });
const source = bundled.outputFiles[0].text;

test.beforeEach(async ({ page }) => {
  await page.setContent(`<!doctype html><style>body{margin:0}#plot{position:relative;width:400px;height:180px;overflow:hidden}.record-label-layer{position:absolute;inset:0;pointer-events:none}.record-label,.record-hit{position:absolute;pointer-events:auto}.record-hit{height:12px;border:0;background:transparent}</style><div id="plot"></div>`);
  await page.addScriptTag({ content: source });
  await page.evaluate(() => {
    window.renderer = new window.TimelineRenderer(document.getElementById('plot'));
    window.makeItem = (id, x = 20, end = 100, row = 0) => ({ record: { id, title: id, kind: 'session', start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z', render: { color: '#227788' } },
      xStart: x, xEnd: end, row, labelX: 20, labelWidth: 80 });
    window.paint = items => window.renderer.render({ rows: { items, rows: [], startRow: 0, endRow: 3, rowHeight: 32 },
      width: 400, height: 180, rowHeight: 32, fontSize: 13, project: () => 0, preview: true });
  });
});

test.afterEach(async ({ page }) => { await page.evaluate(() => window.renderer?.dispose()); });

test('very long session bars remain clickable after camera movement without giant CSS geometry', async ({ page }) => {
  await page.evaluate(() => { window.paint([window.makeItem('long', -1e20, 1e20)]); });
  const target = page.locator('.record-hit[data-record-id="long"]');
  expect(await target.evaluate(node => parseFloat(node.style.width))).toBe(1200);
  expect(await page.evaluate(() => document.elementFromPoint(200, 76)?.dataset.recordId)).toBe('long');
  await target.evaluate(node => node.addEventListener('click', () => { window.hitCount = (window.hitCount || 0) + 1; }));
  await page.mouse.click(200, 76);
  await page.evaluate(() => window.renderer.previewOffset(-500));
  expect(await target.evaluate(node => parseFloat(node.style.width))).toBe(1200);
  expect(await page.evaluate(() => document.elementFromPoint(200, 76)?.dataset.recordId)).toBe('long');
  await page.mouse.click(200, 76);
  expect(await page.evaluate(() => window.hitCount)).toBe(2);
});

test('preview additions retain the unchanged focused label node without a blur/refocus cycle', async ({ page }) => {
  await page.evaluate(() => {
    window.paint([window.makeItem('focused')]);
    window.focusedLabel = document.querySelector('.record-label[data-record-id="focused"]');
    window.blurCount = 0; window.focusedLabel.addEventListener('blur', () => window.blurCount++); window.focusedLabel.focus();
    window.paint([window.makeItem('focused'), window.makeItem('incoming', 420, 480, 1)]);
  });
  expect(await page.evaluate(() => document.activeElement === window.focusedLabel)).toBe(true);
  expect(await page.evaluate(() => document.querySelector('.record-label[data-record-id="focused"]') === window.focusedLabel)).toBe(true);
  expect(await page.evaluate(() => window.blurCount)).toBe(0);
  await page.evaluate(() => window.paint([window.makeItem('focused')]));
  expect(await page.evaluate(() => document.activeElement === window.focusedLabel)).toBe(true);
  expect(await page.evaluate(() => window.blurCount)).toBe(0);
});

test('keyboard Tab skips offscreen preview labels and camera movement updates eligibility without scrolling', async ({ page }) => {
  await page.evaluate(() => {
    const plot = document.getElementById('plot');
    plot.insertAdjacentHTML('beforebegin', '<button id="before">Before timeline</button>');
    plot.insertAdjacentHTML('afterend', '<button id="after">After timeline</button>');
    window.keyboardItems = [
      { ...window.makeItem('visible'), labelX: 20 },
      { ...window.makeItem('past'), labelX: -200 },
      { ...window.makeItem('future'), labelX: 460 },
      { ...window.makeItem('partial'), labelX: 390, row: 1 },
    ];
    window.paint(window.keyboardItems);
  });
  const label = id => page.locator(`.record-label[data-record-id="${id}"]`);
  for (const id of ['past', 'future']) expect(await label(id).evaluate(node => node.tabIndex)).toBe(-1);
  await page.locator('#before').focus(); await page.keyboard.press('Tab'); await expect(label('visible')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(label('partial')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('#after')).toBeFocused();
  expect(await page.locator('#plot').evaluate(node => node.scrollLeft)).toBe(0);
  await label('partial').focus();
  expect(await page.locator('#plot').evaluate(node => node.scrollLeft)).toBe(0);
  await label('visible').focus();
  await page.evaluate(() => {
    window.focusedPreview = document.activeElement; window.previewBlurCount = 0;
    window.focusedPreview.addEventListener('blur', () => window.previewBlurCount++);
    window.renderer.previewOffset(-300);
  });
  await expect(label('visible')).toBeFocused();
  expect(await label('visible').evaluate(node => node.tabIndex)).toBe(-1);
  expect(await label('future').evaluate(node => node.tabIndex)).toBe(0);
  expect(await page.evaluate(() => window.previewBlurCount)).toBe(0);
  await page.locator('#before').focus(); await page.keyboard.press('Tab'); await expect(label('future')).toBeFocused();
  expect(await page.locator('#plot').evaluate(node => node.scrollLeft)).toBe(0);
  await page.evaluate(() => { window.paint(window.keyboardItems); window.renderer.previewOffset(-300); });
  await expect(label('future')).toBeFocused();
  expect(await page.locator('.record-label').count()).toBe(4);
  expect(await page.locator('#plot').evaluate(node => node.scrollLeft)).toBe(0);
});

test('canonical rendering and disposal restore authored overflow and normal label tab order', async ({ page }) => {
  await page.evaluate(() => {
    document.getElementById('plot').style.setProperty('overflow', 'hidden', 'important');
    window.paint([{ ...window.makeItem('outside'), labelX: 450 }]);
  });
  expect(await page.locator('#plot').evaluate(node => getComputedStyle(node).overflow)).toBe('clip');
  expect(await page.locator('.record-label').evaluate(node => node.tabIndex)).toBe(-1);
  await page.evaluate(() => window.renderer.render({ rows: { items: [window.makeItem('canonical')], rows: [], startRow: 0, endRow: 3, rowHeight: 32 },
    width: 400, height: 180, rowHeight: 32, fontSize: 13, project: () => 0 }));
  expect(await page.locator('.record-label').evaluate(node => node.tabIndex)).toBe(0);
  expect(await page.locator('#plot').evaluate(node => [node.style.overflow, node.style.getPropertyPriority('overflow')])).toEqual(['hidden', 'important']);
  await page.evaluate(() => { window.paint([window.makeItem('again')]); window.renderer.dispose(); });
  expect(await page.locator('#plot').evaluate(node => [node.style.overflow, node.style.getPropertyPriority('overflow')])).toEqual(['hidden', 'important']);
});
