import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: { url: { type: 'string' }, token: { type: 'string' }, snapshot: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, 'overview-from': { type: 'string' }, 'overview-to': { type: 'string' }, search: { type: 'string', default: '5_1 0_3' }, width: { type: 'string', default: '1600' }, height: { type: 'string', default: '1000' }, hazards: { type: 'boolean', default: false }, output: { type: 'string', default: 'docs/ui/legacy' } } });
const token = values.token || process.env.OPENBEXI_API_TOKEN;
if (!values.snapshot && (!values.url || !token)) throw new Error('Provide --snapshot or --url and OPENBEXI_API_TOKEN (or --token for a local test instance).');
if (!!values.from !== !!values.to || !!values['overview-from'] !== !!values['overview-to']) throw new Error('Time ranges require paired start and end values.');
const output = path.resolve(values.output);
await mkdir(output, { recursive: true });
const report = { capturedAt: new Date().toISOString(), source: values.snapshot || values.url, observations: [], errors: [], queries: [] };
const browser = await chromium.launch(process.platform === 'win32' ? { executablePath: process.env.OPENBEXI_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } : {});
const width = Number(values.width), height = Number(values.height);
if (![width, height].every(value => Number.isInteger(value) && value >= 320 && value <= 8192)) throw new Error('Invalid capture dimensions');
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.setDefaultTimeout(40000);
page.on('pageerror', error => report.errors.push(error.message));
page.on('request', request => { if (request.method() === 'POST' && /\/(query-sessions|layouts)$/.test(new URL(request.url()).pathname)) report.queries.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
const ready = async () => {
  await expect(page.locator('.busy-indicator')).toHaveCount(0, { timeout: 60000 });
  await expect.poll(() => page.locator('.plot-wrap').evaluate(node => Math.abs(node.querySelector('canvas').width / Math.min(devicePixelRatio, 2) - node.clientWidth)), { timeout: 60000 }).toBeLessThan(1);
};
async function capture(name) {
  await ready();
  await expect.poll(() => page.locator('.record-icon img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10000 });
  const measurements = await page.evaluate(() => {
    const state = window.__timelineDebug;
    const plot = document.querySelector('.plot-wrap').getBoundingClientRect();
    const labels = [...document.querySelectorAll('.plot-wrap .record-label')].map(node => ({ id: node.dataset.recordId, box: node.getBoundingClientRect() }));
    const overlaps = [];
    for (let index = 0; index < labels.length; index++) for (let next = index + 1; next < labels.length; next++) {
      const a = labels[index].box, b = labels[next].box;
      if (Math.min(a.right, b.right, plot.right) - Math.max(a.left, b.left, plot.left) > 0.5
          && Math.min(a.bottom, b.bottom, plot.bottom) - Math.max(a.top, b.top, plot.top) > 0.5) overlaps.push([labels[index].id, labels[next].id]);
    }
    const canvases = ['.plot-wrap canvas', '.overview-plot canvas'].map(selector => {
      const canvas = document.querySelector(selector), gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const bytes = new Uint8Array(canvas.width * canvas.height * 4), colors = new Set();
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      for (let index = 0; index < bytes.length; index += 16) colors.add(bytes[index] * 65536 + bytes[index + 1] * 256 + bytes[index + 2]);
      return { selector, width: canvas.width, height: canvas.height, colorCount: colors.size };
    });
    return { state, overlaps, canvases, namespaceLabels: [...document.querySelectorAll('.group-label')].map(node => node.textContent),
      hazards: [...document.querySelectorAll('[data-hazard-icon]')].map(node => ({ icon: node.dataset.hazardIcon, complete: node.complete, width: node.getBoundingClientRect().width, naturalWidth: node.naturalWidth, embedded: node.src.startsWith('data:image/png') })),
      minorTicks: JSON.parse(document.querySelector('.plot-wrap canvas').dataset.minorTicks || '[]'),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      status: document.querySelector('.save-status').textContent };
  });
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  report.observations.push({ name, ...measurements });
  expect(measurements.state.providerKind).toBe(values.snapshot ? 'local' : 'server');
  expect(measurements.status).toContain('Read-only');
  expect(measurements.overlaps).toEqual([]);
  expect(measurements.horizontalOverflow).toBe(false);
  for (const canvas of measurements.canvases) {
    if (canvas.selector.includes('overview') && measurements.state.overviewMatched === 0) continue;
    expect(canvas.colorCount).toBeGreaterThan(canvas.selector.includes('plot-wrap') && measurements.hazards.length ? 1 : 2);
  }
}
async function search(value) {
  const previous = await page.evaluate(() => window.__timelineDebug.queryId);
  await page.locator('#search').fill(value);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.queryId), { timeout: 60000 }).not.toBe(previous);
  await ready();
}
async function range(from, to) {
  const previous = await page.evaluate(() => window.__timelineDebug.queryId);
  await page.locator('.range-button').click();
  const input = value => new Date(value).toISOString().replace(/:00\.000Z$/, '').replace(/Z$/, '');
  await page.locator('#range-form [name=from]').fill(input(from));
  await page.locator('#range-form [name=to]').fill(input(to));
  await page.locator('#range-form [type=submit]').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.queryId), { timeout: 60000 }).not.toBe(previous);
  await ready();
}
try {
  const standalone = await readFile(path.resolve('dist/index.html'));
  report.standaloneBundleSha256 = createHash('sha256').update(standalone).digest('hex');
  const response = await page.goto(values.url || pathToFileURL(path.resolve('dist/index.html')).href);
  report.loadedBundleSha256 = createHash('sha256').update(values.url ? await response.body() : standalone).digest('hex');
  expect(report.loadedBundleSha256).toBe(report.standaloneBundleSha256);
  await expect(page.locator('.record-label').first()).toBeVisible(); await ready();
  await page.locator('[data-action=sources]').first().click();
  if (values.snapshot) await page.locator('#json-file').setInputFiles(path.resolve(values.snapshot));
  else {
    await page.locator('#server-form [name=baseUrl]').fill(values.url);
    await page.locator('#server-form [name=token]').fill(token);
    await page.locator('#server-form [type=submit]').click();
    await expect(page.locator('#switch-source')).toBeVisible();
    await page.locator('#switch-source').click();
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server');
  }
  await expect(page.locator('.save-status')).toContainText('Read-only');
  await ready();
  if (values['overview-from']) await range(values['overview-from'], values['overview-to']);
  if (values.from) await range(values.from, values.to);
  await expect(page.locator('.record-label').first()).toBeVisible(); await ready();
  await expect(page.locator('[data-action=create]').first()).toBeDisabled();
  await capture('legacy-namespace-desktop');
  if (values.hazards) { expect(report.observations[0].hazards.length).toBeGreaterThan(0); expect(report.observations[0].hazards.every(icon => icon.embedded && icon.complete && icon.width === 16)).toBe(true); expect(report.observations[0].minorTicks.length).toBeGreaterThan(0); }
  await search(values.search);
  for (let index = 0; index < 100 && await page.locator('.record-label.search-match').count() === 0 && await page.locator('[data-action=next]').isEnabled(); index++) {
    const before = await page.evaluate(() => window.__timelineDebug.startRow);
    await page.locator('[data-action=next]').click();
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.startRow), { timeout: 60000 }).toBeGreaterThan(before);
    await ready();
  }
  await capture('legacy-search');
  report.visibleSearchMatches = await page.locator('.record-label.search-match').count();
  report.searchMatched = await page.evaluate(() => window.__timelineDebug.overviewMatched);
  if (values.hazards) { expect(report.visibleSearchMatches).toBeGreaterThan(0); expect(report.searchMatched).toBeGreaterThan(0); }
  await search('');
  await page.locator('.record-label').first().click();
  await expect(page.locator('.descriptor')).toBeVisible(); await capture('legacy-descriptor');
  await page.locator('[data-action=close-descriptor]').click(); await ready();
  await page.locator('[data-action=models]').first().click();
  await expect(page.locator('.model-version')).toBeEnabled();
  await expect(page.locator('[data-action=model-save]')).toBeDisabled();
  await page.screenshot({ path: path.join(output, 'legacy-model-library.png'), fullPage: true });
  await page.locator('[data-action=model-close]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('legacy-namespace-mobile');
  if (values.hazards) {
    await page.setViewportSize({ width, height }); await ready();
    const before = await page.evaluate(() => window.__timelineDebug), box = await page.locator('.plot-wrap').boundingBox();
    const overviewBefore = await page.locator('.overview-window').boundingBox();
    const x = box.x + box.width * 0.4, y = box.y + box.height * 0.8, dx = 96;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y, { steps: 8 });
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.navigationOffset)).toBeGreaterThan(dx - 1);
    const held = await page.evaluate(() => window.__timelineDebug);
    expect(held.mapId).toBe(before.mapId); expect(held.queryId).toBe(before.queryId); expect(held.fromMs).toBe(before.fromMs);
    const offsets = await page.evaluate(() => ['.record-label-layer', '.axis-tick-layer'].map(selector => new DOMMatrixReadOnly(getComputedStyle(document.querySelector(selector)).transform).m41));
    offsets.forEach(offset => expect(offset).toBeCloseTo(dx, 1));
    expect((await page.locator('.overview-window').boundingBox()).x).toBeLessThan(overviewBefore.x);
    await page.screenshot({ path: path.join(output, 'legacy-drag-held.png'), fullPage: true });
    await page.waitForTimeout(210); await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.navigationPhase)).toBe('idle'); await ready();
    const after = await page.evaluate(() => window.__timelineDebug);
    expect(after.mapId).toBe(before.mapId); expect(after.queryId).toBe(before.queryId); expect(after.fromMs).not.toBe(before.fromMs); expect(after.navigationOffset).toBe(0); expect(after.dirty).toBe(false);
    report.drag = { status: 'passed', before: { fromMs: before.fromMs, toMs: before.toMs }, after: { fromMs: after.fromMs, toMs: after.toMs }, heldOffsets: offsets, pinnedQuery: true, pinnedMap: true, dirty: after.dirty };
    await page.screenshot({ path: path.join(output, 'legacy-drag-settled.png'), fullPage: true });
  }
  expect(report.errors).toEqual([]);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.message;
  await page.screenshot({ path: path.join(output, 'legacy-capture-failed.png'), fullPage: true });
  throw error;
} finally {
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  process.stdout.write(JSON.stringify({ status: report.status, output, captures: report.observations.length, searchMatched: report.searchMatched }) + '\n');
}
