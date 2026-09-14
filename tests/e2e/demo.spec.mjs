import { test, expect } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const site = 'https://openbexi-demo.test/open_timeline2.0/';
const artifact = path.resolve('artifacts/demo/index.html');
const html = () => readFile(artifact, 'utf8');
const ready = page => expect.poll(() => page.evaluate(() => window.__timelineDebug?.ready)).toBe(true);

async function openHosted(page) {
  const errors = [], unexpected = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    // A static host correctly returns 404 to the bounded backend discovery probe.
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
  });
  page.on('dialog', dialog => dialog.accept());
  const source = await html();
  await page.route(/^https?:/, route => {
    const url = route.request().url();
    if (url === site) return route.fulfill({ status: 200, contentType: 'text/html', body: source });
    if (url === 'https://openbexi-demo.test/api/v1/bootstrap') return route.fulfill({ status: 404, contentType: 'text/html', body: 'Not found' });
    unexpected.push(url);
    return route.abort();
  });
  await page.goto(site);
  await ready(page);
  return { errors, unexpected };
}

async function canvasColors(page) {
  return page.locator('.plot-wrap canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2');
    const bytes = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    const colors = new Set();
    for (let i = 0; i < bytes.length; i += 4) colors.add(`${bytes[i]},${bytes[i + 1]},${bytes[i + 2]}`);
    return colors.size;
  });
}

test('demo package contains the same standalone application and only intended public files', async () => {
  expect((await readdir(path.dirname(artifact))).sort()).toEqual(['.nojekyll', 'THIRD-PARTY-NOTICES.json', 'index.html']);
  expect(await readFile(artifact)).toEqual(await readFile('dist/index.html'));
  expect(await readFile(path.join(path.dirname(artifact), 'THIRD-PARTY-NOTICES.json'))).toEqual(await readFile('dist/THIRD-PARTY-NOTICES.json'));
});

test('HTTPS project-site demo supports all datasets, row paging, and offline navigation', async ({ page }, info) => {
  test.setTimeout(90000);
  const observed = await openHosted(page);
  await expect(page.locator('.provider-status')).toContainText('Local');
  expect(await canvasColors(page)).toBeGreaterThan(8);
  await expect(page.locator('.overview-plot canvas')).toBeVisible();
  await page.screenshot({ path: info.outputPath('demo-desktop.png') });
  const initial = await page.evaluate(() => window.__timelineDebug);
  await page.locator('[data-action=next]').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.startRow)).toBeGreaterThan(initial.startRow);
  const next = await page.evaluate(() => window.__timelineDebug);
  for (const field of ['fromMs', 'toMs', 'mapId']) expect(next[field]).toBe(initial[field]);
  await page.context().setOffline(true);
  try {
    for (const [id, count] of [['ephemeris',127], ['jfk',130], ['monet',27], ['religions',730], ['space_exploration',1287], ['default-dataset',48]]) {
      await page.locator('[data-action=help]').click();
      await page.getByLabel('Test local dataset', { exact: true }).selectOption(id);
      await page.locator('[data-help=open-test-data]').click();
      await expect.poll(() => page.evaluate(() => window.__timelineDebug.testDatasetId)).toBe(id);
      await ready(page);
      expect(await page.evaluate(() => window.__timelineDebug.recordCount)).toBe(count);
      await expect(page.locator('.plot-wrap .record-label').first()).toBeVisible();
    }
    const before = await page.evaluate(() => window.__timelineDebug.fromMs);
    await page.locator('.plot-wrap').focus();
    await page.keyboard.press('ArrowRight');
    await ready(page);
    expect(await page.evaluate(() => window.__timelineDebug.fromMs)).not.toBe(before);
    expect(await canvasColors(page)).toBeGreaterThan(8);
    expect(observed.errors).toEqual([]);
    expect(observed.unexpected).toEqual([]);
  } finally { await page.context().setOffline(false); }
});

test('mobile project-site demo has visible canvases and no horizontal page overflow', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const observed = await openHosted(page);
  await expect(page.locator('.plot-wrap .record-label').first()).toBeVisible();
  await expect(page.locator('.overview-plot canvas')).toBeVisible();
  expect(await canvasColors(page)).toBeGreaterThan(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath('demo-mobile.png') });
  expect(observed.errors).toEqual([]);
  expect(observed.unexpected).toEqual([]);
});

test('the packaged HTML opens from a local file without any HTTP request', async ({ page }) => {
  const requests = [];
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.route(/^https?:/, route => route.abort());
  await page.goto(pathToFileURL(artifact).href);
  await ready(page);
  expect(await canvasColors(page)).toBeGreaterThan(8);
  expect(requests).toEqual([]);
});
