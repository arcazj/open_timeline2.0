import http from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { platform, cpus } from 'node:os';
import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const countIndex = process.argv.indexOf('--runs');
const runs = countIndex < 0 ? 3 : Number(process.argv[countIndex + 1]);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('--runs must be an integer from 1 to 10');
const hosted = process.argv.includes('--hosted');
const html = await readFile(path.join(root, 'artifacts/demo/index.html'));
const gzip = gzipSync(html, { level: 9 });
const output = path.join(root, 'artifacts/performance');
await mkdir(output, { recursive: true });
const server = http.createServer((request, response) => {
  if (request.url === '/open_timeline2.0/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip',
      'Content-Length': gzip.length, 'Cache-Control': 'no-store' });
    response.end(gzip);
  } else { response.writeHead(404); response.end('No backend on this static site'); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = hosted ? 'https://arcazj.github.io/open_timeline2.0/' : `http://127.0.0.1:${server.address().port}/open_timeline2.0/`;
const profiles = [
  { name: 'desktop', width: 1600, height: 900, cpuSlowdown: 1, latencyMs: 0, downloadMbps: null },
  { name: 'mobile-slow-4g', width: 390, height: 844, cpuSlowdown: 4, latencyMs: 150, downloadMbps: 1.6 },
];
const report = {
  format: 'openbexi-demo-startup-v1', measuredAt: new Date().toISOString(),
  scope: hosted ? 'Actual GitHub Pages site under browser emulation' : 'Loopback static host with gzip; not a live GitHub Pages measurement',
  localBundleSha256: createHash('sha256').update(html).digest('hex'), htmlBytes: html.length,
  gzipBytes: gzip.length, brotliBytes: brotliCompressSync(html).length,
  environment: { platform: platform(), logicalCpus: cpus().length }, profiles: [], status: 'running',
};
let browser;
try {
  browser = await chromium.launch(process.platform === 'win32' ? {
    executablePath: process.env.OPENBEXI_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--disable-features=msEdgeSidebarV2'],
  } : {});
  report.environment.browser = browser.version();
  for (const profile of profiles) {
    const result = { ...profile, samples: [] };
    report.profiles.push(result);
    for (let iteration = 0; iteration < runs; iteration++) {
      const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuSlowdown });
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latencyMs,
          downloadThroughput: profile.downloadMbps ? profile.downloadMbps * 1000000 / 8 : -1,
          uploadThroughput: profile.downloadMbps ? 750000 / 8 : -1 });
        await page.addInitScript(() => {
          const sample = () => {
            if (window.__timelineDebug?.ready) window.__firstTimelineReadyMs = performance.now();
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        if (response.status() !== 200) throw new Error(`Demo is not available: HTTP ${response.status()}`);
        await page.waitForFunction(() => window.__firstTimelineReadyMs !== undefined, undefined, { timeout: 120000 });
        const sample = await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0];
          const canvas = document.querySelector('.plot-wrap canvas'), gl = canvas.getContext('webgl2');
          const pixels = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const colors = new Set();
          for (let i = 0; i < pixels.length; i += 4) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
          return { readyMs: window.__firstTimelineReadyMs, domContentLoadedMs: nav.domContentLoadedEventEnd,
            firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
            transferBytes: nav.transferSize, encodedBodyBytes: nav.encodedBodySize, decodedBodyBytes: nav.decodedBodySize,
            canvasColors: colors.size, horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
            providerKind: window.__timelineDebug.providerKind, recordCount: window.__timelineDebug.recordCount };
        });
        if (sample.canvasColors < 9 || sample.horizontalOverflow || sample.providerKind !== 'local' || errors.length) {
          throw new Error(`Invalid rendered measurement: ${JSON.stringify({ ...sample, errors })}`);
        }
        const before = await page.evaluate(() => window.__timelineDebug.fromMs);
        const start = performance.now();
        await page.locator('.plot-wrap').focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(value => window.__timelineDebug.ready && window.__timelineDebug.fromMs !== value, before);
        sample.navigationRoundTripMs = performance.now() - start;
        result.samples.push(sample);
        if (iteration === runs - 1) await page.screenshot({ path: path.join(output, `demo-${profile.name}.png`) });
        console.log(`${profile.name} ${iteration + 1}/${runs}: ready ${(sample.readyMs / 1000).toFixed(2)} s; navigation ${sample.navigationRoundTripMs.toFixed(0)} ms`);
      } finally { await context.close(); }
    }
    const times = result.samples.map(sample => sample.readyMs).sort((a, b) => a - b);
    result.medianReadyMs = times[Math.floor(times.length / 2)];
    result.maxReadyMs = times.at(-1);
  }
  report.status = 'measured';
} catch (error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, hosted ? 'demo-startup-hosted.json' : 'demo-startup.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(`HTML ${(html.length / 1048576).toFixed(2)} MiB; gzip ${(gzip.length / 1048576).toFixed(2)} MiB. ${report.scope}`);
