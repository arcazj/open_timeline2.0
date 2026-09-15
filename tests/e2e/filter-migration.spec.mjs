import { test, expect } from '@playwright/test';
import { startServer } from '../integration/server-fixture.mjs';

let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });
async function open(page, mode) {
  await page.goto(server.baseUrl); await expect(page.locator('.record-label').first()).toBeVisible(); await expect(page.locator('.busy-indicator')).toHaveCount(0);
  if (mode === 'server') {
    await page.locator('[data-action=sources]').first().click();
    await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl); await page.locator('#server-form [name=token]').fill(server.token);
    await page.locator('#server-form [type=submit]').click(); await page.locator('#switch-source').click();
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server'); await expect(page.locator('.busy-indicator')).toHaveCount(0);
  }
  await page.locator('[data-view=table]').click(); await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
  await page.locator('[data-action=filters]').first().click(); await page.locator('.filter-migration > summary').click();
  return page.locator('#settings-form');
}

for (const mode of ['local', 'server']) {
  test(`${mode} legacy migration requires semantic approvals and separate draft/apply actions`, async ({ page }, info) => {
    const form = await open(page, mode), before = await page.evaluate(() => window.__timelineDebug);
    await form.locator('[name=legacyInclude]').fill('title=Telemetry downlink'); await form.locator('[name=legacySortBy]').selectOption('/sourceId');
    await form.locator('[data-migration=review]').click();
    await expect(form.locator('.filter-migration-status')).toHaveText('Explicit approval required');
    await expect(form.locator('[data-migration=use]')).toBeDisabled();
    await expect(form.locator('.filter-migration-diagnostics')).toContainText('intent repair');
    await form.locator('.filter-migration-acknowledgements input[value="help-equality-repair"]').check();
    await form.locator('.filter-migration-acknowledgements input[value="deterministic-group-order"]').check();
    await expect(form.locator('[data-migration=use]')).toBeEnabled();
    await form.locator('.filter-migration-proposal > summary').click();
    await expect(form.locator('.filter-migration-proposal pre')).toContainText('"acknowledged"');
    await page.screenshot({ path: info.outputPath(`migration-${mode}-review.png`), fullPage: true });
    await form.locator('[data-migration=use]').click();
    await expect(form.locator('[name=definitionVersion]')).toHaveValue('2');
    await expect(form.locator('[data-filter-field]')).toHaveValue('/title'); await expect(form.locator('[data-filter-value]')).toHaveValue('Telemetry downlink');
    expect(await page.evaluate(() => window.__timelineDebug.queryId)).toBe(before.queryId); await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
    await form.locator('[type=submit]').click(); await expect(form).toHaveCount(0);
    await expect(page.locator('.table-view tbody tr')).toHaveCount(1);
    const after = await page.evaluate(() => window.__timelineDebug); expect(after.grouping).toBe('/sourceId');
    expect(after.fromMs).toBe(before.fromMs); expect(after.toMs).toBe(before.toMs);
  });

  test(`${mode} ambiguous legacy syntax stays blocked and editing revokes an earlier approval`, async ({ page }) => {
    const form = await open(page, mode), before = await page.evaluate(() => window.__timelineDebug.queryId);
    await form.locator('[name=legacyInclude]').fill('title:Telemetry|status:Nominal'); await form.locator('[data-migration=review]').click();
    await expect(form.locator('.filter-migration-status')).toHaveText('Conversion blocked'); await expect(form.locator('[data-migration=use]')).toBeDisabled();
    await expect(form.locator('.filter-migration-diagnostics')).toContainText('ambiguous');
    await form.locator('[name=legacyInclude]').fill(''); await form.locator('[data-migration=review]').click();
    await expect(form.locator('[data-migration=use]')).toBeEnabled();
    await form.locator('[name=legacyInclude]').fill('title=Changed');
    await expect(form.locator('[data-migration=use]')).toBeDisabled(); await expect(form.locator('.filter-migration-status')).toHaveText('Review required.');
    await form.locator('#filter-cancel').click(); await expect(form).toHaveCount(0);
    expect(await page.evaluate(() => window.__timelineDebug.queryId)).toBe(before); await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
  });
}
