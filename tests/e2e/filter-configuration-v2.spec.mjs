import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

const bundle = (await build({ entryPoints: ['client/src/ui/configuration-fields.js'], bundle: true, format: 'iife', globalName: 'configurationFields', write: false })).outputFiles[0].text;
const definition = { definitionVersion: 2, relationshipMode: 'family', sourceIds: null, kinds: ['event', 'session'], schemaRefs: [], expression: null, search: { text: '^Event.*', mode: 'regex', fields: ['/title'], flags: ['i', 'm'], matchMode: 'full', dialect: 're2-common-v1' } };

async function open(page) {
  await page.setContent('<main></main>'); await page.addScriptTag({ content: bundle });
  await page.evaluate(definition => {
    window.editor = new window.configurationFields.ConfigurationFields(document.querySelector('main'), {
      family: 'filters', definition, catalogs: { sources: [], schemas: [] }, models: [], settings: {}, updateIcons() {}, onChange() {},
    });
  }, definition);
}

test('saved filter fields round-trip version, relationship and regex options without adding literal case settings', async ({ page }) => {
  await open(page);
  await expect(page.locator('[name=definitionVersion]')).toHaveValue('2');
  await expect(page.locator('[name=relationshipMode]')).toHaveValue('family');
  await expect(page.locator('[name=searchMode]')).toHaveValue('regex');
  await expect(page.locator('[data-search-regex-flag=i]')).toBeChecked();
  await expect(page.locator('[data-search-regex-flag=m]')).toBeChecked();
  await expect(page.locator('[data-search-regex-mode]')).toHaveValue('full');
  expect(await page.evaluate(() => window.editor.value())).toEqual(definition);
});

test('a deliberate saved filter downgrade emits the original literal definition format', async ({ page }) => {
  await open(page);
  await page.locator('[name=searchMode]').selectOption('phrase');
  await page.locator('[name=definitionVersion]').selectOption('1');
  const result = await page.evaluate(() => window.editor.value());
  expect(result.definitionVersion).toBeUndefined(); expect(result.relationshipMode).toBeUndefined();
  expect(result.search).toEqual({ text: '^Event.*', mode: 'phrase', fields: ['/title'], caseSensitive: false });
});
