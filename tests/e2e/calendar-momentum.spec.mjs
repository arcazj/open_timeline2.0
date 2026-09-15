import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { startLocalPathsServer } from '../integration/local-paths-server-fixture.mjs';

const debug = page => page.evaluate(() => window.__timelineDebug);
async function ready(page) { await expect.poll(async () => (await debug(page))?.ready).toBe(true); }
async function open(page, url = pathToFileURL(path.resolve('dist/index.html')).href) {
  await page.goto(url); await ready(page);
  await expect.poll(() => page.locator('.plot-wrap').evaluate(plot => Math.abs(plot.querySelector('canvas').height / Math.min(devicePixelRatio, 2) - plot.clientHeight))).toBeLessThan(1);
}
async function chooseMonth(page, year, month) {
  await page.getByRole('spinbutton', { name: 'Calendar year', exact: true }).fill(String(year));
  await page.getByRole('spinbutton', { name: 'Calendar year', exact: true }).press('Tab');
  await page.getByRole('combobox', { name: 'Calendar month', exact: true }).selectOption(String(month));
}
async function assertCenter(page, iso) {
  await ready(page);
  await expect.poll(async () => Math.abs(Number((await debug(page)).centerMs) - Date.parse(iso))).toBeLessThan(1);
}

for (const width of [1600, 390]) test(`calendar, UTC centering, keyboard and existing range dialog (${width}px)`, async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await page.route(/^https?:\/\//, route => route.abort());
  await open(page);
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  const calendar = page.getByRole('complementary', { name: 'Calendar', exact: true });
  await expect(calendar).toBeVisible();
  await expect(calendar.getByRole('button', { name: /^\d{4}-\d{2}-\d{2}$/ })).toHaveCount(42);
  const time = page.getByLabel('Calendar center time / UTC', { exact: true });
  await expect(time).toHaveValue('04:00'); await expect(time).toHaveAttribute('step', '3600');
  await chooseMonth(page, 2024, 5);
  await page.getByRole('button', { name: '2024-05-03', exact: true }).click();
  await assertCenter(page, '2024-05-03T04:00:00Z');
  await expect(calendar.locator('.calendar-error')).toBeHidden();
  await page.getByRole('button', { name: '2024-05-03', exact: true }).focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  await assertCenter(page, '2024-05-04T04:00:00Z');
  await chooseMonth(page, 2026, 9);
  await page.getByRole('button', { name: '2026-09-12', exact: true }).click(); await ready(page);
  await time.fill('10:00'); await time.press('Tab'); await assertCenter(page, '2026-09-12T10:00:00Z');
  await expect(page.locator('.record-label').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await calendar.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  await page.screenshot({ path: info.outputPath(`calendar-${width}.png`), fullPage: true });
  await calendar.getByRole('button', { name: 'Date and time range', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Date and time range' })).toBeVisible();
  await expect(calendar).toHaveCount(0);
  await page.keyboard.press('Escape'); expect(errors).toEqual([]);
});

test('adaptive calendar centers the selected UTC instant and keeps filters on the Python-backed timeline', async ({ page }) => {
  const server = await startLocalPathsServer();
  try {
    await open(page, server.baseUrl);
    await expect.poll(async () => (await debug(page)).localPaths).toBe(true); await ready(page);
    await page.locator('#search').fill('SOURCE1'); await ready(page);
    await page.getByRole('button', { name: 'Calendar', exact: true }).click();
    await chooseMonth(page, 2024, 3);
    const time = page.getByLabel('Calendar center time / UTC', { exact: true });
    await time.fill('20:00'); await time.press('Tab'); await ready(page);
    await page.getByRole('button', { name: '2024-03-18', exact: true }).click();
    await assertCenter(page, '2024-03-18T20:00:00Z');
    expect((await debug(page)).search).toBe('SOURCE1'); expect((await debug(page)).localPaths).toBe(true);
    expect((await debug(page)).scaleMode).toBe('adaptive'); expect((await debug(page)).dirty).toBe(false);
    await expect(page.locator('.notice')).toBeHidden();
    await page.getByRole('button', { name: 'Next month', exact: true }).click();
    const before = (await debug(page)).centerMs;
    await expect(page.getByRole('combobox', { name: 'Calendar month', exact: true })).toHaveValue('4');
    expect((await debug(page)).centerMs).toBe(before);
    await page.route('**/api/v1/workspaces/default/query-sessions', route => route.fulfill({ status: 422, contentType: 'application/problem+json', body: JSON.stringify({ code: 'invalid_query', message: 'Controlled query failure', status: 422 }) }));
    await page.getByRole('button', { name: '2024-04-15', exact: true }).click();
    await expect(page.locator('.calendar-error')).toContainText('previous view is retained');
    await assertCenter(page, '2024-03-18T20:00:00Z');
  } finally { await server.stop(); }
});

for (const direction of [-1, 1]) test(`long glide and click-stop keep the displayed position (${direction})`, async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  const before = await debug(page), plot = await page.locator('.plot-wrap').boundingBox();
  const x = plot.x + plot.width * .5, y = plot.y + plot.height * .8;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + direction * 240, y, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => (await debug(page)).navigationPhase).toBe('coasting');
  await expect.poll(async () => Math.abs((await debug(page)).navigationOffset)).toBeGreaterThan(550);
  await page.mouse.move(x, y); await page.mouse.down();
  const stopped = await debug(page);
  await page.waitForTimeout(160);
  expect((await debug(page)).navigationOffset).toBe(stopped.navigationOffset);
  await page.mouse.up(); await ready(page);
  const after = await debug(page), span = Number(before.toMs) - Number(before.fromMs);
  const expected = Number(before.fromMs) - stopped.navigationOffset / before.layoutWidth * span;
  expect(Math.abs(Number(after.fromMs) - expected)).toBeLessThan(1);
  expect(after.selectedId).toBeUndefined(); expect(after.dirty).toBe(false); expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath(`glide-stop-${direction}.png`), fullPage: true });
});

test('long mobile coast keeps time grids and the rolling overview visible beyond the original query', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date('2026-09-12T00:00:00.000Z') });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 5000));
  const before = await debug(page), plot = await page.locator('.plot-wrap').boundingBox(), x = plot.x + plot.width * .4, y = plot.y + plot.height * .8;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let step = 1; step <= 3; step++) {
    await page.clock.runFor(16); await page.mouse.move(x + step * 50, y);
  }
  await page.clock.runFor(8); await page.mouse.up();
  expect((await debug(page)).navigationPhase).toBe('coasting');
  await page.clock.runFor(250);
  expect(Math.abs((await debug(page)).navigationOffset)).toBeGreaterThan(plot.width * 1.2);
  await page.evaluate(() => {
    const deltas = window.__controlledCoastFrames = []; let previous = performance.now();
    function frame(now) { deltas.push(now - previous); previous = now; if (deltas.length < 20) requestAnimationFrame(frame); }
    requestAnimationFrame(frame);
  });
  await page.clock.runFor(350);
  const frames = await page.evaluate(() => window.__controlledCoastFrames);
  expect(frames).toHaveLength(20);
  const band = await page.locator('.overview-plot').boundingBox(), selected = await page.locator('.overview-window').boundingBox();
  expect(selected.x).toBeGreaterThanOrEqual(band.x - 1); expect(selected.x + selected.width).toBeLessThanOrEqual(band.x + band.width + 1);
  await expect(page.locator('.overview-count')).toContainText('rolling context');
  expect(await page.locator('.main-axis span').count()).toBeGreaterThan(1);
  const colors = await page.locator('.plot-wrap canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2'), pixels = new Uint8Array(canvas.width * canvas.height * 4), result = new Set();
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let i = 0; i < pixels.length; i += 16) result.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    return result.size;
  });
  expect(colors).toBeGreaterThan(1);
  await info.attach('coast-frames.json', { body: JSON.stringify({ clock: 'controlled', frameIntervalsMs: frames, performanceBenchmark: false }), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('coast-mobile.png'), fullPage: true });
  await page.mouse.click(x, y); await page.clock.resume(); await ready(page);
  expect((await debug(page)).domain).not.toEqual(before.domain); expect(errors).toEqual([]);
});

test('calendar time precision follows the visible scale and rapid day picks keep the last request', async ({ page }) => {
  await open(page);
  await page.locator('.range-button').click();
  await page.locator('#range-form [name=from]').fill('2026-09-12T10:00');
  await page.locator('#range-form [name=to]').fill('2026-09-12T10:01');
  await page.locator('#range-form [type=submit]').click(); await ready(page);
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await expect(page.getByLabel('Calendar center time / UTC', { exact: true })).toHaveAttribute('step', '1');
  await page.getByRole('button', { name: '2026-09-13', exact: true }).click();
  await page.getByRole('button', { name: '2026-09-14', exact: true }).click();
  await assertCenter(page, '2026-09-14T10:00:30Z');
  await page.keyboard.press('Escape');
  await expect(page.locator('.timeline-calendar')).toHaveCount(0);
});
