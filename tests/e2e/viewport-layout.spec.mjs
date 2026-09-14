import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('short mobile Split pages use the real plot height without clipping label or bar ink', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.route(/^https?:/, route => route.abort());
  await page.goto(pathToFileURL(path.resolve('dist/index.html')).href);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug?.queryId)).toBeTruthy();
  await page.locator('[data-view=split]').click();
  await expect.poll(() => page.evaluate(() => { const plot = document.querySelector('.plot-wrap'), view = window.__timelineDebug; return view.pageCapacity === Math.floor((plot.clientHeight - 52) / view.effectiveRowHeight); })).toBe(true);
  const before = await page.evaluate(() => window.__timelineDebug);
  expect(before.pageCapacity).toBe(2);
  for (let index = 0; index < 3; index++) {
    await expect(page.locator('.busy-indicator')).toHaveCount(0);
    const bounds = await page.locator('.plot-wrap').evaluate(plot => {
      const box = plot.getBoundingClientRect(), ink = [...plot.querySelectorAll('.record-label,.record-hit')].map(node => node.getBoundingClientRect());
      return { bottom: box.bottom, lastInk: Math.max(...ink.map(node => node.bottom)), top: box.top, firstInk: Math.min(...ink.map(node => node.top)) };
    });
    expect(bounds.lastInk).toBeLessThanOrEqual(bounds.bottom); expect(bounds.firstInk).toBeGreaterThanOrEqual(bounds.top);
    const previous = await page.evaluate(() => window.__timelineDebug.startRow); await page.locator('[data-action=next]').click();
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.startRow)).toBe(previous + 2);
    const current = await page.evaluate(() => window.__timelineDebug); expect(current.queryId).toBe(before.queryId); expect(current.mapId).toBe(before.mapId); expect(current.fromMs).toBe(before.fromMs); expect(current.toMs).toBe(before.toMs);
  }
  await expect(page.locator('.overview-section')).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await expect(page.locator('.toast')).toHaveCount(0); await page.screenshot({ path: info.outputPath('short-mobile-split-pagination.png') });
});
