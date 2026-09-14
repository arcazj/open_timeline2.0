import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { startServer } from '../integration/server-fixture.mjs';

const recoveryKey = 'openbexi:model-command-recovery:v1';
let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });

async function connect(page) {
  await expect.poll(() => page.evaluate(() => Boolean(window.__timelineDebug?.queryId))).toBe(true);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl);
  await page.locator('#server-form [name=token]').fill(server.token);
  await page.locator('#server-form [type=submit]').click();
  await page.locator('#switch-source').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server');
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
}
async function open(page, url = server.baseUrl) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(url);
  await expect(page.locator('.record-label').first()).toBeVisible();
  await connect(page);
  return errors;
}
async function manager(page) {
  const toolbar = page.locator('[data-action=models]').first();
  if (await toolbar.isVisible()) await toolbar.click();
  else { await page.locator('[data-action=settings]').click(); await page.locator('#models-command').click(); }
  await expect(page.locator('.model-catalog-item').first()).toBeVisible();
}
async function newModel(page, name) {
  await page.locator('[data-action=model-new]').click();
  await page.locator('[name=modelName]').fill(name);
  await page.locator('[data-action=model-save]').click();
}
function writes(page) {
  const list = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (/\/models(?:\/[^/]+(?:\/(?:publish|apply|archive|unarchive))?)?$/.test(url.pathname) && !url.pathname.endsWith('/validate') && ['POST', 'PUT', 'DELETE'].includes(request.method())) list.push({ method: request.method(), url: request.url(), key: request.headers()['idempotency-key'] });
  });
  return list;
}
async function loseCreateReply(page, commit = true) {
  await page.route('**/api/v1/workspaces/default/models', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    if (commit) expect((await route.fetch()).status()).toBe(201);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{unknown' });
  });
}
async function stored(page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]'), recoveryKey); }
async function assertPreview(page) {
  const host = page.locator('.model-preview-canvas');
  await expect(host).toHaveAttribute('data-preview-state', 'ready');
  await expect.poll(() => host.evaluate(node => {
    const canvas = node.querySelector('canvas');
    return !!canvas && Math.abs(canvas.getBoundingClientRect().width - node.clientWidth) < 1 && Math.abs(canvas.getBoundingClientRect().height - node.clientHeight) < 1;
  })).toBe(true);
  const colors = await host.locator('canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2'), pixels = new Uint8Array(canvas.width * canvas.height * 4), colors = new Set();
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let index = 0; index < pixels.length; index += 16) colors.add(pixels[index] * 65536 + pixels[index + 1] * 256 + pixels[index + 2]);
    return colors.size;
  });
  expect(colors).toBeGreaterThan(8);
}

test('reload restores only safe model-write identity and blocks duplicate writes until original GET confirmation', async ({ page }) => {
  const errors = await open(page), commands = writes(page), checks = [];
  page.on('request', request => { if (request.url().includes('/command-results/')) checks.push({ method: request.method(), url: request.url() }); });
  await manager(page); await loseCreateReply(page);
  await newModel(page, 'Private model content must not enter recovery storage');
  await expect(page.locator('.model-outcome-check')).toBeVisible();
  const identities = await stored(page);
  expect(identities).toHaveLength(1);
  expect(Object.keys(identities[0]).sort()).toEqual(['baseUrl', 'clientCommandId', 'generation', 'type', 'workspaceId'].sort());
  expect(identities[0]).toMatchObject({ baseUrl: server.baseUrl, workspaceId: 'default', type: 'create', clientCommandId: commands[0].key });
  const serialized = JSON.stringify(identities);
  expect(serialized).not.toContain(server.token); expect(serialized).not.toContain('Private model'); expect(serialized).not.toContain('definition');
  await page.reload(); await expect(page.locator('.record-label').first()).toBeVisible(); await connect(page); await manager(page);
  await expect(page.locator('[data-action=model-save]')).toBeDisabled();
  await expect(page.locator('[data-action=model-new]')).toBeDisabled();
  await expect(page.locator('.model-outcome-check')).toBeVisible();
  await page.locator('.model-outcome-check').click();
  await expect(page.locator('.model-message')).toContainText('Model saved');
  await expect(page.locator('.model-outcome-check')).toHaveCount(0);
  expect(await stored(page)).toEqual([]); expect(commands).toHaveLength(1);
  expect(checks).toEqual([{ method: 'GET', url: `${server.baseUrl}/api/v1/workspaces/default/command-results/${commands[0].key}` }]);
  await expect(page.locator('.model-catalog-item')).toHaveCount(4);
  await page.reload(); await connect(page); await manager(page);
  await expect(page.locator('.model-outcome-check')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a not-found outcome does not erase a restored identity or unlock another mutation', async ({ page }) => {
  const errors = await open(page), commands = writes(page);
  await manager(page); await loseCreateReply(page, false); await newModel(page, 'No confirmed result');
  await expect(page.locator('.model-outcome-check')).toBeVisible();
  const before = await stored(page);
  await page.reload(); await connect(page); await manager(page);
  await page.locator('.model-outcome-check').click();
  await expect(page.locator('.model-message')).toContainText('No committed outcome is confirmed');
  expect(await stored(page)).toEqual(before);
  await expect(page.locator('[data-action=model-save]')).toBeDisabled();
  await expect(page.locator('[data-action=model-new]')).toBeDisabled();
  expect(commands).toHaveLength(1); expect(errors).toEqual([]);
});

test('a restored Apply outcome recovers its pinned version from the confirmed result without persisting its payload', async ({ page }) => {
  const errors = await open(page);
  await manager(page); await newModel(page, 'Reload-safe pinned model');
  await expect(page.locator('.model-message')).toContainText('Model saved');
  await page.locator('[data-action=model-publish]').click();
  await expect(page.locator('.model-message')).toContainText('Immutable version published');
  await page.route('**/api/v1/workspaces/default/models/*/apply', async route => {
    expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{unknown' });
  });
  await page.locator('[data-action=model-apply]').click();
  await expect(page.locator('.model-outcome-check')).toBeVisible();
  expect((await stored(page))[0].type).toBe('apply');
  expect((await stored(page))[0].payload).toBeUndefined();
  await page.reload(); await connect(page); await manager(page);
  await page.locator('.model-outcome-check').click();
  await expect(page.locator('.model-message')).toContainText('Pinned version applied');
  await expect(page.locator('.model-version')).toHaveValue('1');
  expect(await stored(page)).toEqual([]); expect(errors).toEqual([]);
});

test('unavailable storage warns explicitly and still preserves memory-only original outcome through Close', async ({ page }) => {
  await page.addInitScript(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith('openbexi:model-command-recovery')) throw new DOMException('Storage denied', 'SecurityError'); return original.call(this, key, value); }; });
  const errors = await open(page), commands = writes(page);
  await manager(page);
  await expect(page.locator('.model-recovery-warning')).toContainText('Recovery is memory-only');
  await loseCreateReply(page); await newModel(page, 'Memory-only command recovery');
  await expect(page.locator('.model-outcome-check')).toBeVisible();
  await page.locator('[data-action=model-close]').click(); await manager(page);
  await expect(page.locator('[data-action=model-save]')).toBeDisabled();
  await page.locator('.model-outcome-check').click();
  await expect(page.locator('.model-message')).toContainText('Model saved');
  expect(commands).toHaveLength(1); expect(errors).toEqual([]);
});

test('file URL recovery explicitly discloses browser-dependent retention', async ({ page }) => {
  const previousOrigins = process.env.OPENBEXI_CORS_ORIGINS;
  try { process.env.OPENBEXI_CORS_ORIGINS = 'null'; await server.restart(); }
  finally { if (previousOrigins === undefined) delete process.env.OPENBEXI_CORS_ORIGINS; else process.env.OPENBEXI_CORS_ORIGINS = previousOrigins; }
  const errors = await open(page, pathToFileURL(path.resolve('dist/index.html')).href);
  await manager(page);
  await expect(page.locator('.model-recovery-warning')).toBeVisible();
  await expect(page.locator('.model-recovery-warning')).toContainText(/browser-dependent|memory-only/);
  expect(errors).toEqual([]);
});

test('preview resize reuses its query and map, coalesces layouts and keeps the active timeline focus unchanged', async ({ page }, info) => {
  const errors = await open(page);
  const active = await page.evaluate(() => window.__timelineDebug), allocations = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/query-sessions')) allocations.push(request.url()); });
  await manager(page); await page.locator('[data-model-tab=preview]').click(); await assertPreview(page);
  const original = await page.locator('.model-preview-canvas').evaluate(node => ({ ...node.dataset }));
  let inFlight = 0, maxInFlight = 0, layouts = 0;
  const isPreviewLayout = request => request.method() === 'POST' && request.url().endsWith(`/query-sessions/${original.previewQueryId}/layouts`);
  page.on('request', request => { if (isPreviewLayout(request)) { layouts++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); } });
  page.on('requestfinished', request => { if (isPreviewLayout(request)) inFlight--; });
  page.on('requestfailed', request => { if (isPreviewLayout(request)) inFlight--; });
  for (const width of [1100, 900, 700, 390]) await page.setViewportSize({ width, height: 844 });
  await assertPreview(page);
  const mobile = await page.locator('.model-preview-canvas').evaluate(node => ({ ...node.dataset }));
  expect(mobile.previewQueryId).toBe(original.previewQueryId); expect(mobile.previewMapId).toBe(original.previewMapId);
  expect(mobile.previewFromMs).toBe(original.previewFromMs); expect(mobile.previewToMs).toBe(original.previewToMs);
  await page.screenshot({ path: info.outputPath('preview-resized-mobile.png') });
  await page.setViewportSize({ width: 1600, height: 900 }); await assertPreview(page);
  const after = await page.evaluate(() => window.__timelineDebug);
  for (const field of ['queryId', 'mapId', 'fromMs', 'toMs', 'modelId', 'modelVersion']) expect(after[field]).toBe(active[field]);
  expect(allocations).toHaveLength(1);
  expect(layouts).toBeGreaterThanOrEqual(2); expect(maxInFlight).toBe(1);
  const released = page.waitForRequest(request => request.method() === 'DELETE' && request.url().endsWith(`/query-sessions/${original.previewQueryId}`));
  await page.locator('[data-action=model-close]').click(); await released;
  expect(errors).toEqual([]);
});

test('closing during a resized layout releases the isolated query and rejects stale canvas completion', async ({ page }) => {
  const errors = await open(page);
  await manager(page); await page.locator('[data-model-tab=preview]').click(); await assertPreview(page);
  const queryId = await page.locator('.model-preview-canvas').getAttribute('data-preview-query-id');
  let enteredResolve, releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; }), release = new Promise(resolve => { releaseResolve = resolve; });
  await page.route(`**/query-sessions/${queryId}/layouts`, async route => {
    const response = await route.fetch(); enteredResolve(); await release; await route.fulfill({ response });
  });
  await page.setViewportSize({ width: 1000, height: 800 }); await entered;
  const released = page.waitForRequest(request => request.method() === 'DELETE' && request.url().endsWith(`/query-sessions/${queryId}`));
  await page.locator('[data-action=model-close]').click(); await expect(page.locator('.model-manager')).toHaveCount(0);
  releaseResolve(); await released;
  await manager(page); await page.locator('[data-model-tab=preview]').click(); await assertPreview(page);
  expect(await page.locator('.model-preview-canvas').getAttribute('data-preview-query-id')).not.toBe(queryId);
  expect(errors).toEqual([]);
});
