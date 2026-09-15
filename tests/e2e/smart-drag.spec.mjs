import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { startLocalPathsServer } from '../integration/local-paths-server-fixture.mjs';

const debug = page => page.evaluate(() => window.__timelineDebug);
const ready = page => expect.poll(async () => (await debug(page))?.ready).toBe(true);
const day = '2026-09-12T';
async function openFixture(page, { crowded = false, crowdedNeighbor = false } = {}) {
  await page.goto(pathToFileURL(path.resolve('dist/index.html')).href); await ready(page);
  const snapshot = JSON.parse(await readFile('data/default-dataset.json', 'utf8'));
  snapshot.records = ['11:45', '12:05', '12:35', '13:05'].map((time, index) => ({ ...snapshot.records[index],
    kind: 'event', end: null, start: `${day}${time}:00.000Z`, title: ['Past buffer', 'Visible anchor', 'Future buffer', 'Further future'][index],
    sourceId: 'operations', parentSessionId: null, groupIds: [], order: index, extensions: {} }));
  if (crowded) for (let index = 0; index < 80; index++) snapshot.records.push({ ...snapshot.records[1],
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: `Simultaneous ${index}`, order: index + 4 });
  if (crowdedNeighbor) for (let index = 0; index < 80; index++) snapshot.records.push({ ...snapshot.records[2],
    id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: `Neighbor ${index}`, order: index + 4 });
  snapshot.manifest.recordCount = snapshot.records.length; snapshot.manifest.sourceName = 'Smart drag fixture';
  snapshot.settings = { ...snapshot.settings, scaleMode: 'uniform',
    range: { from: `${day}12:00:00.000Z`, to: `${day}12:30:00.000Z` },
    overview: { from: `${day}11:00:00.000Z`, to: `${day}14:00:00.000Z` } };
  snapshot.zones = snapshot.zones.slice(0, 1);
  if (await page.locator('[data-action=sources]').first().isVisible()) await page.locator('[data-action=sources]').first().click();
  else { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.locator('#source-command').click(); }
  await page.locator('#json-file').setInputFiles({ name: 'smart-drag.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
  await expect.poll(async () => (await debug(page))?.sourceName).toBe('Smart drag fixture');
  await ready(page);
  return snapshot;
}
const label = (page, title) => page.locator('.plot-wrap .record-label').filter({ hasText: title });
const neighboringPreparation = (request, view) => {
  if (request.method() !== 'POST' || view.navigationBuffer.activeRequests !== 1 || view.queryLoading) return false;
  const input = request.postDataJSON(), range = input.domain || input;
  const from = Date.parse(range.from), to = Date.parse(range.to);
  // Neighbor query timestamps round outward to integer milliseconds.
  return Number.isFinite(from) && Number.isFinite(to) && (from >= Number(view.toMs) - 1 || to <= Number(view.fromMs) + 1);
};
async function holdDrag(page, fraction) {
  const plot = await page.locator('.plot-wrap').boundingBox(), start = Math.abs(fraction) > .45 ? fraction < 0 ? .9 : .1 : .5;
  const x = plot.x + plot.width * start, y = plot.y + plot.height * .8;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + plot.width * fraction, y, { steps: 15 });
  return { plot, x, y };
}

for (const width of [1600, 390]) test(`prepared adjacent records enter without row movement or late-loading coverage (${width}px)`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:\/\//, route => route.abort());
  const fixture = await openFixture(page);
  await expect(label(page, 'Future buffer')).toHaveCount(1);
  await expect(label(page, 'Past buffer')).toHaveCount(1);
  const original = await debug(page), anchorY = (await label(page, 'Visible anchor').boundingBox()).y;
  const futureBefore = await label(page, 'Future buffer').boundingBox(), plotBefore = await page.locator('.plot-wrap').boundingBox();
  expect(futureBefore.x).toBeGreaterThan(plotBefore.x + plotBefore.width);
  expect(await label(page, 'Future buffer').evaluate(node => node.tabIndex)).toBe(-1);
  await label(page, 'Visible anchor').focus(); await page.keyboard.press('Tab');
  await expect(label(page, 'Future buffer')).not.toBeFocused();
  expect(await page.locator('.plot-wrap').evaluate(node => node.scrollLeft)).toBe(0);
  await holdDrag(page, -.4);
  await expect.poll(async () => (await debug(page)).navigationOffset).toBeLessThan(-plotBefore.width * .35);
  const during = await debug(page), future = await label(page, 'Future buffer').boundingBox();
  expect(future.x).toBeLessThan(plotBefore.x + plotBefore.width);
  expect(await label(page, 'Future buffer').evaluate(node => node.tabIndex)).toBe(0);
  expect(await page.locator('.plot-wrap').evaluate(node => node.scrollLeft)).toBe(0);
  expect((await label(page, 'Visible anchor').boundingBox()).y).toBe(anchorY);
  expect(during.queryId).toBe(original.queryId); expect(during.mapId).toBe(original.mapId);
  expect(during.startRow).toBe(original.startRow); expect(during.navigationCoverage).toBe('ready');
  expect(during.navigationBuffer.activeRequests).toBeLessThanOrEqual(1);
  expect(during.navigationBuffer.cachedPages).toBeLessThanOrEqual(6);
  expect(during.navigationBuffer.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  const markerPixels = await page.locator('.plot-wrap canvas').evaluate((canvas, hex) => {
    const target = hex.slice(1).match(/../g).map(value => parseInt(value, 16));
    const gl = canvas.getContext('webgl2'), pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) if (target.every((channel, n) => Math.abs(pixels[index + n] - channel) <= 2)) count++;
    return count;
  }, fixture.records[2].render.color);
  expect(markerPixels).toBeGreaterThan(8);
  await info.attach('navigation-metrics.json', { body: JSON.stringify(during.navigationBuffer), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath(`prepared-drag-${width}.png`), fullPage: true });
  // A reversal uses the same frozen base, not the most recently received query.
  const plot = await page.locator('.plot-wrap').boundingBox();
  await page.mouse.move(plot.x + plot.width * .9, plot.y + plot.height * .8, { steps: 15 });
  await expect.poll(async () => (await debug(page)).navigationOffset).toBeGreaterThan(plot.width * .35);
  expect((await label(page, 'Visible anchor').boundingBox()).y).toBe(anchorY);
  await page.waitForTimeout(120); await page.mouse.up(); await ready(page);
  expect(errors).toEqual([]);
});

test('slow server layout is shown as partial coverage and a new drag supersedes pending navigation', async ({ page }, info) => {
  const server = await startLocalPathsServer({ archiveDays: 3 });
  let release = () => {};
  try {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.baseUrl); await ready(page);
    await expect.poll(async () => (await debug(page)).localPaths).toBe(true); await ready(page);
    let heldRequests = 0, targetSeen = false, blockAll = false;
    const delayedLayouts = new Set();
    const targetFrom = Date.parse('2024-03-18T19:50:00.000Z'), targetTo = Date.parse('2024-03-18T20:10:00.000Z');
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(/\/query-sessions\/[^/]+\/layouts\/[^/?]+$/, async route => {
      if (route.request().method() !== 'GET' || !delayedLayouts.has(route.request().url())) return route.continue();
      heldRequests++; await gate;
      try { await route.continue(); } catch { /* Superseded speculative status read. */ }
    });
    await page.route('**/query-sessions/*/layouts', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const input = route.request().postDataJSON();
      const canonical = Date.parse(input.from) === targetFrom && Date.parse(input.to) === targetTo;
      if (canonical) targetSeen = true;
      // Arm on the new canonical view, before its first neighbor can enter the cache.
      if (!targetSeen || !blockAll && canonical) return route.continue();
      // Delay preparation only after ownership is known, so cancellation can release it.
      const response = await route.fetch({ headers: { ...route.request().headers(), 'x-openbexi-local': '1', 'sec-fetch-site': 'same-origin' } });
      const manifest = await response.json();
      expect(response.status()).toBe(202); expect(manifest.layoutId).toEqual(expect.any(String));
      delayedLayouts.add(`${route.request().url()}/${encodeURIComponent(manifest.layoutId)}`);
      await route.fulfill({ response, json: { ...manifest, state: 'preparing' } });
    });
    await page.locator('.range-button').click();
    await page.locator('#range-form [name=from]').fill('2024-03-18T19:50');
    await page.locator('#range-form [name=to]').fill('2024-03-18T20:10');
    await page.locator('#range-form [type=submit]').click(); await ready(page);
    blockAll = true;
    await expect.poll(() => heldRequests).toBeGreaterThan(0);
    const { plot, y } = await holdDrag(page, -.8);
    await expect(page.locator('.navigation-pending-edge')).toBeVisible();
    await expect.poll(async () => (await debug(page)).navigationCoverage).toBe('partial');
    await page.waitForTimeout(120); await page.mouse.up();
    await expect.poll(() => heldRequests).toBeGreaterThan(0);
    await expect.poll(async () => (await debug(page)).ready).toBe(false);
    await expect.poll(async () => (await debug(page)).queryLoading).toBe(true);
    const restartX = plot.x + plot.width * .4;
    await page.mouse.move(restartX, y); await page.mouse.down(); await page.mouse.move(restartX + plot.width * .15, y, { steps: 10 });
    await expect.poll(async () => (await debug(page)).navigationPhase).toBe('dragging');
    await page.waitForTimeout(120); await page.mouse.up(); release(); await ready(page);
    const result = await debug(page);
    await info.attach('delayed-navigation.json', { body: JSON.stringify(result), contentType: 'application/json' });
    expect(result.navigationBuffer.activeRequests).toBeLessThanOrEqual(1); expect(errors).toEqual([]);
  } finally { release(); await server.stop(); }
});

test('simultaneous records retain the selected vertical page during drag and settling', async ({ page }) => {
  await openFixture(page, { crowded: true });
  await page.getByRole('button', { name: 'Next rows', exact: true }).click(); await ready(page);
  await expect.poll(async () => (await debug(page)).startRow).toBeGreaterThan(0);
  const before = await debug(page); expect(before.startRow).toBeGreaterThan(0);
  await holdDrag(page, -.05);
  expect((await debug(page)).startRow).toBe(before.startRow);
  expect((await debug(page)).mapId).toBe(before.mapId);
  await page.waitForTimeout(120); await page.mouse.up(); await ready(page);
  expect((await debug(page)).startRow).toBe(before.startRow);
  expect((await debug(page)).totalRows).toBe(before.totalRows);
});

test('a prepared neighboring page still reports additional rows when other pages exist', async ({ page }) => {
  await openFixture(page, { crowdedNeighbor: true });
  await expect(page.locator('.plot-wrap .record-label').filter({ hasText: /^Neighbor / }).first()).toBeAttached();
  await holdDrag(page, -.4);
  await expect(page.locator('.navigation-pending-edge')).toContainText('Additional rows pending');
  expect((await debug(page)).navigationCoverage).toBe('partial');
  await page.waitForTimeout(120); await page.mouse.up(); await ready(page);
});

for (const [status, code] of [[403, 'permission_scope_changed'], [409, 'generation_mismatch']]) {
  test(`a current speculative ${code} response applies the existing source boundary`, async ({ page }) => {
    const server = await startLocalPathsServer({ archiveDays: 3 });
    try {
      await page.goto(server.baseUrl); await ready(page);
      await label(page, 'SOURCE1 session').first().click();
      await expect(page.locator('.descriptor')).toBeVisible(); await ready(page);
      let denied = 0;
      await page.route(/\/query-sessions(?:\/[^/]+\/layouts)?$/, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const view = await debug(page);
        if (!neighboringPreparation(route.request(), view)) return route.continue();
        denied++;
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code, message: 'Controlled speculative source boundary' }) });
      });
      await holdDrag(page, -.8);
      await expect.poll(() => denied).toBeGreaterThan(0);
      if (status === 403) {
        await expect(page.locator('.provider-status')).toContainText('Authorization required');
        await expect(page.locator('.record-label')).toHaveCount(0);
        await expect(page.locator('.descriptor')).toBeHidden();
        expect((await debug(page)).selectedId).toBeFalsy();
      } else {
        await expect(page.locator('.notice')).toContainText('The server workspace changed');
        expect((await debug(page)).ready).toBe(false);
        expect((await debug(page)).navigationPhase).toBe('idle');
      }
      await page.mouse.up();
    } finally { await server.stop(); }
  });
}

test('a late denied speculative request cannot clear a replacement local source', async ({ page }) => {
  const server = await startLocalPathsServer({ archiveDays: 3 });
  let release = () => {};
  try {
    await page.goto(server.baseUrl); await ready(page);
    let held = 0;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(/\/query-sessions(?:\/[^/]+\/layouts)?$/, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const view = await debug(page);
      if (!neighboringPreparation(route.request(), view)) return route.continue();
      held++; await gate;
      try { await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'permission_scope_changed', message: 'Old source denied' }) }); }
      catch { /* The old source may already have canceled its HTTP request. */ }
    });
    await holdDrag(page, -.8); await expect.poll(() => held).toBeGreaterThan(0);
    // A source import supersedes the old interaction before its response arrives.
    const snapshot = JSON.parse(await readFile('data/default-dataset.json', 'utf8'));
    snapshot.manifest.sourceName = 'Replacement authorized local snapshot';
    await page.evaluate(text => {
      const transfer = new DataTransfer(); transfer.items.add(new File([text], 'replacement.json', { type: 'application/json' }));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, JSON.stringify(snapshot));
    await expect.poll(async () => (await debug(page)).sourceName).toBe('Replacement authorized local snapshot');
    release(); await page.mouse.up(); await ready(page);
    await expect(page.locator('.provider-status')).not.toContainText('Authorization required');
    await expect(page.locator('.record-label').first()).toBeAttached();
    expect((await debug(page)).providerKind).toBe('local');
  } finally { release(); await server.stop(); }
});
