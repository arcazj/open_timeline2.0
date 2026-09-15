import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startServer } from '../integration/server-fixture.mjs';
import { snapshotContent } from '../../client/src/data/snapshot-content.js';
import { sha256 } from '../../client/src/data/data-provider.js';
import { LocalProvider } from '../../client/src/data/local-provider.js';
const fixture = JSON.parse(await readFile('shared/fixtures/initial-snapshot.json', 'utf8'));
let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });
async function ready(page) { await expect.poll(() => page.evaluate(() => Boolean(window.__timelineDebug?.queryId))).toBe(true); await expect(page.locator('.busy-indicator')).toHaveCount(0); }
async function open(page, mode) {
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  // Capture the bounded bootstrap probe without logging request headers or data.
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.__bootstrapDiagnostic = [];
    window.fetch = function (input, options) {
      'use strict';
      const args = [input, options];
      if (args[0] !== '/api/v1/bootstrap') return Reflect.apply(fetch, this, args);
      const probe = { startedAt: performance.now() };
      window.__bootstrapDiagnostic.push(probe);
      const failed = error => {
        Object.assign(probe, { elapsedMs: performance.now() - probe.startedAt, error: error.name, message: error.message });
        throw error;
      };
      try {
        return Reflect.apply(fetch, this, args).then(response => {
          Object.assign(probe, { elapsedMs: performance.now() - probe.startedAt, status: response.status });
          return response;
        }, failed);
      } catch (error) { return failed(error); }
    };
  });
  await page.goto(server.baseUrl);
  try { await ready(page); }
  catch (error) {
    await test.info().attach('bootstrap-diagnostic', {
      body: JSON.stringify(await page.evaluate(() => window.__bootstrapDiagnostic)), contentType: 'application/json',
    });
    throw error;
  }
  if (mode === 'server') {
    await page.locator('[data-action=sources]').first().click(); await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl); await page.locator('#server-form [name=token]').fill(server.token); await page.locator('#server-form [type=submit]').click(); await page.locator('#switch-source').click();
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server'); await ready(page);
  }
  return errors;
}
async function manager(page) { await page.locator('[data-action=settings]').click(); await page.locator('#configuration-command').click(); await expect(page.locator('[name=cfgName]')).toBeVisible(); await expect(page.locator('[data-cfg-action=reload]')).toBeEnabled(); }
async function create(page, family, name, definition) {
  await page.locator(`[data-cfg-family=${family}]`).click(); await expect(page.locator('[data-cfg-action=reload]')).toBeEnabled();
  if (await page.locator('.cfg-version').isEnabled()) await page.locator('[data-cfg-action=new]').click();
  await page.locator('[name=cfgName]').fill(name); await page.locator('[data-cfg-tab=json]').click(); await page.locator('.cfg-json').fill(JSON.stringify(definition));
  await page.locator('[data-cfg-action=save]').click(); await expect(page.locator('.cfg-message')).toContainText('Configuration committed');
  await page.locator('[data-cfg-action=publish]').click(); await expect(page.locator('.cfg-version')).toHaveValue('1'); await expect(page.locator('[data-cfg-action=reload]')).toBeEnabled();
  return (await page.locator('.cfg-version-bar > span').textContent()).split(' / revision ')[0];
}
async function apply(page) {
  const before = await page.evaluate(() => window.__timelineDebug.queryId);
  await page.locator('[data-cfg-action=apply]').click(); await expect(page.locator('.cfg-message')).toContainText('Configuration committed');
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.queryId)).not.toBe(before); await ready(page);
}
async function exportJson(page) {
  await page.locator('[data-action=sources]').first().click(); const pending = page.waitForEvent('download'); await page.locator('#export-json').click();
  const stream = await (await pending).createReadStream(); let text = ''; for await (const bytes of stream) text += bytes;
  await page.locator('.modal [data-action=close-modal]').click();
  return JSON.parse(text);
}
const filter = { sourceIds: ['operations'], kinds: ['session'], schemaRefs: [], expression: null, search: { text: 'gate', mode: 'any', caseSensitive: false, fields: ['/title'] } };

test('cold bootstrap can take more than two seconds without premature sample data', async ({ page }) => {
  let entered, release;
  const requested = new Promise(resolve => { entered = resolve; });
  const inspected = new Promise(resolve => { release = resolve; });
  await page.route('**/api/v1/bootstrap', async route => {
    entered();
    await inspected;
    const elapsed = await page.evaluate(() => performance.now() - window.__bootstrapDiagnostic[0].startedAt);
    // Browser dispatch is part of the probe budget, not an additional delay.
    if (elapsed < 2500) await new Promise(resolve => setTimeout(resolve, Math.ceil(2500 - elapsed)));
    await route.continue();
  });
  const opening = open(page, 'local');
  try {
    await requested;
    expect(await page.evaluate(() => Boolean(window.__timelineDebug?.queryId))).toBe(false);
    await expect(page.locator('.record-label')).toHaveCount(0);
  } finally { release(); }
  expect(await opening).toEqual([]);
  const [probe] = await page.evaluate(() => window.__bootstrapDiagnostic);
  expect(probe.status).toBe(404);
  expect(probe.elapsedMs).toBeGreaterThanOrEqual(2500);
});

for (const mode of ['local', 'server']) {
  test(`${mode} Apply preserves genuine temporary settings, uses saved-filter scope and exports principal-owned preferences`, async ({ page }, info) => {
    const errors = await open(page, mode);
    await page.locator('[data-action=range]').first().click(); await page.locator('#range-form [name=from]').fill('2026-09-12T10:00'); await page.locator('#range-form [name=to]').fill('2026-09-12T13:00'); await page.locator('#range-form [type=submit]').click(); await ready(page);
    const window = await page.evaluate(() => ({ fromMs: window.__timelineDebug.fromMs, toMs: window.__timelineDebug.toMs }));
    await page.locator('#auto-scale').check(); await page.locator('#search').fill('temporary old search'); await ready(page);
    await manager(page); const filterId = await create(page, 'filters', 'Operations gates', filter); await apply(page);
    await expect(page.locator('#search')).toHaveValue('gate'); await expect(page.locator('#auto-scale')).toBeChecked();
    expect(await page.evaluate(() => ({ fromMs: window.__timelineDebug.fromMs, toMs: window.__timelineDebug.toMs }))).toEqual(window);
  const columns = [{ field: 'title', visible: true, width: 260 }, { field: 'sourceId', visible: false, width: 100 }, { field: 'start', visible: true, width: 210 }, { field: 'data.status', visible: true, width: 140 }];
    const viewId = await create(page, 'views', 'Operations review', { model: { id: 'light', version: 1 }, filter: { id: filterId, version: 1 }, settings: { theme: 'dark', mode: 'table', columns, sort: [{ field: 'sourceId', direction: 'asc' }, { field: 'title', direction: 'desc' }] } });
    await apply(page); await page.locator('[data-cfg-action=close]').click();
    const expected = fixture.records.filter(record => record.sourceId === 'operations' && record.kind === 'session');
    await expect(page.locator('.table-view tbody tr')).toHaveCount(expected.length);
    expect(await page.locator('.table-view th button').evaluateAll(nodes => nodes.map(node => node.dataset.tableSort))).toEqual(['title', 'start', 'data.status']);
    expect(await page.locator('.table-view th').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().width)))).toEqual([260, 210, 140]);
    expect(await page.locator('.table-view tbody tr').evaluateAll(nodes => nodes.map(node => node.dataset.recordId))).toEqual(expected.slice().sort((a, b) => a.title < b.title ? 1 : a.title > b.title ? -1 : a.id.localeCompare(b.id)).map(record => record.id));
    await expect(page.locator('#app')).toHaveClass(/dark/); await expect(page.locator('#auto-scale')).toBeChecked();
    const snapshot = await exportJson(page), principal = snapshot.preferences.find(entry => entry.values.viewId === viewId);
    expect(principal).toBeTruthy(); expect(principal.values.range).toEqual({ from: '2026-09-12T10:00:00.000Z', to: '2026-09-12T13:00:00.000Z' }); expect(principal.values.scaleMode).toBe('adaptive');
    expect(snapshot.manifest.localPreferencesPrincipalId).toBe(principal.principalId);
    if (mode === 'server') expect(principal.principalId).not.toBe('local');
    const imported = new LocalProvider(snapshot);
    try {
      const metadata = await imported.initialize();
      expect(metadata.actor.id).toBe(principal.principalId);
      expect(metadata.actor.verified).toBe(false);
    } finally { await imported.dispose(); }
    expect(snapshot.settings.viewId).not.toBe(viewId); expect(snapshot.settings.filterId).not.toBe(filterId);
    expect(snapshot.manifest.contentSha256).toBe(await sha256(snapshotContent(snapshot)));
    await page.screenshot({ path: info.outputPath(`configuration-apply-${mode}.png`) });
    await page.locator('[data-action=sources]').first().click(); await page.locator('#json-file').setInputFiles({ name: 'configuration-export.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) }); await ready(page);
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('local');
    await expect(page.locator('.table-view tbody tr')).toHaveCount(expected.length);
    await expect(page.locator('#app')).toHaveClass(/dark/);
    await expect(page.locator('#search')).toHaveValue('gate');
    await expect(page.locator('#auto-scale')).toBeChecked();
    expect(await page.evaluate(() => ({ fromMs: window.__timelineDebug.fromMs, toMs: window.__timelineDebug.toMs }))).toEqual(window);
    const roundTrip = await exportJson(page);
    expect(roundTrip.manifest.localPreferencesPrincipalId).toBe(principal.principalId);
    expect(roundTrip.preferences.map(({ revision, ...entry }) => entry)).toEqual(snapshot.preferences.map(({ revision, ...entry }) => entry));
    expect(roundTrip.preferences.find(entry => entry.principalId === principal.principalId).revision).toBeGreaterThanOrEqual(principal.revision);
    expect(roundTrip.preferences.filter(entry => entry.principalId !== principal.principalId)).toEqual(snapshot.preferences.filter(entry => entry.principalId !== principal.principalId));
    expect(roundTrip.records).toEqual(snapshot.records);
    expect(errors).toEqual([]);
  });
}

test('version 1 catalog group collapse is rejected before Apply changes preference state', async ({ page }) => {
  const errors = await open(page, 'local'); await manager(page);
  await page.locator('[data-cfg-family=groups]').click(); await page.locator('[name=cfgName]').fill('Future collapse group'); await page.locator('[data-cfg-action=save]').click(); await expect(page.locator('.cfg-message')).toContainText('Configuration committed');
  const groupId = (await page.locator('.cfg-version-bar > span').textContent()).split(' / revision ')[0];
  await create(page, 'views', 'Collapse review', { model: { id: 'light', version: 1 }, filter: null, settings: { collapsedGroups: [groupId] } });
  const before = await page.evaluate(() => window.__timelineDebug.queryId); await page.locator('[data-cfg-action=apply]').click();
  await expect(page.locator('.cfg-message')).toContainText('Group collapse requires a version 2 view with typed group keys'); expect(await page.evaluate(() => window.__timelineDebug.queryId)).toBe(before);
  await page.locator('[data-cfg-action=close]').click(); const snapshot = await exportJson(page); expect(snapshot.preferences).toHaveLength(0); expect(errors).toEqual([]);
});

test('version 2 saved views apply typed group collapse without dropping records or changing temporal focus', async ({ page }) => {
  const errors = await open(page, 'local'); await manager(page);
  const definition = { definitionVersion: 2, model: { id: 'light', version: 1 }, filter: null,
    settings: { definitionVersion: 2, mode: 'timeline', groupBy: 'sourceId', collapsedGroups: ['string:operations'] } };
  const viewId = await create(page, 'views', 'Collapsed operations review', definition);
  const range = await page.evaluate(() => ({ fromMs: window.__timelineDebug.fromMs, toMs: window.__timelineDebug.toMs }));
  await apply(page); await page.locator('[data-cfg-action=close]').click();
  const group = page.locator('.plot-wrap [data-group-key="string:operations"]');
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  const collapsed = await page.evaluate(() => window.__timelineDebug);
  const snapshot = await exportJson(page);
  expect(snapshot.records).toHaveLength(fixture.records.length);
  expect(snapshot.preferences.some(entry => entry.values.viewId === viewId)).toBe(true);
  await group.click(); await expect(group).toHaveAttribute('aria-expanded', 'true'); await ready(page);
  const expanded = await page.evaluate(() => window.__timelineDebug);
  expect(expanded.queryId).toBe(collapsed.queryId); expect(expanded.mapId).toBe(collapsed.mapId);
  expect(expanded.detailTotal).toBe(collapsed.detailTotal); expect(expanded.overviewTotal).toBe(collapsed.overviewTotal);
  expect(expanded.totalRows).toBeGreaterThan(collapsed.totalRows);
  expect(await page.evaluate(() => ({ fromMs: window.__timelineDebug.fromMs, toMs: window.__timelineDebug.toMs }))).toEqual(range);
  expect(errors).toEqual([]);
});

test('schema-typed table columns display Boolean and array values with global numeric multi-sort', async ({ page }, info) => {
  const local = new LocalProvider(fixture), metadata = await local.initialize();
  const draft = await local.mutateConfiguration({ family: 'schemas', type: 'create', generation: metadata.generation, clientCommandId: crypto.randomUUID(), payload: { name: 'Table metrics', visibility: 'workspace', definition: { schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { rank: { type: 'number' }, approved: { type: 'boolean' }, labels: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } } } });
  const publication = await local.mutateConfiguration({ family: 'schemas', type: 'publish', resourceId: draft.resource.id, expectedRevision: draft.resource.revision, generation: metadata.generation, clientCommandId: crypto.randomUUID(), payload: {} });
  const snapshot = await local.exportSnapshot(); local.dispose();
  snapshot.records.forEach((record, index) => { record.schemaId = publication.resource.id; record.schemaVersion = 1; record.data.rank = index % 4; record.data.approved = Math.floor(index / 3) % 2 === 0; record.data.labels = [`label${index}`, 'review']; }); delete snapshot.manifest.contentSha256;
  const errors = await open(page, 'local'); await page.locator('[data-action=sources]').first().click(); await page.locator('#json-file').setInputFiles({ name: 'typed-columns.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) }); await ready(page);
  await manager(page); const filterId = await create(page, 'filters', 'Typed record scope', { ...filter, sourceIds: null, kinds: ['event', 'session'], schemaRefs: [{ id: publication.resource.id, version: 1 }], search: { text: '', mode: 'any', caseSensitive: false, fields: ['/title'] } });
  await create(page, 'views', 'Metrics table', { model: { id: 'light', version: 1 }, filter: { id: filterId, version: 1 }, settings: { mode: 'table', columns: [{ field: 'title', visible: true, width: 230 }, { field: '/data/rank', visible: true, width: 90 }, { field: '/data/approved', visible: true, width: 110 }, { field: '/data/labels', visible: true, width: 230 }], sort: [{ field: '/data/rank', direction: 'desc' }, { field: '/data/approved', direction: 'asc' }] } });
  await apply(page); await page.locator('[data-cfg-action=close]').click(); await expect(page.locator('.table-view tbody tr')).toHaveCount(48);
  const expected = snapshot.records.slice().sort((a, b) => b.data.rank - a.data.rank || Number(a.data.approved) - Number(b.data.approved) || a.id.localeCompare(b.id));
  expect(await page.locator('.table-view tbody tr').evaluateAll(nodes => nodes.map(node => node.dataset.recordId))).toEqual(expected.map(record => record.id));
  const cells = page.locator('.table-view tbody tr').first().locator('td'); await expect(cells.nth(1)).toHaveText(String(expected[0].data.rank)); await expect(cells.nth(2)).toHaveText(String(expected[0].data.approved)); await expect(cells.nth(3)).toHaveText(JSON.stringify(expected[0].data.labels));
  await expect(page.locator('[data-table-sort="/data/labels"]')).toBeDisabled(); await page.screenshot({ path: info.outputPath('configuration-typed-columns.png') }); expect(errors).toEqual([]);
});

test('authored view range and scale replace only those genuine transient overrides', async ({ page }) => {
  const errors = await open(page, 'local'); await page.locator('#auto-scale').check(); await page.locator('[data-view=split]').click(); await ready(page);
  await manager(page); await create(page, 'views', 'Focused uniform range', { model: { id: 'light', version: 1 }, filter: null, settings: { scaleMode: 'uniform', range: { from: '2026-09-12T11:00:00.000Z', to: '2026-09-12T12:00:00.000Z' } } });
  await apply(page); await page.locator('[data-cfg-action=close]').click(); await expect(page.locator('#auto-scale')).not.toBeChecked();
  expect(await page.evaluate(() => ({ from: window.__timelineDebug.fromMs, to: window.__timelineDebug.toMs, view: window.__timelineDebug.view }))).toEqual({ from: String(Date.parse('2026-09-12T11:00:00.000Z')), to: String(Date.parse('2026-09-12T12:00:00.000Z')), view: 'split' });
  expect(errors).toEqual([]);
});

test('Server catalog lost reply survives reload using principal-scoped identity and original GET only', async ({ page }) => {
  const errors = await open(page, 'server'), writes = [], gets = [];
  page.on('request', request => { if (request.url().endsWith('/configuration/commands')) writes.push(request.postDataJSON()); if (request.url().includes('/command-results/')) gets.push({ method: request.method(), url: request.url() }); });
  await manager(page); await page.locator('[data-cfg-family=filters]').click(); await page.locator('[name=cfgName]').fill('Private catalog definition');
  await page.route('**/configuration/commands', async route => { expect((await route.fetch()).ok()).toBe(true); await route.fulfill({ status: 200, contentType: 'application/json', body: '{lost' }); });
  await page.locator('[data-cfg-action=save]').click(); await expect(page.locator('.cfg-outcome-check')).toBeVisible(); await expect(page.locator('.cfg-outcome-check')).toBeEnabled(); await expect(page.locator('[data-cfg-action=save]')).toBeDisabled();
  const key = 'openbexi:configuration-command-recovery:v1', identities = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
  expect(identities).toHaveLength(1); expect(identities[0].principalId).toBeTruthy(); expect(identities[0].clientCommandId).toBe(writes[0].clientCommandId); expect(JSON.stringify(identities)).not.toMatch(/Private catalog|definition|payload|test-only-token/);
  await page.unroute('**/configuration/commands'); await page.reload(); await ready(page);
  await page.locator('[data-action=sources]').first().click(); await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl); await page.locator('#server-form [name=token]').fill(server.token); await page.locator('#server-form [type=submit]').click(); await page.locator('#switch-source').click(); await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server'); await ready(page);
  await manager(page); await expect(page.locator('.cfg-outcome-check')).toBeVisible(); await page.locator('.cfg-outcome-check').click(); await expect(page.locator('.cfg-message')).toContainText('Configuration committed');
  expect(writes).toHaveLength(1); expect(gets).toEqual([{ method: 'GET', url: `${server.baseUrl}/api/v1/workspaces/default/command-results/${identities[0].clientCommandId}` }]);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull(); expect(errors).toEqual([]);
});
