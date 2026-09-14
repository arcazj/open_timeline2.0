import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const input = path.resolve('output/local-paths-production-range.json');
const output = path.resolve('docs/ui/local-source-paths/production');
const snapshot = JSON.parse(await readFile(input, 'utf8'));
if (!snapshot.manifest.legacy?.readOnly) throw new Error('This capture requires a read-only legacy snapshot.');
await mkdir(output, { recursive: true });
const browser = await chromium.launch(process.platform === 'win32' ? {
  executablePath: process.env.OPENBEXI_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
} : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const report = { capturedAt: new Date().toISOString(), snapshot: input,
  htmlSha256: createHash('sha256').update(await readFile('dist/index.html')).digest('hex'),
  records: snapshot.records.length, captures: [], errors: [] };
page.on('pageerror', error => report.errors.push(error.message));
page.setDefaultTimeout(60000);
const ready = async () => {
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await expect.poll(() => page.locator('.plot-wrap').evaluate(node =>
    Math.abs(node.querySelector('canvas').width / Math.min(devicePixelRatio, 2) - node.clientWidth))).toBeLessThan(1);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await expect(page.locator('.record-label').first()).toBeVisible();
};
async function range(from, to) {
  await page.locator('.range-button').click();
  await page.locator('#range-form [name=from]').fill(from);
  await page.locator('#range-form [name=to]').fill(to);
  await page.locator('#range-form [type=submit]').click(); await ready();
}
async function capture(name) {
  await ready();
  const result = await page.evaluate(() => {
    const plot = document.querySelector('.plot-wrap').getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.plot-wrap .record-label')].map(node => node.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (Math.min(a.right, b.right, plot.right) - Math.max(a.left, b.left, plot.left) > .5
          && Math.min(a.bottom, b.bottom, plot.bottom) - Math.max(a.top, b.top, plot.top) > .5) overlaps++;
    }
    const colors = [...document.querySelectorAll('.plot-wrap canvas,.overview-plot canvas')].map(canvas => {
      const gl = canvas.getContext('webgl2'), bytes = new Uint8Array(canvas.width * canvas.height * 4), values = new Set();
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      for (let i = 0; i < bytes.length; i += 16) values.add(bytes[i] * 65536 + bytes[i + 1] * 256 + bytes[i + 2]);
      return values.size;
    });
    return { state: window.__timelineDebug, overlaps, colors,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      status: document.querySelector('.save-status').textContent };
  });
  expect(result.overlaps).toBe(0); expect(result.horizontalOverflow).toBe(false);
  expect(result.status).toContain('Read-only'); expect(result.state.providerKind).toBe('local');
  for (const count of result.colors) expect(count).toBeGreaterThan(1);
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  report.captures.push({ name, ...result });
}
try {
  await page.goto(pathToFileURL(path.resolve('dist/index.html')).href); await ready();
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#json-file').setInputFiles(input);
  await expect(page.locator('.save-status')).toContainText('Read-only'); await ready();
  await page.locator('#grouping-mode').selectOption('all'); await ready();
  await range('2024-03-17T00:00', '2024-03-25T00:00');
  await page.getByLabel('Auto scale', { exact: true }).check(); await ready();
  await capture('combined-range');
  await page.locator('#grouping-mode').selectOption('namespace'); await ready();
  await capture('namespace-range');
  await range('2024-03-18T19:00', '2024-03-18T22:00');
  await capture('source2-detail');
  await range('2024-03-24T19:00', '2024-03-24T22:00');
  await capture('source1-detail');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('source1-mobile');
  expect(report.errors).toEqual([]); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.message;
  await page.screenshot({ path: path.join(output, 'capture-failed.png'), fullPage: true });
  throw error;
} finally {
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  process.stdout.write(JSON.stringify({ status: report.status, captures: report.captures.length, output }) + '\n');
}
