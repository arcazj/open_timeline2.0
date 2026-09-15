import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

const bundle = (await build({ entryPoints: ['client/src/ui/filter-schema-scope.js'], bundle: true, format: 'iife', globalName: 'schemaScope', write: false })).outputFiles[0].text;
async function open(page, locked = false) {
  await page.setContent('<main></main>'); await page.addScriptTag({ content: bundle });
  await page.evaluate(locked => {
    const schema = { id: 'schema', versions: [{ version: 3, definition: { schema: { type: 'object', properties: { namespace: { type: 'string' } }, additionalProperties: false } } }] };
    window.changes = []; window.requireNamespace = false;
    window.scope = window.schemaScope.mountFilterSchemaScope(document.querySelector('main'), { generation: 'g', filters: locked ? { filterId: 'filter', filterVersion: 2 } : {}, current: () => true,
      provider: { async listConfiguration() { return { generation: 'g', items: [{ id: 'schema', name: 'Namespaces', publishedVersions: [3] }] }; }, async getConfiguration(family) { return { generation: 'g', resource: family === 'schemas' ? schema : { versions: [{ version: 2, definition: { schemaRefs: [{ id: 'schema', version: 3 }] } }] } }; } },
      onChange(value) { if (window.requireNamespace && !value.reset && !Object.hasOwn(value.registry, '/data/namespace')) throw new Error('The current condition requires Namespace.'); window.changes.push(value); },
    });
  }, locked);
  await page.locator('summary').click(); await expect(page.locator('[role=status]')).not.toBeEmpty();
}
test('schema scope is opt-in, rejects a destructive scope change and resets explicitly', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('checkbox', { name: 'Namespaces / v3' })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Namespaces / v3' }).check();
  await expect(page.locator('[role=status]')).toContainText('1 schema version selected');
  expect(await page.evaluate(() => window.changes.at(-1).registry['/data/namespace'])).toBe('string');
  await page.evaluate(() => { window.requireNamespace = true; });
  await page.getByRole('checkbox', { name: 'Namespaces / v3' }).click();
  await expect(page.locator('[role=status]')).toContainText('requires Namespace');
  await expect(page.getByRole('checkbox', { name: 'Namespaces / v3' })).toBeChecked();
  await page.evaluate(() => window.scope.reset()); await expect(page.getByRole('checkbox', { name: 'Namespaces / v3' })).not.toBeChecked();
  expect(await page.evaluate(() => window.scope.value())).toEqual({ pins: [], locked: false });
});
test('published saved filter schema scope is pinned and cannot be edited implicitly', async ({ page }) => {
  await open(page, true);
  await expect(page.getByRole('checkbox', { name: 'Namespaces / v3' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Namespaces / v3' })).toBeDisabled();
  expect(await page.evaluate(() => window.scope.value())).toEqual({ pins: [{ id: 'schema', version: 3 }], locked: true });
  await page.evaluate(() => window.scope.reset());
  expect(await page.evaluate(() => window.scope.value())).toEqual({ pins: [{ id: 'schema', version: 3 }], locked: true });
});
