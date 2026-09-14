import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startServer } from '../integration/server-fixture.mjs';

const sampleText = await readFile('shared/fixtures/initial-snapshot.json', 'utf8');
let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });

async function boot(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__failureProbe = { workers: [], methods: [], terminations: [] };
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.probeIndex = window.__failureProbe.workers.length;
        window.__failureProbe.workers.push(this);
      }
      postMessage(message, ...rest) {
        if (message.type === 'request') window.__failureProbe.methods.push({ worker: this.probeIndex, method: message.method });
        return super.postMessage(message, ...rest);
      }
      terminate() {
        window.__failureProbe.terminations.push(this.probeIndex);
        return super.terminate();
      }
    };
  });
  await page.goto(server.baseUrl);
  await expect(page.locator('.record-label').first()).toBeVisible();
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  expect(await page.evaluate(() => window.__timelineDebug.executionMode)).toBe('worker');
  expect(await page.evaluate(() => window.__failureProbe.workers.length)).toBe(1);
  return errors;
}

async function createRecord(page, title) {
  await page.locator('[data-action=create]').click();
  await page.locator('#record-form [name=title]').fill(title);
  await page.locator('#record-form [type=submit]').click();
  await expect(page.locator('#record-form')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(49);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
}

async function crashWorker(page, index = 0) {
  await page.evaluate(index => window.__failureProbe.workers[index].dispatchEvent(new ErrorEvent('error', { message: 'Injected fatal idle worker failure', cancelable: true })), index);
  await expect.poll(() => page.evaluate(index => window.__failureProbe.terminations.includes(index), index)).toBe(true);
}

async function noAutomaticReplay(page, workers, mutationCount) {
  // This bounded quiet interval observes absence of restart/replay, not application readiness.
  const observed = await page.evaluate(() => new Promise(resolve => setTimeout(() => resolve({ workers: window.__failureProbe.workers.length, mutations: window.__failureProbe.methods.filter(item => ['executeCommand', 'executeModelCommand'].includes(item.method)).length }), 500)));
  expect(observed).toEqual({ workers, mutations: mutationCount });
}

async function connect(page) {
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl);
  await page.locator('#server-form [name=token]').fill(server.token);
  await page.locator('#server-form [type=submit]').click();
  await page.locator('#switch-source').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server');
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await expect(page.locator('.provider-status')).toContainText('Connected');
}

test('fatal idle Local worker loss preserves open drafts, blocks writes and export, and requires explicit complete-source import', async ({ page }, info) => {
  const errors = await boot(page);
  await createRecord(page, 'Lost Local branch record');
  const before = await page.evaluate(() => window.__timelineDebug);
  await page.locator('[data-action=create]').click();
  await page.locator('#record-form [name=title]').fill('Unsubmitted draft retained for recovery');
  await crashWorker(page);
  await expect(page.locator('.provider-status')).toContainText('Local / Unavailable');
  await expect(page.locator('.save-status')).toContainText('Local memory unavailable');
  await expect(page.locator('.notice')).toContainText('Displayed records are stale');
  await expect(page.locator('.notice')).toContainText('No writes were replayed');
  await expect(page.locator('#record-form [name=title]')).toHaveValue('Unsubmitted draft retained for recovery');
  await page.locator('#record-form [type=submit]').click();
  await expect(page.locator('.form-error')).toContainText(/Local worker stopped|Local source.*unavailable/i);
  await expect(page.locator('#record-form [name=title]')).toHaveValue('Unsubmitted draft retained for recovery');
  await page.locator('#cancel-edit').click();
  for (const selector of ['#search', '#source-filter', '#kind-filter', '#auto-scale', '[data-action=previous]', '[data-action=next]']) await expect(page.locator(selector)).toBeDisabled();
  for (const action of ['create', 'models', 'refresh', 'zoom-in']) await page.locator(`[data-action=${action}]`).first().dispatchEvent('click');
  await expect(page.locator('#record-form, .model-manager')).toHaveCount(0);
  expect((await page.evaluate(() => window.__timelineDebug)).queryId).toBe(before.queryId);
  await page.locator('[data-action=sources]').first().click();
  await expect(page.locator('#export-json')).toBeDisabled();
  await expect(page.locator('#import-json')).toBeEnabled();
  await noAutomaticReplay(page, 1, 1);
  await page.screenshot({ path: info.outputPath('local-worker-unavailable.png'), fullPage: true });
  await page.locator('#json-file').setInputFiles({ name: 'explicit-complete-source.json', mimeType: 'application/json', buffer: Buffer.from(sampleText) });
  await expect(page.locator('#json-file')).toHaveCount(0);
  await expect(page.locator('.provider-status')).toContainText('Local / Ready');
  await expect(page.locator('.notice')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(48);
  expect(await page.evaluate(() => window.__failureProbe.workers.length)).toBe(2);
  await expect(page.locator('#search')).toBeEnabled();
  await createRecord(page, 'Explicit replacement branch record');
  await page.locator('[data-action=sources]').first().click();
  await expect(page.locator('#export-json')).toBeEnabled();
  const download = page.waitForEvent('download'); await page.locator('#export-json').click();
  const exported = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(exported.records.some(record => record.title === 'Lost Local branch record')).toBe(false);
  expect(exported.records.some(record => record.title === 'Unsubmitted draft retained for recovery')).toBe(false);
  expect(exported.records.filter(record => record.title === 'Explicit replacement branch record')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('a dead retained Local branch cannot masquerade as its modified snapshot during Server outage fallback', async ({ page }, info) => {
  const errors = await boot(page), writes = [];
  page.on('request', request => { if (request.url().includes('/api/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && /\/records(?:\/|$)/.test(new URL(request.url()).pathname)) writes.push(request.url()); });
  await createRecord(page, 'Retained Local change that must not reappear');
  expect(await page.evaluate(() => window.__timelineDebug.dirty)).toBe(true);
  await connect(page);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(48);
  const before = await page.evaluate(() => window.__timelineDebug);
  await crashWorker(page, 0);
  await expect(page.locator('.provider-status')).toContainText('Server / Connected');
  expect((await page.evaluate(() => window.__timelineDebug)).queryId).toBe(before.queryId);
  await noAutomaticReplay(page, 1, 1);
  await server.pause(); await page.locator('[data-action=refresh]').first().click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('local');
  await expect(page.locator('.notice')).toContainText('retained Local worker was also unavailable');
  await expect(page.locator('.notice')).toContainText('unexported changes were not recovered');
  await expect(page.locator('.notice')).toContainText('No writes were replayed');
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(48);
  const fallback = await page.evaluate(() => window.__timelineDebug);
  expect(fallback.dirty).toBe(false); expect(fallback.fromMs).toBe(before.fromMs); expect(fallback.toMs).toBe(before.toMs);
  await expect(page.locator('.provider-status')).toContainText('Local / Ready');
  await noAutomaticReplay(page, 2, 1);
  expect(writes).toEqual([]);
  await page.screenshot({ path: info.outputPath('server-outage-lost-local-branch.png'), fullPage: true });
  await page.locator('[data-action=sources]').first().click();
  await expect(page.locator('.source-facts')).toContainText('48 in declared snapshot');
  const download = page.waitForEvent('download'); await page.locator('#export-json').click();
  const exported = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(exported.records).toHaveLength(48);
  expect(exported.records.some(record => record.title === 'Retained Local change that must not reappear')).toBe(false);
  expect(errors).toEqual([]);
});

test('a healthy retained Local worker returns fresh modified counts on Server outage fallback', async ({ page }) => {
  const errors = await boot(page);
  await createRecord(page, 'Retained Local record survives the Server visit');
  const original = await page.evaluate(() => window.__timelineDebug);
  await connect(page); await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(48);
  await server.pause(); await page.locator('[data-action=refresh]').first().click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('local');
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(49);
  const restored = await page.evaluate(() => window.__timelineDebug);
  expect(restored.providerId).toBe(original.providerId); expect(restored.generation).toBe(original.generation); expect(restored.dirty).toBe(true);
  await expect(page.locator('.provider-status')).toContainText('Local / Modified');
  await expect(page.locator('.notice')).not.toContainText('unexported changes were not recovered');
  await noAutomaticReplay(page, 1, 1);
  await page.locator('[data-action=sources]').first().click();
  await expect(page.locator('.source-facts')).toContainText('49 in declared snapshot');
  const download = page.waitForEvent('download'); await page.locator('#export-json').click();
  const exported = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(exported.records).toHaveLength(49);
  expect(exported.records.filter(record => record.title === 'Retained Local record survives the Server visit')).toHaveLength(1);
  expect(errors).toEqual([]);
});
