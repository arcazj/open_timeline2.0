import { test, expect } from '@playwright/test';
import { startServer } from '../integration/server-fixture.mjs';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { pointerRecordTime } from '../../client/src/ui/record-time-edit.js';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

let server, remote, records;
test.beforeEach(async () => {
  server = await startServer(); remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token }); await remote.initialize();
  records = {};
  for (const [key, payload] of Object.entries({
    session: { title: 'Gesture calibration session', kind: 'session', start: '2026-09-12T09:00:00.000Z', end: '2026-09-12T11:00:00.000Z' },
    point: { title: 'Gesture calibration point', kind: 'event', start: '2026-09-12T09:30:00.000Z', end: null },
    ongoing: { title: 'Gesture ongoing watch', kind: 'session', start: '2026-09-12T10:00:00.000Z', end: null },
  })) records[key] = (await remote.executeCommand({ type: 'create', generation: remote.metadata.generation, clientCommandId: crypto.randomUUID(), payload: { ...payload, sourceId: 'operations' } })).record;
});
test.afterEach(async () => { remote?.dispose(); await server?.stop(); });
async function ready(page) {
  await expect.poll(() => page.evaluate(() => !!window.__timelineDebug?.queryId)).toBe(true); await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await expect.poll(() => page.locator('.plot-wrap').evaluate(plot => Math.abs(plot.clientWidth - plot.querySelector('canvas').getBoundingClientRect().width))).toBeLessThan(1);
  await expect.poll(() => page.evaluate(() => { const view = window.__timelineDebug, plot = document.querySelector('.plot-wrap'); return Math.abs(view.layoutWidth - plot.clientWidth) < 1 && view.pageCapacity === Math.max(1, Math.floor((plot.clientHeight - 52) / view.effectiveRowHeight)); })).toBe(true);
}
async function connect(page) {
  await ready(page); const prior = await page.evaluate(() => window.__timelineDebug.providerId);
  await page.locator('[data-action=sources]').first().click(); await page.locator('#server-form [name=baseUrl]').fill(server.baseUrl); await page.locator('#server-form [name=token]').fill(server.token);
  await page.locator('#server-form [type=submit]').click(); await page.locator('#switch-source').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerId)).not.toBe(prior); await ready(page);
}
async function open(page) {
  const errors = [], writes = []; page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  page.on('request', request => { if (/\/records\/[^/?]+$/.test(new URL(request.url()).pathname) && ['PATCH', 'PUT', 'DELETE'].includes(request.method())) writes.push({ method: request.method(), key: request.headers()['idempotency-key'], body: request.postDataJSON() }); });
  await page.goto(server.baseUrl); await connect(page); return { errors, writes };
}
const label = (page, record) => page.locator(`.record-label[data-record-id="${record.id}"]`);
async function select(page, record) { await label(page, record).click(); await expect(page.locator('[data-action=time-edit]')).toBeEnabled(); await ready(page); }
async function editMode(page) { await page.locator('[data-time-mode=edit]').click(); await expect(page.locator('[data-time-mode=edit]')).toHaveAttribute('aria-pressed', 'true'); }
async function recordVersion(record, version) { await expect.poll(async () => (await remote.getRecord(record.id)).version).toBe(version); return remote.getRecord(record.id); }
async function drag(page, node, dx, { cancel = null, returnToOrigin = false } = {}) {
  const box = await node.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y, { steps: 3 });
  if (returnToOrigin) await page.mouse.move(x, y, { steps: 2 });
  if (cancel === 'Escape') await page.keyboard.press('Escape');
  else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  else if (cancel) await page.locator('.plot-wrap').dispatchEvent(cancel, { pointerId: 1 });
  await page.mouse.up(); return { x, y };
}

test('Navigate pans record labels, bars, background and zone areas without record writes', async ({ page }) => {
  const { errors, writes } = await open(page);
  expect(await page.evaluate(() => window.__timelineDebug.interactionMode)).toBe('navigate');
  for (const target of [() => label(page, records.session), () => page.locator(`.record-hit[data-record-id="${records.session.id}"]`)]) {
    const before = await page.evaluate(() => window.__timelineDebug.fromMs); await drag(page, target(), 20); await expect.poll(() => page.evaluate(() => window.__timelineDebug.fromMs)).not.toBe(before); await ready(page);
  }
  const plot = await page.locator('.plot-wrap').boundingBox();
  for (const y of [plot.y + 10, plot.y + plot.height - 12]) { const before = await page.evaluate(() => window.__timelineDebug.fromMs); await page.mouse.move(plot.x + 180, y); await page.mouse.down(); await page.mouse.move(plot.x + 200, y); await page.mouse.up(); await expect.poll(() => page.evaluate(() => window.__timelineDebug.fromMs)).not.toBe(before); await ready(page); }
  expect(writes).toEqual([]); expect((await remote.getRecord(records.session.id)).version).toBe(1); expect(errors).toEqual([]);
});

for (const adaptive of [false, true]) test(`${adaptive ? 'Adaptive' : 'Uniform'} move and finite edge drags use frozen inverse times and one versioned PATCH each`, async ({ page }, info) => {
  const { errors, writes } = await open(page); await select(page, records.session);
  if (adaptive) { await page.locator('#auto-scale').check(); await ready(page); }
  await editMode(page);
  let record = records.session;
  for (const [operation, dx] of [['move', 42], ['start', -18], ['end', 22]]) {
    const node = operation === 'move' ? page.locator(`.record-hit[data-record-id="${record.id}"]`) : page.locator(`.record-time-handle[data-time-operation=${operation}]`);
    await expect(node).toBeVisible();
    const debug = await page.evaluate(() => window.__timelineDebug), map = await remote.getMap(debug.queryId, debug.mapId), plot = await page.locator('.plot-wrap').boundingBox(), box = await node.boundingBox();
    const grab = box.x + box.width / 2 - plot.x, expected = pointerRecordTime(record, operation, { map, fromMs: debug.fromMs, toMs: debug.toMs, width: plot.width }, grab, grab + dx).payload;
    await drag(page, node, dx); const updated = await recordVersion(record, record.version + 1); await ready(page);
    expect(updated.start).toBe(expected.start); expect(updated.end).toBe(expected.end);
    if (operation === 'move') expect(Date.parse(updated.end) - Date.parse(updated.start)).toBe(Date.parse(record.end) - Date.parse(record.start));
    expect(await page.evaluate(() => ({ from: window.__timelineDebug.fromMs, to: window.__timelineDebug.toMs }))).toEqual({ from: debug.fromMs, to: debug.toMs });
    record = updated;
  }
  expect(writes).toHaveLength(3); expect(new Set(writes.map(write => write.key)).size).toBe(3); expect(writes.every(write => write.method === 'PATCH')).toBe(true); expect(errors).toEqual([]);
  const collisions = await page.locator('.plot-wrap').evaluate(plot => [...plot.querySelectorAll('.record-time-handle')].flatMap(handle => {
    const box = handle.getBoundingClientRect(); return [...plot.querySelectorAll('.record-label')].filter(label => { const text = label.getBoundingClientRect(); return Math.min(box.right, text.right) - Math.max(box.left, text.left) > 0.1 && Math.min(box.bottom, text.bottom) - Math.max(box.top, text.top) > 0.1; }).map(label => label.dataset.recordId);
  })); expect(collisions).toEqual([]);
  await expect(page.locator('.toast')).toHaveCount(0); await page.screenshot({ path: info.outputPath(`record-time-${adaptive ? 'adaptive' : 'uniform'}.png`) });
});

test('subthreshold, zero-date return, Escape, cancel, lost capture and focus loss send no commands', async ({ page }) => {
  const { errors, writes } = await open(page); await select(page, records.session); await editMode(page);
  const hit = () => page.locator(`.record-hit[data-record-id="${records.session.id}"]`);
  await drag(page, hit(), 3); await drag(page, hit(), 20, { returnToOrigin: true });
  for (const cancel of ['Escape', 'pointercancel', 'lostpointercapture', 'blur']) { await drag(page, hit(), 24, { cancel }); await expect(page.locator('.record-time-ghost')).toHaveCount(0); }
  expect(writes).toEqual([]); expect((await remote.getRecord(records.session.id)).version).toBe(1); expect(errors).toEqual([]);
  await drag(page, hit(), 4); await recordVersion(records.session, 2); expect(writes).toHaveLength(1);
});

test('precise keyboard movement preserves points and explicitly closes ongoing sessions on mobile', async ({ page }, info) => {
  const { errors, writes } = await open(page); await select(page, records.point); await editMode(page);
  await label(page, records.point).focus(); await page.keyboard.press('e');
  await page.locator('#record-time-form [name=unit]').selectOption('1'); await page.locator('#record-time-form [name=offset]').fill('125');
  await page.locator('#record-time-form [type=submit]').click(); const updated = await recordVersion(records.point, 2); expect(updated.start).toBe('2026-09-12T09:30:00.125Z'); expect(updated.end).toBeNull(); expect(updated.kind).toBe('event');
  await ready(page); await select(page, records.ongoing); await page.setViewportSize({ width: 390, height: 844 }); await ready(page);
  await page.locator('[data-action=close-session]').click(); await page.locator('#record-time-form [name=time]').fill('2026-09-12T14:01:02.003');
  await expect(page.locator('#record-time-form [type=submit]')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: info.outputPath('record-time-mobile.png') });
  await page.locator('#record-time-form [type=submit]').click(); const closed = await recordVersion(records.ongoing, 2); expect(closed.start).toBe(records.ongoing.start); expect(closed.end).toBe('2026-09-12T14:01:02.003Z');
  expect(writes).toHaveLength(2); expect(errors).toEqual([]);
});

for (const delayedStatus of [200, 404]) test(`stale gesture retains proposed times and child selection survives a delayed ${delayedStatus} parent refresh`, async ({ page }) => {
  const child = (await remote.executeCommand({ type: 'create', generation: remote.metadata.generation, clientCommandId: crypto.randomUUID(), payload: { kind: 'event', title: 'Child outside parent', start: '2026-09-12T11:15:00.000Z', end: null, sourceId: 'operations', parentSessionId: records.session.id } })).record;
  const { errors, writes } = await open(page); await select(page, records.session); await editMode(page);
  await remote.executeCommand({ type: 'update', recordId: records.session.id, expectedVersion: 1, generation: remote.metadata.generation, clientCommandId: crypto.randomUUID(), payload: { title: 'Server changed before drag' } });
  await drag(page, page.locator(`.record-hit[data-record-id="${records.session.id}"]`), 25);
  await expect(page.locator('#record-time-form .form-error')).toBeVisible(); await expect(page.locator('#record-time-form [name=operation]')).toHaveValue('exact');
  expect(writes).toHaveLength(1); expect((await remote.getRecord(records.session.id)).version).toBe(2); expect((await remote.getRecord(child.id)).version).toBe(1);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  await page.route(`**/records/${records.session.id}`, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(); enter(); await held;
    if (delayedStatus === 404) await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'record_not_found', message: 'Record is no longer available.' }) });
    else await route.fulfill({ response });
  });
  try {
    await page.locator('#cancel-time-edit').click(); await page.locator('[data-action=refresh]').first().click(); await entered; await ready(page); await select(page, child);
    await expect(page.locator('.descriptor h3')).toHaveText(child.title);
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('.change-reload')).toBeEnabled();
    await expect(page.locator('.descriptor h3')).toHaveText(child.title);
    await expect(page.locator('.record-time-warning')).toContainText('Outside parent time extent'); expect(errors).toEqual([]);
  } finally { release(); }
});

test('lost gesture reply survives reload and resolves with original GET only', async ({ page }) => {
  const { errors, writes } = await open(page); await select(page, records.session); await editMode(page);
  await page.route(`**/records/${records.session.id}`, async route => { if (route.request().method() !== 'PATCH') return route.continue(); const result = await route.fetch(); expect(result.status()).toBe(200); await route.fulfill({ status: 200, contentType: 'application/json', body: '{unknown' }); });
  await drag(page, page.locator(`.record-hit[data-record-id="${records.session.id}"]`), 35);
  await expect(page.locator('#record-time-form .outcome-check')).toBeVisible(); await expect(page.locator('[data-time-mode=edit]')).toBeDisabled();
  const identities = await page.evaluate(() => JSON.parse(localStorage.getItem('openbexi:record-command-recovery:v1'))); expect(identities[0].clientCommandId).toBe(writes[0].key); expect(JSON.stringify(identities)).not.toContain(records.session.title);
  await page.reload(); await connect(page); await page.locator('.record-recovery-banner button').click(); await page.locator('.record-recovery .record-outcome-check').click();
  await expect(page.locator('.record-recovery-message')).toContainText('original write committed'); expect((await remote.getRecord(records.session.id)).version).toBe(2); expect(writes).toHaveLength(1); expect(errors).toEqual([]);
});

test('fresh source policy rejects a stale writable affordance before any record request', async ({ page }) => {
  const { errors, writes } = await open(page); await select(page, records.session); await editMode(page);
  const source = (await remote.getConfiguration('sources', records.session.sourceId)).resource;
  const draft = await remote.mutateConfiguration({ family: 'sources', type: 'update', resourceId: source.id, generation: remote.metadata.generation, expectedRevision: source.revision, clientCommandId: crypto.randomUUID(), payload: { draft: { ...source.versions.at(-1).definition, writable: false } } });
  await remote.mutateConfiguration({ family: 'sources', type: 'publish', resourceId: source.id, generation: remote.metadata.generation, expectedRevision: draft.resource.revision, clientCommandId: crypto.randomUUID(), payload: {} });
  await drag(page, page.locator(`.record-hit[data-record-id="${records.session.id}"]`), 30);
  await expect(page.locator('#record-time-form .form-error')).toContainText('does not permit'); expect(writes).toEqual([]); expect((await remote.getRecord(records.session.id)).version).toBe(1); expect(errors).toEqual([]);
});

test('closing precise time draft during permission preflight cancels its undispatched mutation', async ({ page }) => {
  const { errors, writes } = await open(page); await select(page, records.session); await page.locator('[data-action=time-edit]').click(); await page.locator('#record-time-form [name=offset]').fill('2');
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/v1/workspaces/default', async route => { const response = await route.fetch(); enter(); await held; await route.fulfill({ response }); });
  try { await page.locator('#record-time-form [type=submit]').click(); await entered; await page.locator('#cancel-time-edit').click(); release(); await page.unrouteAll({ behavior: 'wait' }); await expect(page.locator('#record-time-form')).toHaveCount(0); expect(writes).toEqual([]); expect((await remote.getRecord(records.session.id)).version).toBe(1); expect(errors).toEqual([]); }
  finally { release(); }
});

test('mode changes, layout replacement and explicit source import cancel active drags', async ({ page }) => {
  const { errors, writes } = await open(page); await select(page, records.session); await editMode(page);
  const begin = async () => { const box = await page.locator(`.record-hit[data-record-id="${records.session.id}"]`).boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2); await expect(page.locator('.record-time-ghost')).toHaveCount(1); };
  await begin(); await page.locator('[data-time-mode=navigate]').dispatchEvent('click'); await page.mouse.up(); await expect(page.locator('.record-time-ghost')).toHaveCount(0);
  await editMode(page); await begin(); await page.setViewportSize({ width: 1500, height: 900 }); await ready(page); await page.mouse.up(); await expect(page.locator('.record-time-ghost')).toHaveCount(0);
  await begin(); const oldRow = await page.evaluate(() => window.__timelineDebug.startRow); await page.locator('[data-action=next]').dispatchEvent('click'); await expect.poll(() => page.evaluate(() => window.__timelineDebug.startRow)).not.toBe(oldRow); await page.mouse.up(); await expect(page.locator('.record-time-ghost')).toHaveCount(0); await page.locator('[data-action=previous]').click(); await expect.poll(() => page.evaluate(() => window.__timelineDebug.startRow)).toBe(oldRow); await ready(page);
  await begin(); const snapshot = await remote.exportSnapshot(); await page.locator('[data-action=sources]').first().dispatchEvent('click');
  await page.locator('#json-file').setInputFiles({ name: 'Explicit local replacement.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerKind)).toBe('local'); await ready(page); await page.mouse.up();
  await expect(page.locator('.record-time-ghost')).toHaveCount(0); expect(await page.evaluate(() => window.__timelineDebug.interactionMode)).toBe('navigate'); expect(writes).toEqual([]); expect((await remote.getRecord(records.session.id)).version).toBe(1); expect(errors).toEqual([]);
});

test('offline Local touch threshold and DPR2 time edits export canonical JSON without HTTP writes', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); const page = await context.newPage(), errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept()); page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && request.url().startsWith('http')) writes.push(request.url()); });
  try {
    await page.goto(pathToFileURL(path.resolve('dist/index.html')).href); await ready(page);
    const prior = await page.evaluate(() => window.__timelineDebug.providerId);
    await page.locator('[data-action=settings]').click(); await page.locator('#source-command').click(); await page.locator('#json-file').setInputFiles({ name: 'Touch snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(await remote.exportSnapshot())) }); await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerId)).not.toBe(prior); await ready(page); await editMode(page);
    const touch = await context.newCDPSession(page);
    const gesture = async dx => { const box = await label(page, records.point).boundingBox(), x = box.x + Math.min(20, box.width / 2), y = box.y + box.height / 2; await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y }] }); if (dx >= 8) await expect(page.locator('.record-time-ghost')).toHaveCount(1); else await expect(page.locator('.record-time-ghost')).toHaveCount(0); await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
    await gesture(7); await expect(page.locator('.descriptor')).toBeVisible(); await page.locator('[data-action=close-descriptor]').click(); await ready(page);
    await gesture(8); await expect(page.locator('.descriptor')).toContainText('Version'); await expect(page.locator('.descriptor dd').filter({ hasText: /^2$/ })).toHaveCount(1); await ready(page);
    const canvas = await page.locator('.plot-wrap canvas').evaluate(node => ({ css: node.getBoundingClientRect().width, intrinsic: node.width, plot: node.parentElement.clientWidth })); expect(canvas.css).toBe(canvas.plot); expect(canvas.intrinsic).toBe(canvas.css * 2);
    await page.locator('[data-action=time-edit]').click(); await page.screenshot({ path: info.outputPath('record-time-local-dpr2.png') }); await page.locator('#cancel-time-edit').click();
    await page.locator('[data-action=settings]').click(); await page.locator('#source-command').click(); const downloaded = page.waitForEvent('download'); await page.locator('#export-json').click(); const result = await downloaded; const exported = JSON.parse(await readFile(await result.path(), 'utf8'));
    const edited = exported.records.find(record => record.id === records.point.id); expect(edited.version).toBe(2); expect(edited.start).not.toBe(records.point.start); expect(edited.end).toBeNull(); expect(writes).toEqual([]); expect(errors).toEqual([]);
  } finally { await context.close(); }
});
