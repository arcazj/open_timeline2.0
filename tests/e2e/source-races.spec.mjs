import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startServer } from '../integration/server-fixture.mjs';
import { ServerProvider } from '../../client/src/data/server-provider.js';

const sample = JSON.parse(await readFile('shared/fixtures/initial-snapshot.json', 'utf8'));
let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });

async function boot(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window), NativeWorker = window.Worker;
    const probe = window.__sourceRace = { workers: [], fetchGate: null, workerGate: null };
    function gate(options) {
      const value = { ...options, armed: true, captured: false, delivered: false };
      value.promise = new Promise(resolve => { value.release = resolve; });
      return value;
    }
    probe.armFetch = options => { probe.fetchGate = gate(options); };
    probe.armWorker = options => { probe.workerGate = gate(options); };
    window.fetch = async (...args) => {
      const candidate = probe.fetchGate, url = new URL(String(args[0]), location.href);
      const held = candidate?.armed && url.pathname === candidate.path && (args[1]?.method || 'GET') === (candidate.method || 'GET') ? candidate : null;
      if (held) held.armed = false;
      const response = await originalFetch(...args);
      if (!held) return response;
      const body = await response.text();
      held.captured = true;
      // Hold a fully received body so disposing the old provider cannot erase
      // the completion which its source-identity guard must reject.
      const result = new Response(body, { status: response.status, headers: response.headers });
      result.text = async () => { await held.promise; held.delivered = true; return body; };
      return result;
    };
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options); this.probeIndex = probe.workers.length; this.methods = new Map(); probe.workers.push(this);
      }
      postMessage(message, ...rest) {
        if (message.type === 'request') this.methods.set(message.id, { method: message.method, args: message.args });
        return super.postMessage(message, ...rest);
      }
      addEventListener(type, listener, options) {
        if (type !== 'message') return super.addEventListener(type, listener, options);
        return super.addEventListener(type, event => {
          const candidate = probe.workerGate, request = this.methods.get(event.data?.id);
          const held = candidate?.armed && candidate.worker === this.probeIndex && event.data?.type === 'response' && request?.method === candidate.method
            && (candidate.queryId === undefined || request.args?.[0] === candidate.queryId) ? candidate : null;
          if (!held) { listener.call(this, event); return; }
          held.armed = false; held.captured = true; held.capturedQueryId = request.args?.[0];
          held.promise.then(() => { held.delivered = true; listener.call(this, event); });
        }, options);
      }
    };
  });
  await page.goto(server.baseUrl);
  await expect(page.locator('.record-label').first()).toBeVisible();
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  return errors;
}

function replacementSnapshot() {
  const snapshot = structuredClone(sample), template = snapshot.records[0];
  snapshot.records = [{ ...template, id: randomUUID(), title: 'Newly selected Local source record', sourceId: 'replacement', start: '2026-09-12T12:00:00.000Z', kind: 'event', end: null, parentSessionId: null, originalStart: null, originalEnd: null, data: { description: 'Only the explicitly selected replacement source may supply this descriptor.' } }];
  snapshot.manifest.generation = randomUUID(); snapshot.manifest.bundleId = randomUUID(); snapshot.manifest.recordCount = 1; snapshot.manifest.sourceName = 'Explicit replacement source'; snapshot.manifest.scope.sourceIds = ['replacement']; delete snapshot.manifest.contentSha256;
  return snapshot;
}

async function connect(page) {
  const before = await page.evaluate(() => window.__timelineDebug);
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl);
  await page.locator('#server-form [name=token]').fill(server.token);
  await page.locator('#server-form [type=submit]').click();
  await page.locator('#switch-source').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerId)).not.toBe(before.providerId);
  await expect(page.locator('.provider-status')).toContainText('Server / Connected');
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
}

async function importReplacement(page, snapshot = replacementSnapshot()) {
  const previous = await page.evaluate(() => window.__timelineDebug);
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#json-file').setInputFiles({ name: 'explicit-replacement-source.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
  await expect(page.locator('#json-file')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('local');
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.generation)).not.toBe(previous.generation);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.sourceName)).toBe(snapshot.manifest.sourceName);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(1);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await page.locator(`.record-label[data-record-id="${snapshot.records[0].id}"]`).click();
  await expect(page.locator('.descriptor')).toContainText(snapshot.records[0].title);
  return snapshot;
}

async function armFetch(page, path) { await page.evaluate(path => window.__sourceRace.armFetch({ path }), path); }
async function captured(page, kind) { await expect.poll(() => page.evaluate(kind => window.__sourceRace[`${kind}Gate`].captured, kind)).toBe(true); }
async function release(page, kind) {
  await page.evaluate(kind => window.__sourceRace[`${kind}Gate`].release(), kind);
  await expect.poll(() => page.evaluate(kind => window.__sourceRace[`${kind}Gate`].delivered, kind)).toBe(true);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function sameSource(page, before) {
  const current = await page.evaluate(() => window.__timelineDebug);
  for (const key of ['providerId', 'providerKind', 'generation', 'sourceName', 'queryId', 'selectedId', 'detailTotal']) expect(current[key], key).toBe(before[key]);
  await expect(page.locator('.record-label').first()).toBeVisible();
  await expect(page.locator('.descriptor')).toBeVisible();
}

test('a delayed obsolete Refresh200 cannot replace explicit Local source metadata or selection', async ({ page }) => {
  const errors = await boot(page); await connect(page);
  await armFetch(page, '/api/v1/workspaces/default');
  await page.locator('[data-action=refresh]').first().click(); await captured(page, 'fetch');
  const replacement = await importReplacement(page), before = await page.evaluate(() => window.__timelineDebug);
  await release(page, 'fetch'); await sameSource(page, before);
  expect(before.generation).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.locator('.descriptor')).toContainText(replacement.records[0].title);
  await expect(page.locator('.provider-status')).toContainText('Local / Ready'); expect(errors).toEqual([]);
});

test('a delayed obsolete Refresh401 cannot clear a new authorized Server instance on the same URL', async ({ page }) => {
  const errors = await boot(page); await connect(page);
  const path = '/api/v1/workspaces/default';
  await armFetch(page, path);
  const handler = route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'authentication_required', message: 'Authorization from the obsolete source expired.' }) });
  await page.route(`**${path}`, handler);
  await page.locator('[data-action=refresh]').first().click(); await captured(page, 'fetch');
  await page.unroute(`**${path}`, handler);
  await connect(page); await page.locator('.record-label').first().click();
  const before = await page.evaluate(() => window.__timelineDebug), title = await page.locator('.descriptor h3').textContent();
  await release(page, 'fetch'); await sameSource(page, before);
  await expect(page.locator('.provider-status')).toContainText('Server / Connected');
  await expect(page.locator('.descriptor h3')).toHaveText(title);
  await expect(page.locator('.notice')).toBeHidden(); expect(errors).toEqual([]);
});

test('a delayed selected-record restoration from an old initialization cannot inject its private descriptor into a new source', async ({ page }) => {
  const errors = await boot(page);
  const first = page.locator('.record-label').first(), id = await first.getAttribute('data-record-id'); await first.click();
  const provider = new ServerProvider({ baseUrl: server.baseUrl, token: server.token }); const metadata = await provider.initialize(); const record = await provider.getRecord(id);
  await provider.executeCommand({ type: 'update', recordId: id, expectedVersion: record.version, generation: metadata.generation, clientCommandId: randomUUID(), payload: { title: 'Private descriptor from obsolete Server source', data: { description: 'This old-source content must never enter the replacement descriptor.' } } });
  provider.dispose();
  await armFetch(page, `/api/v1/workspaces/default/records/${id}`); await connect(page); await captured(page, 'fetch');
  const replacement = await importReplacement(page), before = await page.evaluate(() => window.__timelineDebug);
  await release(page, 'fetch'); await sameSource(page, before);
  await expect(page.locator('.descriptor')).toContainText(replacement.records[0].title);
  await expect(page.locator('.descriptor')).not.toContainText('Private descriptor');
  await expect(page.locator('.descriptor')).not.toContainText('old-source content'); expect(errors).toEqual([]);
});

test('closing the descriptor during delayed source initialization prevents automatic selection restoration', async ({ page }) => {
  const errors = await boot(page);
  await page.locator('.record-label').first().click();
  await expect(page.locator('.descriptor')).toBeVisible();
  const originalProvider = await page.evaluate(() => window.__timelineDebug.providerId);
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl);
  await page.locator('#server-form [name=token]').fill(server.token);
  await page.locator('#server-form [type=submit]').click();
  await expect(page.locator('#switch-source')).toBeVisible();
  await armFetch(page, '/api/v1/workspaces/default');
  await page.locator('#switch-source').click(); await captured(page, 'fetch');
  await page.locator('[data-action=close-descriptor]').click();
  await expect(page.locator('.descriptor')).toBeHidden();
  await release(page, 'fetch');
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerId)).not.toBe(originalProvider);
  await expect(page.locator('.provider-status')).toContainText('Server / Connected');
  await expect(page.locator('.toast')).toHaveText('Server source active.');
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await expect(page.locator('.descriptor')).toBeHidden();
  expect(await page.evaluate(() => window.__timelineDebug.selectedId)).toBeUndefined();
  expect(errors).toEqual([]);
});

for (const target of ['Local import', 'Server reconnection']) {
  test(`delayed automatic fallback cannot replace a newer explicit ${target}`, async ({ page }) => {
    const errors = await boot(page); await connect(page);
    await page.evaluate(() => window.__sourceRace.armWorker({ worker: 0, method: 'getStatus' }));
    await server.pause(); await page.locator('[data-action=refresh]').first().click(); await captured(page, 'worker');
    if (target === 'Local import') await importReplacement(page);
    else { await server.restart(); await connect(page); await page.locator('.record-label').first().click(); }
    const before = await page.evaluate(() => window.__timelineDebug), title = await page.locator('.descriptor h3').textContent();
    await release(page, 'worker'); await sameSource(page, before);
    await expect(page.locator('.descriptor h3')).toHaveText(title);
    await expect(page.locator('.notice')).toBeHidden(); expect(errors).toEqual([]);
  });
}

test('a delayed Local query release cannot let an obsolete Server switch replace the newer explicit connection', async ({ page }) => {
  const errors = await boot(page);
  const local = await page.evaluate(() => window.__timelineDebug);
  const delayedSwitch = async () => {
    const queryId = await page.evaluate(() => {
      const queryId = window.__timelineDebug.queryId;
      window.__sourceRace.armWorker({ worker: 0, method: 'releaseQuery', queryId });
      return queryId;
    });
    expect(queryId).toBeTruthy();
    await page.locator('[data-action=sources]').first().click();
    await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl);
    await page.locator('#server-form [name=token]').fill(server.token);
    await page.locator('#server-form [type=submit]').click();
    await page.locator('#switch-source').click();
    await captured(page, 'worker');
    expect(await page.evaluate(() => window.__sourceRace.workerGate.capturedQueryId)).toBe(queryId);
  };
  await delayedSwitch();
  expect((await page.evaluate(() => window.__timelineDebug)).providerId).toBe(local.providerId);

  await connect(page);
  await page.locator('.record-label').first().click();
  const selected = await page.evaluate(() => window.__timelineDebug);
  const title = await page.locator('.descriptor h3').textContent();
  await release(page, 'worker');
  await sameSource(page, selected);
  await expect(page.locator('.descriptor h3')).toHaveText(title);
  await expect(page.locator('.provider-status')).toContainText('Server / Connected');
  await expect(page.locator('.notice')).toBeHidden();

  await server.pause();
  await page.locator('[data-action=refresh]').first().click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerId)).toBe(local.providerId);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(local.detailTotal);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await expect(page.locator('.provider-status')).toContainText('Local / Ready');

  await server.restart();
  await delayedSwitch();
  await importReplacement(page);
  const imported = await page.evaluate(() => window.__timelineDebug);
  // Import disposes the old worker and rejects its pending release RPC.
  // Neither that failure nor its subsequently delivered reply owns this source.
  await release(page, 'worker');
  await sameSource(page, imported);
  await expect(page.locator('.provider-status')).toContainText('Local / Ready');
  await expect(page.locator('.notice')).toBeHidden();
  await expect(page.locator('.toast')).not.toContainText('Unable to switch source');
  expect(errors).toEqual([]);
});
