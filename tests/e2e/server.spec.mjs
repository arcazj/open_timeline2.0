import { test, expect } from '@playwright/test';
import { startServer } from '../integration/server-fixture.mjs';

let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });

async function openApp(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.baseUrl);
  await expect(page.locator('.record-label').first()).toBeVisible();
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  return errors;
}

async function checkConnection(page, token = server.token) {
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl);
  await page.locator('#server-form [name=token]').fill(token);
  await page.locator('#server-form [type=submit]').click();
}

async function connect(page) {
  const before = await page.evaluate(() => window.__timelineDebug);
  await checkConnection(page);
  await expect(page.locator('#switch-source')).toBeVisible();
  expect(await page.evaluate(() => window.__timelineDebug.providerKind)).toBe(before.providerKind);
  await page.locator('#switch-source').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server');
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await expect(page.locator('.provider-status')).toContainText('Connected');
}

test('Python-backed UI persists JSON edits, falls back on outage, and reconnects without replay', async ({ page }, info) => {
  const errors = await openApp(page);
  await connect(page);
  await page.locator('[data-action=create]').click();
  await page.locator('#record-form [name=title]').fill('Server persistence checkpoint');
  await page.locator('#record-form [type=submit]').click();
  await expect(page.locator('[role=dialog]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(49);
  expect(await page.evaluate(() => window.__timelineDebug.dirty)).toBe(false);
  const before = await page.evaluate(() => window.__timelineDebug);
  await expect.poll(() => page.locator('.plot-wrap').evaluate(node => Math.abs(node.querySelector('canvas').width / Math.min(devicePixelRatio, 2) - node.clientWidth))).toBeLessThan(1);
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('server-connected.png'), fullPage: true });

  await server.pause();
  await page.locator('[data-action=refresh]').first().click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('local');
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(48);
  await expect(page.locator('.notice')).toContainText('may differ');
  const fallback = await page.evaluate(() => window.__timelineDebug);
  expect(fallback.fromMs).toBe(before.fromMs); expect(fallback.toMs).toBe(before.toMs);
  await page.screenshot({ path: info.outputPath('server-outage-local-snapshot.png'), fullPage: true });

  await server.restart();
  await connect(page);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(49);
  const response = await fetch(`${server.baseUrl}/api/v1/workspaces/default/snapshot`, { headers: { Authorization: `Bearer ${server.token}` } });
  const snapshot = await response.json();
  expect(snapshot.records.filter(record => record.title === 'Server persistence checkpoint')).toHaveLength(1);
  expect(snapshot.manifest.recordCount).toBe(49);
  expect(errors).toEqual([]);
});

test('invalid credentials never replace the active local source', async ({ page }) => {
  await openApp(page);
  const before = await page.evaluate(() => window.__timelineDebug);
  await checkConnection(page, 'incorrect-token-for-test-only');
  await expect(page.locator('.form-error')).toBeVisible();
  const after = await page.evaluate(() => window.__timelineDebug);
  expect(after.providerKind).toBe('local'); expect(after.queryId).toBe(before.queryId);
  await expect(page.locator('#switch-source')).toHaveCount(0);
});

test('a lost successful write reply is resolved read-only under the original command identity', async ({ page }) => {
  await openApp(page); await connect(page);
  const mutations = [];
  await page.route('**/api/v1/workspaces/default/records', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    mutations.push(route.request().headers()['idempotency-key']);
    const reply = await route.fetch();
    expect(reply.status()).toBe(201);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{broken-reply' });
  });
  await page.locator('[data-action=create]').click();
  await page.locator('#record-form [name=title]').fill('Lost reply checkpoint');
  await page.locator('#record-form [type=submit]').click();
  await expect(page.locator('#record-form [type=submit]')).toBeDisabled();
  await expect(page.locator('.outcome-check')).toBeVisible();
  await page.locator('.outcome-check').click();
  await expect(page.locator('.form-error')).toContainText('original write committed');
  expect(mutations).toHaveLength(1);
  await page.locator('#cancel-edit').click();
  await page.locator('[data-action=refresh]').first().click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(49);
  const response = await fetch(`${server.baseUrl}/api/v1/workspaces/default/snapshot`, { headers: { Authorization: `Bearer ${server.token}` } });
  expect((await response.json()).records.filter(record => record.title === 'Lost reply checkpoint')).toHaveLength(1);
});

test('an open server draft cannot be saved into the fallback Local source', async ({ page }) => {
  await openApp(page); await connect(page);
  await page.locator('[data-action=create]').click();
  await page.locator('#record-form [name=title]').fill('Draft must stay on server');
  await server.pause();
  await page.locator('[data-action=refresh]').first().dispatchEvent('click');
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('local');
  await expect(page.locator('#record-form')).toBeVisible();
  await page.locator('#record-form [type=submit]').click();
  await expect(page.locator('.form-error')).toContainText('previous source');
  expect(await page.evaluate(() => window.__timelineDebug.dirty)).toBe(false);
  expect(await page.evaluate(() => window.__timelineDebug.detailTotal)).toBe(48);
});

test('revoked server access clears protected visuals and does not silently switch to Local', async ({ page }, info) => {
  await openApp(page); await connect(page);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.ready)).toBe(true);
  let releaseLayout, layoutRequested = false, revokedRequests = 0;
  const heldLayout = new Promise(resolve => { releaseLayout = resolve; });
  await page.route('**/query-sessions/*/layouts', async route => { layoutRequested = true; await heldLayout; await route.continue(); });
  try {
    await page.locator('.record-label').first().click();
    await expect(page.locator('.descriptor')).toBeVisible();
    await expect.poll(() => layoutRequested).toBe(true);
    await page.route('**/api/v1/workspaces/default/query-sessions', route => {
      revokedRequests++;
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'authentication_required', message: 'Access was revoked for this test.' }) });
    });
    await page.locator('[data-action=refresh]').first().click();
    expect(revokedRequests).toBe(0);
  } finally { releaseLayout(); }
  await expect.poll(() => revokedRequests).toBe(1);
  await expect(page.locator('.record-label')).toHaveCount(0);
  await expect(page.locator('.descriptor')).not.toBeVisible();
  expect(await page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server');
  await expect(page.locator('.notice')).toContainText(/access|auth|revoked/i);
  await page.screenshot({ path: info.outputPath('server-access-revoked.png'), fullPage: true });
});
