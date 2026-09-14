import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

let html;
test.beforeAll(async () => {
  const output = await build({ entryPoints: ['tests/fixtures/configuration-ui-harness.mjs'], absWorkingDir: process.cwd(), bundle: true, format: 'esm', write: false, outdir: 'harness', loader: { '.woff': 'dataurl', '.woff2': 'dataurl' } });
  const js = output.outputFiles.find(file => file.path.endsWith('.js')).text, css = output.outputFiles.find(file => file.path.endsWith('.css')).text;
  html = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><script type="module">${js.replaceAll('</script', '<\\/script')}</script></body></html>`;
});
async function open(page) {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? 'Independent copy' : undefined));
  await page.route('http://127.0.0.1:47777/configuration', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://127.0.0.1:47777/configuration');
  await expect(page.locator('[name=cfgName]')).toBeVisible();
  await expect(page.locator('[data-cfg-action=reload]')).toBeEnabled();
  return errors;
}
async function family(page, name) {
  await page.locator(`[data-cfg-family=${name}]`).click();
  await expect(page.locator(`[data-cfg-family=${name}]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-cfg-action=reload]')).toBeEnabled();
}
async function json(page) { await page.locator('[data-cfg-tab=json]').click(); await expect(page.locator('.cfg-json')).toBeVisible(); return JSON.parse(await page.locator('.cfg-json').inputValue()); }
async function save(page, name) {
  if (name) await page.locator('[name=cfgName]').fill(name);
  await page.locator('[data-cfg-action=save]').click();
  await expect(page.locator('.cfg-message')).toContainText('Configuration committed');
  await expect(page.locator('[data-cfg-action=reload]')).toBeEnabled();
}
async function publish(page) { await page.locator('[data-cfg-action=publish]').click(); await expect(page.locator('.cfg-message')).toContainText('Configuration committed'); await expect(page.locator('.cfg-version')).toHaveValue('1'); }
const state = page => page.evaluate(() => window.configurationHarness.state());

test('source and group structured definitions round-trip JSON with lifecycle and independent copies', async ({ page }) => {
  const errors = await open(page);
  await page.locator('[data-cfg-action=new]').click(); await page.locator('[data-cfg=writable]').uncheck();
  expect(await json(page)).toEqual({ storage: 'json', enabled: true, writable: false, defaultSchema: null });
  await save(page, 'Readonly archive');
  expect((await state(page)).snapshot.sources.find(item => item.name === 'Readonly archive').versions).toHaveLength(1);
  await family(page, 'groups'); await page.locator('[data-cfg=order]').fill('7'); await page.locator('[data-cfg=useColor]').check();
  await page.locator('[data-cfg=color]').fill('#8045a1'); await save(page, 'Operations group');
  await page.locator('[data-cfg-action=duplicate]').click(); await expect(page.locator('[name=cfgName]')).toHaveValue('Independent copy');
  await page.locator('[data-cfg-action=archive]').click(); await expect(page.locator('[data-cfg-action=unarchive]')).toBeVisible();
  await page.locator('[data-cfg-action=unarchive]').click(); await expect(page.locator('[data-cfg-action=archive]')).toBeVisible();
  await page.locator('[data-cfg-action=delete]').click(); await expect(page.locator('.cfg-message')).toContainText('Configuration committed');
  expect((await state(page)).snapshot.groups.map(item => item.name)).toEqual(['Operations group']);
  expect(errors).toEqual([]);
});

test('schema fields and pinned Boolean filter validation preserve one definition across structured and JSON views', async ({ page }, testInfo) => {
  const errors = await open(page); await family(page, 'schemas');
  await page.locator('[data-cfg-command=schema-add]').click(); await page.locator('[data-schema-name]').fill('approved'); await page.locator('[data-schema-type]').selectOption('boolean');
  await page.locator('[data-schema-required]').check(); await save(page, 'Approval schema'); await publish(page);
  const schema = (await state(page)).snapshot.schemas[0];
  expect(schema.versions[0].definition.schema.properties.approved).toEqual({ type: 'boolean' });
  await page.locator('[data-cfg-tab=impact]').click(); await expect(page.locator('.cfg-definition')).toContainText('0 affected records');
  await family(page, 'filters'); await page.locator('[data-filter-schema]').check();
  await page.locator('[data-filter-command=add-root]').click(); await page.locator('[data-filter-field]').selectOption('/data/approved');
  await page.locator('[data-filter-value]').selectOption('true'); await save(page, 'Approved events'); await publish(page);
  const saved = (await state(page)).snapshot.filters[0].versions[0].definition;
  expect(saved.schemaRefs).toEqual([{ id: schema.id, version: 1 }]); expect(saved.expression.root).toEqual({ op: 'eq', field: '/data/approved', value: true });
  await page.locator('.filter-tree').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('configuration-filter-desktop.png') });
  await family(page, 'schemas'); await page.locator('[data-cfg-tab=usage]').click(); await expect(page.locator('.cfg-definition')).toContainText('Deletion blocked');
  await expect(page.locator('[data-cfg-action=delete]')).toBeDisabled(); expect(errors).toEqual([]);
});

test('published saved-view apply changes only personal effective settings and reset restores inheritance', async ({ page }) => {
  const errors = await open(page), before = (await state(page)).snapshot.settings;
  await family(page, 'views'); await page.locator('[data-override=theme]').check(); await page.locator('[data-cfg=setting-theme]').selectOption('dark');
  await save(page, 'Night review'); await publish(page);
  expect((await state(page)).applied).toHaveLength(0);
  await page.locator('[data-cfg-action=apply]').click(); await expect.poll(async () => (await state(page)).applied.length).toBe(1);
  const after = await state(page); expect(after.snapshot.settings).toEqual(before); expect(after.applied[0].settings.values.theme).toBe('dark'); expect(after.commands.at(-1).expectedPreferenceRevision).toBe(0);
  await family(page, 'settings'); await expect(page.locator('.cfg-settings-table')).toContainText('personal:local');
  const reset = page.locator('[data-reset-path="/viewId"]'); await expect(reset).toBeVisible(); await reset.click();
  await expect.poll(async () => (await state(page)).applied.length).toBe(2); expect(errors).toEqual([]);
});

test('uncertain catalog command stays locked across close until original read-only outcome confirmation', async ({ page }) => {
  const errors = await open(page); await family(page, 'filters'); await page.locator('[name=cfgName]').fill('Uncertain private name');
  await page.evaluate(() => window.configurationHarness.loseNext()); await page.locator('[data-cfg-action=save]').click();
  await expect(page.locator('.cfg-outcome-check')).toBeVisible(); await expect(page.locator('[data-cfg-action=save]')).toBeDisabled();
  const id = (await state(page)).commands[0].clientCommandId;
  await page.locator('[data-cfg-action=close]').click(); await page.evaluate(() => window.configurationHarness.open());
  await expect(page.locator('.cfg-outcome-check')).toBeVisible(); await page.locator('.cfg-outcome-check').click();
  await expect(page.locator('.cfg-message')).toContainText('Configuration committed');
  const result = await state(page); expect(result.commands).toHaveLength(1); expect(result.lookups).toEqual([id]); expect(result.snapshot.filters).toHaveLength(1); expect(errors).toEqual([]);
});

test('closing during validation cancels undispatched save and source changes preserve a read-only draft', async ({ page }) => {
  const errors = await open(page); await family(page, 'filters'); await page.locator('[name=cfgName]').fill('Held validation');
  await page.evaluate(() => window.configurationHarness.gateValidation()); await page.locator('[data-cfg-action=save]').click();
  await expect(page.locator('[data-cfg-action=new]')).toBeDisabled(); await page.locator('[data-cfg-action=close]').click(); await page.evaluate(() => window.configurationHarness.releaseValidation());
  await page.evaluate(() => window.configurationHarness.open()); await expect(page.locator('[name=cfgName]')).toBeVisible(); expect((await state(page)).commands).toHaveLength(0);
  await family(page, 'filters'); await page.locator('[name=cfgName]').fill('Source bound draft'); await page.evaluate(() => window.configurationHarness.suspend());
  await expect(page.locator('[name=cfgName]')).toHaveValue('Source bound draft'); await expect(page.locator('[name=cfgName]')).toBeDisabled(); await expect(page.locator('[data-cfg-action=save]')).toBeDisabled();
  await expect(page.locator('.cfg-message')).toContainText('read-only'); expect((await state(page)).commands).toHaveLength(0); expect(errors).toEqual([]);
});

test('portable import rejects duplicate fields and exports only selected definition without catalog identity', async ({ page }) => {
  const errors = await open(page), portable = { format: 'timeline-configuration', formatVersion: 1, family: 'groups', name: 'Imported group', description: '', tags: ['imported'], visibility: 'workspace', definition: { order: 1, color: null, collapsed: false } };
  await page.locator('.cfg-import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(portable).replace('"name":', '"name":"Duplicate","name":')) });
  await expect(page.locator('.cfg-message')).toContainText('Duplicate');
  await page.locator('.cfg-import-file').setInputFiles({ name: 'group.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(portable)) }); await expect(page.locator('[name=cfgName]')).toHaveValue('Imported group');
  const download = page.waitForEvent('download'); await page.locator('[data-cfg-action=export]').click(); const file = await download, stream = await file.createReadStream(); let contents = ''; for await (const chunk of stream) contents += chunk;
  expect(JSON.parse(contents)).toEqual(portable); expect((await state(page)).snapshot.groups).toHaveLength(0); expect(errors).toEqual([]);
});

test('mobile catalog remains bounded with visible controls and independently scrolling field definitions', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); const errors = await open(page); await family(page, 'views');
  await page.locator('[name=cfgName]').fill('Mobile review'); await expect(page.locator('[data-cfg-action=save]')).toBeInViewport();
  const bounds = await page.locator('.configuration-manager').boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390); expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.locator('[data-cfg-tab=json]').click(); await expect(page.locator('.cfg-json')).toBeVisible();
  for (const node of await page.locator('.cfg-header-actions button').all()) { const box = await node.boundingBox(); expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44); }
  await page.screenshot({ path: testInfo.outputPath('configuration-mobile.png') }); expect(errors).toEqual([]);
});

test('a confirmed in-flight command still notifies the original active source after editor closure', async ({ page }) => {
  const errors = await open(page); await family(page, 'filters'); await page.locator('[name=cfgName]').fill('Close while committing');
  await page.evaluate(() => window.configurationHarness.gateMutation()); await page.locator('[data-cfg-action=save]').click();
  await expect.poll(async () => (await state(page)).snapshot.filters.length).toBe(1);
  await page.locator('[data-cfg-action=close]').click(); await expect(page.locator('.configuration-manager')).toHaveCount(0);
  await page.evaluate(() => window.configurationHarness.releaseMutation());
  await expect.poll(async () => (await state(page)).confirmed.length).toBe(1);
  expect((await state(page)).commands).toHaveLength(1); expect(errors).toEqual([]);
});
