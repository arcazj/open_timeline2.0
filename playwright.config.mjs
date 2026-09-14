import { defineConfig } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export default defineConfig({
  metadata: { standaloneBundleSha256: createHash('sha256').update(readFileSync(new URL('./dist/index.html', import.meta.url))).digest('hex') },
  testDir: './tests/e2e', testIgnore: ['demo.spec.mjs'], timeout: 30000, expect: { timeout: 10000 },
  fullyParallel: false, workers: 1, retries: 0,
  outputDir: 'artifacts/browser/results',
  reporter: [['list'], ['json', { outputFile: 'artifacts/browser/results.json' }]],
  use: {
    viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1,
    launchOptions: process.platform === 'win32' ? {
      executablePath: process.env.OPENBEXI_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      args: ['--disable-features=msEdgeSidebarV2'],
    } : {},
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
});
