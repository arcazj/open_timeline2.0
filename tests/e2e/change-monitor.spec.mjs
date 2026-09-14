import { test, expect } from '@playwright/test';
import { startServer } from '../integration/server-fixture.mjs';
import { readFile } from 'node:fs/promises';

let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });
const debug = page => page.evaluate(() => window.__timelineDebug);
async function ready(page) {
  await expect.poll(async () => (await debug(page))?.queryId).toBeTruthy(); await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => { const view = window.__timelineDebug, plot = document.querySelector('.plot-wrap'); return Math.abs(view.layoutWidth - plot.clientWidth) < 1 && view.pageCapacity === Math.max(1, Math.floor((plot.clientHeight - 52) / view.effectiveRowHeight)); })).toBe(true);
}
async function connect(page, token = server.token) {
  await page.goto(server.baseUrl); await ready(page); await page.locator('[data-action=sources]').first().click();
  await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl); await page.locator('#server-form [name=token]').fill(token);
  await page.locator('#server-form [type=submit]').click(); await page.locator('#switch-source').click();
  await expect.poll(async () => (await debug(page)).providerKind).toBe('server'); await ready(page);
}
async function commitFrom(page, title, sourceId = 'operations') {
  return page.evaluate(async ({ token, title, sourceId }) => {
    const status = await (await fetch('/api/v1/workspaces/default', { headers: { Authorization: `Bearer ${token}` } })).json();
    const response = await fetch('/api/v1/workspaces/default/records', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID(), 'X-Workspace-Generation': status.generation }, body: JSON.stringify({ kind: 'event', sourceId, title, start: '2026-09-12T10:15:00.000Z', end: null }) });
    const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body;
  }, { token: server.token, title, sourceId });
}
const pinnedShape = state => Object.fromEntries(['queryId', 'queryRevision', 'mapId', 'layoutId', 'fromMs', 'toMs', 'startRow', 'endRow', 'loadedCount', 'detailTotal', 'overviewTotal', 'scaleMode', 'search'].map(key => [key, state[key]]));

test('two browser contexts keep Pinned rows, map, range, zones and overview unchanged until explicit Reload', async ({ browser }, info) => {
  const first = await browser.newContext(), second = await browser.newContext(), page = await first.newPage(), writer = await second.newPage();
  try {
    await connect(page); await connect(writer);
    await page.locator('#source-filter').selectOption('operations'); await ready(page); await page.locator('#auto-scale').check(); await ready(page);
    if (await page.locator('[data-action=next]').isEnabled()) { const row = (await debug(page)).startRow; await page.locator('[data-action=next]').click(); await expect.poll(async () => (await debug(page)).startRow).not.toBe(row); }
    const before = pinnedShape(await debug(page)), labels = await page.locator('.plot-wrap .record-label').evaluateAll(nodes => nodes.map(node => node.dataset.recordId));
    const geometry = await page.locator('.plot-wrap').boundingBox(), zones = await page.locator('.zone-label').allTextContents();
    let queries = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/query-sessions')) queries++; });
    for (let i = 0; i < 3; i++) await commitFrom(writer, `Pinned change ${i}`);
    await expect.poll(async () => (await debug(page)).changePending).toBe(true); await expect(page.locator('.change-summary')).toContainText('Committed changes available');
    expect(pinnedShape(await debug(page))).toEqual(before); expect(await page.locator('.plot-wrap').boundingBox()).toEqual(geometry);
    expect(await page.locator('.plot-wrap .record-label').evaluateAll(nodes => nodes.map(node => node.dataset.recordId))).toEqual(labels); expect(await page.locator('.zone-label').allTextContents()).toEqual(zones); expect(queries).toBe(0);
    await expect(page.locator('.toast')).toHaveCount(0); await page.screenshot({ path: info.outputPath('server-pinned-changes.png') });
    await page.locator('[data-action=reload-changes]').click(); await expect.poll(async () => (await debug(page)).queryId).not.toBe(before.queryId); await ready(page);
    expect((await debug(page)).queryRevision).toBeGreaterThan(before.queryRevision); expect((await debug(page)).fromMs).toBe(before.fromMs); expect((await debug(page)).toMs).toBe(before.toMs); expect(await page.locator('#source-filter').inputValue()).toBe('operations');
    await expect.poll(async () => (await debug(page)).changePending).toBe(false);
  } finally { await first.close(); await second.close(); }
});

test('Live coalesces committed changes, defers open drafts, and keeps range and filters', async ({ browser }, info) => {
  const first = await browser.newContext(), second = await browser.newContext(), page = await first.newPage(), writer = await second.newPage();
  try {
    await connect(page); await connect(writer); await page.locator('#source-filter').selectOption('operations'); await ready(page);
    const previous = (await debug(page)).queryId; await page.locator('#search').fill('Liveproof'); await expect.poll(async () => (await debug(page)).queryId).not.toBe(previous); await ready(page);
    await page.locator('[data-change-mode=live]').click(); await page.locator('[data-action=create]').first().click(); await page.locator('#record-form [name=title]').fill('Unsaved local draft');
    const before = await debug(page); let reads = 0, active = 0, maximum = 0;
    const isQuery = request => request.method() === 'POST' && request.url().endsWith('/query-sessions');
    page.on('request', request => { if (isQuery(request)) { reads++; active++; maximum = Math.max(maximum, active); } });
    page.on('requestfinished', request => { if (isQuery(request)) active--; }); page.on('requestfailed', request => { if (isQuery(request)) active--; });
    for (let i = 0; i < 4; i++) await commitFrom(writer, `Liveproof ${i}`);
    await expect.poll(async () => (await debug(page)).changePending).toBe(true); await page.waitForTimeout(400);
    expect((await debug(page)).queryId).toBe(before.queryId); expect(reads).toBe(0); expect(await page.locator('#record-form [name=title]').inputValue()).toBe('Unsaved local draft');
    await page.locator('#cancel-edit').click(); await expect.poll(async () => (await debug(page)).queryId).not.toBe(before.queryId); await ready(page);
    await expect.poll(async () => (await debug(page)).overviewMatched).toBe(4); expect(maximum).toBe(1); expect(reads).toBe(1);
    expect(await page.locator('#source-filter').inputValue()).toBe('operations'); expect((await debug(page)).search).toBe(before.search); expect((await debug(page)).fromMs).toBe(before.fromMs); expect((await debug(page)).toMs).toBe(before.toMs);
    await page.setViewportSize({ width: 390, height: 844 }); await ready(page); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await expect(page.locator('.toast')).toHaveCount(0); await page.screenshot({ path: info.outputPath('server-live-updates.png') });
  } finally { await first.close(); await second.close(); }
});

async function identity(method, path, payload, expected) {
  const list = await (await fetch(server.baseUrl + '/api/v1/principals', { headers: { Authorization: `Bearer ${server.token}` } })).json();
  const response = await fetch(server.baseUrl + path, { method, headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', 'X-Identity-Generation': list.generation, 'If-Match': `"${list.generation}:${expected ?? list.revision}"`, 'Idempotency-Key': crypto.randomUUID() }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const result = await response.json(); expect(response.ok, JSON.stringify(result)).toBe(true); return result;
}
test('a real source grant change clears protected Pinned data immediately without Local fallback', async ({ page }) => {
  const principal = (await identity('POST', '/api/v1/principals', { name: 'Scoped observer', role: 'viewer', grants: [{ workspaceId: 'default', sourceIds: ['operations'], capabilities: [] }] })).principal;
  const token = await identity('POST', '/api/v1/tokens', { name: 'Observer browser', principalId: principal.id, expiresAt: null });
  await connect(page, token.secret); await expect(page.locator('.plot-wrap .record-label').first()).toBeVisible(); const providerId = (await debug(page)).providerId;
  await identity('PATCH', `/api/v1/principals/${principal.id}`, { grants: [{ workspaceId: 'default', sourceIds: ['verification'], capabilities: [] }] }, principal.revision);
  await expect(page.locator('.notice')).toContainText('authorization'); await expect(page.locator('.plot-wrap .record-label')).toHaveCount(0); await expect(page.locator('.descriptor')).toBeHidden();
  expect((await debug(page)).providerKind).toBe('server'); expect((await debug(page)).providerId).toBe(providerId); expect((await debug(page)).queryId).toBeUndefined(); expect((await debug(page)).changeRequired).toBe('authorization-lost');
  await expect(page.locator('#source-filter')).toContainText('Authorization required'); await expect(page.locator('#source-filter option')).toHaveCount(1); await expect(page.locator('#search')).toBeDisabled();
  await page.locator('[data-action=sources]').first().click(); await expect(page.locator('.source-facts')).toContainText('Unavailable'); await expect(page.locator('#server-form')).toBeVisible();
  await page.locator('[data-action=close-modal]').click();
  await page.route('**/api/v1/workspaces/default', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'server_unavailable', message: 'Controlled outage after authorization loss.' }) }));
  await page.locator('[data-action=refresh]').first().click(); await expect(page.locator('.toast')).toContainText('Controlled outage'); expect((await debug(page)).providerKind).toBe('server'); await expect(page.locator('.notice')).toContainText('authorization');
});

test('Live defers a provisional time drag and resumes only after its zero-write cancellation', async ({ browser }) => {
  const first = await browser.newContext(), second = await browser.newContext(), page = await first.newPage(), writer = await second.newPage();
  try {
    await connect(page); await connect(writer); await page.locator('.plot-wrap .record-label').first().click(); await ready(page);
    await page.locator('[data-time-mode=edit]').click(); await expect(page.locator('[data-time-mode=edit]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-change-mode=live]').click(); const before = await debug(page), label = page.locator(`.plot-wrap .record-label[data-record-id="${before.selectedId}"]`); await expect(label).toBeVisible(); const box = await label.boundingBox();
    let writes = 0; page.on('request', request => { if (['PUT', 'PATCH', 'DELETE'].includes(request.method()) && /\/records\/[^/?]+$/.test(request.url())) writes++; });
    await page.mouse.move(box.x + 10, box.y + 8); await page.mouse.down(); await page.mouse.move(box.x + 40, box.y + 8); await expect(page.locator('.record-time-ghost')).toHaveCount(1);
    await commitFrom(writer, 'Concurrent provisional guard'); await expect.poll(async () => (await debug(page)).changePending).toBe(true); await page.waitForTimeout(400);
    expect((await debug(page)).queryId).toBe(before.queryId); await expect(page.locator('.record-time-ghost')).toHaveCount(1); expect(writes).toBe(0);
    await page.keyboard.press('Escape'); await page.mouse.up(); await expect.poll(async () => (await debug(page)).queryId).not.toBe(before.queryId); await ready(page); expect(writes).toBe(0);
  } finally { await first.close(); await second.close(); }
});

test('a replay-gap notice stops Live reads until an explicit refresh re-establishes its baseline', async ({ page }) => {
  await connect(page); await page.locator('[data-change-mode=live]').click(); const before = await debug(page);
  await page.route('**/changes?*', route => route.fulfill({ status: 409, contentType: 'application/problem+json', body: JSON.stringify({ code: 'replay_gap', detail: 'Change replay is no longer available.' }) }));
  await expect.poll(async () => (await debug(page)).changeRequired).toBe('replay-gap'); expect((await debug(page)).queryId).toBe(before.queryId);
  await page.locator('[data-action=create]').first().click(); await expect(page.locator('#record-form')).toHaveCount(0); expect((await debug(page)).providerKind).toBe('server');
  await page.unroute('**/changes?*'); await page.locator('[data-action=reload-changes]').click();
  await expect.poll(async () => (await debug(page)).queryId).not.toBe(before.queryId); await ready(page); expect((await debug(page)).changeRequired).toBeNull(); expect((await debug(page)).changeMode).toBe('pinned');
});

test('Live waits for a CSV export to finish its original pinned snapshot', async ({ browser }) => {
  const first = await browser.newContext(), second = await browser.newContext(), page = await first.newPage(), writer = await second.newPage(); let release = () => {};
  try {
    await connect(page); await connect(writer); await page.locator('[data-change-mode=live]').click(); await page.locator('[data-view=table]').click();
    await expect(page.locator('[data-table-action=export]')).toBeEnabled(); const before = await debug(page);
    let enter; const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
    await page.route('**/records/query', async route => {
      if (route.request().postDataJSON()?.limit !== 1000) return route.continue();
      const response = await route.fetch(); enter(); await held; await route.fulfill({ response });
    });
    const downloading = page.waitForEvent('download'); await page.locator('[data-table-action=export]').click(); await entered;
    await commitFrom(writer, 'Concurrent export guard'); await expect.poll(async () => (await debug(page)).changePending).toBe(true); await page.waitForTimeout(400);
    expect((await debug(page)).queryId).toBe(before.queryId); await expect(page.locator('[data-table-action=cancel-export]')).toBeVisible();
    release(); const download = await downloading, csv = await readFile(await download.path(), 'utf8'); expect(csv).toContain('Antenna ready'); expect(csv).not.toContain('Concurrent export guard');
    await expect.poll(async () => (await debug(page)).queryId).not.toBe(before.queryId); await expect(page.locator('.table-caption')).toContainText('49 records');
    await expect(page.locator('.notice')).toBeHidden();
    await page.locator('[data-view=timeline]').click(); await ready(page);
    await expect(page.locator('.overview-plot canvas')).toBeVisible();
    expect((await debug(page)).overviewTotal).toBe(49);
  } finally { release(); await first.close(); await second.close(); }
});
