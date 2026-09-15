import test from 'node:test';
import assert from 'node:assert/strict';
import { previewProjector, extendPreviewSessions, reprojectPreviewRows } from '../../client/src/timeline/navigation-preview-projection.js';
import { navigationMap } from '../../client/src/timeline/navigation-domain.js';
import { fixedScaleMap } from '../../client/src/timeline/fixed-scale.js';
import { projectTime, toMs, toIso, MIN_TIME, MAX_TIME } from '../../client/src/timeline/time-scale.js';

const start = toMs('2026-01-01T00:00:00Z'), hour = 3600000;
const stamp = hours => toIso(start + hours * hour);
const uniform = (from = 0, to = 3) => ({ mode: 'uniform', knots: [{ timeMs: start + from * hour, u: '0' }, { timeMs: start + to * hour, u: '1' }] });
const base = { fromMs: start, toMs: start + hour, recordIds: new Set() };
const range = { fromMs: start + hour, toMs: start + 2 * hour };
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
function graphic(id, from, to, map = uniform(1, 2), overrides = {}) {
  const record = { id, kind: to === undefined ? 'event' : 'session', start: stamp(from), end: to == null ? null : stamp(to) };
  const x = value => projectTime(map, Math.max(map.knots[0].timeMs, Math.min(map.knots.at(-1).timeMs, value)), range.fromMs, range.toMs, 100);
  return { record, row: 1, xStart: x(toMs(record.start)), xEnd: x(record.end === null ? record.kind === 'session' ? MAX_TIME : toMs(record.start) : toMs(record.end)),
    labelX: x(toMs(record.start)) + 7, iconX: x(toMs(record.start)) - 20, labelWidth: 20, labelLines: ['Measured'], labelLineHeight: 18,
    labelOffsetY: 6, labelInkOffsets: [-1], geometryOffsetY: 27, style: { icon: 'flag', fontSize: 13, barHeight: 8 }, ...overrides };
}

for (const [name, map] of [
  ['uniform', uniform()],
  ['adaptive', { mode: 'adaptive', knots: [{ timeMs: start, u: '0' }, { timeMs: start + hour, u: '0.2' }, { timeMs: start + 2 * hour, u: '0.8' }, { timeMs: start + 3 * hour, u: '1' }] }],
  ['fixed', fixedScaleMap({ from: stamp(0), to: stamp(3) }, [{ from: stamp(1), to: stamp(2), ratio: 4 }])],
]) test(`${name} projection uses the frozen time map while preserving pixel label and icon geometry`, () => {
  const context = freeze({ map, ...base, width: 100 }), project = previewProjector(context);
  const sourceMap = uniform(1, 2), original = freeze(graphic('new', 1.2, 1.6, sourceMap));
  const source = freeze({ items: [original], rows: [{ type: 'group', row: 0, key: 'string:N' }], rowHeight: 48, startRow: 0, endRow: 2 });
  const result = reprojectPreviewRows(source, sourceMap, range, 100, project, base);
  const next = result.rows.items[0];
  close(next.xStart, projectTime(navigationMap(map), toMs(original.record.start), base.fromMs, base.toMs, 100));
  close(next.xEnd, projectTime(navigationMap(map), toMs(original.record.end), base.fromMs, base.toMs, 100));
  close(next.labelX - next.xStart, original.labelX - original.xStart); close(next.iconX - next.xStart, original.iconX - original.xStart);
  for (const field of ['labelWidth', 'labelLines', 'labelLineHeight', 'labelOffsetY', 'labelInkOffsets', 'geometryOffsetY', 'style', 'record', 'row']) assert.equal(next[field], original[field]);
  assert.equal(result.rows.rows, source.rows); assert.equal(result.omitted, 0);
  assert.deepEqual(reprojectPreviewRows(source, sourceMap, range, 100, project, base), result);
});

test('finite neighboring events remain correctly positioned beyond fifty viewports in either direction', () => {
  const map = freeze(uniform()), project = previewProjector({ map, ...base, width: 100 });
  for (const hours of [-80, -10, 10, 80]) close(project(start + hours * hour), hours * 100);
  assert.equal(JSON.stringify(map), JSON.stringify(uniform()));
});

test('BCE, astronomical year zero and supported calendar endpoints preserve finite exact mapping', () => {
  const ancient = toMs('-000100-01-01T00:00:00Z'), zero = toMs('0000-01-01T00:00:00Z'), recent = toMs('0001-01-01T00:00:00Z');
  const map = { knots: [{ timeMs: ancient, u: '0' }, { timeMs: recent, u: '1' }] };
  const project = previewProjector({ map, fromMs: ancient, toMs: recent, width: 600 });
  close(project(ancient), 0); close(project(recent), 600); close(project(zero), (zero - ancient) / (recent - ancient) * 600);
  for (const time of [MIN_TIME, MAX_TIME]) { assert.ok(Number.isFinite(project(time))); close(project(time), projectTime(navigationMap(map), time, ancient, recent, 600)); }
  assert.throws(() => project(MIN_TIME - 1), RangeError); assert.throws(() => project(MAX_TIME + 1), RangeError);
});

test('long and ongoing sessions reproject actual timestamps instead of clipped source map edges', () => {
  const project = previewProjector({ map: uniform(), ...base, width: 100 });
  const sourceMap = uniform(1, 2), ongoing = graphic('ongoing', 1.2, null, sourceMap), long = graphic('long', 1.1, 2.8, sourceMap);
  const result = reprojectPreviewRows({ items: [ongoing, long] }, sourceMap, range, 100, project, base);
  close(result.rows.items[0].xEnd, project(MAX_TIME)); close(result.rows.items[1].xEnd, project(toMs(long.record.end)));
  assert.ok(result.rows.items[1].xEnd > 200);
});

test('original baseline endpoints use original times even when clipped in source geometry', () => {
  const project = previewProjector({ map: uniform(), ...base, width: 100 }), sourceMap = uniform(1, 2);
  const source = graphic('baseline', 1.2, 1.8, sourceMap, { baselineStart: 0, baselineEnd: 100, baselineOffsetY: 40 });
  source.record.originalStart = stamp(.9); source.record.originalEnd = stamp(2.5);
  const result = reprojectPreviewRows({ items: [source] }, sourceMap, range, 100, project, base).rows.items[0];
  close(result.baselineStart, 90); close(result.baselineEnd, 250); assert.equal(result.baselineOffsetY, 40);
});

test('extending original sessions changes only necessary bar endpoints, never labels, points or structural rows', () => {
  const project = previewProjector({ map: uniform(), ...base, width: 100 });
  const source = freeze({ items: [graphic('long', -.5, 2.8), graphic('ongoing', .5, null), graphic('event', 1.5),
    graphic('point-session', 1.5, 1.5), { row: 0, type: 'group', name: 'N' }], rows: [] });
  const result = extendPreviewSessions(source, project);
  close(result.items[0].xStart, -50); close(result.items[0].xEnd, 280); close(result.items[1].xEnd, project(MAX_TIME));
  for (let index = 0; index < 2; index++) {
    assert.equal(result.items[index].labelX, source.items[index].labelX); assert.equal(result.items[index].row, source.items[index].row);
  }
  for (let index = 2; index < source.items.length; index++) assert.equal(result.items[index], source.items[index]);
});

for (const [name, map] of [
  ['uniform', uniform()],
  ['adaptive', { mode: 'adaptive', knots: [{ timeMs: start, u: '0' }, { timeMs: start + hour, u: '0.2' }, { timeMs: start + 2 * hour, u: '0.8' }, { timeMs: start + 3 * hour, u: '1' }] }],
]) test(`${name} base baselines extend beyond both map boundaries without moving rows, labels or footprint metadata`, () => {
  const project = previewProjector({ map, ...base, width: 100 });
  const item = { record: { id: 'baseline', kind: 'session', start: stamp(.25), end: stamp(7), originalStart: stamp(-3), originalEnd: stamp(10) },
    row: 4, xStart: project(start + .25 * hour), xEnd: project(start + 3 * hour), labelX: 25, labelWidth: 40, labelLines: ['Pinned'],
    labelOffsetY: 6, geometryOffsetY: 28, baselineOffsetY: 38, baselineStart: project(start), baselineEnd: project(start + 3 * hour),
    footprintStart: 0, footprintEnd: 100, style: { barHeight: 8 }, ancestorIds: [] };
  const source = freeze({ items: [item], rows: [{ type: 'group', row: 3 }], startRow: 3, endRow: 6, pageCapacity: 3 }), before = JSON.stringify(source);
  const result = extendPreviewSessions(source, project), next = result.items[0];
  close(next.baselineStart, project(start - 3 * hour)); close(next.baselineEnd, project(start + 10 * hour));
  close(next.xEnd, project(start + 7 * hour)); assert.ok(next.baselineStart < item.baselineStart); assert.ok(next.baselineEnd > item.baselineEnd);
  for (const field of ['row', 'labelX', 'labelWidth', 'labelLines', 'labelOffsetY', 'geometryOffsetY', 'baselineOffsetY', 'footprintStart', 'footprintEnd', 'style', 'ancestorIds', 'record']) assert.equal(next[field], item[field]);
  assert.equal(result.rows, source.rows); assert.equal(result.startRow, source.startRow); assert.equal(result.pageCapacity, source.pageCapacity);
  assert.equal(JSON.stringify(source), before); assert.deepEqual(extendPreviewSessions(source, project), result);
});

test('base event, zero-duration and ongoing baselines use authored timestamps and canonical fallback values', () => {
  const project = previewProjector({ map: uniform(), ...base, width: 100 });
  const item = (id, kind, end, originalStart, originalEnd) => ({ record: { id, kind, start: stamp(.5), end, originalStart, originalEnd },
    row: 0, xStart: 50, xEnd: kind === 'session' && end === null ? 300 : 50, labelX: 60,
    baselineStart: 0, baselineEnd: 300, baselineOffsetY: 32, footprintStart: 0, footprintEnd: 100 });
  const source = freeze({ items: [item('event', 'event', null, stamp(-4), null), item('zero', 'session', stamp(.5), null, stamp(8)),
    item('ongoing', 'session', null, stamp(-2), null), item('finite', 'session', stamp(5), null, stamp(9))] });
  const next = extendPreviewSessions(source, project).items;
  close(next[0].baselineStart, -400); close(next[0].baselineEnd, 50);
  close(next[1].baselineStart, 50); close(next[1].baselineEnd, 800);
  close(next[2].baselineStart, -200); close(next[2].baselineEnd, project(MAX_TIME));
  close(next[3].baselineStart, 50); close(next[3].baselineEnd, 900);
  for (let index = 0; index < 2; index++) for (const field of ['xStart', 'xEnd', 'row', 'labelX', 'baselineOffsetY', 'footprintStart', 'footprintEnd']) assert.equal(next[index][field], source.items[index][field]);
});

test('known base records are excluded by identity, while unseen base-overlapping records count as omitted', () => {
  const project = previewProjector({ map: uniform(), ...base, width: 100 }), sourceMap = uniform(1, 2);
  const selected = { ...base, recordIds: new Set(['known', 'known-outside']) };
  const source = { items: [graphic('known', .5), graphic('known-outside', 1.5), graphic('hidden-base-page', .5), graphic('new', 1.5)] };
  const result = reprojectPreviewRows(source, sourceMap, range, 100, project, selected);
  assert.deepEqual(result.rows.items.map(item => item.record.id), ['new']); assert.equal(result.omitted, 1);
});

test('base ownership follows half-open event and duration overlap including boundary-crossing sessions', () => {
  const project = previewProjector({ map: uniform(), ...base, width: 100 }), sourceMap = uniform(1, 2);
  const source = { items: [graphic('at-start', 0), graphic('at-end', 1), graphic('ends-at-start', -.5, 0),
    graphic('crosses-start', -.5, .1), graphic('starts-at-end', 1, 1.5)] };
  const result = reprojectPreviewRows(source, sourceMap, range, 100, project, base);
  assert.deepEqual(result.rows.items.map(item => item.record.id), ['at-end', 'ends-at-start', 'starts-at-end']);
  assert.equal(result.omitted, 2);
});

test('inside-bar labels are omitted if their fixed pixel inset no longer fits the compressed bar', () => {
  const original = graphic('inside', 1.2, 1.8, uniform(1, 2), { labelInsideBar: true, labelX: 22, labelWidth: 30 });
  const target = time => (Number(time) - start) / hour * 52;
  const result = reprojectPreviewRows({ items: [original] }, uniform(1, 2), range, 100, target, base);
  assert.equal(result.rows.items.length, 0); assert.equal(result.omitted, 1);
});
