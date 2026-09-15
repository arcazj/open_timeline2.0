import { test, expect } from '@playwright/test';
import { startLocalPathsServer } from '../integration/local-paths-server-fixture.mjs';
import snapshot from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };

const workspace = '**/api/v1/workspaces/default';
const allocations = '**/api/v1/workspaces/default/query-sessions';
const debug = page => page.evaluate(() => window.__timelineDebug);
const ready = page => expect.poll(async () => (await debug(page))?.ready).toBe(true);
async function fetchMetadata(route) {
  const response = await route.fetch({ headers: { ...route.request().headers(), 'x-openbexi-local': '1', 'sec-fetch-site': 'same-origin' } });
  expect(response.ok()).toBe(true); return response;
}
let server;
test.beforeEach(async ({ page }) => {
  server = await startLocalPathsServer();
  await page.goto(server.baseUrl); await ready(page);
});
test.afterEach(async () => { await server?.stop(); });

async function failNavigation(page) {
  const initial = await debug(page);
  await page.route(allocations, route => route.abort());
  await page.locator('.plot-wrap').focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('.notice [data-action=reconnect-server]')).toBeVisible();
  await page.unroute(allocations);
  const retained = await debug(page);
  expect(retained.providerKind).toBe('server');
  expect(retained.providerId).toBe(initial.providerId);
  expect(retained.queryId).toBe(initial.queryId);
  // The retained-error notice schedules a 100ms ResizeObserver relayout before the next user intent.
  let previous, stable = 0;
  await expect.poll(async () => {
    const value = await page.evaluate(() => {
      const state = window.__timelineDebug, plot = document.querySelector('.plot-wrap').getBoundingClientRect(), notice = document.querySelector('.notice');
      return { ready: state.ready, queryId: state.queryId, from: state.fromMs, to: state.toMs,
        width: plot.width, height: plot.height, noticeHeight: notice.getBoundingClientRect().height, noticeText: notice.textContent };
    });
    const key = JSON.stringify(value);
    stable = value.ready && key === previous ? stable + 1 : value.ready ? 1 : 0; previous = key;
    return stable;
  }, { intervals: [100] }).toBeGreaterThanOrEqual(4);
  return debug(page);
}

test('explicit Retry replaces only the failed connection and preserves version 2 view and table choices', async ({ page }) => {
  test.setTimeout(90000);
  const requests = [];
  page.on('request', request => requests.push({ method: request.method(), url: request.url(), body: request.method() === 'POST' ? request.postDataJSON() : null }));
  await page.locator('[data-action=filters]').first().click();
  const form = page.locator('#settings-form');
  await form.locator('[name=definitionVersion]').selectOption('2');
  await form.locator('[name=searchMode]').selectOption('regex');
  await form.locator('[name=search]').fill('SOURCE[12]');
  await form.locator('[type=submit]').click(); await ready(page);
  await page.locator('.record-label').first().click(); await expect(page.locator('.descriptor')).toBeVisible();
  await page.locator('[data-view=split]').click();
  await expect(page.locator('.table-view tbody tr')).toHaveCount(6);
  await page.locator('[data-table-projection]').selectOption('matches');
  await expect(page.locator('.table-view tbody tr')).toHaveCount(4);
  await page.locator('[data-table-limit]').selectOption('25');
  await page.locator('[data-table-sort="title"],[data-table-sort="/title"]').click();
  await page.locator('[data-table-order]').selectOption('natural');
  await expect(page.locator('.table-view tbody tr')).toHaveCount(4);
  await page.getByRole('button', { name: 'Date and time range', exact: true }).click();
  await page.getByLabel('Start / UTC', { exact: true }).fill('2024-03-20T19:30');
  await page.getByLabel('End / UTC', { exact: true }).fill('2024-03-20T20:30');
  await page.getByRole('button', { name: 'Apply range', exact: true }).click(); await ready(page);
  const failed = await failNavigation(page);
  const failedInput = requests.filter(request => request.method === 'POST' && request.url.endsWith('/query-sessions')).at(-1).body;
  const boundary = requests.length;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(async () => (await debug(page)).providerId).not.toBe(failed.providerId);
  await ready(page); await expect(page.locator('.notice')).toBeHidden();
  const recovered = await debug(page);
  for (const key of ['providerKind', 'fromMs', 'toMs', 'domain', 'search', 'view', 'theme', 'rowHeight', 'fontSize', 'modelId', 'modelVersion', 'selectedSourceIds']) expect(recovered[key]).toEqual(failed[key]);
  expect(recovered.queryId).not.toBe(failed.queryId); expect(recovered.selectedId).toBeUndefined();
  await expect(page.locator('.descriptor')).toBeHidden();
  await expect(page.locator('[data-table-projection]')).toHaveValue('matches');
  await expect(page.locator('[data-table-limit]')).toHaveValue('25');
  await expect(page.locator('[data-table-order]')).toHaveValue('natural');
  const after = requests.slice(boundary), metadata = after.findIndex(request => request.method === 'GET' && request.url.endsWith('/workspaces/default'));
  const allocation = after.findIndex(request => request.method === 'POST' && request.url.endsWith('/query-sessions'));
  expect(metadata).toBeGreaterThanOrEqual(0); expect(allocation).toBeGreaterThan(metadata);
  expect(after.slice(0, allocation).some(request => request.method === 'DELETE' && request.url.endsWith(`/query-sessions/${failed.queryId}`))).toBe(true);
  for (const key of ['definitionVersion', 'relationshipMode', 'filters', 'search', 'searchMode', 'searchFlags', 'searchMatchMode', 'domain']) expect(after[allocation].body[key]).toEqual(failedInput[key]);
  expect(after.some(request => /\/commands(?:\/|$)/.test(request.url))).toBe(false);
});

test('delayed reconnect metadata cannot replace a newer navigation intent', async ({ page }) => {
  test.setTimeout(60000);
  const failed = await failNavigation(page);
  let finish, started;
  const requested = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  await page.route(workspace, async route => { const response = await fetchMetadata(route); started(); await gate; await route.fulfill({ response }); });
  await page.getByRole('button', { name: 'Retry', exact: true }).click(); await requested;
  await page.locator('.plot-wrap').focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await debug(page)).fromMs).not.toBe(failed.fromMs);
  const newer = await debug(page); finish();
  await expect(page.locator('.notice')).toContainText('Server data may be stale');
  await page.waitForTimeout(300);
  const retained = await debug(page);
  expect(retained.providerId).toBe(failed.providerId); expect(retained.fromMs).toBe(newer.fromMs); expect(retained.toMs).toBe(newer.toMs);
  expect(retained.queryId).toBe(failed.queryId);
});

test('a newer slow local JSON import takes precedence over staged server reconnect metadata', async ({ page }) => {
  test.setTimeout(60000);
  const failed = await failNavigation(page);
  let finishMetadata, started;
  const requested = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { finishMetadata = resolve; });
  await page.route(workspace, async route => { const response = await fetchMetadata(route); started(); await gate; await route.fulfill({ response }); });
  await page.getByRole('button', { name: 'Retry', exact: true }).click(); await requested;
  await expect(page.locator('.notice')).toHaveAttribute('aria-busy', 'true');
  page.on('dialog', dialog => dialog.accept());
  await page.evaluate(snapshot => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      if (this.name !== 'newer-complete-snapshot.json') return original.call(this);
      return new Promise(resolve => { window.finishReconnectImport = async () => { File.prototype.text = original; resolve(await original.call(this)); }; });
    };
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify(snapshot)], 'newer-complete-snapshot.json', { type: 'application/json' }));
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  }, snapshot);
  await expect.poll(() => page.evaluate(() => typeof window.finishReconnectImport)).toBe('function');
  finishMetadata(); await expect(page.locator('.notice')).toHaveAttribute('aria-busy', 'false');
  expect((await debug(page)).providerId).toBe(failed.providerId);
  await page.evaluate(() => window.finishReconnectImport());
  await expect.poll(async () => (await debug(page)).providerKind).toBe('local'); await ready(page);
  await expect(page.locator('.toast')).toContainText('Opened newer-complete-snapshot.json');
});

for (const changed of ['authorization', 'generation']) test(`Retry gates a changed server ${changed} without transferring the old view`, async ({ page }) => {
  const failed = await failNavigation(page);
  let posts = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/query-sessions')) posts++; });
  await page.route(workspace, async route => {
    const response = await fetchMetadata(route), info = await response.json();
    if (changed === 'generation') info.generation += '-restored';
    else info.actor = { ...info.actor, capabilities: [] };
    await route.fulfill({ response, json: info });
  });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.notice')).toContainText(changed === 'authorization' ? 'Managed records have been cleared' : 'restored or replaced');
  expect((await debug(page)).ready).toBe(false);
  expect((await debug(page)).providerId).toBe(failed.providerId); expect(posts).toBe(0);
  await expect(page.locator('.notice [data-action=sources]')).toBeVisible();
  if (changed === 'authorization') {
    await expect(page.locator('.record-label')).toHaveCount(0); await expect(page.locator('.descriptor')).toBeHidden();
    expect((await debug(page)).queryId).toBeUndefined();
  } else expect((await debug(page)).generation).toBe(failed.generation);
});

test('Retry preserves unconfirmed command identities instead of replaying or discarding them', async ({ page }) => {
  const failed = await failNavigation(page);
  const identity = { baseUrl: server.baseUrl, workspaceId: 'default', generation: failed.generation, clientCommandId: 'unconfirmed-model-write', type: 'create' };
  await page.evaluate(identity => localStorage.setItem('openbexi:model-command-recovery:v1', JSON.stringify([identity])), identity);
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('resolve pending command outcomes');
  expect((await debug(page)).providerId).toBe(failed.providerId);
  expect(requests.some(url => url.endsWith('/workspaces/default') || url.includes('/commands'))).toBe(false);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('openbexi:model-command-recovery:v1')))).toEqual([identity]);
});
