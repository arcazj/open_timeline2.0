import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const debug = page => page.evaluate(() => window.__timelineDebug);
async function settled(page) { await expect(page.locator('.busy-indicator')).toHaveCount(0); }
async function setRatio(page, ratio) {
  await page.locator('#local-scale').fill(String(ratio));
  await page.locator('#local-scale').dispatchEvent('change');
  await settled(page);
}
for (const viewport of [{ width: 1600, height: 900 }, { width: 390, height: 844 }]) {
  test(`local scale controls, pagination and canvas at ${viewport.width}px`, async ({ page }, info) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport);
    await page.route(/^https?:\/\//, route => route.abort('internetdisconnected'));
    await page.goto(pathToFileURL(path.resolve('dist/index.html')).href);
    await expect(page.locator('.record-label').first()).toBeVisible(); await settled(page);
    const before = await debug(page);
    await expect(page.locator('#local-scale')).toBeDisabled();
    await page.locator('#auto-scale').check(); await settled(page);
    await page.locator('#scale-strategy').selectOption('manual'); await settled(page);
    await setRatio(page, 16);
    await expect.poll(async () => (await debug(page)).scaleRatio).toBe(16);
    await setRatio(page, 32);
    await expect.poll(async () => (await debug(page)).scaleRatio).toBe(32);
    const manual = await debug(page);
    expect([manual.fromMs, manual.toMs]).toEqual([before.fromMs, before.toMs]);
    await page.locator('#scale-strategy').selectOption('automatic'); await settled(page);
    const optimized = await debug(page);
    expect(optimized.totalRows).toBeLessThanOrEqual(manual.totalRows);
    expect(optimized.scaleRatio).toBeGreaterThanOrEqual(1);
    expect(optimized.scaleRatio).toBeLessThanOrEqual(32);
    if (await page.locator('[data-action=next]').isEnabled()) {
      await page.locator('[data-action=next]').click(); await settled(page);
      const next = await debug(page);
      expect(next.mapId).toBe(optimized.mapId);
      expect(next.scaleRatio).toBe(optimized.scaleRatio);
      expect([next.fromMs, next.toMs]).toEqual([optimized.fromMs, optimized.toMs]);
    }
    const check = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.local-scale-controls > *')].map(node => node.getBoundingClientRect());
      const overlaps = nodes.some((a, i) => nodes.slice(i + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5));
      const colors = [...document.querySelectorAll('.plot-wrap canvas, .overview-plot canvas')].map(canvas => {
        const gl = canvas.getContext('webgl2'), pixels = new Uint8Array(canvas.width * canvas.height * 4), values = new Set();
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        for (let i = 0; i < pixels.length; i += 16) values.add(pixels[i] * 65536 + pixels[i + 1] * 256 + pixels[i + 2]);
        return values.size;
      });
      return { overlaps, colors, overflow: document.documentElement.scrollWidth > innerWidth, outside: nodes.some(b => b.left < 0 || b.right > innerWidth) };
    });
    expect(check.overlaps).toBe(false); expect(check.overflow).toBe(false); expect(check.outside).toBe(false);
    expect(check.colors).toHaveLength(2); for (const count of check.colors) expect(count).toBeGreaterThan(2);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`scaling-${viewport.width}.png`), fullPage: true });
    await page.locator('#auto-scale').uncheck(); await settled(page);
    await expect(page.locator('#local-scale')).toBeDisabled();
    await expect(page.locator('.scale-cue')).toHaveText('Uniform time scale');
  });
}
