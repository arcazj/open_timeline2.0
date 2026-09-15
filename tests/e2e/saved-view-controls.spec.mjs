import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

const bundle = async (file, name) => (await build({ entryPoints: [file], bundle: true, format: 'iife', globalName: name, write: false, loader: { '.css': 'empty' } })).outputFiles[0].text;
const controls = await bundle('client/src/ui/saved-view-controls.js', 'savedViews');
const manager = await bundle('client/src/ui/configuration-manager.js', 'configurationManager');
const filter = { definitionVersion: 2, relationshipMode: 'family', sourceIds: ['alpha'], kinds: ['event', 'session'], schemaRefs: [], expression: { version: 2, root: { op: 'contains', field: '/title', value: 'launch' } }, search: { text: 'launch', mode: 'phrase', fields: ['/title'], caseSensitive: false } };
const settings = { definitionVersion: 2, relationshipMode: 'family', groupOrder: { order: 'natural', caseSensitive: false }, collapsedGroups: ['string:alpha'], sort: [{ field: '/title', direction: 'asc', order: 'natural', caseSensitive: false }], table: { scope: 'window', projection: 'matches', limit: 100 }, columns: [{ field: '/title', visible: true, width: 250 }], range: { from: '-006000-01-01T00:00:00.000Z', to: '-005999-01-01T00:00:00.000Z' } };
const view = { definitionVersion: 2, model: { id: 'model', version: 1 }, filter: { id: 'filter', version: 1 }, settings };

async function setup(page) {
  await page.setContent('<main></main>'); await page.addScriptTag({ content: controls });
  await page.evaluate(({ filter, settings, view }) => {
    window.active = true; window.opened = []; window.writes = []; window.published = false;
    window.provider = {
      async listConfiguration(family) { return { generation: 'g', items: family === 'views' ? [{ id: 'view', name: 'Operations', lifecycle: 'active', publishedVersions: [1, 2] }] : family === 'filters' ? [{ id: 'filter', lifecycle: 'active', publishedVersions: window.published ? [1] : [] }] : [] }; },
      async getConfiguration(family) { return { generation: 'g', resource: { id: family === 'filters' ? 'filter' : 'view', visibility: 'personal', lifecycle: 'active', versions: [{ version: 1, definition: family === 'filters' ? filter : view }] } }; },
      async getModel() { return { generation: 'g', model: { lifecycle: 'active', versions: [{ version: 1 }] } }; },
      async mutateConfiguration(input) { window.writes.push(input); throw new Error('Unexpected mutation'); },
    };
    window.savedControls = window.savedViews.mountSavedViewControls(document.querySelector('main'), { provider: window.provider, generation: 'g', isCurrent: () => window.active,
      capture: () => ({ definitionVersion: 2, relationshipMode: 'family', filters: { sourceIds: ['alpha'], expression: filter.expression }, search: filter.search, model: { id: 'model', version: 1 }, settings }),
      openConfigurations: input => window.opened.push(input), updateIcons() {},
    });
  }, { filter, settings, view });
  await expect(page.getByRole('combobox', { name: 'Saved view preset' })).toBeEnabled();
}

test('save view requires an exact publication and never publishes its filter or view automatically', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Save current view draft', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('No published filter matches');
  expect(await page.evaluate(() => window.opened)).toEqual([]);
  await page.getByRole('button', { name: 'Save current filter draft', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.opened.length)).toBe(1);
  expect(await page.evaluate(() => window.opened[0].initialImport.definition)).toEqual(filter);
  await page.evaluate(() => { window.published = true; });
  await page.getByRole('button', { name: 'Save current view draft', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.opened.length)).toBe(2);
  expect(await page.evaluate(() => window.opened[1].initialImport.definition)).toEqual({ ...view, settings: { ...settings, search: filter.search } });
  expect(await page.evaluate(() => window.writes)).toEqual([]);
});

test('presets review an exact published version and stale results cannot open a draft', async ({ page }) => {
  await setup(page);
  await page.getByRole('combobox', { name: 'Saved view preset' }).selectOption({ label: 'Operations / v2' });
  await page.getByRole('button', { name: 'Review selected view' }).click();
  expect(await page.evaluate(() => window.opened[0])).toEqual({ initialFamily: 'views', initialResourceId: 'view', initialVersion: 2 });
  await page.evaluate(() => { window.provider.listConfiguration = () => new Promise(resolve => { window.finishRead = resolve; }); });
  await page.getByRole('button', { name: 'Save current view draft', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.finishRead)).toBe('function');
  await page.evaluate(() => { window.active = false; window.finishRead({ generation: 'g', items: [] }); });
  expect(await page.evaluate(() => window.opened.length)).toBe(1);
  expect(await page.evaluate(() => window.writes)).toEqual([]);
});

test('seeded view draft and published version retain all v2 settings without mutation', async ({ page }) => {
  await page.setContent('<main></main>'); await page.addScriptTag({ content: manager });
  await page.evaluate(({ filter, view }) => {
    window.writes = [];
    const resource = { id: 'view', name: 'Operations', description: '', tags: [], visibility: 'personal', lifecycle: 'active', revision: 2, draft: { ...view, settings: { ...view.settings, theme: 'dark' } }, versions: [{ version: 1, definition: view }] };
    window.managerHost = { generation: 'g', actor: { id: 'local', capabilities: ['*'] }, local: true, isCurrent: () => true, updateIcons() {}, models: [{ id: 'model', name: 'Legacy model', lifecycle: 'active', versions: [{ version: 1 }] }], settings: {}, onApply() {},
      provider: { identity: 'component', async listConfiguration(family) { return { generation: 'g', items: family === 'views' ? [{ id: 'view', name: 'Operations', visibility: 'personal', lifecycle: 'active', publishedVersions: [1], hasDraft: true }] : family === 'filters' ? [{ id: 'filter', name: 'Launches', publishedVersions: [1] }] : [] }; },
        async getEffectiveSettings() { return { generation: 'g', values: {} }; }, async getConfiguration(family) { return { generation: 'g', resource: family === 'views' ? resource : { id: 'filter', versions: [{ version: 1, definition: filter }] }, allowedActions: ['update', 'publish', 'apply'] }; }, async mutateConfiguration(value) { window.writes.push(value); throw new Error('Unexpected mutation'); } },
      initialImport: { format: 'timeline-configuration', formatVersion: 1, family: 'views', name: 'Captured view', description: '', tags: [], visibility: 'personal', definition: view },
    };
    window.manager = window.configurationManager.openConfigurationManager(window.managerHost);
  }, { filter, view });
  await expect(page.locator('[name=cfgName]')).toHaveValue('Captured view');
  await expect(page.locator('.cfg-message')).toContainText('unsaved draft');
  await page.locator('[data-cfg-tab=json]').click();
  expect(JSON.parse(await page.locator('.cfg-json').inputValue())).toEqual(view);
  expect(await page.evaluate(() => window.writes)).toEqual([]);
  await page.evaluate(async () => { await window.manager.close(true); const { initialImport, ...host } = window.managerHost; window.manager = window.configurationManager.openConfigurationManager({ ...host, initialFamily: 'views', initialResourceId: 'view', initialVersion: 1 }); });
  await expect(page.locator('.cfg-version')).toHaveValue('1');
  await page.locator('[data-cfg-tab=json]').click();
  expect(JSON.parse(await page.locator('.cfg-json').inputValue())).toEqual(view);
  await expect(page.locator('[data-cfg-action=apply]')).toBeEnabled();
  expect(await page.evaluate(() => window.writes)).toEqual([]);
});
