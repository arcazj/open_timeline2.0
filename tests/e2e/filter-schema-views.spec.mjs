import { test, expect } from '@playwright/test';
import { startServer } from '../integration/server-fixture.mjs';
import fixture from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { normalizeConfiguration, applyConfigurationCommand } from '../../client/src/data/configuration-catalog.js';

let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });
const ready = async page => { await expect(page.locator('.busy-indicator')).toHaveCount(0); };
function scopedSnapshot() {
  const actor = { id: 'local', capabilities: ['*'] }, properties = {};
  let snapshot = normalizeConfiguration(structuredClone(fixture), actor);
  for (const record of snapshot.records) for (const [key, value] of Object.entries(record.data)) properties[key] = { type: typeof value };
  properties.namespace = { type: 'string' };
  const id = 'ee908202-a82b-4ce0-8ba5-55a8491273ce', generation = snapshot.manifest.generation, now = snapshot.manifest.snapshotAt;
  let result = applyConfigurationCommand(snapshot, { family: 'schemas', type: 'create', generation, clientCommandId: 'create-schema', payload: { name: 'Namespace records', visibility: 'workspace', definition: { schema: { type: 'object', properties, additionalProperties: false } } } }, { actor, now, createId: () => id });
  result = applyConfigurationCommand(result.snapshot, { family: 'schemas', type: 'publish', generation, clientCommandId: 'publish-schema', resourceId: id, expectedRevision: result.resource.revision, payload: {} }, { actor, now });
  snapshot = result.snapshot;
  snapshot.records.forEach((record, index) => { record.schemaId = id; record.schemaVersion = 1; record.data.namespace = index % 2 ? 'SOURCE10' : 'SOURCE2'; });
  return snapshot;
}
async function open(page) {
  await page.goto(server.baseUrl); await expect(page.locator('.record-label').first()).toBeVisible(); await ready(page);
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#json-file').setInputFiles({ name: 'namespaces.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(scopedSnapshot())) });
  await expect(page.locator('#json-file')).toHaveCount(0); await ready(page);
  await page.locator('[data-action=filters]').first().click(); await expect(page.locator('#settings-form [type=submit]')).toBeEnabled();
  return page.locator('#settings-form');
}

test('explicit schema scope enables namespace grouping, rejects incompatible removal and supports undo', async ({ page }, info) => {
  const form = await open(page);
  await expect(form.getByRole('combobox', { name: 'Group by field' })).toBeDisabled();
  await form.locator('[name=definitionVersion]').selectOption('2');
  await form.locator('.filter-schema-scope summary').click();
  await form.getByRole('checkbox', { name: 'Namespace records / v1' }).check();
  await expect(form.locator('.filter-schema-scope [role=status]')).toContainText('Records outside this schema scope are excluded');
  await form.getByRole('combobox', { name: 'Group by field' }).selectOption('/data/namespace');
  await form.getByRole('combobox', { name: 'Group text order' }).selectOption('natural');
  await form.getByRole('checkbox', { name: 'Case-sensitive groups' }).uncheck();
  await form.getByRole('checkbox', { name: 'Namespace records / v1' }).click();
  await expect(form.locator('.filter-schema-scope [role=status]')).toContainText('excludes the current grouping field');
  await expect(form.getByRole('checkbox', { name: 'Namespace records / v1' })).toBeChecked();
  await form.locator('[type=submit]').click(); await expect(form).toHaveCount(0); await ready(page);
  await expect(page.locator('.group-name').first()).toHaveText('SOURCE2');
  const focus = await page.evaluate(() => ({ fromMs: window.__timelineDebug.fromMs, toMs: window.__timelineDebug.toMs }));
  for (let index = 0; index < 8 && !(await page.locator('.group-name').allTextContents()).includes('SOURCE10'); index++) {
    const previousRows = await page.locator('.row-count').textContent();
    await page.getByRole('button', { name: 'Next rows', exact: true }).click();
    await expect(page.locator('.row-count')).not.toHaveText(previousRows); await ready(page);
  }
  await expect(page.locator('.group-name')).toContainText(['SOURCE10']);
  expect(await page.evaluate(() => ({ fromMs: window.__timelineDebug.fromMs, toMs: window.__timelineDebug.toMs }))).toEqual(focus);
  await page.screenshot({ path: info.outputPath('namespace-groups-desktop.png'), fullPage: true });
  await page.locator('[data-action=filters]').first().click();
  await expect(page.getByRole('combobox', { name: 'Group by field' })).toHaveValue('/data/namespace');
  await page.locator('#filter-undo').click(); await expect(page.locator('#settings-form')).toHaveCount(0); await ready(page);
  await page.locator('[data-action=filters]').first().click(); await expect(page.locator('[name=definitionVersion]')).toHaveValue('1');
  await page.locator('.filter-schema-scope summary').click(); await expect(page.getByRole('checkbox', { name: 'Namespace records / v1' })).not.toBeChecked();
});

test('current filter and view drafts publish only on explicit commands and narrow toolbar remains contained', async ({ page }, info) => {
  const form = await open(page);
  await form.locator('[name=definitionVersion]').selectOption('2');
  await form.locator('.filter-schema-scope summary').click(); await form.getByRole('checkbox', { name: 'Namespace records / v1' }).check();
  await expect(form.locator('[type=submit]')).toBeEnabled();
  await form.getByRole('combobox', { name: 'Group by field' }).selectOption('/data/namespace');
  await form.getByRole('combobox', { name: 'Group text order' }).selectOption('natural');
  await form.locator('[data-filter-command=add-root]').click(); await form.locator('[data-filter-value]').fill('Telemetry');
  await form.locator('[type=submit]').click(); await expect(form).toHaveCount(0); await ready(page);
  await page.getByRole('button', { name: 'Save current filter draft', exact: true }).click();
  await expect(page.locator('[name=cfgName]')).toHaveValue('Current timeline filter');
  await expect(page.locator('.cfg-message')).toContainText('unsaved draft');
  await page.locator('[data-cfg-action=save]').click(); await expect(page.locator('.cfg-message')).toContainText('Configuration committed');
  await page.locator('[data-cfg-action=publish]').click(); await expect(page.locator('.cfg-version')).toHaveValue('1');
  await page.locator('[data-cfg-action=close]').click();
  await page.getByRole('button', { name: 'Save current view draft', exact: true }).click();
  await expect(page.locator('[name=cfgName]')).toHaveValue('Current timeline view');
  await page.locator('[data-cfg-tab=json]').click();
  const view = JSON.parse(await page.locator('.cfg-json').inputValue());
  expect(view.definitionVersion).toBe(2); expect(view.filter.version).toBe(1);
  expect(view.settings.presentation.grouping.field).toBe('/data/namespace'); expect(view.settings.groupOrder.order).toBe('natural');
  expect(view.settings.table).toMatchObject({ scope: 'all', projection: 'context' });
  await page.locator('[data-cfg-action=save]').click(); await expect(page.locator('.cfg-message')).toContainText('Configuration committed');
  await page.locator('[data-cfg-action=publish]').click(); await expect(page.locator('.cfg-version')).toHaveValue('1');
  await page.locator('[data-cfg-action=close]').click();
  await page.getByRole('button', { name: 'Refresh saved views' }).click();
  await page.getByRole('combobox', { name: 'Saved view preset' }).selectOption({ label: 'Current timeline view / v1' });
  await page.getByRole('button', { name: 'Review selected view' }).click(); await expect(page.locator('.cfg-version')).toHaveValue('1');
  await page.locator('[data-cfg-action=apply]').click(); await expect(page.locator('.cfg-message')).toContainText('Configuration committed');
  await page.locator('[data-cfg-action=close]').click();
  await page.locator('[data-action=filters]').first().click();
  await expect(page.getByRole('combobox', { name: 'Group by field' })).toHaveValue('/data/namespace');
  await page.locator('.filter-schema-scope summary').click();
  await expect(page.getByRole('checkbox', { name: 'Namespace records / v1' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Namespace records / v1' })).toBeDisabled();
  await page.locator('#filter-cancel').click();
  await page.setViewportSize({ width: 390, height: 844 }); await ready(page);
  await expect.poll(() => page.evaluate(() => Math.abs(window.__timelineDebug.layoutWidth - document.querySelector('.plot-wrap').clientWidth))).toBeLessThan(1);
  await expect(page.locator('.toast')).toHaveCount(0);
  await expect(page.locator('.record-label').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const colors = await page.locator('.plot-wrap canvas').first().evaluate(canvas => {
    const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
    const context = copy.getContext('2d'); context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data, values = new Set();
    for (let offset = 0; offset < pixels.length; offset += 400) values.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
    return values.size;
  });
  expect(colors).toBeGreaterThan(3);
  await page.screenshot({ path: info.outputPath('saved-presets-mobile.png'), fullPage: true });
});
