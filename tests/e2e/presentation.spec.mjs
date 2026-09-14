import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { startServer } from '../integration/server-fixture.mjs';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import hazardIcons from '../../shared/legacy-hazard-icons.json' with { type: 'json' };

const sample = JSON.parse(await readFile('shared/fixtures/initial-snapshot.json', 'utf8'));
const definition = {
  theme: 'light', rowHeight: 32, fontSize: 13, groupBy: 'none', displayUnit: 'HOUR', timeZone: 'UTC', scaleMode: 'uniform', ratio: 4, bins: 128,
  presentation: { version: 1, bands: { primary: { backgroundColor: '#f4f6f7', textColor: '#27343a', dateColor: '#34576b', axisPosition: 'top', intervalUnit: 'HOUR', dateFormat: 'MM/dd-hh:mm', barHeight: 12, pointRadius: 6 }, overview: { backgroundColor: '#dce7ec', eventColor: '#7c35a5', sessionColor: '#2b7795', axisPosition: 'bottom', intervalUnit: 'DAY', dateFormat: 'yyyy mmm dd', barHeight: 4, pointRadius: 3 } }, labels: { fields: ['/title', '/data/status'], fontSize: 14, fontWeight: 400, fontStyle: 'normal', maxLines: 2 }, sourceStyles: [{ sourceId: 'operations', backgroundColor: '#17232d', textColor: '#f5f5f5', dateColor: '#eeeeee' }], inspector: { fields: [{ field: '/data/status', label: 'Operational state' }, { field: '/data/details', label: 'Details JSON' }] }, nesting: { enabled: true, color: '#75a9b4', opacity: 0.15 }, baseline: { enabled: true, color: '#78909c' } },
};
let server;
test.beforeEach(async ({}, info) => { server = info.title.startsWith('Server presentation') ? await startServer() : null; });
test.afterEach(async () => { await server?.stop(); });

function fixture() {
  const snapshot = structuredClone(sample), base = snapshot.records.find(record => record.kind === 'session'), parentId = randomUUID();
  snapshot.records = Array.from({ length: 5 }, (_, index) => ({ ...structuredClone(base), id: index ? randomUUID() : parentId, sourceId: 'operations', title: index ? `Activity ${index}\nSecond line for activity ${index}` : 'Parent operation\nSecond line for parent', start: `2026-09-12T${String(8 + index).padStart(2, '0')}:20:00.000Z`, end: index === 3 ? null : `2026-09-12T${String(index ? 9 + index : 16).padStart(2, '0')}:00:00.000Z`, kind: index === 3 ? 'event' : 'session', parentSessionId: index ? parentId : null, order: index, data: { status: 'Running', details: { safe: '<script>not executable</script>' } }, originalStart: `2026-09-12T${String(8 + index).padStart(2, '0')}:10:00.000Z`, originalEnd: index === 3 ? null : `2026-09-12T${String(index ? 9 + index : 16).padStart(2, '0')}:10:00.000Z`, render: { color: index === 1 ? '#a73359' : '#008a80', ...(index === 1 ? { fontSize: 16, fontWeight: 700, fontStyle: 'italic', icon: 'check', barHeight: 14 } : index === 3 ? { icon: 'star', pointRadius: 7 } : {}) } }));
  const time = snapshot.manifest.snapshotAt;
  const schemaId = randomUUID();
  snapshot.schemas = [{ formatVersion: 1, id: schemaId, name: 'Presentation inspection data', description: '', tags: [], revision: 1, lifecycle: 'active', createdAt: time, updatedAt: time, ownerId: 'local', visibility: 'workspace', copiedFrom: null, draft: null, versions: [{ version: 1, publishedAt: time, publishedBy: 'local', definition: { schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { details: { type: 'object', properties: { safe: { type: 'string' } }, additionalProperties: false } }, additionalProperties: false } } }] }];
  snapshot.records.forEach(record => { record.schemaId = schemaId; record.schemaVersion = 1; });
  snapshot.records[2].render.fontWeight = 700; snapshot.records[4].render.fontStyle = 'italic';
  snapshot.models = [{ id: 'presentation-fixture', name: 'Presentation fixture', description: '', tags: [], revision: 1, lifecycle: 'active', createdAt: time, updatedAt: time, draft: null, versions: [{ version: 1, publishedAt: time, definition: structuredClone(definition) }] }];
  Object.assign(snapshot.settings, structuredClone(definition), { modelId: 'presentation-fixture', modelVersion: 1 });
  snapshot.manifest.recordCount = 5; snapshot.manifest.generation = randomUUID(); snapshot.manifest.bundleId = randomUUID(); delete snapshot.manifest.contentSha256;
  return snapshot;
}
async function boot(page, url = server?.baseUrl || pathToFileURL(path.resolve('dist/index.html')).href) {
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(url); await expect(page.locator('.record-label').first()).toBeVisible(); return errors;
}
async function importFixture(page, snapshot) {
  const source = page.locator('[data-action=sources]:visible').first();
  if (await source.count()) await source.click();
  else { await page.locator('[data-action=settings]').click(); await page.locator('#source-command').click(); }
  await page.locator('#json-file').setInputFiles({ name: 'presentation-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
  await expect(page.locator('#json-file')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(snapshot.records.length);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
}
async function canvasCheck(page, selector) {
  await expect(page.locator(selector)).toBeVisible();
  await expect.poll(() => page.locator(selector).evaluate(canvas => Math.abs(canvas.getBoundingClientRect().width - canvas.parentElement.clientWidth))).toBeLessThan(1);
  const colors = await page.locator(selector).evaluate(canvas => {
    const gl = canvas.getContext('webgl2'), pixels = new Uint8Array(canvas.width * canvas.height * 4), colors = new Set();
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let i = 0; i < pixels.length; i += 16) colors.add(pixels[i] * 65536 + pixels[i + 1] * 256 + pixels[i + 2]);
    return colors.size;
  });
  expect(colors).toBeGreaterThan(5);
}
async function connect(page) {
  await page.locator('[data-action=sources]').first().click(); await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl); await page.locator('#server-form [name=token]').fill(server.token);
  await page.locator('#server-form [type=submit]').click(); await page.locator('#switch-source').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server');
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
}

test('Local presentation paints measured multiline font variants, approved icons, baselines, axes and text-only inspector fields', async ({ page }, info) => {
  const errors = await boot(page), snapshot = fixture(); await importFixture(page, snapshot);
  const id = snapshot.records[1].id, label = page.locator(`.plot-wrap .record-label[data-record-id="${id}"]`);
  await expect(label).toHaveAttribute('data-multiline', 'true'); await expect(label.locator('.record-label-line')).toHaveCount(2);
  await expect(label).toHaveCSS('font-weight', '700'); await expect(label).toHaveCSS('font-style', 'italic'); await expect(label).toHaveCSS('font-size', '16px');
  await expect(page.locator(`.plot-wrap .record-label[data-record-id="${snapshot.records[2].id}"]`)).toHaveCSS('font-weight', '700');
  await expect(page.locator(`.plot-wrap .record-label[data-record-id="${snapshot.records[4].id}"]`)).toHaveCSS('font-style', 'italic');
  const icon = page.locator(`.plot-wrap .record-icon[data-record-id="${id}"] svg`); await expect(icon).toHaveCSS('width', '16px'); await expect(icon).toHaveCSS('height', '16px');
  const positions = await page.evaluate(id => { const label = document.querySelector(`.plot-wrap .record-label[data-record-id="${id}"]`).getBoundingClientRect(), bar = document.querySelector(`.plot-wrap .record-hit[data-record-id="${id}"]`).getBoundingClientRect(), axis = document.querySelector('.main-axis').getBoundingClientRect(), plot = document.querySelector('.plot-wrap').getBoundingClientRect(); return { labelBottom: label.bottom, barTop: bar.top, axisBottom: axis.bottom, plotTop: plot.top }; }, id);
  expect(positions.labelBottom).toBeLessThanOrEqual(positions.barTop); expect(positions.axisBottom).toBeLessThanOrEqual(positions.plotTop + 1);
  await expect(page.locator('.main-axis')).toContainText('09/12-'); await expect(page.locator('.overview-axis')).toContainText('2026 Sep');
  await canvasCheck(page, '.plot-wrap canvas'); await canvasCheck(page, '.overview-plot canvas');
  const pointClearance = await page.evaluate(record => { const plot = document.querySelector('.plot-wrap').getBoundingClientRect(), svg = document.querySelector(`.plot-wrap .record-icon[data-record-id="${record.id}"] svg`).getBoundingClientRect(), view = window.__timelineDebug; const center = plot.left + (Date.parse(record.start) - Number(view.fromMs)) / (Number(view.toMs) - Number(view.fromMs)) * plot.width; return center - record.render.pointRadius - svg.right; }, snapshot.records[3]);
  expect(pointClearance).toBeGreaterThanOrEqual(4.9);
  await label.click(); await expect(page.locator('.descriptor')).toContainText('Operational state'); await expect(page.locator('.descriptor')).toContainText('<script>not executable</script>');
  expect(await page.locator('.descriptor script').count()).toBe(0);
  await canvasCheck(page, '.plot-wrap canvas'); await page.mouse.move(0, 0); await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('presentation-desktop.png'), fullPage: true }); expect(errors).toEqual([]);
});

test('parent enclosure fragments follow 2/2/1 canonical record pages without duplicate activities', async ({ page }, info) => {
  const errors = await boot(page), snapshot = fixture(); await importFixture(page, snapshot);
  await page.locator('.plot-wrap').evaluate(node => { node.style.flex = 'none'; node.style.height = '220px'; });
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.loadedCount)).toBe(2);
  const seen = [], flags = [[false, true], [true, true], [true, false]];
  for (let index = 0; index < 3; index++) {
    const loadedCount = index === 2 ? 1 : 2;
    await expect.poll(() => page.evaluate(() => { const { startRow, endRow, loadedCount } = window.__timelineDebug; return { startRow, endRow, loadedCount }; })).toEqual({ startRow: index * 2, endRow: Math.min(index * 2 + 2, 5), loadedCount });
    const enclosure = page.locator('.plot-wrap .session-enclosure'); await expect(enclosure).toHaveCount(1);
    await expect(enclosure).toHaveAttribute('data-continued-before', String(flags[index][0])); await expect(enclosure).toHaveAttribute('data-continued-after', String(flags[index][1]));
    await expect(page.locator('.plot-wrap .record-label')).toHaveCount(loadedCount);
    seen.push(...await page.locator('.plot-wrap .record-label').evaluateAll(nodes => nodes.map(node => node.dataset.recordId)));
    await page.screenshot({ path: info.outputPath(`nested-page-${index + 1}.png`) });
    if (index < 2) await page.locator('[data-action=next]').click();
  }
  expect(seen).toHaveLength(5); expect(new Set(seen).size).toBe(5); expect(seen.sort()).toEqual(snapshot.records.map(record => record.id).sort()); expect(errors).toEqual([]);
});

test('Server presentation editor preserves structured and JSON state, previews without applying, and restores pinned styles after restart', async ({ page }, info) => {
  const provider = new ServerProvider({ baseUrl: server.baseUrl, token: server.token }); const status = await provider.initialize();
  const target = sample.records.filter(record => record.kind === 'event').sort((a, b) => a.start.localeCompare(b.start))[0];
  await provider.executeCommand({ type: 'update', recordId: target.id, expectedVersion: target.version, generation: status.generation, clientCommandId: randomUUID(), payload: { title: 'Styled server point\nSecond line', render: { color: '#b44974', fontSize: 16, fontWeight: 700, fontStyle: 'italic', icon: 'star', pointRadius: 7 } } });
  const errors = await boot(page); await connect(page); await page.locator('[data-action=models]').click(); await expect(page.locator('.model-catalog-item').first()).toBeVisible();
  await page.locator('[data-action=model-new]').click(); await page.locator('[name=modelName]').fill('Published presentation');
  await page.locator('[data-presentation-enabled]').check();
  await page.locator('[data-presentation-path="bands.primary.backgroundColor"]').fill('#ddeeff'); await page.locator('[data-presentation-path="bands.primary.backgroundColor"]').dispatchEvent('change');
  await page.locator('[data-model-tab=json]').click(); expect(JSON.parse(await page.locator('.model-json').inputValue()).presentation.bands.primary.backgroundColor).toBe('#ddeeff');
  const authored = structuredClone(definition); authored.presentation.sourceStyles.push({ sourceId: 'future-source', textColor: '#abcdef' });
  await page.locator('.model-json').fill(JSON.stringify(authored, null, 2));
  const before = await page.evaluate(() => window.__timelineDebug);
  await page.locator('[data-model-tab=preview]').click(); await expect(page.locator('.model-preview-canvas')).toHaveAttribute('data-preview-state', 'ready');
  await expect(page.locator('.model-preview-summary')).toContainText('Unused source styles: future-source');
  await canvasCheck(page, '.model-preview-canvas canvas'); expect((await page.evaluate(() => window.__timelineDebug)).queryId).toBe(before.queryId);
  await page.screenshot({ path: info.outputPath('presentation-preview.png'), fullPage: true });
  await page.locator('[data-model-tab=fields]').click(); await page.locator('[data-action=model-save]').click(); await expect(page.locator('.model-message')).toContainText('Model saved');
  await page.locator('[data-action=model-publish]').click(); await expect(page.locator('.model-message')).toContainText('Immutable version published');
  await page.locator('[data-action=model-apply]').click(); await expect(page.locator('.model-message')).toContainText('Pinned version applied'); await page.locator('[data-action=model-close]').click();
  await expect(page.locator('.main-axis')).toContainText('09/12-'); await expect(page.locator('.record-icon').first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('presentation-server.png'), fullPage: true });
  await server.restart(); await page.reload(); await expect(page.locator('.record-label').first()).toBeVisible(); await connect(page);
  await expect(page.locator('.main-axis')).toContainText('09/12-'); expect(errors).toEqual([]);
});

test('offline narrow presentation and model preview render nonblank aligned canvases', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = []; page.on('request', request => { if (request.url().startsWith('http')) requests.push(request.url()); });
  const errors = await boot(page, pathToFileURL(path.resolve('dist/index.html')).href); await importFixture(page, fixture());
  await canvasCheck(page, '.plot-wrap canvas'); await canvasCheck(page, '.overview-plot canvas');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.mouse.move(0, 0); await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('presentation-mobile.png'), fullPage: true });
  await page.locator('[data-action=settings]').click(); await page.locator('#models-command').click(); await expect(page.locator('.model-catalog-item')).toHaveCount(1);
  await page.locator('[data-model-tab=preview]').click(); await expect(page.locator('.model-preview-canvas')).toHaveAttribute('data-preview-state', 'ready');
  await canvasCheck(page, '.model-preview-canvas canvas');
  await page.screenshot({ path: info.outputPath('presentation-mobile-preview.png'), fullPage: true });
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});

test('four-line 24px labels retain a complete row, overview and table in narrow Split and preview', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await boot(page), snapshot = fixture();
  const tall = { fields: ['/title'], fontSize: 24, fontWeight: 700, fontStyle: 'italic', maxLines: 4 };
  snapshot.settings.presentation.labels = tall; snapshot.models[0].versions[0].definition.presentation.labels = tall;
  for (const record of snapshot.records) { record.title = 'Line one\nLine two\nLine three\nLine four'; record.render = { color: '#008a80', barHeight: 20 }; }
  await importFixture(page, snapshot); await page.locator('[data-view=split]').click();
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await expect(page.locator('.plot-wrap .record-label-line')).toHaveCount(4);
  await canvasCheck(page, '.plot-wrap canvas'); await canvasCheck(page, '.overview-plot canvas');
  const bounds = await page.evaluate(() => Object.fromEntries(['.plot-wrap', '.overview-section', '.table-view', 'footer'].map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [selector, { top: r.top, bottom: r.bottom, height: r.height }]; })));
  const rowHeight = await page.evaluate(() => window.__timelineDebug.effectiveRowHeight);
  expect(bounds['.plot-wrap'].height).toBeGreaterThanOrEqual(rowHeight + 52);
  const lastInk = await page.locator('.plot-wrap .record-label, .plot-wrap .record-hit').evaluateAll(nodes => Math.max(...nodes.map(node => node.getBoundingClientRect().bottom)));
  expect(lastInk).toBeLessThanOrEqual(bounds['.plot-wrap'].bottom);
  expect(bounds['.overview-section'].bottom).toBeLessThanOrEqual(bounds['.table-view'].top + 1); expect(bounds['.table-view'].bottom).toBeLessThanOrEqual(bounds.footer.top + 1); expect(bounds.footer.bottom).toBeLessThanOrEqual(845);
  const tableRow = await page.evaluate(() => { const row = document.querySelector('.table-scroll tbody tr').getBoundingClientRect(), scroll = document.querySelector('.table-scroll').getBoundingClientRect(), head = document.querySelector('.table-scroll thead').getBoundingClientRect(); return { top: row.top, bottom: row.bottom, headBottom: head.bottom, visibleBottom: scroll.bottom }; });
  expect(tableRow.top).toBeGreaterThanOrEqual(tableRow.headBottom); expect(tableRow.bottom).toBeLessThanOrEqual(tableRow.visibleBottom);
  expect(await page.locator('.filter-strip').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await page.locator('#auto-scale').scrollIntoViewIfNeeded();
  await expect(page.locator('#auto-scale')).toBeInViewport();
  await page.locator('.range-button').scrollIntoViewIfNeeded();
  const dateControl = await page.locator('.range-button').evaluate(node => {
    const box = node.getBoundingClientRect(), grouping = document.querySelector('#grouping-mode').getBoundingClientRect();
    return { clipped: node.scrollWidth > node.clientWidth + 1, outside: box.right > innerWidth,
      overlap: Math.min(box.right, grouping.right) > Math.max(box.left, grouping.left) && Math.min(box.bottom, grouping.bottom) > Math.max(box.top, grouping.top) };
  });
  expect(dateControl).toEqual({ clipped: false, outside: false, overlap: false });
  await page.mouse.move(0, 0); await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('presentation-mobile-tall-split.png'), fullPage: true });
  await page.locator('[data-action=settings]').click(); await page.locator('#models-command').click(); await page.locator('[data-model-tab=preview]').click();
  await expect(page.locator('.model-preview-canvas')).toHaveAttribute('data-preview-state', 'ready'); await canvasCheck(page, '.model-preview-canvas canvas');
  const previewBounds = await page.evaluate(() => { const host = document.querySelector('.model-preview-canvas').getBoundingClientRect(), label = document.querySelector('.model-preview-canvas .record-label').getBoundingClientRect(); return { bottom: label.bottom, limit: host.bottom }; });
  expect(previewBounds.bottom).toBeLessThanOrEqual(previewBounds.limit); expect(errors).toEqual([]);
});

test('mixed-source packed rows preserve label contrast while explicit backgrounds and null remain authoritative', async ({ page }, info) => {
  const errors = await boot(page), snapshot = fixture();
  snapshot.records = snapshot.records.slice(0, 2).map((record, index) => ({ ...record, title: index ? 'Verification' : 'Operations', sourceId: index ? 'verification' : 'operations', start: `2026-09-12T${index ? '15' : '09'}:00:00.000Z`, kind: 'event', end: null, originalStart: null, originalEnd: null, parentSessionId: null, render: {} }));
  const presentation = snapshot.settings.presentation;
  presentation.labels = { fields: ['/title'] }; presentation.nesting.enabled = false;
  snapshot.models[0].versions[0].definition.presentation = structuredClone(presentation); snapshot.manifest.recordCount = 2;
  await importFixture(page, snapshot);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.totalRows)).toBe(1);
  const label = page.locator(`.plot-wrap .record-label[data-record-id="${snapshot.records[0].id}"]`);
  await expect(label).toHaveCSS('background-color', 'rgb(23, 35, 45)'); await expect(label).toHaveCSS('color', 'rgb(245, 245, 245)');
  await label.hover(); await expect(label).toHaveCSS('background-color', 'rgb(23, 35, 45)');
  await expect(page.locator(`.plot-wrap .record-label[data-record-id="${snapshot.records[1].id}"]`)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.mouse.move(0, 0); await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('presentation-mixed-source.png') });
  for (const background of [null, '#ddeeff']) {
    snapshot.settings.presentation.labels.backgroundColor = background; snapshot.models[0].versions[0].definition.presentation.labels.backgroundColor = background;
    await importFixture(page, snapshot); await expect(label).toHaveCSS('background-color', background === null ? 'rgba(0, 0, 0, 0)' : 'rgb(221, 238, 255)');
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.totalRows)).toBe(1);
  }
  delete snapshot.settings.presentation.labels.backgroundColor; delete snapshot.models[0].versions[0].definition.presentation.labels.backgroundColor;
  snapshot.records[0].render.backgroundColor = null; await importFixture(page, snapshot);
  await expect(label).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)'); expect(errors).toEqual([]);
});

test('point-only multiline labels reserve their complete vertical text boxes across adjacent rows', async ({ page }, info) => {
  const errors = await boot(page), snapshot = fixture();
  snapshot.records = snapshot.records.slice(0, 2).map(record => ({ ...record, title: 'Alpha\nBeta\nGamma\nDelta', kind: 'event', start: '2026-09-12T12:00:00.000Z', end: null, parentSessionId: null, originalStart: '2026-09-12T11:00:00.000Z', originalEnd: '2026-09-12T13:00:00.000Z', render: { color: '#008a80' } }));
  snapshot.settings.presentation.labels = { fields: ['/title'], fontSize: 24, maxLines: 4 }; snapshot.settings.presentation.nesting.enabled = false;
  snapshot.models[0].versions[0].definition.presentation = structuredClone(snapshot.settings.presentation); snapshot.manifest.recordCount = 2;
  await importFixture(page, snapshot);
  await expect(page.locator('.plot-wrap .record-label-line')).toHaveCount(8);
  expect(await page.evaluate(() => window.__timelineDebug.effectiveRowHeight)).toBeGreaterThanOrEqual(144);
  const labels = await page.locator('.plot-wrap .record-label').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }).sort((a, b) => a.top - b.top));
  expect(labels[1].top).toBeGreaterThanOrEqual(labels[0].bottom + 6);
  await canvasCheck(page, '.plot-wrap canvas'); await page.mouse.move(0, 0); await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('presentation-point-label-clearance.png') }); expect(errors).toEqual([]);
});

for (const width of [1600, 390]) test(`offline legacy hazard icons, quarter-hour grid and search remain readable at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const requests = []; page.on('request', request => { if (request.url().startsWith('http')) requests.push(request.url()); });
  const errors = await boot(page), snapshot = fixture(), base = snapshot.records[0];
  snapshot.records = Object.values(hazardIcons).map((icon, index) => ({ ...structuredClone(base), id: randomUUID(), title: `Hazard ${index + 1}`, start: new Date(Date.parse('2026-09-12T12:05:00Z') + index * 25 * 60000).toISOString(), end: null, kind: 'event', parentSessionId: null, originalStart: null, originalEnd: null, render: { color: '#731616', icon } }));
  const presentation = { version: 1, bands: { primary: { backgroundColor: '#BBEDF0', axisPosition: 'top', intervalUnit: 'HOUR', minorDivisions: 4, dateFormat: 'MM/dd-hh:mm' }, overview: { backgroundColor: '#BCD9DB', intervalUnit: 'DAY' } }, labels: { fields: ['/title'], fontSize: 12 }, nesting: { enabled: true } };
  snapshot.records[0].title = 'P\u0101hala';
  snapshot.settings.presentation = presentation; snapshot.models[0].versions[0].definition.presentation = structuredClone(presentation); snapshot.manifest.recordCount = snapshot.records.length;
  await importFixture(page, snapshot);
  await page.locator('.range-button').click(); await page.locator('#range-form [name=from]').fill('2026-09-12T12:00'); await page.locator('#range-form [name=to]').fill('2026-09-12T16:00'); await page.locator('#range-form [type=submit]').click();
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  const icons = page.locator('.plot-wrap [data-hazard-icon]'); await expect(icons).toHaveCount(8);
  await expect.poll(() => icons.evaluateAll(nodes => nodes.every(node => node.complete && node.naturalWidth > 0))).toBe(true);
  const images = await icons.evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.hazardIcon, embedded: node.src.startsWith('data:image/png'), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
  expect(images.map(image => image.id).sort()).toEqual(Object.values(hazardIcons).sort());
  expect(images.every(image => image.embedded && image.width === 16 && image.height === 16)).toBe(true);
  if (width === 1600) await expect.poll(() => page.evaluate(() => window.__timelineDebug.totalRows)).toBe(1);
  await expect.poll(() => page.locator('.plot-wrap canvas').evaluate(canvas => JSON.parse(canvas.dataset.minorTicks).length)).toBe(12);
  await canvasCheck(page, '.plot-wrap canvas'); await canvasCheck(page, '.overview-plot canvas');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  const boxes = await page.locator('.plot-wrap .record-label').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; }));
  for (let index = 0; index < boxes.length; index++) for (const other of boxes.slice(index + 1)) {
    const box = boxes[index]; expect(Math.min(box.right, other.right) <= Math.max(box.left, other.left) || Math.min(box.bottom, other.bottom) <= Math.max(box.top, other.top)).toBe(true);
  }
  await page.locator(width === 390 ? '[data-action=settings]' : '[data-action=filters]').first().click();
  await page.locator('#settings-form [name=search]').fill('Hazard 3'); await page.locator('#settings-form [name=searchMode]').selectOption('phrase'); await page.locator('#settings-form [type=submit]').click();
  await expect(page.locator('.record-label.search-match')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.overviewMatched)).toBe(1);
  await expect(page.locator('.record-label')).toHaveCount(8);
  await page.mouse.move(0, 0); await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`hazards-${width}.png`), fullPage: true }); expect(requests).toEqual([]); expect(errors).toEqual([]);
});
