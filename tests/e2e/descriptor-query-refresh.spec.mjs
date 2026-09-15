import { test, expect } from '@playwright/test';
import { startServer } from '../integration/server-fixture.mjs';
import { ServerProvider } from '../../client/src/data/server-provider.js';

let server, remote, snapshot, parent, child;
test.beforeEach(async () => {
  server = await startServer(); remote = new ServerProvider(server); await remote.initialize();
  const create = async (title, sourceId, parentSessionId = null) => (await remote.executeCommand({ type: 'create', generation: remote.metadata.generation,
    clientCommandId: crypto.randomUUID(), payload: { title, kind: parentSessionId ? 'event' : 'session', start: '2026-09-12T12:00:00.000Z',
      end: parentSessionId ? null : '2026-09-12T13:00:00.000Z', sourceId, parentSessionId } })).record;
  parent = await create('Review parent', 'operations'); child = await create('Review child', 'operations', parent.id);
  snapshot = await remote.exportSnapshot();
});
test.afterEach(async () => { remote?.dispose(); await server?.stop(); });

const ready = page => expect.poll(() => page.evaluate(() => window.__timelineDebug?.ready)).toBe(true);
async function open(page, mode) {
  page.on('dialog', dialog => dialog.accept());
  await page.goto(server.baseUrl); await ready(page);
  await page.locator('[data-action=sources]').first().click();
  if (mode === 'server') {
    await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl); await page.locator('#server-form [name=token]').fill(server.token);
    await page.locator('#server-form [type=submit]').click(); await page.locator('#switch-source').click();
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server');
  } else {
    await page.locator('#json-file').setInputFiles({ name: 'query-descriptor.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.recordCount)).toBe(50);
  }
  await ready(page); await page.locator('[data-view=table]').click();
  await expect(page.locator('.table-view tbody tr')).toHaveCount(50);
  await page.locator('[data-action=filters]').first().click();
  const form = page.locator('#settings-form'); await form.locator('[name=definitionVersion]').selectOption('2');
  await form.locator('[name=search]').fill('Review child'); await form.locator('[name=searchMode]').selectOption('phrase');
  await form.locator('[type=submit]').click(); await ready(page);
  await page.locator(`.table-view [data-record-id="${child.id}"]`).click();
  await expect(page.locator('.descriptor h3')).toHaveText('Review child');
  await expect(page.locator('.descriptor-context')).toContainText('Matching record');
  await expect(page.locator('.descriptor-data')).toContainText('Timeline snapshot');
}
async function change(page, action) {
  const previous = await page.evaluate(() => window.__timelineDebug.queryId);
  await action(); await expect.poll(() => page.evaluate(() => window.__timelineDebug.queryId)).not.toBe(previous); await ready(page);
}

for (const mode of ['local', 'server']) {
  test(`${mode} adopted queries replace obsolete descriptor findings and clear excluded selections`, async ({ page }) => {
    await open(page, mode);
    await change(page, () => page.locator('#search').fill(''));
    await expect(page.locator('.descriptor')).toBeVisible();
    await expect(page.locator('.descriptor h3')).toHaveText('Review child');
    await expect(page.locator('.descriptor-context')).not.toContainText('Matching record');
    await expect(page.locator('.descriptor-context')).not.toContainText('search-term-');
    await change(page, () => page.locator('#source-filter').selectOption('verification'));
    await expect(page.locator('.descriptor')).toBeHidden();
    expect(await page.evaluate(() => window.__timelineDebug.selectedId)).toBeUndefined();
    await expect(page.locator('.toast')).not.toContainText('Record is not available');
  });

  test(`${mode} refreshed child descriptors cannot use an unscoped parent fallback`, async ({ page }) => {
    const unscopedReads = [];
    page.on('request', request => {
      if (request.method() === 'GET' && /\/workspaces\/[^/]+\/records\/[^/]+$/.test(new URL(request.url()).pathname)) unscopedReads.push(request.url());
    });
    await open(page, mode);
    await expect(page.getByRole('navigation', { name: 'Parent sessions' }).getByRole('button', { name: 'Review parent' })).toBeVisible();
    await change(page, () => page.locator('#kind-filter').selectOption('event'));
    await expect(page.locator('.descriptor')).toBeVisible();
    await expect(page.locator('.descriptor h3')).toHaveText('Review child');
    await expect(page.locator('.descriptor')).not.toContainText('Review parent');
    await expect(page.getByRole('navigation', { name: 'Parent sessions' })).toHaveCount(0);
    expect(unscopedReads).toEqual([]);
  });
}

test('a failed v2 query descriptor never retries via the unrestricted record endpoint', async ({ page }) => {
  await open(page, 'server'); await page.locator('[data-action=close-descriptor]').click();
  const unscopedReads = [];
  page.on('request', request => {
    if (request.method() === 'GET' && /\/workspaces\/[^/]+\/records\/[^/]+$/.test(new URL(request.url()).pathname)) unscopedReads.push(request.url());
  });
  await page.route(`**/query-sessions/*/records/${child.id}`, route => route.fulfill({ status: 404, json: { code: 'record_not_found', message: 'Record is not available in this query.' } }));
  await page.locator(`.table-view [data-record-id="${child.id}"]`).click();
  await expect(page.locator('.toast')).toContainText('Record is not available in this query');
  await expect(page.locator('.descriptor')).toBeHidden(); expect(unscopedReads).toEqual([]);
});

for (const action of ['refresh', 'new selection']) {
  test(`a pending scoped descriptor preserves selection intent during ${action}`, async ({ page }) => {
    await open(page, 'server');
    let release, entered, requests = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    await page.route(`**/query-sessions/*/records/${child.id}`, async route => {
      if (++requests === 1) { entered(); await pending; }
      await route.continue().catch(() => {});
    });
    try {
      await page.locator('#search').fill(''); await started;
      await expect(page.locator('.descriptor')).toBeHidden();
      expect(await page.evaluate(() => window.__timelineDebug.selectedId)).toBe(child.id);
      if (action === 'refresh') {
        await change(page, () => page.locator('#search').fill('Review child'));
        expect(requests).toBe(2);
      } else {
        await page.locator(`.table-view [data-record-id="${parent.id}"]`).click(); await ready(page);
      }
      const expected = action === 'refresh' ? child : parent;
      await expect(page.locator('.descriptor h3')).toHaveText(expected.title);
      expect(await page.evaluate(() => window.__timelineDebug.selectedId)).toBe(expected.id);
      release();
      await expect(page.locator('.descriptor h3')).toHaveText(expected.title);
      await expect(page.locator('.descriptor')).toBeVisible();
    } finally { release(); }
  });
}
