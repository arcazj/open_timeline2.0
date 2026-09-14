import { chromium, expect } from '@playwright/test';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { execFileSync } from 'node:child_process';

const root = path.resolve('C:/projects/openbexi_timeline');
const output = path.resolve('output/hazard-parity/legacy');
const focus = '2026-09-12T14:00:00.000Z';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { mode: 'original-renderer-with-read-only-request-fixture', focus, files: [], requests: [], errors: [], blocked: [] };
const records = [];
const filters = JSON.parse(await readFile(path.join(root, 'filters/default_filter_setting.json'), 'utf8'));
const sources = JSON.parse(execFileSync('.venv/Scripts/python.exe', ['-c', 'import json,yaml; print(json.dumps(yaml.safe_load(open(r"C:/projects/openbexi_timeline/yaml/sources_earthquake.yml"))["data_sources"]))'], { encoding: 'utf8' }));
filters.openbexi_timeline[0].sources = sources.filter(source => source.enable);
report.configuration = { filters: 'filters/default_filter_setting.json', sources: 'yaml/sources_earthquake.yml', mutation: 'Source definitions combined in response only; originals unchanged.' };
for (const source of ['earthquake', 'volcano']) for (const day of ['11', '12', '13']) {
  const directory = `C:/data/${source}/2026/09/${day}`;
  const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of names.filter(name => name.endsWith('.json')).sort()) {
    const filename = path.join(directory, name), raw = await readFile(filename), errors = [];
    const data = parse(raw.toString('utf8'), errors, { allowTrailingComma: true });
    if (errors.length || !Array.isArray(data.events)) throw new Error(`Invalid fixture: ${filename}`);
    report.files.push({ path: filename, sha256: hash(raw), records: data.events.length });
    records.push(...data.events);
  }
}
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'records.json'), JSON.stringify({ dateTimeFormat: 'iso8601', scene: 0, events: records }, null, 2));
const browser = await chromium.launch({ executablePath: process.env.OPENBEXI_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const page = await browser.newPage({ viewport: { width: 2040, height: 1200 }, timezoneId: 'UTC' });
report.console = [];
page.on('console', message => { if (report.console.length < 100) report.console.push(message.text()); });
await page.clock.setFixedTime(new Date(focus));
page.on('pageerror', error => report.errors.push(error.message));
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
await page.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.hostname !== '127.0.0.1' || url.port !== '8879') { report.blocked.push(request.url()); return route.abort(); }
  if (url.pathname.endsWith('/sessions')) {
    report.requests.push({ method: request.method(), query: Object.fromEntries(url.searchParams) });
    if (request.method() === 'POST' && url.searchParams.get('ob_request') === 'readFilters') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(filters) });
    if (request.method() !== 'GET') return route.fulfill({ status: 405, body: 'Read-only renderer comparison' });
    const from = Date.parse(url.searchParams.get('startDate')), to = Date.parse(url.searchParams.get('endDate'));
    const selected = records.filter(record => !Number.isFinite(from) || !Number.isFinite(to) || Date.parse(record.start) >= from && Date.parse(record.start) <= to);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ dateTimeFormat: 'iso8601', scene: 0, events: selected }) });
  }
  const filename = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!filename.startsWith(root + path.sep) || request.method() !== 'GET') return route.abort();
  try { const raw = await readFile(filename); await route.fulfill({ contentType: mime[path.extname(filename)] || 'application/octet-stream', body: raw }); }
  catch { await route.fulfill({ status: 404, body: 'Not found' }); }
});
try {
  await page.goto('https://127.0.0.1:8879/openbexi_timeline_earthquake.html');
  await expect.poll(() => page.evaluate(() => window.get_ob_timeline?.('ob_timeline_2')?.ob_scene?.[0]?.sessions?.events?.length || 0), { timeout: 30000 }).toBeGreaterThan(0);
  await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some(canvas => canvas.width > 100));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(output, 'legacy-hazard-initial.png'), fullPage: true });
  const reload = page.waitForResponse(response => response.url().includes('/sessions?startDate=') && !response.url().includes('current_time'));
  await page.locator('img[alt="No overview"]').click();
  await reload;
  await expect.poll(() => page.evaluate(() => window.get_ob_timeline('ob_timeline_2').ob_scene[0].bands.length)).toBe(2);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  report.overview = 'Enabled using the original overview menu control. Effective band state is recorded below; capture is renderer evidence, not backend certification.';
  report.state = await page.evaluate(() => {
    const timeline = window.get_ob_timeline('ob_timeline_2'), scene = timeline.ob_scene[0];
    return { name: timeline.name, width: scene.width, height: scene.height, date: timeline.params[0].date,
      minDate: scene.minDate, maxDate: scene.maxDate, records: scene.sessions.events.length,
      bands: scene.bands.map(band => ({ name: band.name, height: band.height, width: band.width, intervalPixels: band.intervalPixels, subIntervalPixels: band.subIntervalPixels, intervalUnit: band.intervalUnit, minDate: band.minDate, maxDate: band.maxDate,
        visibleFrom: timeline.pixelOffSetToDate(0, -scene.width / 2, band.gregorianUnitLengths, band.intervalPixels), visibleTo: timeline.pixelOffSetToDate(0, scene.width / 2, band.gregorianUnitLengths, band.intervalPixels) })) };
  });
  await page.screenshot({ path: path.join(output, 'legacy-hazard.png'), fullPage: true });
  report.status = report.errors.length ? 'renderer-errors' : 'captured';
} catch (error) {
  report.status = 'failed'; report.failure = error.message;
  await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true });
  throw error;
} finally {
  for (const file of report.files) if (hash(await readFile(file.path)) !== file.sha256) throw new Error('Source changed during comparison');
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
  await browser.close();
  process.stdout.write(JSON.stringify({ status: report.status, state: report.state, failure: report.failure, errors: report.errors }) + '\n');
}
