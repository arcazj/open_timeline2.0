import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('a mobile toolbar press survives timeline layout refresh without replacing its icon', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(pathToFileURL(path.resolve('dist/index.html')).href);
  await expect.poll(() => page.evaluate(() => !!window.__timelineDebug?.queryId)).toBe(true);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  const button = page.getByRole('button', { name: 'Help and sharing', exact: true });
  await expect(button).toBeEnabled();
  await expect(button.locator('svg')).toBeVisible();
  const original = await button.locator('svg').elementHandle();
  const box = await button.boundingBox();
  const width = await page.evaluate(() => window.__timelineDebug.layoutWidth);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  let connected;
  try {
    await page.setViewportSize({ width: 394, height: 844 });
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.layoutWidth)).not.toBe(width);
    await expect(page.locator('.busy-indicator')).toHaveCount(0);
    connected = await original.evaluate(node => node.isConnected);
  } finally {
    await page.mouse.up();
  }
  await expect(page.getByRole('dialog', { name: 'Help and sharing', exact: true })).toBeVisible();
  expect(connected).toBe(true);
  await expect(page.getByLabel('Test local dataset', { exact: true })).toBeVisible();
  await expect(page.locator('.help-modal svg').first()).toBeVisible();
});
