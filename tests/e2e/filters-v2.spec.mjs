import { test, expect } from '@playwright/test';
import { startServer } from '../integration/server-fixture.mjs';
import fixture from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };

let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });
async function ready(page) { await expect(page.locator('.busy-indicator')).toHaveCount(0); }
async function open(page, mode) {
  await page.goto(server.baseUrl); await expect(page.locator('.record-label').first()).toBeVisible(); await ready(page);
  if (mode === 'server') {
    await page.locator('[data-action=sources]').first().click();
    await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl); await page.locator('#server-form [name=token]').fill(server.token);
    await page.locator('#server-form [type=submit]').click(); await page.locator('#switch-source').click();
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server'); await ready(page);
  }
  await page.locator('[data-view=table]').click(); await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
  await page.locator('[data-action=filters]').first().click(); return page.locator('#settings-form');
}
async function apply(form) { await form.locator('[type=submit]').click(); await expect(form).toHaveCount(0); await ready(form.page()); }

for (const mode of ['local', 'server']) {
  test(`${mode} version 2 regex conditions round-trip losslessly and preview without replacing the active query`, async ({ page }, info) => {
    const form = await open(page, mode), before = await page.evaluate(() => window.__timelineDebug.queryId);
    await form.locator('[name=definitionVersion]').selectOption('2');
    await form.locator('[data-filter-command=add-root]').click(); await form.locator('[data-filter-op]').selectOption('regex');
    await form.locator('[data-filter-value]').fill('^Telemetry');
    await form.locator('[data-filter-mode=advanced]').click();
    const expression = JSON.parse(await form.locator('[aria-label="Filter expression JSON"]').inputValue());
    expression.root.ruleId = 'telemetry-rule';
    await form.locator('[aria-label="Filter expression JSON"]').fill(JSON.stringify(expression, null, 2));
    await form.locator('[data-filter-mode=simple]').click(); await expect(form.locator('[data-filter-value]')).toHaveValue('^Telemetry');
    await form.locator('[data-filter-mode=advanced]').click(); expect(JSON.parse(await form.locator('[aria-label="Filter expression JSON"]').inputValue())).toEqual(expression);
    await form.locator('#filter-preview').click(); await expect(form.locator('.filter-preview-status')).toContainText('filter results');
    expect(await page.evaluate(() => window.__timelineDebug.queryId)).toBe(before); await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
    await page.screenshot({ path: info.outputPath(`filter-v2-${mode}-advanced.png`), fullPage: true });
    await apply(form);
    await expect(page.locator('.table-view tbody tr')).toHaveCount(fixture.records.filter(record => record.title.startsWith('Telemetry')).length);
    await page.locator('[data-action=filters]').first().click();
    await expect(page.locator('#settings-form [name=definitionVersion]')).toHaveValue('2');
    await page.locator('#filter-undo').click(); await expect(page.locator('#settings-form')).toHaveCount(0);
    await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
  });

  test(`${mode} invalid advanced drafts and unsafe regex cannot apply; reset and cancel preserve the active view`, async ({ page }) => {
    const form = await open(page, mode), before = await page.evaluate(() => window.__timelineDebug.queryId);
    await form.locator('[name=definitionVersion]').selectOption('2');
    await form.locator('[data-filter-mode=advanced]').click(); await form.locator('[aria-label="Filter expression JSON"]').fill('{"version":2,');
    await expect(form.locator('[type=submit]')).toBeDisabled(); await expect(form.locator('.filter-error')).toContainText('JSON');
    await form.locator('[data-filter-mode=simple]').click(); await expect(form.locator('.filter-advanced')).toBeVisible();
    await expect(form.locator('[aria-label="Filter expression JSON"]')).toHaveValue('{"version":2,');
    await form.locator('#filter-reset').click(); await expect(form.locator('[name=definitionVersion]')).toHaveValue('1');
    await form.locator('[name=definitionVersion]').selectOption('2'); await form.locator('[name=searchMode]').selectOption('regex');
    await form.locator('[name=search]').fill('(?=secret)'); await expect(form.locator('[type=submit]')).toBeDisabled();
    await expect(form.locator('.filter-error')).toBeVisible(); await form.locator('#filter-cancel').click();
    await expect(form).toHaveCount(0); expect(await page.evaluate(() => window.__timelineDebug.queryId)).toBe(before);
    await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
  });

  test(`${mode} regex search has explicit flags and full-field mode`, async ({ page }) => {
    const form = await open(page, mode);
    await form.locator('[name=definitionVersion]').selectOption('2'); await form.locator('[name=searchMode]').selectOption('regex');
    await form.locator('[name=search]').fill('telemetry.*'); await form.locator('[data-search-regex-flag=i]').check();
    await form.locator('[data-search-regex-mode]').selectOption('full');
    await apply(form); await page.locator('[data-table-projection]').selectOption('matches');
    await expect(page.locator('.table-view tbody tr')).toHaveCount(fixture.records.filter(record => record.title.toLowerCase().startsWith('telemetry')).length);
    await page.locator('[data-action=filters]').first().click();
    await expect(page.locator('[data-search-regex-flag=i]')).toBeChecked(); await expect(page.locator('[data-search-regex-mode]')).toHaveValue('full');
  });
}

test('version 2 missing/null/value selectors and narrow-screen editor stay readable', async ({ page }, info) => {
  const form = await open(page, 'local'); await page.setViewportSize({ width: 390, height: 844 });
  await form.locator('[name=definitionVersion]').selectOption('2'); await form.locator('[data-filter-command=add-root]').click();
  await form.locator('[data-filter-field]').selectOption('/data/status'); await form.locator('[data-filter-op]').selectOption('isMissing');
  await form.locator('[data-filter-mode=advanced]').click();
  expect(JSON.parse(await form.locator('[aria-label="Filter expression JSON"]').inputValue()).root).toEqual({ op: 'exists', field: '/data/status', value: false });
  await form.locator('[data-filter-mode=simple]').click(); await form.locator('[data-filter-op]').selectOption('isNull');
  await form.locator('[data-filter-mode=advanced]').click();
  expect(JSON.parse(await form.locator('[aria-label="Filter expression JSON"]').inputValue()).root).toEqual({ op: 'eq', field: '/data/status', value: null });
  await form.locator('[data-filter-mode=simple]').click(); await form.locator('[data-filter-op]').selectOption('hasValue');
  expect(await form.evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
  await page.screenshot({ path: info.outputPath('filter-v2-mobile.png'), fullPage: true }); await apply(form);
  await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
});
