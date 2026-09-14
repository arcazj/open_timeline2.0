import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };

test('legacy snapshot model library remains inspectable but cannot edit or import definitions', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('dist/index.html')).href);
  await expect(page.locator('.record-label').first()).toBeVisible();
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  const snapshot = structuredClone(initial); delete snapshot.manifest.contentSha256;
  snapshot.manifest.legacy = { readOnly: true, status: 'current', declaredRange: snapshot.settings.overview };
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#json-file').setInputFiles({ name: 'legacy-read-only.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
  await expect(page.locator('.save-status')).toContainText('Read-only');
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  const before = await page.evaluate(() => window.__timelineDebug);
  await expect(page.locator('[data-action=create]').first()).toBeDisabled();
  await page.locator('[data-action=models]').first().click();
  await expect(page.locator('.model-version')).toBeEnabled();
  await expect(page.locator('[name=modelName]')).toHaveJSProperty('readOnly', true);
  await expect(page.locator('[data-definition-field=theme]')).toBeDisabled();
  for (const action of ['new', 'import', 'duplicate', 'save', 'publish', 'apply', 'archive', 'delete']) {
    await expect(page.locator(`[data-action=model-${action}]`)).toBeDisabled();
  }
  await page.locator('[data-action=model-new]').dispatchEvent('click');
  await expect(page.locator('.model-message')).toContainText('read-only');
  await page.locator('[data-model-tab=json]').click();
  await expect(page.locator('.model-json')).toHaveJSProperty('readOnly', true);
  await page.locator('[data-model-tab=preview]').click();
  await expect(page.locator('.model-preview-summary')).not.toBeEmpty();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('[data-action=model-export]').click();
  const download = await downloadEvent;
  const portable = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(portable.format).toBe('timeline-visual-model');
  await page.locator('[data-action=model-close]').click();
  const after = await page.evaluate(() => window.__timelineDebug);
  expect(after.modelId).toBe(before.modelId); expect(after.modelVersion).toBe(before.modelVersion);
  expect(after.detailTotal).toBe(before.detailTotal); expect(after.dirty).toBe(false); expect(errors).toEqual([]);
});
