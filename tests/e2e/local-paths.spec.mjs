import { test, expect } from '@playwright/test';
import { startLocalPathsServer } from '../integration/local-paths-server-fixture.mjs';

let server;
test.beforeEach(async () => { server = await startLocalPathsServer(); });
test.afterEach(async () => { await server?.stop(); });
const debug = page => page.evaluate(() => window.__timelineDebug);
async function ready(page) {
  await expect.poll(async () => (await debug(page)).localPaths).toBe(true);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
}
async function assertRendering(page) {
  const result = await page.evaluate(() => {
    const plot = document.querySelector('.plot-wrap').getBoundingClientRect();
    const controls = [...document.querySelector('.filter-strip').children].filter(node => node.getClientRects().length);
    const toolbar = controls.map(node => node.getBoundingClientRect());
    let toolbarOverlaps = 0;
    for (let i = 0; i < toolbar.length; i++) for (let j = i + 1; j < toolbar.length; j++) {
      const a = toolbar[i], b = toolbar[j];
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5) toolbarOverlaps++;
    }
    const boxes = [...document.querySelectorAll('.plot-wrap .record-label')].map(node => node.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (Math.min(a.right, b.right, plot.right) - Math.max(a.left, b.left, plot.left) > 0.5 && Math.min(a.bottom, b.bottom, plot.bottom) - Math.max(a.top, b.top, plot.top) > 0.5) overlaps++;
    }
    const colors = [...document.querySelectorAll('.plot-wrap canvas,.overview-plot canvas')].map(canvas => {
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl'), pixels = new Uint8Array(canvas.width * canvas.height * 4), values = new Set();
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      for (let i = 0; i < pixels.length; i += 16) values.add(pixels[i] * 65536 + pixels[i + 1] * 256 + pixels[i + 2]);
      return values.size;
    });
    return { overlaps, colors, toolbarOverlaps, clippedControls: controls.filter(node => node.scrollWidth > node.clientWidth + 1).length, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(result.overlaps).toBe(0); expect(result.overflow).toBe(false);
  expect(result.toolbarOverlaps).toBe(0); expect(result.clippedControls).toBe(0);
  expect(result.colors).toHaveLength(2); for (const count of result.colors) expect(count).toBeGreaterThan(1);
}

test('approved paths auto-connect without tokens, multi-select, favorite and combine or group n namespaces', async ({ page }, info) => {
  const errors = [], authorizations = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.headers().authorization) authorizations.push(request.url()); });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(server.baseUrl); await ready(page);
  await expect.poll(async () => (await debug(page)).detailTotal).toBe(6);
  await expect(page.locator('#grouping-mode')).toHaveValue('all');
  await expect(page.locator('.group-label')).toHaveCount(0);
  await page.locator('#grouping-mode').selectOption('namespace');
  await expect(page.locator('.group-label')).toHaveCount(3);
  expect(await page.locator('.group-label').allTextContents()).toEqual(['SOURCE1', 'SOURCE2', 'SOURCE3']);
  await assertRendering(page);
  await page.screenshot({ path: info.outputPath('three-namespaces.png'), fullPage: true });
  await page.locator('[data-action=sources]').first().click();
  await expect(page.locator('#server-form [name=token]')).toBeHidden();
  const choices = page.locator('.path-choice');
  await choices.nth(2).locator('[name=path]').uncheck();
  await choices.nth(0).locator('.path-favorite').click();
  await page.locator('#path-form [type=submit]').click(); await ready(page);
  await expect.poll(async () => (await debug(page)).detailTotal).toBe(4);
  await expect(page.locator('.group-label')).toHaveCount(2);
  const state = await debug(page); expect(state.selectedSourceIds).toHaveLength(2);
  await page.locator('#grouping-mode').selectOption('all');
  await expect(page.locator('.group-label')).toHaveCount(0);
  expect((await debug(page)).detailTotal).toBe(4);
  await assertRendering(page);
  await page.screenshot({ path: info.outputPath('combined-sources.png'), fullPage: true });
  page.on('dialog', dialog => dialog.accept());
  await page.reload(); await ready(page);
  await expect.poll(async () => (await debug(page)).detailTotal).toBe(4);
  for (let i = 0; i < 4; i++) {
    await page.reload(); await ready(page);
    await expect.poll(async () => (await debug(page)).detailTotal).toBe(4);
    await expect(page.locator('.notice')).toBeHidden();
  }
  const favorite = await page.locator('#path-shortcut option').filter({ hasText: /data[\\/]SOURCE1$/ }).getAttribute('value');
  await page.locator('#path-shortcut').selectOption(favorite); await ready(page);
  await expect.poll(async () => (await debug(page)).detailTotal).toBe(2);
  expect(authorizations).toEqual([]); expect(errors).toEqual([]);
});

test('navigation crosses both analysis edges, keeps held geometry pinned and makes the overview follow', async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(server.baseUrl); await ready(page);
  await page.locator('.range-button').click();
  await page.locator('#range-form [name=from]').fill('2030-01-01T00:00');
  await page.locator('#range-form [name=to]').fill('2030-01-01T02:00');
  await page.locator('#range-form [type=submit]').click(); await ready(page);
  const before = await debug(page), plot = await page.locator('.plot-wrap').boundingBox();
  await page.mouse.move(plot.x + plot.width * 0.6, plot.y + plot.height * 0.7);
  await page.mouse.down(); await page.mouse.move(plot.x + plot.width * 0.2, plot.y + plot.height * 0.7, { steps: 8 });
  await expect.poll(async () => (await debug(page)).navigationPhase).toBe('dragging');
  const held = await debug(page); expect(held.mapId).toBe(before.mapId); expect(held.fromMs).toBe(before.fromMs);
  await page.waitForTimeout(210); await page.mouse.up();
  await expect.poll(async () => (await debug(page)).navigationPhase).toBe('idle'); await ready(page);
  const after = await debug(page);
  expect(Number(after.toMs)).toBeGreaterThan(Date.parse(before.domain.to));
  expect(after.mapId).not.toBe(before.mapId); expect(after.domain).not.toEqual(before.domain);
  expect(Number(after.fromMs)).toBeGreaterThanOrEqual(Date.parse(after.domain.from));
  expect(Number(after.toMs)).toBeLessThanOrEqual(Date.parse(after.domain.to));
  await page.screenshot({ path: info.outputPath('future-navigation.png'), fullPage: true });
  await page.locator('.plot-wrap').focus();
  for (let i = 0; i < 20; i++) { await page.keyboard.press('ArrowLeft'); await ready(page); }
  expect(Number((await debug(page)).fromMs)).toBeLessThan(Date.parse(before.domain.from));
  expect((await debug(page)).dirty).toBe(false); expect(errors).toEqual([]);
});

test('path picker and shortcuts fit mobile and empty selection never becomes all paths', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(server.baseUrl); await ready(page);
  await page.locator('#path-shortcut').selectOption('choose');
  await page.screenshot({ path: info.outputPath('mobile-path-picker.png'), fullPage: true });
  for (const node of await page.locator('#path-form [name=path]').all()) await node.uncheck();
  await page.locator('#path-form [type=submit]').click(); await ready(page);
  await expect.poll(async () => (await debug(page)).detailTotal).toBe(0);
  expect((await debug(page)).selectedSourceIds).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#path-shortcut').selectOption('all'); await ready(page);
  await expect.poll(async () => (await debug(page)).detailTotal).toBe(6);
  await assertRendering(page);
  await page.screenshot({ path: info.outputPath('mobile-timeline.png'), fullPage: true });
});
