import { test, expect } from '@playwright/test';
import { startServer } from '../integration/server-fixture.mjs';
import fixture from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };

test('server outage preserves the version-2 predicate and regex search in the complete local snapshot', async ({ page }) => {
  const server = await startServer();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(server.baseUrl);
    await expect(page.locator('.record-label').first()).toBeVisible();
    await expect(page.locator('.busy-indicator')).toHaveCount(0);
    await page.locator('[data-action=sources]').first().click();
    await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl);
    await page.locator('#server-form [name=token]').fill(server.token);
    await page.locator('#server-form [type=submit]').click();
    await page.locator('#switch-source').click();
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server');
    await expect(page.locator('.busy-indicator')).toHaveCount(0);
    await page.locator('[data-view=table]').click();
    await page.locator('[data-action=filters]').first().click();
    const form = page.locator('#settings-form');
    await form.locator('[name=definitionVersion]').selectOption('2');
    await form.locator('[data-filter-command=add-root]').click();
    await form.locator('[data-filter-op]').selectOption('regex');
    await form.locator('[data-filter-value]').fill('^Telemetry');
    await form.locator('[name=searchMode]').selectOption('regex');
    await form.locator('[name=search]').fill('telemetry.*');
    await form.locator('[data-search-regex-flag=i]').check();
    await form.locator('[data-search-regex-mode]').selectOption('full');
    await form.locator('[type=submit]').click();
    await expect(form).toHaveCount(0);
    const count = fixture.records.filter(record => record.title.startsWith('Telemetry')).length;
    await expect(page.locator('.table-view tbody tr')).toHaveCount(count);
    const before = await page.evaluate(() => window.__timelineDebug);

    await server.pause();
    await page.locator('[data-action=refresh]').first().click();
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('local');
    await expect(page.locator('.busy-indicator')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(count);
    await page.locator('[data-view=table]').click();
    await expect(page.locator('.table-view tbody tr')).toHaveCount(count);
    await expect(page.locator('.notice')).toContainText('may differ');
    const after = await page.evaluate(() => window.__timelineDebug);
    expect(after.fromMs).toBe(before.fromMs); expect(after.toMs).toBe(before.toMs);
    await page.locator('[data-action=filters]').first().click();
    await expect(form.locator('[name=definitionVersion]')).toHaveValue('2');
    await expect(form.locator('[data-filter-value]')).toHaveValue('^Telemetry');
    await expect(form.locator('[name=searchMode]')).toHaveValue('regex');
    await expect(form.locator('[name=search]')).toHaveValue('telemetry.*');
    await expect(form.locator('[data-search-regex-flag=i]')).toBeChecked();
    await expect(form.locator('[data-search-regex-mode]')).toHaveValue('full');
    expect(errors).toEqual([]);
  } finally { await server.stop(); }
});
