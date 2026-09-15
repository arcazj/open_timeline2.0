import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startServer } from '../integration/server-fixture.mjs';

const fixture = JSON.parse(await readFile('shared/fixtures/initial-snapshot.json', 'utf8'));
let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });
async function open(page, mode) {
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(server.baseUrl); await expect(page.locator('.record-label').first()).toBeVisible();
  if (mode === 'server') {
    await page.locator('[data-action=sources]').first().click();
    await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl); await page.locator('#server-form [name=token]').fill(server.token);
    await page.locator('#server-form [type=submit]').click(); await page.locator('#switch-source').click();
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server');
  }
  await page.locator('[data-view=table]').click(); await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
  return errors;
}
async function filters(page) { await page.locator('[data-action=filters]').first().click(); return page.locator('#settings-form'); }
async function apply(form) {
  const page = form.page(), before = await page.evaluate(() => window.__timelineDebug.queryId);
  await form.locator('[type=submit]').click(); await expect(form).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.queryId)).not.toBe(before);
  await expect(page.locator('.table-view')).toHaveAttribute('aria-busy', 'false');
}
const ids = page => page.locator('.table-view tbody tr').evaluateAll(rows => rows.map(row => row.dataset.recordId).sort());

for (const mode of ['local', 'server']) {
  test(`${mode} nested structured filters keep table and overview on one complete projection`, async ({ page }, info) => {
    const errors = await open(page, mode), form = await filters(page);
    await form.locator('[data-filter-command=add-root]').click();
    await form.locator('[data-filter-field]').selectOption('/sourceId');
    await form.locator('[data-filter-value]').fill('operations');
    await form.locator('[data-filter-command=add-root]').click();
    const second = form.locator('[data-filter-path="args.1"]');
    await second.locator('[data-filter-field]').selectOption('/kind');
    await second.locator('[data-filter-value]').fill('session');
    await apply(form);
    const expected = fixture.records.filter(record => record.sourceId === 'operations' && record.kind === 'session');
    await expect(page.locator('.table-view tbody tr')).toHaveCount(expected.length);
    expect(await ids(page)).toEqual(expected.map(record => record.id).sort());
    await expect(page.locator('.overview-count')).toContainText(`${expected.length} records`);
    const reopened = await filters(page);
    await expect(reopened.locator('[data-filter-path="args.0"] [data-filter-value]')).toHaveValue('operations');
    await expect(reopened.locator('[data-filter-path="args.1"] [data-filter-value]')).toHaveValue('session');
    await page.screenshot({ path: info.outputPath(`filters-${mode}.png`), fullPage: true });
    await reopened.locator('[data-filter-command=clear]').click(); await apply(reopened);
    await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
    expect(errors).toEqual([]);
  });

  test(`${mode} search supports All, exact phrase, selected fields and case`, async ({ page }) => {
    const errors = await open(page, mode);
    await page.locator('[data-table-projection]').selectOption('matches');
    let form = await filters(page);
    await form.locator('[name=search]').fill('Generic Nominal'); await form.locator('[name=searchMode]').selectOption('all'); await apply(form);
    const expected = fixture.records.filter(record => record.data.description.includes('Generic') && record.data.status === 'Nominal');
    await expect(page.locator('.table-view tbody tr')).toHaveCount(expected.length);
    expect(await ids(page)).toEqual(expected.map(record => record.id).sort());
    await expect(page.locator('.overview-count')).toContainText(`${expected.length} search matches`);
    form = await filters(page);
    await form.locator('[name=search]').fill('generic operational'); await form.locator('[name=searchMode]').selectOption('phrase'); await form.locator('[name=searchCaseSensitive]').check(); await apply(form);
    await expect(page.locator('.table-view tbody tr')).toHaveCount(0);
    form = await filters(page); await form.locator('[name=searchCaseSensitive]').uncheck(); await apply(form);
    await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
    form = await filters(page); await form.locator('.search-fields summary').click();
    for (const input of await form.locator('[data-search-field]').all()) await input.uncheck();
    await form.locator('[data-search-field="/title"]').check(); await apply(form);
    await expect(page.locator('.table-view tbody tr')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test(`${mode} changing a selector beside an invalid list preserves raw input and applies the visible predicate`, async ({ page }) => {
    const errors = await open(page, mode), form = await filters(page);
    const before = await page.evaluate(() => window.__timelineDebug.queryId);
    await form.locator('[data-filter-command=add-root]').click();
    await form.locator('[data-filter-field]').selectOption('/sourceId');
    await form.locator('[data-filter-op]').selectOption('in');
    await form.locator('[data-filter-value]').fill('not-json');
    await form.locator('[data-filter-command=add-root]').click();
    const first = form.locator('[data-filter-path="args.0"]'), second = form.locator('[data-filter-path="args.1"]');
    await second.locator('[data-filter-field]').selectOption('/kind');
    await second.locator('[data-filter-value]').fill('session');
    await second.locator('[data-filter-field]').selectOption('/title');
    await second.locator('[data-filter-op]').selectOption('contains');
    await second.locator('[data-filter-value]').fill('Telemetry');
    await expect(first.locator('[data-filter-value]')).toHaveValue('not-json');
    await expect(form.locator('[type=submit]')).toBeDisabled();
    await expect(form.locator('.form-error')).toContainText('JSON array');
    expect(await page.evaluate(() => window.__timelineDebug.queryId)).toBe(before);
    await first.locator('[data-filter-value]').fill('["operations"]');
    await apply(form);
    const expected = fixture.records.filter(record => record.sourceId === 'operations' && record.title.toLowerCase().includes('telemetry'));
    expect(await ids(page)).toEqual(expected.map(record => record.id).sort());
    const reopened = await filters(page);
    await expect(reopened.locator('[data-filter-path="args.1"] [data-filter-field]')).toHaveValue('/title');
    await expect(reopened.locator('[data-filter-path="args.1"] [data-filter-op]')).toHaveValue('contains');
    await expect(reopened.locator('[data-filter-path="args.1"] [data-filter-value]')).toHaveValue('Telemetry');
    expect(errors).toEqual([]);
  });

  test(`${mode} removing and clearing malformed conditions preserves other valid and invalid drafts`, async ({ page }) => {
    const errors = await open(page, mode), form = await filters(page);
    await form.locator('[data-filter-command=wrap-root]').click();
    let rules = form.locator('.filter-rule');
    await rules.nth(0).locator('[data-filter-op]').selectOption('in');
    await rules.nth(0).locator('[data-filter-value]').fill('first-invalid');
    await form.locator('[data-filter-command=add]').first().click();
    await rules.nth(1).locator('[data-filter-op]').selectOption('in');
    await rules.nth(1).locator('[data-filter-value]').fill('second-invalid');
    await form.locator('[data-filter-command=add]').first().click();
    await rules.nth(2).locator('[data-filter-field]').selectOption('/sourceId');
    await rules.nth(2).locator('[data-filter-value]').fill('operations');
    await rules.nth(0).locator('[data-filter-command=remove]').click();
    await expect(rules).toHaveCount(2);
    await expect(rules.nth(0).locator('[data-filter-value]')).toHaveValue('second-invalid');
    await expect(rules.nth(1).locator('[data-filter-field]')).toHaveValue('/sourceId');
    await expect(rules.nth(1).locator('[data-filter-value]')).toHaveValue('operations');
    await form.locator('[data-filter-command=clear]').click();
    await expect(form.locator('.filter-node')).toHaveCount(0);
    await apply(form);
    await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
    expect(errors).toEqual([]);
  });
}

test('filter validation preserves the draft and narrow layout remains readable', async ({ page }) => {
  await open(page, 'local'); await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-action=settings]').click(); const form = page.locator('#settings-form');
  await form.locator('[data-filter-command=add-root]').click(); await form.locator('[data-filter-op]').selectOption('in');
  await form.locator('[data-filter-value]').fill('not-json'); await expect(form.locator('[type=submit]')).toBeDisabled();
  await expect(form.locator('.form-error')).toContainText('JSON array'); await expect(form.locator('[data-filter-value]')).toHaveValue('not-json');
  const overflow = await form.evaluate(node => node.scrollWidth > node.clientWidth + 1); expect(overflow).toBe(false);
  await form.locator('[data-filter-value]').fill('["Telemetry downlink"]'); await apply(form);
  await expect(page.locator('.table-view tbody tr')).toHaveCount(1);
});

test('empty numeric and interval inputs survive structural edits and can be removed', async ({ page }) => {
  const errors = await open(page, 'local'), form = await filters(page);
  await form.locator('[data-filter-command=wrap-root]').click();
  let rules = form.locator('.filter-rule');
  await rules.nth(0).locator('[data-filter-field]').selectOption('/order');
  await rules.nth(0).locator('[data-filter-value]').fill('');
  await form.locator('[data-filter-command=add]').first().click();
  await expect(rules.nth(0).locator('[data-filter-value]')).toHaveValue('');
  await rules.nth(1).locator('[data-filter-op]').selectOption('overlaps');
  await rules.nth(1).locator('[data-filter-from]').fill('');
  await form.locator('[data-filter-command=add]').first().click();
  await expect(rules.nth(0).locator('[data-filter-value]')).toHaveValue('');
  await expect(rules.nth(1).locator('[data-filter-from]')).toHaveValue('');
  await rules.nth(0).locator('[data-filter-command=remove]').click();
  await expect(rules.nth(0).locator('[data-filter-from]')).toHaveValue('');
  await rules.nth(0).locator('[data-filter-command=remove]').click();
  await expect(rules).toHaveCount(1);
  await expect(rules.nth(0).locator('[data-filter-field]')).toHaveValue('/title');
  await form.locator('[data-filter-command=clear]').click(); await apply(form);
  await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
  expect(errors).toEqual([]);
});
