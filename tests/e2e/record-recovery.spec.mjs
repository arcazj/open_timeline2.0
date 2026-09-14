import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { startServer } from '../integration/server-fixture.mjs';

const storageKey = 'openbexi:record-command-recovery:v1';
let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });

async function ready(page) { await expect.poll(() => page.evaluate(() => Boolean(window.__timelineDebug?.queryId))).toBe(true); await expect(page.locator('.busy-indicator')).toHaveCount(0); }
async function connect(page, target = server) {
  await ready(page);
  const previous = await page.evaluate(() => window.__timelineDebug.providerId);
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#server-form [name=baseUrl]').fill(target.baseUrl);
  await page.locator('#server-form [name=token]').fill(target.token);
  await page.locator('#server-form [type=submit]').click(); await page.locator('#switch-source').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerId)).not.toBe(previous);
  await expect(page.locator('.provider-status')).toContainText('Server / Connected'); await ready(page);
}
async function open(page, url = server.baseUrl) {
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(url); await ready(page); await connect(page); return errors;
}
function requests(page) {
  const writes = [], reads = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (/\/records(?:\/[^/]+(?:\/restore)?)?$/.test(url.pathname) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push({ key: request.headers()['idempotency-key'], method: request.method(), url: request.url() });
    if (url.pathname.includes('/command-results/')) reads.push({ method: request.method(), url: request.url() });
  });
  return { writes, reads };
}
async function loseReply(page, { method = 'POST', recordId = '', commit = true } = {}) {
  await page.route(`**/api/v1/workspaces/default/records${recordId ? `/${recordId}` : ''}`, async route => {
    if (route.request().method() !== method) return route.continue();
    if (commit) expect((await route.fetch()).status()).toBe(method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{unconfirmed-reply' });
  });
}
async function createUnknown(page, title = 'Private record title should never enter recovery storage') {
  await page.locator('[data-action=create]').click();
  await page.locator('#record-form [name=title]').fill(title);
  await page.locator('#record-form [name=notes]').fill('Private notes are not a recovery payload');
  await page.locator('#record-form [type=submit]').click();
  await expect(page.locator('.outcome-check')).toBeVisible();
  await expect(page.locator('#record-form [type=submit]')).toBeDisabled();
}
async function stored(page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]'), storageKey); }
async function recovery(page) { await page.locator('.record-recovery-banner [data-action=record-recovery]').click(); await expect(page.locator('.record-recovery')).toBeVisible(); }
async function assertLocked(page) {
  await expect(page.locator('[data-action=create]')).toBeDisabled();
  await page.locator('.record-label').first().click();
  for (const action of ['edit', 'duplicate', 'delete']) await expect(page.locator(`[data-action=${action}]`)).toBeDisabled();
}
async function snapshot(target = server) { const result = await fetch(`${target.baseUrl}/api/v1/workspaces/default/snapshot`, { headers: { Authorization: `Bearer ${target.token}` } }); expect(result.status).toBe(200); return result.json(); }

test('lost create reply survives reload as identity only and unlocks solely after its original GET confirmation', async ({ page }, info) => {
  const errors = await open(page), traffic = requests(page);
  await loseReply(page); await createUnknown(page);
  const identities = await stored(page);
  expect(identities).toHaveLength(1);
  expect(Object.keys(identities[0]).sort()).toEqual(['baseUrl', 'workspaceId', 'generation', 'clientCommandId', 'type'].sort());
  expect(identities[0]).toMatchObject({ baseUrl: server.baseUrl, workspaceId: 'default', type: 'create', clientCommandId: traffic.writes[0].key });
  expect(JSON.stringify(identities)).not.toMatch(/Private|payload|notes|expectedVersion/); expect(JSON.stringify(identities)).not.toContain(server.token);
  await page.locator('#cancel-edit').click(); await assertLocked(page);
  await page.reload(); await ready(page); await expect(page.locator('[data-action=create]')).toBeEnabled();
  await connect(page); await assertLocked(page); await recovery(page);
  await page.screenshot({ path: info.outputPath('record-recovery-reloaded.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const bounds = await page.locator('.record-recovery').evaluate(node => { const box = node.closest('.modal').getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; });
  expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(390); expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.bottom).toBeLessThanOrEqual(844);
  await expect(page.locator('.record-recovery .record-outcome-check')).toHaveCSS('min-height', '44px');
  await page.screenshot({ path: info.outputPath('record-recovery-mobile.png') });
  await page.setViewportSize({ width: 1600, height: 900 });
  expect(traffic.reads).toEqual([]);
  await page.locator('.record-recovery .record-outcome-check').click();
  await expect(page.locator('.record-recovery-message')).toContainText('original write committed');
  expect(await stored(page)).toEqual([]); await expect(page.locator('.record-recovery-banner')).toBeHidden();
  expect(traffic.writes).toHaveLength(1);
  expect(traffic.reads).toEqual([{ method: 'GET', url: `${server.baseUrl}/api/v1/workspaces/default/command-results/${traffic.writes[0].key}` }]);
  await page.locator('[data-action=close-modal]').click(); await expect(page.locator('[data-action=create]')).toBeEnabled();
  expect((await snapshot()).records.filter(record => record.title === 'Private record title should never enter recovery storage')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('not-found outcome remains unknown after reload and never permits a replacement mutation', async ({ page }) => {
  const errors = await open(page), traffic = requests(page);
  await loseReply(page, { commit: false }); await createUnknown(page, 'Unconfirmed command never reached server');
  const before = await stored(page);
  await page.reload(); await connect(page); await assertLocked(page); await recovery(page);
  await page.locator('.record-recovery .record-outcome-check').click();
  await expect(page.locator('.record-recovery-message')).toContainText('No committed outcome is confirmed');
  expect(await stored(page)).toEqual(before); await expect(page.locator('[data-action=create]')).toBeDisabled();
  expect(traffic.writes).toHaveLength(1); expect((await snapshot()).records).toHaveLength(48); expect(errors).toEqual([]);
});

test('reload during an in-flight committed create retains its pre-dispatch identity', async ({ page }) => {
  const errors = await open(page), traffic = requests(page);
  let enteredResolve, releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; }), release = new Promise(resolve => { releaseResolve = resolve; });
  await page.route('**/api/v1/workspaces/default/records', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(201); enteredResolve(); await release;
    try { await route.fulfill({ response }); } catch { /* Reload can cancel the browser request after the server committed. */ }
  });
  try {
    await page.locator('[data-action=create]').click(); await page.locator('#record-form [name=title]').fill('Committed before reload');
    await page.locator('#record-form [type=submit]').click(); await entered;
    expect((await stored(page))[0].clientCommandId).toBe(traffic.writes[0].key);
    await page.reload(); releaseResolve(); await connect(page); await recovery(page);
    await page.locator('.record-recovery .record-outcome-check').click();
    await expect(page.locator('.record-recovery-message')).toContainText('original write committed');
    expect(await stored(page)).toEqual([]); expect(traffic.writes).toHaveLength(1);
    expect((await snapshot()).records.filter(record => record.title === 'Committed before reload')).toHaveLength(1); expect(errors).toEqual([]);
  } finally { releaseResolve(); }
});

for (const operation of ['update', 'delete']) test(`lost ${operation} reply recovers the original record identity after reload without a second mutation`, async ({ page }) => {
  const errors = await open(page), traffic = requests(page), initial = await snapshot();
  const record = initial.records.find(item => item.kind === 'event' && item.title === 'Antenna ready');
  await page.locator(`.record-label[data-record-id="${record.id}"]`).click();
  await loseReply(page, { method: operation === 'update' ? 'PATCH' : 'DELETE', recordId: record.id });
  await page.locator(`[data-action=${operation === 'update' ? 'edit' : 'delete'}]`).click();
  if (operation === 'update') { await page.locator('#record-form [name=title]').fill('Confirmed once after reload'); await page.locator('#record-form [type=submit]').click(); }
  else await page.locator('#confirm-delete').click();
  await expect(page.locator('.outcome-check')).toBeVisible();
  const identities = await stored(page); expect(identities[0]).toMatchObject({ type: operation, recordId: record.id, clientCommandId: traffic.writes[0].key });
  await page.reload(); await connect(page); await recovery(page);
  await page.locator('.record-recovery .record-outcome-check').click();
  await expect(page.locator('.record-recovery-message')).toContainText('original write committed');
  expect(await stored(page)).toEqual([]); expect(traffic.writes).toHaveLength(1);
  const response = await fetch(`${server.baseUrl}/api/v1/workspaces/default/records/${record.id}?includeDeleted=true`, { headers: { Authorization: `Bearer ${server.token}` } });
  const updated = await response.json(); expect(updated.version).toBe(record.version + 1);
  if (operation === 'update') expect(updated.title).toBe('Confirmed once after reload'); else expect(updated.deletedAt).toBeTruthy();
  expect(errors).toEqual([]);
});

test('storage denial explicitly warns while same-page Close retains read-only recovery', async ({ page }) => {
  await page.addInitScript(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith('openbexi:record-command-recovery')) throw new DOMException('Storage denied', 'SecurityError'); return original.call(this, key, value); }; });
  const errors = await open(page), traffic = requests(page);
  await loseReply(page); await createUnknown(page, 'Memory-only record identity');
  await expect(page.locator('.record-recovery-warning')).toContainText('memory-only');
  await page.locator('#cancel-edit').click(); await recovery(page);
  await expect(page.locator('.record-recovery-warning')).toContainText('memory-only');
  await page.locator('.record-recovery .record-outcome-check').click();
  await expect(page.locator('.record-recovery-message')).toContainText('original write committed');
  expect(traffic.writes).toHaveLength(1); expect(errors).toEqual([]);
});

test('file URL record recovery warns about browser-dependent identity retention', async ({ page }) => {
  const previous = process.env.OPENBEXI_CORS_ORIGINS;
  try { process.env.OPENBEXI_CORS_ORIGINS = 'null'; await server.restart(); }
  finally { if (previous === undefined) delete process.env.OPENBEXI_CORS_ORIGINS; else process.env.OPENBEXI_CORS_ORIGINS = previous; }
  const errors = await open(page, pathToFileURL(path.resolve('dist/index.html')).href);
  await page.locator('[data-action=create]').click();
  await expect(page.locator('.record-recovery-warning')).toContainText(/browser-dependent|memory-only/);
  expect(errors).toEqual([]);
});

test('record recovery is isolated from another server and an unrelated generation', async ({ page }) => {
  const previous = process.env.OPENBEXI_CORS_ORIGINS;
  let other;
  try { process.env.OPENBEXI_CORS_ORIGINS = server.baseUrl; other = await startServer(); }
  finally { if (previous === undefined) delete process.env.OPENBEXI_CORS_ORIGINS; else process.env.OPENBEXI_CORS_ORIGINS = previous; }
  try {
    const errors = await open(page), traffic = requests(page);
    await loseReply(page); await createUnknown(page, 'Original source only');
    const identity = (await stored(page))[0]; await page.locator('#cancel-edit').click();
    await connect(page, other); await expect(page.locator('[data-action=create]')).toBeEnabled();
    await expect(page.locator('.record-recovery-banner')).toBeHidden(); expect(traffic.reads).toEqual([]);
    const current = await page.evaluate(() => window.__timelineDebug);
    await page.evaluate(({ key, identity, otherBase }) => { const entries = JSON.parse(localStorage.getItem(key)); entries.push({ ...identity, baseUrl: otherBase, generation: crypto.randomUUID(), clientCommandId: crypto.randomUUID() }); localStorage.setItem(key, JSON.stringify(entries)); }, { key: storageKey, identity, otherBase: other.baseUrl });
    await connect(page, other); expect(await page.evaluate(() => window.__timelineDebug.generation)).toBe(current.generation);
    await expect(page.locator('[data-action=create]')).toBeEnabled();
    await connect(page); await recovery(page); await page.locator('.record-recovery .record-outcome-check').click();
    await expect(page.locator('.record-recovery-message')).toContainText('original write committed');
    const remaining = await stored(page); expect(remaining).toHaveLength(1); expect(remaining[0].baseUrl).toBe(other.baseUrl);
    expect(traffic.writes).toHaveLength(1); expect((await snapshot(other)).records).toHaveLength(48); expect(errors).toEqual([]);
  } finally { await other.stop(); }
});

test('denied original outcome lookup clears protected records without clearing recovery or falling back', async ({ page }) => {
  const errors = await open(page), traffic = requests(page);
  await loseReply(page); await createUnknown(page, 'Authorization remains source-bound');
  const identities = await stored(page); await page.locator('#cancel-edit').click(); await recovery(page);
  await page.route('**/command-results/*', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'authentication_required', message: 'Original source access expired' }) }));
  await page.locator('.record-recovery .record-outcome-check').click();
  await expect(page.locator('.record-label')).toHaveCount(0); await expect(page.locator('.descriptor')).toBeHidden();
  await expect(page.locator('.notice')).toContainText('authorization');
  expect(await page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server');
  expect(await stored(page)).toEqual(identities); expect(traffic.writes).toHaveLength(1); expect(errors).toEqual([]);
});

test('confirmed original outcome remains resolved even when its follow-up metadata refresh fails', async ({ page }) => {
  const errors = await open(page), traffic = requests(page);
  await loseReply(page); await createUnknown(page, 'Confirmation is not undone by refresh failure');
  await page.reload(); await connect(page); await recovery(page);
  await page.route('**/api/v1/workspaces/default', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'refresh_failed', message: 'Read-only refresh failed for this test' }) }));
  await page.locator('.record-recovery .record-outcome-check').click();
  await expect(page.locator('.record-recovery-message')).toContainText('Follow-up refresh failed');
  expect(await stored(page)).toEqual([]); await expect(page.locator('[data-action=create]')).toBeEnabled();
  await expect(page.locator('.record-recovery-banner')).toBeHidden(); expect(traffic.writes).toHaveLength(1); expect(errors).toEqual([]);
});
