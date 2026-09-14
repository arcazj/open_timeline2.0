import { test, expect } from '@playwright/test';
import { startServer } from '../integration/server-fixture.mjs';

let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function connect(page) {
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl);
  await page.locator('#server-form [name=token]').fill(server.token);
  await page.locator('#server-form [type=submit]').click();
  await expect(page.locator('#switch-source')).toBeVisible();
  await page.locator('#switch-source').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server');
  await expect(page.locator('.provider-status')).toContainText('Connected');
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
}

async function openServer(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(server.baseUrl);
  await expect(page.locator('.record-label').first()).toBeVisible();
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await connect(page);
  return errors;
}

async function openManager(page) {
  await page.locator('[data-action=models]').first().click();
  await expect(page.locator('.model-manager')).toBeVisible();
  await expect(page.locator('.model-catalog-item').first()).toBeVisible();
}

async function catalog() {
  const response = await fetch(`${server.baseUrl}/api/v1/workspaces/default/models`, { headers: { Authorization: `Bearer ${server.token}` } });
  expect(response.status).toBe(200);
  return response.json();
}

function observeWrites(page) {
  const writes = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (/\/models(?:\/[^/]+(?:\/(?:publish|apply|archive|unarchive))?)?$/.test(pathname) && !pathname.endsWith('/validate') && ['POST', 'PUT', 'DELETE'].includes(request.method())) writes.push({ url: request.url(), method: request.method(), body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
  });
  return writes;
}

async function holdValidation(page) {
  const entered = deferred(), release = deferred();
  await page.route('**/api/v1/workspaces/default/models/validate', async route => {
    const response = await route.fetch();
    entered.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  return { entered: entered.promise, release: release.resolve };
}

async function settledResponse(page, response) {
  await response.finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('delayed validation cannot redirect an in-progress Save to another model or New editor', async ({ page }) => {
  const errors = await openServer(page);
  await openManager(page);
  const before = await catalog();
  const originalId = await page.locator('.model-catalog-item.selected').getAttribute('data-model-id');
  const otherId = before.items.find(item => item.id !== originalId).id;
  const writes = observeWrites(page);
  const validation = await holdValidation(page);
  await page.locator('[name=modelName]').fill('Original submitted model');
  await page.locator('[data-definition-field=theme]').selectOption('dark');
  await page.locator('[data-action=model-save]').click();
  await validation.entered;
  try {
    await page.locator(`[data-model-id="${otherId}"]`).dispatchEvent('click');
    await page.locator('[data-action=model-new]').dispatchEvent('click');
    await expect(page.locator('.model-catalog-item.selected')).toHaveAttribute('data-model-id', originalId);
    await expect(page.locator('[name=modelName]')).toHaveValue('Original submitted model');
  } finally { validation.release(); }
  await expect(page.locator('.model-message')).toContainText('Model saved');
  expect(writes).toHaveLength(1);
  expect(writes[0].method).toBe('PUT');
  expect(writes[0].url).toContain(`/models/${originalId}`);
  expect(writes[0].body.name).toBe('Original submitted model');
  expect(writes[0].body.draft.theme).toBe('dark');
  const after = await catalog();
  expect(after.items).toHaveLength(before.items.length);
  expect(after.items.find(item => item.id === otherId)).toEqual(before.items.find(item => item.id === otherId));
  expect(errors).toEqual([]);
});

test('closing an editor during delayed validation cancels the undispatched Save', async ({ page }) => {
  const errors = await openServer(page);
  await openManager(page);
  const before = await catalog();
  const writes = observeWrites(page);
  const validation = await holdValidation(page);
  await page.locator('[data-action=model-new]').click();
  await page.locator('[name=modelName]').fill('Must not be created after Close');
  await page.locator('[data-action=model-save]').click();
  await validation.entered;
  await page.locator('[data-action=model-close]').click();
  await expect(page.locator('.model-manager')).toHaveCount(0);
  const response = page.waitForResponse('**/api/v1/workspaces/default/models/validate');
  validation.release();
  await settledResponse(page, await response);
  await openManager(page);
  expect(writes).toHaveLength(0);
  expect(await catalog()).toEqual(before);
  await expect(page.locator('.model-catalog-item')).toHaveCount(before.items.length);
  expect(errors).toEqual([]);
});

test('a stale editor authorization failure cannot clear a newly connected Server source', async ({ page }) => {
  // Hold decoding of an already received response: aborting the old HTTP request
  // cannot erase this completion, so the source-identity guard must reject it.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    window.__modelAuthRace = { path: null, captured: false, delivered: false, release };
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const url = String(args[0]);
      if (!window.__modelAuthRace.path || !url.endsWith(window.__modelAuthRace.path)) return response;
      const body = await response.text();
      window.__modelAuthRace.captured = true;
      const held = new Response(body, { status: response.status, headers: response.headers });
      held.text = async () => {
        await gate;
        window.__modelAuthRace.delivered = true;
        return body;
      };
      return held;
    };
  });
  const errors = await openServer(page);
  await openManager(page);
  const target = page.locator('.model-catalog-item').nth(1);
  const targetId = await target.getAttribute('data-model-id');
  const routePath = `/api/v1/workspaces/default/models/${targetId}`;
  await page.evaluate(path => { window.__modelAuthRace.path = path; }, routePath);
  await page.route(`**${routePath}`, route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'authentication_required', message: 'Expired authorization on the original editor source' }) }));
  await target.click();
  await expect.poll(() => page.evaluate(() => window.__modelAuthRace.captured)).toBe(true);
  await page.locator('[data-action=model-close]').click();
  await expect(page.locator('.model-manager')).toHaveCount(0);
  await connect(page);
  const connected = await page.evaluate(() => window.__timelineDebug);
  await page.evaluate(() => window.__modelAuthRace.release());
  await expect.poll(() => page.evaluate(() => window.__modelAuthRace.delivered)).toBe(true);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.provider-status')).toContainText('Connected');
  await expect(page.locator('.record-label').first()).toBeVisible();
  expect((await page.evaluate(() => window.__timelineDebug)).queryId).toBe(connected.queryId);
  await expect(page.locator('.row-count')).not.toContainText('Authorization required');
  expect(errors).toEqual([]);
});

test('an uncertain model write retains its original outcome through Close and reopen', async ({ page }) => {
  const errors = await openServer(page);
  await openManager(page);
  const writes = observeWrites(page);
  const checks = [];
  page.on('request', request => {
    if (request.url().includes('/command-results/')) checks.push({ url: request.url(), method: request.method() });
  });
  await page.route('**/api/v1/workspaces/default/models', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const committed = await route.fetch();
    expect(committed.status()).toBe(201);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{lost-reply' });
  });
  await page.locator('[data-action=model-new]').click();
  await page.locator('[name=modelName]').fill('One uncertain model only');
  await page.locator('[data-action=model-save]').click();
  await expect(page.locator('.model-outcome-check')).toBeVisible();
  await expect(page.locator('[data-action=model-save]')).toBeDisabled();
  expect(writes).toHaveLength(1);
  const originalKey = writes[0].key;
  await page.locator('[data-action=model-close]').click();
  await expect(page.locator('.model-manager')).toHaveCount(0);
  await openManager(page);
  await expect(page.locator('.model-outcome-check')).toBeVisible();
  await expect(page.locator('[data-action=model-save]')).toBeDisabled();
  await page.locator('.model-outcome-check').click();
  await expect(page.locator('.model-message')).toContainText('Model saved');
  await expect(page.locator('.model-outcome-check')).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(checks).toEqual([{ url: `${server.baseUrl}/api/v1/workspaces/default/command-results/${originalKey}`, method: 'GET' }]);
  await page.locator('[data-action=model-close]').click();
  await expect(page.locator('.model-manager')).toHaveCount(0);
  await openManager(page);
  await expect(page.locator('.model-catalog-item')).toHaveCount(4);
  await expect(page.locator('.model-outcome-check')).toHaveCount(0);
  const after = await catalog();
  expect(after.items.filter(item => item.name === 'One uncertain model only')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('an uncertain model write survives forced outage closure and logical-source reconnect without replay', async ({ page }) => {
  const errors = await openServer(page);
  await openManager(page);
  const writes = observeWrites(page);
  const checks = [];
  page.on('request', request => {
    if (request.url().includes('/command-results/')) checks.push({ url: request.url(), method: request.method() });
  });
  await page.route('**/api/v1/workspaces/default/models', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{lost-reply' });
  });
  await page.locator('[data-action=model-new]').click();
  await page.locator('[name=modelName]').fill('Original Server outcome after outage');
  await page.locator('[data-action=model-save]').click();
  await expect(page.locator('.model-outcome-check')).toBeVisible();
  expect(writes).toHaveLength(1);
  const originalKey = writes[0].key;
  await server.pause();
  await page.locator('[data-action=refresh]').first().dispatchEvent('click');
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('local');
  await expect(page.locator('.model-manager')).toHaveCount(0);
  await openManager(page);
  await expect(page.locator('.model-outcome-check')).toHaveCount(0);
  await expect(page.locator('.model-catalog-item')).toHaveCount(3);
  await page.locator('[data-action=model-close]').click();
  await server.restart();
  await connect(page);
  await openManager(page);
  await expect(page.locator('.model-outcome-check')).toBeVisible();
  await expect(page.locator('[data-action=model-save]')).toBeDisabled();
  await page.locator('.model-outcome-check').click();
  await expect(page.locator('.model-message')).toContainText('Model saved');
  expect(writes).toHaveLength(1);
  expect(checks).toEqual([{ url: `${server.baseUrl}/api/v1/workspaces/default/command-results/${originalKey}`, method: 'GET' }]);
  expect((await catalog()).items.filter(item => item.name === 'Original Server outcome after outage')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('a confirmed create followed by a failed catalog refresh keeps its ID for the next Save', async ({ page }) => {
  const errors = await openServer(page);
  await openManager(page);
  const writes = observeWrites(page);
  let failNextList = false, committedId = null;
  await page.route(/\/api\/v1\/workspaces\/default\/models(?:\?includeArchived=true)?$/, async route => {
    if (route.request().method() === 'POST') {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committedId = (await response.json()).model.id;
      failNextList = true;
      return route.fulfill({ response });
    }
    if (route.request().method() === 'GET' && failNextList) {
      failNextList = false;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'catalog_refresh_failed', message: 'Controlled follow-up catalog read failure' }) });
    }
    return route.continue();
  });
  await page.locator('[data-action=model-new]').click();
  await page.locator('[name=modelName]').fill('Confirmed identity survives refresh');
  await page.locator('[data-action=model-save]').click();
  await expect(page.locator('.model-message')).toContainText('Command confirmed');
  await expect(page.locator('.model-message')).toContainText('Follow-up refresh failed');
  await expect(page.locator('.model-layer')).not.toHaveClass(/model-busy/);
  expect(writes).toHaveLength(1);
  expect(committedId).toBeTruthy();
  await page.locator('[name=modelName]').fill('Confirmed identity updated');
  await page.locator('[data-action=model-save]').click();
  await expect(page.locator('.model-message')).toContainText('Model saved');
  expect(writes).toHaveLength(2);
  expect(writes[1].method).toBe('PUT');
  expect(writes[1].url).toContain(`/models/${committedId}`);
  const after = await catalog();
  expect(after.items).toHaveLength(4);
  expect(after.items.filter(item => item.id === committedId && item.name === 'Confirmed identity updated')).toHaveLength(1);
  expect(errors).toEqual([]);
});
