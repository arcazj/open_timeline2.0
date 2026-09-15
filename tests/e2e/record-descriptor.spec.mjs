import { test, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startLegacyServer, legacyDomain } from '../integration/legacy-server-fixture.mjs';
import { ServerProvider } from '../../client/src/data/server-provider.js';

let server, snapshot;
test.beforeEach(async () => {
  server = await startLegacyServer();
  const provider = new ServerProvider({ baseUrl: server.baseUrl, token: server.token });
  await provider.initialize(); snapshot = await provider.exportSnapshot(); await provider.dispose();
});
test.afterEach(async () => {
  try { for (const [filename, original] of server?.originals || []) expect(await readFile(filename)).toEqual(original); }
  finally { await server?.stop(); }
});

const target = () => snapshot.records.find(record => record.extensions.legacy.id === 'long');
const label = page => page.locator(`.plot-wrap .record-label[data-record-id="${target().id}"]`);
async function ready(page) { await expect(page.locator('.busy-indicator')).toHaveCount(0); }
async function openServer(page) {
  await page.goto(server.baseUrl);
  await expect(page.locator('.record-label').first()).toBeVisible(); await ready(page);
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl);
  await page.locator('#server-form [name=token]').fill(server.token);
  await page.locator('#server-form [type=submit]').click();
  await page.locator('#switch-source').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug?.providerKind)).toBe('server');
  await ready(page);
  await page.locator('.range-button').click();
  await page.locator('#range-form [name=from]').fill(legacyDomain.from.slice(0, 16));
  await page.locator('#range-form [name=to]').fill(legacyDomain.to.slice(0, 16));
  await page.locator('#range-form [type=submit]').click();
  await ready(page); await expect(label(page)).toBeVisible();
}
async function sidecar(description = 'Linked source description') {
  const filename = path.join(server.directory, 'authority/alpha/2023/12/31/descriptors/long.json');
  await mkdir(path.dirname(filename), { recursive: true });
  const value = { event_descriptor: [{ id: 'long', data: { namespace: 'alpha', title: 'Linked session detail', description, status: 'FAILED', optional: null, telemetry: { count: 0, enabled: false } } }] };
  await writeFile(filename, JSON.stringify(value));
  return { filename, bytes: await readFile(filename) };
}

test('legacy selection automatically opens safe sidecar fields, with missing/retry states and no source writes', async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openServer(page); await label(page).click();
  await expect(page.locator('.descriptor')).toBeVisible();
  await expect(page.locator('.legacy-descriptor [role=status]')).toHaveText('No matching descriptor sidecar.');
  const file = await sidecar('<script>window.descriptorExecuted = true</script>');
  await page.getByRole('button', { name: 'Retry descriptor', exact: true }).click();
  await expect(page.locator('.linked-descriptor-fields')).toContainText('Linked session detail');
  await expect(page.locator('.linked-descriptor-fields')).toContainText('FAILED');
  await expect(page.locator('.linked-descriptor-fields')).toContainText('(null)');
  await expect(page.locator('.linked-descriptor-fields')).toContainText('"enabled": false');
  await expect(page.locator('.linked-descriptor-fields')).toContainText('<script>window.descriptorExecuted = true</script>');
  expect(await page.locator('.descriptor script').count()).toBe(0);
  expect(await page.evaluate(() => window.descriptorExecuted)).toBeUndefined();
  await expect(page.locator('.descriptor-data')).toContainText('Legacy record ID');
  await expect(page.locator('.descriptor-data')).toContainText('alpha');
  for (const action of ['edit', 'duplicate', 'delete', 'time-edit']) await expect(page.locator(`.descriptor [data-action=${action}]`)).toBeDisabled();
  await ready(page); await expect(page.locator('.toast')).toHaveCount(0);
  await page.locator('.linked-descriptor-fields').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('legacy-descriptor-desktop.png'), fullPage: true });
  expect(await readFile(file.filename)).toEqual(file.bytes); expect(errors).toEqual([]);
});

test('a delayed sidecar cannot revive a closed descriptor or replace another selection', async ({ page }, info) => {
  await sidecar(); await openServer(page);
  let requested;
  const requestStarted = new Promise(resolve => { requested = resolve; });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(`**/records/${target().id}/legacy-descriptor`, async route => {
    requested(); await held;
    try { await route.fulfill({ json: { status: 'current', descriptor: { data: { description: 'Late obsolete sidecar' } } } }); } catch { /* The selection cancelled this request. */ }
  });
  await label(page).click(); await requestStarted;
  await page.locator('[data-action=close-descriptor]').click();
  release();
  await expect(page.locator('.descriptor')).toBeHidden();
  await expect(page.locator('.descriptor')).not.toContainText('Late obsolete sidecar');
  await page.unroute(`**/records/${target().id}/legacy-descriptor`);
  await label(page).click(); await expect(page.locator('.linked-descriptor-fields')).toContainText('Linked source description');
  await ready(page);
  await expect.poll(() => page.locator('.plot-wrap').evaluate(node => Math.abs(node.querySelector('canvas').width / Math.min(devicePixelRatio, 2) - node.clientWidth))).toBeLessThan(1);
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('legacy-descriptor-clean-desktop.png'), fullPage: true });
  const next = page.locator('.plot-wrap .record-label').filter({ hasNotText: 'Cross-year session Match_5_1' }).first();
  const title = await next.textContent(); await next.click();
  await expect(page.locator('.descriptor h3')).toContainText(title.trim());
  await expect(page.locator('.descriptor')).not.toContainText('Linked source description');
});

test('offline descriptors retain complete imported metadata, keyboard access and narrow-screen layout', async ({ page }, info) => {
  const value = target(); value.data.description = 'Inline source description'; value.data.legacy.description = value.data.description;
  value.data.legacy.status = 'FAILED'; value.data.legacy.nested = { text: 'x'.repeat(12000), safe: '<img src=x onerror=alert(1)>' };
  value.originalStart = '2023-12-30T00:00:00.000Z'; value.originalEnd = '2024-04-02T00:00:00.000Z';
  snapshot.settings.range = legacyDomain; snapshot.settings.overview = legacyDomain; delete snapshot.manifest.contentSha256;
  await page.goto(pathToFileURL(path.resolve('dist/index.html')).href);
  await expect(page.locator('.record-label').first()).toBeVisible(); await ready(page);
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#json-file').setInputFiles({ name: 'descriptor-snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
  await expect(page.locator('#json-file')).toHaveCount(0); await ready(page);
  await expect(label(page)).toBeVisible(); await label(page).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.descriptor')).toBeVisible(); await expect(page.locator('.descriptor-data')).toContainText('Original start / UTC');
  await expect(page.locator('.descriptor-data')).toContainText('FAILED');
  await expect(page.locator('.legacy-descriptor')).toHaveCount(0);
  const detail = page.locator('.descriptor-data details'); await detail.locator('summary').click();
  await expect(detail.locator('pre')).toContainText('x'.repeat(12000)); expect(await page.locator('.descriptor img').count()).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page); await expect(page.locator('.toast')).toHaveCount(0);
  await expect(page.locator('.descriptor-data details')).toHaveAttribute('open', '');
  await expect.poll(() => page.locator('.descriptor').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  const box = await page.locator('.descriptor').boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath('legacy-descriptor-mobile.png'), fullPage: true });
  await page.locator('[data-action=close-descriptor]').focus(); await page.keyboard.press('Escape');
  await expect(page.locator('.descriptor')).toBeHidden(); await expect(page.locator('.plot-wrap')).toBeFocused();
});
