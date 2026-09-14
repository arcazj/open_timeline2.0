import { test, expect } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function openOffline(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:\/\//, route => route.abort('internetdisconnected'));
  await page.goto(pathToFileURL(path.resolve('dist/index.html')).href);
  await expect(page.locator('.record-label').first()).toBeVisible();
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  // The first query can finish before the boot-time ResizeObserver layout does.
  await expect.poll(() => page.locator('.plot-wrap').evaluate(plot => {
    const canvas = plot.querySelector('canvas');
    return canvas.height / Math.min(devicePixelRatio, 2) - plot.clientHeight;
  })).toBe(0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return errors;
}

async function pixels(page) {
  return page.locator('.plot-wrap canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const values = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, values);
    const colors = new Set(); let hash = 2166136261;
    for (let index = 0; index < values.length; index += 16) {
      const color = values[index] * 65536 + values[index + 1] * 256 + values[index + 2];
      colors.add(color); hash = Math.imul(hash ^ color, 16777619);
    }
    return { hash, colors: colors.size };
  });
}

for (const viewport of [{ width: 1600, height: 900 }, { width: 390, height: 844 }]) {
  test(`retained-scene drag stays synchronized before loading at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const errors = await openOffline(page), before = await page.evaluate(() => window.__timelineDebug);
    const plot = await page.locator('.plot-wrap').boundingBox(), canvas = await page.locator('.plot-wrap canvas').boundingBox();
    const overview = await page.locator('.overview-window').boundingBox(), beforePixels = await pixels(page);
    const x = plot.x + plot.width * 0.4, y = plot.y + plot.height * 0.8, dx = Math.min(110, plot.width * 0.2);
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y, { steps: 8 });
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.navigationPhase)).toBe('dragging');
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.navigationOffset)).toBeGreaterThan(dx - 1);
    const held = await page.evaluate(() => window.__timelineDebug);
    expect(held.fromMs).toBe(before.fromMs); expect(held.toMs).toBe(before.toMs); expect(held.mapId).toBe(before.mapId);
    expect(await page.locator('.plot-wrap canvas').boundingBox()).toEqual(canvas);
    const layers = await page.evaluate(() => ['.record-label-layer', '.axis-tick-layer'].map(selector => new DOMMatrixReadOnly(getComputedStyle(document.querySelector(selector)).transform).m41));
    expect(layers[0]).toBeCloseTo(dx, 1); expect(layers[1]).toBeCloseTo(dx, 1);
    expect((await page.locator('.overview-window').boundingBox()).x).toBeLessThan(overview.x);
    expect((await pixels(page)).colors).toBeGreaterThan(8); expect((await pixels(page)).hash).not.toBe(beforePixels.hash);
    await expect(page.locator('.navigation-pending-edge')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`held-drag-${viewport.width}.png`), fullPage: true });
    await page.waitForTimeout(210);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.navigationPhase)).toBe('idle');
    await expect(page.locator('.busy-indicator')).toHaveCount(0);
    const after = await page.evaluate(() => window.__timelineDebug);
    expect(after.fromMs).not.toBe(before.fromMs); expect(after.mapId).toBe(before.mapId); expect(after.dirty).toBe(false);
    expect(after.navigationOffset).toBe(0); await expect(page.locator('.navigation-pending-edge')).toBeHidden();
    expect((await pixels(page)).colors).toBeGreaterThan(8); expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`settled-drag-${viewport.width}.png`), fullPage: true });
  });
}

test('cancel restores the retained scene and reduced motion settles without coasting', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await openOffline(page), before = await page.evaluate(() => window.__timelineDebug), beforePixels = await pixels(page);
  const box = await page.locator('.plot-wrap').boundingBox(), x = box.x + box.width * 0.45, y = box.y + box.height * 0.8;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 70, y, { steps: 5 });
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.navigationOffset)).toBeGreaterThan(69);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.navigationPhase)).toBe('idle');
  expect(await page.evaluate(() => window.__timelineDebug.fromMs)).toBe(before.fromMs);
  expect(await pixels(page)).toEqual(beforePixels);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 70, y, { steps: 5 }); await page.mouse.up();
  expect(await page.evaluate(() => window.__timelineDebug.navigationPhase)).not.toBe('coasting');
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.navigationPhase)).toBe('idle');
  expect(await page.evaluate(() => window.__timelineDebug.fromMs)).not.toBe(before.fromMs);
  expect(await page.evaluate(() => window.__timelineDebug.dirty)).toBe(false); expect(errors).toEqual([]);
});
