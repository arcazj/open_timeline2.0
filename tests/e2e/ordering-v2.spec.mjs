import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startServer } from '../integration/server-fixture.mjs';

let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });

async function version2(page) {
  await page.goto(server.baseUrl);
  await expect(page.locator('.record-label').first()).toBeVisible();
  await page.locator('[data-action=filters]').first().click();
  await page.locator('#settings-form [name=definitionVersion]').selectOption('2');
  await page.locator('#settings-form [type=submit]').click();
  await expect(page.locator('#settings-form')).toHaveCount(0);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
}

test('v2 natural table controls preserve options and focus across sorting and export explicit roles', async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await version2(page);
  await page.locator('[data-view=table]').click();
  const table = page.locator('.table-view');
  await expect(table).toHaveAttribute('aria-busy', 'false');
  await expect(table.locator('[data-table-order]')).toBeDisabled();
  await table.locator('[data-table-sort=title]').click();
  await expect(table.locator('[data-table-order]')).toBeEnabled();
  await table.locator('[data-table-order]').selectOption('natural');
  await table.locator('[data-table-case]').uncheck();
  await expect(table).toHaveAttribute('aria-busy', 'false');
  const before = await page.evaluate(() => window.__timelineDebug);
  await table.locator('[data-table-sort=title]').focus();
  await table.locator('[data-table-sort=title]').press('Enter');
  await expect(table).toHaveAttribute('aria-busy', 'false');
  await expect(table.locator('[data-table-sort=title]')).toBeFocused();
  await expect(table.locator('[data-table-order]')).toHaveValue('natural');
  await expect(table.locator('[data-table-case]')).not.toBeChecked();
  await expect(table.locator('th.table-role')).toHaveText('Result role');
  await expect(table.locator('tbody tr').first()).toHaveAttribute('data-result-role', 'direct');
  const after = await page.evaluate(() => window.__timelineDebug);
  expect(after.fromMs).toBe(before.fromMs); expect(after.toMs).toBe(before.toMs);
  const downloaded = page.waitForEvent('download');
  await table.locator('[data-table-action=export]').click();
  const download = await downloaded, content = await readFile(await download.path(), 'utf8');
  expect(download.suggestedFilename()).toContain('-context-snapshot-');
  expect(content.split('\n')[0]).toContain('"Result role","Direct predicate match","Search finding","Matching descendants"');
  await page.screenshot({ path: info.outputPath('table-natural-order-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(table.locator('.table-scroll')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: info.outputPath('table-natural-order-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('v2 keyboard group collapse retains query and map and renders a nonblank timeline', async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await version2(page);
  await page.locator('[data-action=settings]').first().click();
  await page.locator('#settings-form [name=groupBy]').selectOption('sourceId');
  await page.locator('#settings-form [type=submit]').click();
  await expect(page.locator('#settings-form')).toHaveCount(0);
  const group = page.locator('.plot-wrap .group-toggle').first();
  await expect(group).toBeVisible();
  const key = await group.getAttribute('data-group-key');
  const before = await page.evaluate(() => window.__timelineDebug);
  await group.focus(); await group.press('Enter');
  await expect.poll(async () => page.locator('.plot-wrap [data-group-key]').evaluateAll((nodes, value) => nodes.find(node => node.dataset.groupKey === value)?.getAttribute('aria-expanded'), key)).toBe('false');
  const after = await page.evaluate(() => window.__timelineDebug);
  expect(after.queryId).toBe(before.queryId); expect(after.mapId).toBe(before.mapId);
  expect(after.fromMs).toBe(before.fromMs); expect(after.toMs).toBe(before.toMs);
  expect(await page.evaluate(value => document.activeElement?.dataset.groupKey === value, key)).toBe(true);
  const pixels = await page.locator('.plot-wrap canvas').first().evaluate(canvas => {
    const target = document.createElement('canvas'); target.width = canvas.width; target.height = canvas.height;
    const context = target.getContext('2d'); context.drawImage(canvas, 0, 0);
    const data = context.getImageData(0, 0, target.width, target.height).data, colors = new Set();
    for (let offset = 0; offset < data.length; offset += 400) colors.add(`${data[offset]},${data[offset + 1]},${data[offset + 2]}`);
    return colors.size;
  });
  expect(pixels).toBeGreaterThan(3);
  await page.screenshot({ path: info.outputPath('group-collapse-desktop.png'), fullPage: true });
  expect(errors).toEqual([]);
});
