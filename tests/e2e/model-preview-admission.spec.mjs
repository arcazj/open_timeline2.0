import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `import { createModelPreview } from './client/src/ui/model-preview.js'; import { createPreparationAdmission } from './client/src/data/preparation-admission.js'; Object.assign(window, { createModelPreview, createPreparationAdmission });`,
  resolveDir: process.cwd(), sourcefile: 'model-preview-admission-fixture.js' }, bundle: true, write: false, format: 'iife', minify: true,
  loader: { '.css': 'empty', '.png': 'dataurl' } });

test.beforeEach(async ({ page }) => {
  await page.setContent('<!doctype html><style>.plot{position:relative;width:420px;height:250px;overflow:hidden}.axis{position:relative;height:24px}.record-label-layer{position:absolute;inset:0}.record-label{position:absolute}</style><div id="host"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    const from = '2026-01-01T00:00:00.000Z', to = '2026-01-03T00:00:00.000Z';
    window.calls = []; window.previews = []; let queryCount = 0;
    window.provider = {
      createQuery: async () => { window.calls.push('query'); return { queryId: `query-${++queryCount}`, mapId: 'map' }; },
      getMap: async () => ({ mapId: 'map', mode: 'uniform', domain: { from, to }, knots: [{ timeMs: Date.parse(from), u: '0' }, { timeMs: Date.parse(to), u: '1' }] }),
      getZones: async () => ({ items: [] }),
      createLayout: async () => { window.calls.push('layout'); return { layoutId: 'layout', rowHeight: 32, detailTotal: 1 }; },
      getRows: async () => ({ items: [{ row: 0, xStart: 30, xEnd: 30, labelX: 40, labelWidth: 100, record: { id: 'event', title: 'Generic event', kind: 'event', start: from, render: { color: '#227788' } } }], rows: [], startRow: 0, endRow: 1, rowHeight: 32, loadedCount: 1 }),
      releaseQuery: async id => { window.calls.push(`release-query:${id}`); },
      releaseLayout: async id => { window.calls.push(`release-layout:${id}`); },
    };
    window.begin = beforePrepare => {
      const container = document.createElement('div'), axis = document.createElement('div');
      container.className = 'plot'; axis.className = 'axis'; document.querySelector('#host').append(container, axis);
      const preview = window.createModelPreview({ provider: window.provider, generation: 'generation', isCurrent: () => true, container, axis,
        domain: { from, to }, fromMs: String(Date.parse(from)), toMs: String(Date.parse(to)), filters: {}, search: '', beforePrepare,
        definition: { scaleMode: 'uniform', ratio: 4, bins: 64, rowHeight: 32, fontSize: 13, displayUnit: 'DAY', timeZone: 'UTC', theme: 'light', groupBy: 'none' } });
      preview.outcome = preview.ready.then(value => ({ value }), error => ({ error: error.name, message: error.message }));
      window.previews.push(preview); return preview;
    };
  });
});

test.afterEach(async ({ page }) => { await page.evaluate(async () => { window.finishRelease?.(); window.releaseBlocker?.(); await Promise.all(window.previews.map(preview => preview.dispose())); }); });

test('model preparation releases its lease after an actual rendered success', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const preview = window.begin(async () => { window.calls.push('admit'); return () => window.calls.push('unlock'); });
    return preview.outcome;
  });
  expect(outcome.error).toBeUndefined();
  await expect.poll(() => page.evaluate(() => window.calls)).toEqual(['admit', 'query', 'layout', 'unlock']);
  await expect(page.locator('[data-preview-state="ready"] canvas')).toHaveCount(1);
});

test('model provider failure cleans its owned query before releasing admission', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    window.provider.createLayout = async () => { window.calls.push('failed-layout'); throw new Error('Fixture layout failure'); };
    return window.begin(async () => { window.calls.push('admit'); return () => window.calls.push('unlock'); }).outcome;
  });
  expect(outcome.message).toBe('Fixture layout failure');
  await expect.poll(() => page.evaluate(() => window.calls)).toEqual(['admit', 'query', 'failed-layout', 'release-query:query-1', 'unlock']);
});

test('disposing a queued preview cancels its admission without waiting for the foreground lease', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const gate = window.createPreparationAdmission(); window.releaseBlocker = await gate.acquire();
    const preview = window.begin(options => gate.acquire(options));
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    const queued = gate.pendingCount;
    await preview.dispose();
    return { queued, remaining: gate.pendingCount, outcome: await preview.outcome, calls: window.calls };
  });
  expect(result).toEqual({ queued: 2, remaining: 1, outcome: { error: 'AbortError', message: 'Preview canceled' }, calls: [] });
});

test('replacement preview completes previous disposal before requesting its own admission', async ({ page }) => {
  await page.evaluate(async () => {
    const first = window.begin(async () => () => {}); await first.ready;
    window.provider.releaseQuery = async id => { window.calls.push(`disposing:${id}`); await new Promise(resolve => { window.finishRelease = resolve; }); window.calls.push('disposed'); };
    window.second = window.begin(async () => { window.calls.push('admit-second'); return () => window.calls.push('unlock-second'); });
  });
  await expect.poll(() => page.evaluate(() => window.calls.includes('disposing:query-1'))).toBe(true);
  expect(await page.evaluate(() => window.calls.includes('admit-second'))).toBe(false);
  await page.evaluate(async () => { window.finishRelease(); window.provider.releaseQuery = async () => {}; await window.second.ready; });
  await expect.poll(() => page.evaluate(() => window.calls.includes('unlock-second'))).toBe(true);
  const calls = await page.evaluate(() => window.calls);
  expect(calls.indexOf('disposed')).toBeLessThan(calls.indexOf('admit-second'));
});
