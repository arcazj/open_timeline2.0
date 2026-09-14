import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { startServer } from '../integration/server-fixture.mjs';

const fixtureDefinition = { theme: 'light', rowHeight: 40, fontSize: 13, groupBy: 'none', displayUnit: 'HOUR', timeZone: 'UTC', scaleMode: 'uniform', ratio: 4, bins: 64 };
async function openLocal(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:\/\//, route => route.abort('internetdisconnected'));
  await page.goto(pathToFileURL(path.resolve('dist/index.html')).href);
  await expect(page.locator('.record-label').first()).toBeVisible();
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  return errors;
}
async function openManager(page) {
  const toolbar = page.locator('[data-action=models]').first();
  if (await toolbar.isVisible()) await toolbar.click();
  else {
    await page.locator('[data-action=settings]').click();
    await page.locator('#models-command').click();
  }
  await expect(page.locator('.model-manager')).toBeVisible();
  await expect(page.locator('.model-catalog-item').first()).toBeVisible();
}
async function settled(page) {
  await expect(page.locator('.model-layer')).not.toHaveClass(/model-busy/);
}
async function save(page) {
  await page.locator('[data-action=model-save]').click();
  await expect(page.locator('.model-message')).toContainText('Model saved');
  await settled(page);
}
async function publish(page) {
  await page.locator('[data-action=model-publish]').click();
  await expect(page.locator('.model-message')).toContainText('Immutable version published');
  await settled(page);
}
async function checkPreview(page) {
  await expect(page.locator('.model-preview-canvas canvas')).toBeVisible();
  const rendered = await page.locator('.model-preview-canvas canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2');
    const values = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, values);
    const colors = new Set();
    for (let index = 0; index < values.length; index += 16) colors.add(values[index] * 65536 + values[index + 1] * 256 + values[index + 2]);
    const bounds = canvas.getBoundingClientRect(), host = canvas.parentElement.getBoundingClientRect();
    return { colors: colors.size, width: bounds.width, height: bounds.height, hostWidth: host.width, hostHeight: host.height };
  });
  expect(rendered.colors).toBeGreaterThan(8);
  expect(rendered.width).toBeCloseTo(rendered.hostWidth, 0);
  expect(rendered.height).toBeCloseTo(rendered.hostHeight - 2, 0);
}

test('Local model drafts, isolated preview, publication and explicit version pinning work end to end', async ({ page }, info) => {
  const errors = await openLocal(page);
  const before = await page.evaluate(() => window.__timelineDebug);
  await openManager(page);
  await page.locator('[data-action=model-new]').click();
  await page.locator('[name=modelName]').fill('Operations night view');
  await page.locator('[data-definition-field=theme]').selectOption('dark');
  await page.locator('[data-definition-field=rowHeight]').fill('44');
  await page.locator('[data-definition-field=fontSize]').fill('15');
  await page.locator('[data-definition-field=timeZone]').fill('America/New_York');
  await page.locator('[data-model-tab=preview]').click();
  await expect(page.locator('.model-message')).toContainText('Active model unchanged');
  await checkPreview(page);
  const preview = await page.evaluate(() => window.__timelineDebug);
  expect(preview.queryId).toBe(before.queryId); expect(preview.mapId).toBe(before.mapId);
  expect(preview.fromMs).toBe(before.fromMs); expect(preview.toMs).toBe(before.toMs);
  await expect(page.locator('#app')).not.toHaveClass(/dark/);
  await page.screenshot({ path: info.outputPath('model-preview.png'), fullPage: true });
  await page.locator('[data-model-tab=fields]').click();
  await save(page); await publish(page);
  await expect(page.locator('#app')).not.toHaveClass(/dark/);
  await expect(page.locator('.model-version')).toHaveValue('1');
  await page.locator('[data-action=model-apply]').click();
  await expect(page.locator('.model-message')).toContainText('Pinned version applied');
  await expect(page.locator('#app')).toHaveClass(/dark/);
  await page.locator('[data-definition-field=rowHeight]').fill('48');
  await save(page); await publish(page);
  await expect(page.locator('.model-version')).toHaveValue('2');
  await expect(page.locator('.model-catalog-item.selected')).toContainText('Active v1');
  await page.screenshot({ path: info.outputPath('model-library.png'), fullPage: true });
  await page.locator('[data-model-tab=json]').click();
  await expect(page.locator('.model-json')).toContainText('America/New_York');
  await page.screenshot({ path: info.outputPath('model-editor.png'), fullPage: true });
  await page.locator('[data-action=model-close]').click();
  await expect(page.locator('.model-manager')).toHaveCount(0);
  await expect(page.locator('.scale-window')).toContainText('America/New_York');
  expect((await page.evaluate(() => window.__timelineDebug)).fromMs).toBe(before.fromMs);
  expect(errors).toEqual([]);
});

test('model library stays usable on a narrow screen with a nonblank independent preview', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await openLocal(page);
  await openManager(page);
  const geometry = await page.locator('.model-manager').evaluate(node => {
    const rect = node.getBoundingClientRect();
    const footer = node.querySelector('.model-manager-footer').getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, footerBottom: footer.bottom, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(390);
  expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeLessThanOrEqual(844);
  expect(geometry.footerBottom).toBeLessThanOrEqual(844); expect(geometry.overflow).toBe(false);
  await page.screenshot({ path: info.outputPath('model-mobile.png'), fullPage: true });
  await page.locator('[data-model-tab=preview]').click();
  await expect(page.locator('.model-message')).toContainText('Active model unchanged');
  await checkPreview(page);
  await page.locator('[data-action=model-close]').click();
  await expect(page.locator('.model-manager')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('model definition export/import, duplication, archive and safe deletion keep catalog identities separate', async ({ page }) => {
  const errors = await openLocal(page);
  await openManager(page);
  await page.locator('[data-action=model-duplicate]').click();
  await page.locator('[name=modelName]').fill('Disposable model copy');
  await save(page);
  await expect(page.locator('.model-catalog-item')).toHaveCount(4);
  await publish(page);
  await page.locator('[data-action=model-archive]').click();
  await settled(page);
  await page.locator('.model-archived').check();
  await expect(page.locator('.model-catalog-item.selected')).toContainText('Archived');
  await page.locator('[data-action=model-unarchive]').click();
  await settled(page);
  page.on('dialog', dialog => dialog.accept());
  await page.locator('[data-action=model-delete]').click();
  await expect(page.locator('.model-catalog-item')).toHaveCount(3);
  const portable = { format: 'timeline-visual-model', formatVersion: 1, name: 'Imported model', description: '', tags: ['fixture'], definition: fixtureDefinition };
  await page.locator('.model-file').setInputFiles({ name: 'model.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(portable)) });
  await expect(page.locator('.model-catalog-item')).toHaveCount(4);
  await expect(page.locator('[name=modelName]')).toHaveValue('Imported model');
  const downloading = page.waitForEvent('download');
  await page.locator('[data-action=model-export]').click();
  const exported = JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
  expect(exported).toEqual(portable);
  const malformed = JSON.stringify(portable).replace('"formatVersion":1', '"formatVersion":1,"formatVersion":1');
  await page.locator('.model-file').setInputFiles({ name: 'duplicate-keys.json', mimeType: 'application/json', buffer: Buffer.from(malformed) });
  await expect(page.locator('.model-message')).toContainText(/duplicate/i);
  await expect(page.locator('.model-catalog-item')).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('model validation is shared between structured and JSON editors without publishing invalid definitions', async ({ page }) => {
  await openLocal(page); await openManager(page);
  await page.locator('[data-action=model-new]').click();
  await page.locator('[name=modelName]').fill('Validation fixture');
  await page.locator('[data-definition-field=fontSize]').fill('24');
  await page.locator('[data-action=model-validate]').click();
  await expect(page.locator('.model-message')).toContainText('rowHeight');
  await page.locator('[data-model-tab=json]').click();
  await page.locator('.model-json').fill(JSON.stringify({ ...fixtureDefinition, executableDescriptor: 'alert(1)' }));
  await page.locator('[data-action=model-save]').click();
  await expect(page.locator('.model-message')).toContainText('executableDescriptor');
  await expect(page.locator('.model-catalog-item')).toHaveCount(3);
  await expect(page.locator('[data-action=model-publish]')).toBeDisabled();
});

test('a lost model-create reply is recovered without duplicate writes and published history survives Python restart', async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.baseUrl);
    await expect(page.locator('.record-label').first()).toBeVisible();
    await page.locator('[data-action=sources]').first().click();
    await page.locator('#server-form [name=token]').fill(server.token);
    await page.locator('#server-form [type=submit]').click();
    await page.locator('#switch-source').click();
    await expect(page.locator('.provider-status')).toContainText('Connected');
    await openManager(page);
    let writes = 0;
    await page.route('**/api/v1/workspaces/default/models', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      writes++;
      const reply = await route.fetch(); expect(reply.status()).toBe(201);
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{lost-reply' });
    });
    await page.locator('[data-action=model-new]').click();
    await page.locator('[name=modelName]').fill('Persistent model');
    await page.locator('[data-action=model-save]').click();
    await expect(page.locator('.model-outcome-check')).toBeVisible();
    await expect(page.locator('[data-action=model-save]')).toBeDisabled();
    await page.locator('.model-outcome-check').click();
    await expect(page.locator('.model-catalog-item')).toHaveCount(4);
    expect(writes).toBe(1);
    await publish(page);
    await page.locator('[data-action=model-apply]').click();
    await expect(page.locator('.model-message')).toContainText('Pinned version applied');
    const originalResponse = await fetch(`${server.baseUrl}/api/v1/workspaces/default/models`, { headers: { Authorization: `Bearer ${server.token}` } });
    expect(originalResponse.status).toBe(200);
    const originalCatalog = await originalResponse.json(), originalModel = originalCatalog.items.find(item => item.id === originalCatalog.active.modelId);
    expect(originalModel?.name).toBe('Persistent model');
    expect(originalModel.versions).toHaveLength(1);
    await page.locator('[data-action=model-close]').click();
    await server.restart();
    const response = await fetch(`${server.baseUrl}/api/v1/workspaces/default/models`, { headers: { Authorization: `Bearer ${server.token}` } });
    expect(response.status).toBe(200);
    const persisted = await response.json(), model = persisted.items.find(item => item.name === 'Persistent model');
    expect(model?.id).toBe(originalModel.id);
    expect(model.versions).toEqual(originalModel.versions);
    expect(persisted.active).toEqual(originalCatalog.active);
    // A restart may trigger the required Local fallback; reconnection is explicit.
    await page.locator('[data-action=sources]').first().click();
    await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl);
    await page.locator('#server-form [name=token]').fill(server.token);
    await page.locator('#server-form [type=submit]').click();
    await page.locator('#switch-source').click();
    await expect(page.locator('.provider-status')).toContainText('Connected');
    await openManager(page);
    await expect(page.locator('.model-catalog-item.selected')).toContainText('Persistent model');
    await expect(page.locator('.model-catalog-item.selected')).toContainText('Active v1');
    await expect(page.locator('.model-version')).toHaveValue('1');
    expect(writes).toBe(1);
  } finally { await server.stop(); }
});
