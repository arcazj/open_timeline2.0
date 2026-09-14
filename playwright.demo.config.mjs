import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: ['demo.spec.mjs'],
  outputDir: 'artifacts/browser/demo',
  reporter: [['list'], ['json', { outputFile: 'artifacts/browser/demo.json' }]],
});
