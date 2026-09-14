import { test, expect } from '@playwright/test';
import { startLocalPathsServer } from '../integration/local-paths-server-fixture.mjs';

let server;
test.beforeEach(async () => { server = await startLocalPathsServer({ deferStartup: true }); });
test.afterEach(async () => { await server?.stop(); });

for (const width of [1600, 390]) test(`server startup shows only configured source, never demo records (${width}px)`, async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.addInitScript(() => { const Worker = window.Worker; window.__workers = 0; window.Worker = class extends Worker { constructor(...args) { super(...args); window.__workers++; } }; });
  expect((await fetch(`${server.baseUrl}/health/ready`)).status).toBe(503);
  await page.goto(server.baseUrl);
  await expect(page.locator('.server-startup')).toContainText('SOURCE1');
  await expect(page.locator('.record-label')).toHaveCount(0);
  await expect(page.locator('.provider-status')).not.toContainText('Local');
  expect(await page.evaluate(() => window.__workers)).toBe(0);
  await page.screenshot({ path: info.outputPath(`startup-real-${width}.png`), fullPage: true });
  await server.releaseStartup();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug?.ready)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(6);
  await expect(page.locator('.provider-status')).toContainText('Server / Connected');
  await expect(page.locator('.record-label').first()).toContainText('SOURCE');
  expect(await page.evaluate(() => window.__workers)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await info.attach('startup-timing.json', { body: JSON.stringify({ urlAvailableMs: server.urlAvailableMs }), contentType: 'application/json' });
  expect(errors).toEqual([]);
});

test('failed initialization keeps the configured source and provides retry without sample fallback', async ({ page }) => {
  await page.goto(server.baseUrl);
  await expect(page.locator('.server-startup')).toContainText('SOURCE1');
  await server.releaseStartup(true);
  await expect(page.locator('.server-startup')).toContainText('initialization failed');
  await page.getByRole('button', { name: 'Retry server connection', exact: true }).click();
  await expect(page.locator('.server-startup')).toContainText('initialization failed');
  await expect(page.locator('.record-label')).toHaveCount(0);
  await expect(page.locator('.provider-status')).not.toContainText('Local');
});
