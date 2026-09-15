import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

const bundle = (await build({ entryPoints: ['client/src/ui/record-descriptor.js'], bundle: true, format: 'iife', globalName: 'descriptor', write: false })).outputFiles[0].text;

test('query descriptor explains findings and navigates only supplied authorized ancestors', async ({ page }) => {
  await page.setContent('<main aria-label="Selected record"></main>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    window.descriptor.appendDescriptorContext(document.querySelector('main'), {
      searchActive: true,
      provenance: { role: 'ancestor-context', directPredicate: false, match: false, descendantMatchCount: 2 },
      ancestors: [{ id: 'authorized-parent', title: 'Authorized parent <script>unsafe()</script>' }], ancestorsTruncated: true,
      explanation: { fields: ['/data/status'], ruleIds: ['rule-1'], truncated: false },
    }, id => { window.selectedParent = id; });
  });
  await expect(page.locator('.descriptor-context')).toContainText('Ancestor context');
  await expect(page.locator('.descriptor-context')).toContainText('Matching descendants');
  await expect(page.locator('.descriptor-context')).toContainText('Matched fields');
  await expect(page.locator('.descriptor-context')).toContainText('/data/status');
  await expect(page.locator('.descriptor-context')).toContainText('rule-1');
  await expect(page.locator('.descriptor-context')).toContainText('Additional context is not included');
  await expect(page.getByRole('navigation', { name: 'Parent sessions' }).getByRole('button')).toHaveCount(1);
  await page.getByRole('button', { name: 'Authorized parent <script>unsafe()</script>' }).focus(); await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.selectedParent)).toBe('authorized-parent');
  expect(await page.locator('main script').count()).toBe(0);
});

test('direct search findings use text rather than authored color, and absent context adds no empty panel', async ({ page }) => {
  await page.setContent('<main></main>'); await page.addScriptTag({ content: bundle });
  await page.evaluate(() => window.descriptor.appendDescriptorContext(document.querySelector('main'), null, () => {}));
  await expect(page.locator('main')).toBeEmpty();
  await page.evaluate(() => window.descriptor.appendDescriptorContext(document.querySelector('main'), {
    searchActive: true,
    provenance: { role: 'direct', directPredicate: true, match: true, descendantMatchCount: 0 }, ancestors: [],
  }, () => {}));
  await expect(page.locator('main')).toContainText('Filter result');
  await expect(page.locator('main')).toContainText('Matching record');
  await expect(page.locator('nav')).toHaveCount(0);
});
