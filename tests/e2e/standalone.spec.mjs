import { test, expect } from '@playwright/test';
import { readFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let directory, fileUrl;
test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'openbexi standalone '));
  const file = path.join(directory, 'index.html');
  await copyFile(path.resolve('dist/index.html'), file);
  fileUrl = pathToFileURL(file).href;
});
test.afterAll(async () => {
  if (path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('openbexi standalone ')) await rm(directory, { recursive: true, force: true });
});

async function openLocal(page) {
  const requests = [], errors = [];
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route(/^https?:\/\//, route => route.abort('internetdisconnected'));
  await page.goto(fileUrl);
  await expect(page.locator('.record-label').first()).toBeVisible();
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  // The initial query can finish before the toolbar's ResizeObserver layout.
  await expect.poll(() => page.locator('.plot-wrap').evaluate(plot => {
    const canvas = plot.querySelector('canvas'), debug = window.__timelineDebug;
    const capacity = Math.min(100, Math.floor(Math.max(debug.effectiveRowHeight, plot.clientHeight - 52) / debug.effectiveRowHeight));
    return debug.ready && debug.pageCapacity === capacity && debug.layoutWidth === plot.clientWidth
      && canvas.height / Math.min(devicePixelRatio, 2) === plot.clientHeight;
  })).toBe(true);
  await expect(page.locator('.record-label.search-match')).toHaveCount(0);
  await expect(page.locator('.range-button')).not.toBeEmpty();
  await expect(page.locator('.scale-cue')).toHaveText('Uniform time scale');
  await expect(page.locator('#auto-scale')).not.toBeChecked();
  const overviewWidth = await page.locator('.overview-plot').evaluate(node => node.clientWidth);
  const selected = await page.locator('.overview-window').boundingBox();
  expect(selected.width / overviewWidth).toBeCloseTo(9 / 24, 2);
  const overlaps = await page.locator('.record-label').evaluateAll(nodes => {
    const boxes = nodes.map(node => ({ id: node.dataset.recordId, box: node.getBoundingClientRect() }));
    const conflicts = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].box, b = boxes[j].box;
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) conflicts.push([boxes[i].id, boxes[j].id]);
    }
    return conflicts;
  });
  expect(overlaps).toEqual([]);
  expect(errors).toEqual([]);
  return { requests, errors };
}

async function pixels(page, selector = '.plot-wrap canvas') {
  return page.locator(selector).evaluate(canvas => {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const values = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, values);
    const colors = new Set(); let hash = 2166136261;
    for (let i = 0; i < values.length; i += 16) {
      const color = values[i] * 65536 + values[i + 1] * 256 + values[i + 2];
      colors.add(color); hash = Math.imul(hash ^ color, 16777619);
    }
    return { width: canvas.width, height: canvas.height, colors: colors.size, hash };
  });
}

test('copied HTML launches offline with real nonblank Three.js main/overview canvases', async ({ page }, info) => {
  const observed = await openLocal(page);
  expect((await pixels(page)).colors).toBeGreaterThan(8);
  expect((await pixels(page, '.overview-plot canvas')).colors).toBeGreaterThan(8);
  await expect(page.locator('.provider-status')).toContainText(/Local/i);
  expect(await page.evaluate(() => document.fonts.check('13px "Noto Sans"'))).toBe(true);
  expect(await page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(48);
  expect(observed.requests).toEqual([]); expect(observed.errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('standalone-desktop.png'), fullPage: true });
});

test('vertical pages preserve time/map/overview while changing drawn records', async ({ page }, info) => {
  await openLocal(page);
  const before = await page.evaluate(() => window.__timelineDebug);
  const beforePixels = await pixels(page);
  const overviewPixels = await pixels(page, '.overview-plot canvas');
  await page.locator('[data-action=next]').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.startRow)).toBeGreaterThan(before.startRow);
  const after = await page.evaluate(() => window.__timelineDebug);
  for (const field of ['fromMs', 'toMs', 'mapId', 'layoutId', 'totalRows']) expect(after[field]).toBe(before[field]);
  expect((await pixels(page)).hash).not.toBe(beforePixels.hash);
  expect((await pixels(page, '.overview-plot canvas')).hash).toBe(overviewPixels.hash);
  await page.screenshot({ path: info.outputPath('vertical-page-two.png'), fullPage: true });
});

test('search highlights only matching labels and overview contains all findings', async ({ page }, info) => {
  await openLocal(page);
  await page.locator('#search').fill('Telemetry');
  await expect(page.locator('.overview-count')).toContainText(/5/);
  await expect(page.locator('.record-label.search-match').first()).toBeVisible();
  for (const text of await page.locator('.record-label.search-match').allTextContents()) expect(text.toLowerCase()).toContain('telemetry');
  expect(await page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(48);
  await page.screenshot({ path: info.outputPath('search-findings.png'), fullPage: true });
});

test('selection, table and Split remain usable with the same source', async ({ page }, info) => {
  await openLocal(page);
  const first = page.locator('.record-label').first();
  const selected = await first.getAttribute('data-record-id');
  await first.click();
  await expect(page.locator('.descriptor')).toBeVisible();
  expect(await page.evaluate(() => window.__timelineDebug.selectedId)).toBe(selected);
  await page.locator('[data-view=table]').click();
  await expect(page.locator('.table-view')).toBeVisible();
  await expect(page.locator('.data-table tbody tr').first()).toBeVisible();
  await page.locator('[data-view=split]').click();
  await expect(page.locator('.plot-wrap canvas')).toBeVisible();
  await expect(page.locator('.table-view')).toBeVisible();
  await expect.poll(() => page.locator('.plot-wrap').evaluate(node => Math.abs(node.querySelector('canvas').width / Math.min(devicePixelRatio, 2) - node.clientWidth))).toBeLessThan(1);
  await page.screenshot({ path: info.outputPath('split-selection.png'), fullPage: true });
});

test('navigation changes projected canvas and range without editing records', async ({ page }, info) => {
  await openLocal(page);
  const before = await page.evaluate(() => window.__timelineDebug);
  const beforePixels = await pixels(page);
  const box = await page.locator('.plot-wrap').boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.7);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.7, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.fromMs)).not.toBe(before.fromMs);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  expect((await pixels(page)).hash).not.toBe(beforePixels.hash);
  expect(await page.evaluate(() => window.__timelineDebug.dirty)).toBe(false);
  await page.locator('#auto-scale').check();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.scaleMode)).toBe('adaptive');
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('adaptive-navigation.png'), fullPage: true });
});

test('zoom controls and overview drag change the range in the expected direction', async ({ page }) => {
  await openLocal(page);
  const span = () => page.evaluate(() => Number(window.__timelineDebug.toMs) - Number(window.__timelineDebug.fromMs));
  const before = await span();
  await page.locator('[data-action=zoom-in]').click();
  await expect.poll(span).toBeLessThan(before);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  const zoomed = await span();
  await page.locator('[data-action=zoom-out]').click();
  await expect.poll(span).toBeGreaterThan(zoomed);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  const previous = await page.evaluate(() => window.__timelineDebug.fromMs);
  const box = await page.locator('.overview-window').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.fromMs)).not.toBe(previous);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
});

test('local create/export/reimport preserves a complete source and truthful unsaved status', async ({ page }, info) => {
  const observed = await openLocal(page);
  await page.locator('[data-action=create]').click();
  await page.locator('#record-form [name=title]').fill('Test checkpoint');
  await page.locator('#record-form [type=submit]').click();
  await expect(page.locator('[role=dialog]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__timelineDebug.dirty)).toBe(true);
  await page.locator('[data-action=sources]').first().click();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-json').click();
  const download = await downloadEvent;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(exported.records).toHaveLength(49);
  expect(exported.manifest.recordCount).toBe(49);
  expect(exported.records.some(record => record.title === 'Test checkpoint')).toBe(true);
  expect(await page.evaluate(() => window.__timelineDebug.dirty)).toBe(true);
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#json-file').setInputFiles({ name: 'saved-snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await expect(page.locator('[role=dialog]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(49);
  expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
  await page.screenshot({ path: info.outputPath('local-edited-reimport.png'), fullPage: true });
});

test('invalid and duplicate-key imports keep the current source intact', async ({ page }) => {
  await openLocal(page);
  const before = await page.evaluate(() => window.__timelineDebug);
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#json-file').setInputFiles({ name: 'partial.json', mimeType: 'application/json', buffer: Buffer.from('{"records":[],"total":10000}') });
  await expect(page.locator('.form-error')).toBeVisible();
  expect(await page.evaluate(() => window.__timelineDebug.queryId)).toBe(before.queryId);
  const raw = await readFile('data/default-dataset.json', 'utf8');
  const duplicate = raw.replace('"formatVersion": 1', '"formatVersion": 1, "formatVersion": 1');
  await page.locator('#json-file').setInputFiles({ name: 'duplicate.json', mimeType: 'application/json', buffer: Buffer.from(duplicate) });
  await expect(page.locator('.form-error')).toContainText(/duplicate/i);
  expect(await page.evaluate(() => window.__timelineDebug.queryId)).toBe(before.queryId);
});

test('local edit, duplicate and delete preserve the original identity and a tombstone', async ({ page }) => {
  const observed = await openLocal(page);
  const originalId = await page.locator('.record-label').first().getAttribute('data-record-id');
  await page.locator('.record-label').first().click();
  await page.locator('[data-action=edit]').click();
  await page.locator('#record-form [name=title]').fill('Edited coverage checkpoint');
  await page.locator('#record-form [type=submit]').click();
  await expect(page.locator('.descriptor h3')).toHaveText('Edited coverage checkpoint');
  expect(await page.evaluate(() => window.__timelineDebug.selectedId)).toBe(originalId);
  await page.locator('[data-action=duplicate]').click();
  await page.locator('#record-form [type=submit]').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(49);
  const duplicateId = await page.evaluate(() => window.__timelineDebug.selectedId);
  expect(duplicateId).not.toBe(originalId);
  await page.locator('[data-action=delete]').click();
  await page.locator('#confirm-delete').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(48);
  await page.locator('[data-action=sources]').first().click();
  const event = page.waitForEvent('download');
  await page.locator('#export-json').click();
  const result = JSON.parse(await readFile(await (await event).path(), 'utf8'));
  expect(result.records.find(record => record.id === originalId).title).toBe('Edited coverage checkpoint');
  expect(result.records.find(record => record.id === duplicateId).deletedAt).toBeTruthy();
  expect(result.records.filter(record => !record.deletedAt)).toHaveLength(48);
  expect(observed.errors).toEqual([]);
});

test.describe('narrow viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('both bands, row controls and all scale options fit without page overflow', async ({ page }, info) => {
    const observed = await openLocal(page);
    await expect(page.locator('.overview-plot')).toBeInViewport();
    await expect(page.locator('[data-action=next]')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect((await pixels(page)).colors).toBeGreaterThan(8);
    await page.screenshot({ path: info.outputPath('standalone-mobile.png'), fullPage: true });
    await page.locator('[data-action=settings]').click();
    await expect(page.locator('[name=unit] option')).toHaveCount(11);
    await expect(page.locator('[role=dialog]')).toBeInViewport();
    expect(observed.errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('mobile-scale-settings.png'), fullPage: true });
    await page.locator('[data-action=close-modal]').click();
    await page.locator('[data-view=split]').click();
    await expect(page.locator('.table-view')).toBeVisible();
    await expect(page.locator('.overview-plot')).toBeInViewport();
    await expect.poll(() => page.locator('.overview-plot').evaluate(node => Math.abs(node.querySelector('canvas').getBoundingClientRect().height - node.clientHeight))).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: info.outputPath('standalone-mobile-split.png'), fullPage: true });
  });
});

test.describe('high-DPI viewport', () => {
  test.use({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2 });
  test('canvas CSS bounds and DOM labels share the same coordinate system at DPR 2', async ({ page }, info) => {
    await openLocal(page);
    for (const selector of ['.plot-wrap', '.overview-plot']) {
      const size = await page.locator(selector).evaluate(node => {
        const canvas = node.querySelector('canvas'), rect = canvas.getBoundingClientRect();
        return { plotWidth: node.clientWidth, plotHeight: node.clientHeight, cssWidth: rect.width, cssHeight: rect.height, pixels: canvas.width };
      });
      expect(size.cssWidth).toBeCloseTo(size.plotWidth, 0);
      expect(size.cssHeight).toBeCloseTo(size.plotHeight, 0);
      expect(size.pixels).toBe(size.plotWidth * 2);
    }
    expect((await pixels(page)).colors).toBeGreaterThan(8);
    await page.screenshot({ path: info.outputPath('standalone-high-dpi.png'), fullPage: true });
  });
});
