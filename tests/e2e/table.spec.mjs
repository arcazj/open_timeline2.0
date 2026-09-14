import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { startServer } from '../integration/server-fixture.mjs';

const fixture = JSON.parse(await readFile('shared/fixtures/initial-snapshot.json', 'utf8'));
let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });
const table = page => page.locator('.table-view');
const rows = page => table(page).locator('tbody tr');
const rowIds = page => rows(page).evaluateAll(nodes => nodes.map(node => node.dataset.recordId));

async function open(page, mode = 'local') {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(server.baseUrl); await expect(page.locator('.record-label').first()).toBeVisible();
  if (mode === 'server') {
    await page.locator('[data-action=sources]').first().click();
    await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl);
    await page.locator('#server-form [name=token]').fill(server.token);
    await page.locator('#server-form [type=submit]').click();
    await page.locator('#switch-source').click();
    await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('server');
  }
  await page.locator('[data-view=table]').click();
  await expect(table(page).locator('.table-caption')).toContainText('48 records');
  return errors;
}
async function settled(page, count) {
  await expect(table(page)).toHaveAttribute('aria-busy', 'false');
  if (count !== undefined) await expect(rows(page)).toHaveCount(count);
}
async function narrowRange(page) {
  await page.locator('[data-action=range]').first().click();
  await page.locator('#range-form [name=from]').fill('2026-09-12T10:00');
  await page.locator('#range-form [name=to]').fill('2026-09-12T13:00');
  await page.locator('#range-form [type=submit]').click();
  await expect(page.locator('#range-form')).toHaveCount(0);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
}
function inNarrowWindow(record) {
  const start = Date.parse(record.start), end = record.end === null ? Infinity : Date.parse(record.end);
  const from = Date.parse('2026-09-12T10:00:00.000Z'), to = Date.parse('2026-09-12T13:00:00.000Z');
  return record.kind === 'event' || start === end ? start >= from && start < to : start < to && end > from;
}
async function csv(page) {
  const downloaded = page.waitForEvent('download');
  await table(page).locator('[data-table-action=export]').click();
  const download = await downloaded, content = await readFile(await download.path());
  const python = path.resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const parsed = execFileSync(python, ['-c', 'import csv,io,json,sys; print(json.dumps(list(csv.reader(io.StringIO(sys.stdin.buffer.read().decode("utf-8-sig"), newline="")))))'], { input: content, encoding: 'utf8' });
  return { rows: JSON.parse(parsed), name: download.suggestedFilename() };
}

for (const mode of ['local', 'server']) {
  test(`${mode} Table browses all canonical records with global sorting and independent time scope`, async ({ page }, info) => {
    const errors = await open(page, mode);
    const original = await page.evaluate(() => window.__timelineDebug);
    await table(page).locator('[data-table-limit]').selectOption('25'); await settled(page, 25);
    const first = await rowIds(page);
    await table(page).locator('[data-table-action=next]').click();
    await expect(table(page).locator('.table-pagination')).toContainText('Records 26-48 of 48'); await settled(page, 23);
    const second = await rowIds(page);
    expect(new Set([...first, ...second]).size).toBe(48);
    expect([...first, ...second].sort()).toEqual(fixture.records.map(record => record.id).sort());
    await table(page).locator('[data-table-sort=title]').click(); await settled(page, 25);
    const ascending = [...fixture.records].sort((a, b) => a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : 1);
    expect(await rowIds(page)).toEqual(ascending.slice(0, 25).map(record => record.id));
    await table(page).locator('[data-table-sort=title]').click(); await settled(page, 25);
    expect(await rowIds(page)).toEqual([...ascending].reverse().slice(0, 25).map(record => record.id));
    const afterSort = await page.evaluate(() => window.__timelineDebug);
    expect(afterSort.fromMs).toBe(original.fromMs); expect(afterSort.toMs).toBe(original.toMs);
    await narrowRange(page);
    await table(page).locator('[data-table-scope]').selectOption('window');
    await table(page).locator('[data-table-limit]').selectOption('100');
    const expected = fixture.records.filter(inNarrowWindow);
    await expect(table(page).locator('.table-caption')).toContainText(`${expected.length} records`); await settled(page, expected.length);
    expect((await rowIds(page)).sort()).toEqual(expected.map(record => record.id).sort());
    await table(page).locator('[data-table-scope]').selectOption('all'); await settled(page, 48);
    await page.screenshot({ path: info.outputPath(`table-${mode}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });

  test(`${mode} Table search projection and CSV keep full scope distinct from the current page`, async ({ page }) => {
    const errors = await open(page, mode);
    await table(page).locator('[data-table-limit]').selectOption('25'); await settled(page, 25);
    const allCsv = await csv(page);
    expect(allCsv.rows).toHaveLength(49);
    expect(allCsv.rows.slice(1).map(row => row[0]).sort()).toEqual(fixture.records.map(record => record.id).sort());
    await page.locator('#search').fill('signal');
    const expected = fixture.records.filter(record => record.title.toLowerCase().includes('signal'));
    await expect(table(page).locator('.table-caption')).toContainText(`${expected.length} search findings`);
    await table(page).locator('[data-table-limit]').selectOption('100'); await settled(page, 48);
    await expect(table(page).locator('.table-match')).toHaveCount(expected.length);
    await table(page).locator('[data-table-projection]').selectOption('matches'); await settled(page, expected.length);
    expect((await rowIds(page)).sort()).toEqual(expected.map(record => record.id).sort());
    const matchingCsv = await csv(page);
    expect(matchingCsv.rows.slice(1).map(row => row[0]).sort()).toEqual(expected.map(record => record.id).sort());
    await page.locator('#search').fill('');
    await table(page).locator('[data-table-projection]').selectOption('context'); await settled(page, 48);
    await page.locator('[data-action=create]').click();
    await page.locator('#record-form [name=title]').fill('=SUM(1,2)');
    await page.locator('#record-form [type=submit]').click();
    await expect(page.locator('#record-form')).toHaveCount(0); await settled(page, 49);
    const protectedCsv = await csv(page);
    expect(protectedCsv.rows).toHaveLength(50);
    expect(protectedCsv.rows.find(row => row[1].includes('SUM'))[1]).toBe("'=SUM(1,2)");
    expect(errors).toEqual([]);
  });
}

test('Local CSV walks more than one provider page and exports every canonical ID exactly once', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    let workerCount = 0;
    window.__tableImportGate = { armed: false, held: false, release: null };
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); this.imported = workerCount++ > 0; }
      postMessage(message, ...rest) {
        const gate = window.__tableImportGate;
        if (this.imported && gate.armed && message.type === 'request' && message.method === 'createQuery') {
          gate.held = true;
          gate.release = () => { gate.armed = false; gate.held = false; super.postMessage(message, ...rest); };
          return;
        }
        return super.postMessage(message, ...rest);
      }
    };
  });
  const errors = await open(page);
  const snapshot = structuredClone(fixture), base = snapshot.records.find(record => record.kind === 'event');
  snapshot.records = Array.from({ length: 1101 }, (_, index) => ({ ...structuredClone(base), id: randomUUID(), title: `Export record ${String(index).padStart(4, '0')}`, parentSessionId: null, order: index }));
  snapshot.manifest.recordCount = 1101; snapshot.manifest.generation = randomUUID(); snapshot.manifest.bundleId = randomUUID(); delete snapshot.manifest.contentSha256;
  await page.evaluate(() => { window.__tableImportGate.armed = true; });
  await page.locator('[data-action=sources]').first().click();
  await page.locator('#json-file').setInputFiles({ name: 'table-export-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
  await expect(page.locator('#json-file')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__tableImportGate.held)).toBe(true);
  const transitioning = await page.evaluate(() => window.__timelineDebug);
  expect(transitioning.layoutId).toBeUndefined();
  expect(transitioning.loadedCount).toBeGreaterThan(0);
  for (const view of ['timeline', 'split', 'table']) {
    await page.locator(`[data-view=${view}]`).click();
    await expect(page.locator('.row-count')).toHaveText(view === 'table' ? 'Loading table' : 'Loading timeline');
    await expect(page.locator('.record-count')).toBeEmpty();
    await expect(page.locator('.overview-count')).toBeEmpty();
    await expect(page.locator('.app-footer [data-action=previous]')).toBeDisabled();
    await expect(page.locator('.app-footer [data-action=next]')).toBeDisabled();
  }
  expect(errors).toEqual([]);
  await page.evaluate(() => window.__tableImportGate.release());
  await expect(table(page).locator('.table-caption')).toContainText('1101 records');
  const exported = await csv(page);
  expect(exported.rows).toHaveLength(1102);
  expect(new Set(exported.rows.slice(1).map(row => row[0])).size).toBe(1101);
  expect(exported.rows.slice(1).map(row => row[0]).sort()).toEqual(snapshot.records.map(record => record.id).sort());
  expect(errors).toEqual([]);
});

test('Table keyboard sorting and selection preserve focus without changing time', async ({ page }) => {
  const errors = await open(page);
  const sort = table(page).locator('[data-table-sort=title]'); await sort.focus(); await sort.press('Enter'); await settled(page, 48);
  await expect(sort).toBeFocused();
  const row = rows(page).first(), id = await row.getAttribute('data-record-id'), before = await page.evaluate(() => window.__timelineDebug);
  await row.focus(); await row.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.selectedId)).toBe(id);
  await expect(table(page).locator(`tr[data-record-id="${id}"]`)).toBeFocused();
  expect((await page.evaluate(() => window.__timelineDebug)).fromMs).toBe(before.fromMs);
  expect(errors).toEqual([]);
});

test('narrow Table and Split retain reachable controls, a scrollable table, and a correctly framed overview', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await open(page);
  await table(page).locator('[data-table-limit]').selectOption('25'); await settled(page, 25);
  await table(page).locator('[data-table-action=next]').click(); await settled(page, 23);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: info.outputPath('table-mobile.png'), fullPage: true });
  await page.locator('[data-view=split]').click();
  await expect(page.locator('.overview-plot canvas')).toBeVisible();
  await expect(table(page)).toBeVisible();
  await expect.poll(() => table(page).locator('.table-scroll').evaluate(node => node.clientHeight)).toBeGreaterThan(20);
  await expect.poll(() => page.locator('.overview-plot').evaluate(node => Math.abs(node.querySelector('canvas').getBoundingClientRect().height - node.clientHeight))).toBeLessThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: info.outputPath('table-split-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});
