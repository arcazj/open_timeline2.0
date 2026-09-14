import { test, expect } from '@playwright/test';
import { readFile, writeFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let directory, fileUrl;
const raw = await readFile('data/default-dataset.json', 'utf8');
test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'openbexi worker '));
  const file = path.join(directory, 'index.html');
  await copyFile(path.resolve('dist/index.html'), file);
  fileUrl = pathToFileURL(file).href;
});
test.afterAll(async () => {
  if (path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('openbexi worker ')) await rm(directory, { recursive: true, force: true });
});

async function open(page, { blocked = false } = {}) {
  const requests = [], errors = [];
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:\/\//, route => route.abort('internetdisconnected'));
  await page.addInitScript(({ blocked }) => {
    window.__workerProbe = { urls: [], methods: [], inputTypes: [], completed: [], ticks: 0 };
    const NativeWorker = window.Worker;
    setInterval(() => window.__workerProbe.ticks++, 20);
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (blocked) throw new DOMException('Worker blocked by policy', 'SecurityError');
        super(url, options);
        const probe = window.__workerProbe;
        probe.urls.push(String(url));
        this.inflight = new Map();
        this.addEventListener('message', ({ data }) => {
          if (data.type !== 'response') return;
          const request = this.inflight.get(data.id);
          if (request) probe.completed.push({ ...request, milliseconds: performance.now() - request.started, ticks: probe.ticks - request.tickStart, error: data.error?.code });
          this.inflight.delete(data.id);
        });
      }
      postMessage(message, ...rest) {
        if (message.type === 'request') {
          const probe = window.__workerProbe;
          probe.methods.push(message.method);
          if (message.method === 'initialize') probe.inputTypes.push(typeof message.args[0]);
          this.inflight.set(message.id, { method: message.method, started: performance.now(), tickStart: probe.ticks });
        }
        return super.postMessage(message, ...rest);
      }
    };
  }, { blocked });
  await page.goto(fileUrl);
  await expect(page.locator('.record-label').first()).toBeVisible();
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  return { requests, errors };
}

test('copied file uses the embedded Blob worker for record/model edits, complete export and strict raw imports', async ({ page }) => {
  const observed = await open(page);
  expect(await page.evaluate(() => window.__timelineDebug.executionMode)).toBe('worker');
  await page.locator('[data-action=create]').click();
  await page.locator('#record-form [name=title]').fill('Worker checkpoint');
  await page.locator('#record-form [type=submit]').click();
  await expect(page.locator('[role=dialog]')).toHaveCount(0);
  await page.locator('[data-action=models]').first().click();
  await expect(page.locator('.model-catalog-item').first()).toBeVisible();
  await page.locator('[data-action=model-new]').click();
  await page.locator('[name=modelName]').fill('Worker authored model');
  await page.locator('[data-action=model-save]').click();
  await expect(page.locator('.model-message')).toContainText('Model saved');
  await page.locator('[data-action=model-close]').click();
  await page.locator('[data-action=sources]').first().click();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-json').click();
  const exported = JSON.parse(await readFile(await (await downloadEvent).path(), 'utf8'));
  expect(exported.records).toHaveLength(49);
  expect(exported.models.some(model => model.name === 'Worker authored model')).toBe(true);
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#json-file').setInputFiles({ name: 'worker-export.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await expect(page.locator('[role=dialog]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(49);
  const before = await page.evaluate(() => window.__timelineDebug.queryId);
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#json-file').setInputFiles({ name: 'duplicate.json', mimeType: 'application/json', buffer: Buffer.from('{"formatVersion":1,"formatVersion":1}') });
  await expect(page.locator('.form-error')).toContainText(/duplicate/i);
  expect(await page.evaluate(() => window.__timelineDebug.queryId)).toBe(before);
  const probe = await page.evaluate(() => window.__workerProbe);
  expect(probe.urls.every(url => url.startsWith('blob:'))).toBe(true);
  expect(probe.inputTypes).toEqual(['object', 'string', 'string']);
  for (const method of ['createQuery', 'createLayout', 'getRows', 'executeCommand', 'validateModel', 'executeModelCommand', 'exportSnapshot']) expect(probe.methods).toContain(method);
  expect(observed.requests).toEqual([]); expect(observed.errors).toEqual([]);
});

test('worker startup denial preserves functional direct Local mode without network requests', async ({ page }) => {
  const observed = await open(page, { blocked: true });
  expect(await page.evaluate(() => window.__timelineDebug.executionMode)).toBe('direct');
  await page.locator('[data-action=create]').click();
  await page.locator('#record-form [name=title]').fill('Direct fallback checkpoint');
  await page.locator('#record-form [type=submit]').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(49);
  expect(observed.requests).toEqual([]); expect(observed.errors).toEqual([]);
});

test('25,000-record raw import and global layout leave the browser event loop running', async ({ page }, info) => {
  test.setTimeout(90000);
  const observed = await open(page), snapshot = JSON.parse(raw);
  const from = Date.parse(snapshot.settings.range.from), span = Date.parse(snapshot.settings.range.to) - from;
  snapshot.records = Array.from({ length: 25000 }, (_, index) => ({ ...snapshot.records[index % snapshot.records.length], id: `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: `Load ${String(index).padStart(5, '0')}`, kind: 'event', start: new Date(from + Math.floor(index * span / 25000)).toISOString(), end: null, parentSessionId: null, originalStart: null, originalEnd: null, render: { color: '#39788a' } }));
  snapshot.manifest.recordCount = 25000;
  delete snapshot.manifest.contentSha256;
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#json-file').setInputFiles({ name: '25000-records.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal), { timeout: 60000 }).toBe(25000);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  expect(await page.evaluate(() => window.__timelineDebug.executionMode)).toBe('worker');
  const probe = await page.evaluate(() => window.__workerProbe);
  const layout = probe.completed.filter(request => request.method === 'createLayout').at(-1);
  expect(layout.error).toBeUndefined();
  expect(layout.ticks).toBeGreaterThan(1);
  expect(probe.inputTypes.at(-1)).toBe('string');
  expect(await page.evaluate(() => window.__timelineDebug.loadedCount)).toBeLessThanOrEqual(1000);
  const queryId = await page.evaluate(() => window.__timelineDebug.queryId);
  await page.locator('[data-view=table]').click();
  await expect(page.locator('.data-table tbody tr').first()).toBeVisible();
  await page.locator('[data-table-limit]').selectOption('1000');
  const ids = [];
  for (let index = 0; index < 25; index++) {
    await expect(page.locator('.table-pagination')).toContainText(`Page ${index + 1} of 25`);
    await expect(page.locator('.table-view')).toHaveAttribute('aria-busy', 'false');
    const pageIds = await page.locator('.data-table tbody tr').evaluateAll(rows => rows.map(row => row.dataset.recordId));
    expect(pageIds).toHaveLength(1000); ids.push(...pageIds);
    if (index < 24) await page.locator('[data-table-action=next]').click();
  }
  expect(new Set(ids).size).toBe(25000);
  expect(ids).toEqual(snapshot.records.map(record => record.id));
  await expect(page.locator('[data-table-action=next]')).toBeDisabled();
  expect(await page.evaluate(() => window.__timelineDebug.queryId)).toBe(queryId);
  const observation = { recordCount: 25000, traversedDistinctRecords: new Set(ids).size, importedBytes: Buffer.byteLength(JSON.stringify(snapshot)), operations: probe.completed.filter(request => ['initialize', 'createQuery', 'createLayout', 'getOverview'].includes(request.method)), note: 'Single-run responsiveness observation, not a p95 performance certification.' };
  const observationPath = info.outputPath('worker-observation.json');
  await writeFile(observationPath, JSON.stringify(observation, null, 2));
  await info.attach('worker-observation.json', { path: observationPath, contentType: 'application/json' });
  expect(observed.requests).toEqual([]); expect(observed.errors).toEqual([]);
});
