import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';

export default defineConfig({
  ...base,
  testMatch: ['standalone.spec.mjs', 'configuration-apply.spec.mjs', 'test-data.spec.mjs'],
  outputDir: 'artifacts/browser/matrix',
  reporter: [['list'], ['json', { outputFile: 'artifacts/browser/matrix.json' }]],
  use: { ...base.use, launchOptions: {} },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox', headless: process.platform !== 'linux' } },
    ...(process.platform === 'win32' ? [{ name: 'edge', use: { browserName: 'chromium', launchOptions: base.use.launchOptions } }] : []),
  ],
});
