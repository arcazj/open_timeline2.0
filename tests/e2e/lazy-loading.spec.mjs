import { test, expect } from '@playwright/test';
import { startLocalPathsServer } from '../integration/local-paths-server-fixture.mjs';

const debug = page => page.evaluate(() => window.__timelineDebug);
const ready = page => expect.poll(async () => (await debug(page))?.ready).toBe(true);

for (const width of [1600, 390]) test(`cold archive loads real viewport before indexing and prefetches during navigation (${width}px)`, async ({ page }, info) => {
  test.setTimeout(60000);
  const server = await startLocalPathsServer({ deferIndex: true, archiveDays: 120 });
  const errors = [], queries = [], prefetches = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/query-sessions')) queries.push(request.postDataJSON());
    if (request.url().endsWith('/legacy/prefetch')) prefetches.push(request.postDataJSON());
  });
  try {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const started = performance.now();
    await page.goto(server.baseUrl); await ready(page);
    const firstRecordsMs = performance.now() - started, before = await debug(page);
    expect(before.providerKind).toBe('server'); expect(before.detailTotal).toBe(6);
    expect(before.coverage.complete).toBe(false);
    await expect(page.locator('.server-startup')).toContainText('provisional');
    const first = queries[0].domain, span = Number(before.toMs) - Number(before.fromMs);
    expect(Date.parse(first.to) - Date.parse(first.from)).toBeLessThanOrEqual(span * 1.5 + 2);
    const loading = await page.evaluate(async () => (await fetch('/api/v1/workspaces/default/legacy/loading', { headers: { 'X-OpenBEXI-Local': '1' } })).json());
    expect(loading.metrics.indexFilesRead).toBe(0);
    expect(loading.metrics.bytesRead).toBeLessThan(100000);
    expect(loading.metrics.cacheBytes).toBeLessThanOrEqual(loading.metrics.cacheLimitBytes);
    for (const selector of ['.plot-wrap canvas', '.overview-plot canvas']) {
      const colors = await page.locator(selector).evaluate(canvas => {
        const gl = canvas.getContext('webgl2'), pixels = new Uint8Array(canvas.width * canvas.height * 4), colors = new Set();
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
        return colors.size;
      });
      expect(colors).toBeGreaterThan(8);
    }
    await page.screenshot({ path: info.outputPath(`lazy-real-${width}.png`), fullPage: true });
    const plot = await page.locator('.plot-wrap').boundingBox(), x = plot.x + plot.width * .75, y = plot.y + plot.height * .7;
    const count = prefetches.length;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x - plot.width * .6, y, { steps: 16 });
    await expect.poll(async () => (await debug(page)).navigationPhase).toBe('dragging');
    await expect.poll(() => prefetches.length).toBeGreaterThan(count);
    expect((await debug(page)).queryId).toBe(before.queryId);
    await page.waitForTimeout(180);
    const held = await debug(page);
    await page.mouse.up(); await ready(page);
    await info.attach('navigation-debug.json', { body: JSON.stringify({ before, held, after: await debug(page) }), contentType: 'application/json' });
    expect((await debug(page)).queryId).not.toBe(before.queryId);
    expect(prefetches.length - count).toBeLessThan(8);
    await expect(page.locator('.notice')).toBeHidden();
    await page.getByRole('button', { name: 'Date and time range', exact: true }).click();
    await page.getByLabel('Start / UTC', { exact: true }).fill(new Date(Number(before.fromMs)).toISOString().slice(0, 19));
    await page.getByLabel('End / UTC', { exact: true }).fill(new Date(Number(before.toMs)).toISOString().slice(0, 19));
    await page.getByRole('button', { name: 'Apply range', exact: true }).click(); await ready(page);
    const pinned = (await debug(page)).queryId;
    await server.releaseIndex();
    await expect(page.getByRole('button', { name: 'Refresh verified view', exact: true })).toBeVisible({ timeout: 30000 });
    expect((await debug(page)).queryId).toBe(pinned);
    await page.getByRole('button', { name: 'Refresh verified view', exact: true }).click(); await ready(page);
    expect((await debug(page)).coverage.complete).toBe(true);
    expect((await debug(page)).detailTotal).toBe(7);
    await expect(page.locator('.record-label').filter({ hasText: 'Earlier crossing session' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await info.attach('window-loading-metrics.json', { body: JSON.stringify({ width, archiveFiles: 360, urlAvailableMs: server.urlAvailableMs, firstRecordsMs,
      initialLoading: loading, queryRequests: queries.length, prefetchRequests: prefetches.length }), contentType: 'application/json' });
    expect(errors).toEqual([]);
  } finally { await server.stop(); }
});

test('server failure during navigation retains real data and never substitutes a sample snapshot', async ({ page }) => {
  const server = await startLocalPathsServer();
  try {
    await page.goto(server.baseUrl); await ready(page);
    const before = await debug(page);
    await page.route('**/api/v1/workspaces/default/query-sessions', route => route.abort());
    await page.locator('.plot-wrap').focus(); await page.keyboard.press('ArrowRight');
    await expect(page.locator('.notice')).toContainText('no sample data was substituted');
    const after = await debug(page);
    expect(after.providerKind).toBe('server'); expect(after.providerId).toBe(before.providerId);
    expect(after.queryId).toBe(before.queryId);
    await page.unroute('**/api/v1/workspaces/default/query-sessions');
    await page.getByRole('button', { name: 'Retry', exact: true }).click(); await ready(page);
    await expect(page.locator('.notice')).toBeHidden();
  } finally { await server.stop(); }
});
