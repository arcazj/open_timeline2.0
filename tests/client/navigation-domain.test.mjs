import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navigatePan, navigateZoom, followingOverview, createPanProjector, navigationQueryDomain, rangeInside, MIN_TIME, MAX_TIME } from '../../client/src/timeline/navigation-domain.js';
import { toIso, toMs } from '../../client/src/timeline/time-scale.js';
import { loadPathPreferences, savePathPreferences, groupedPresentation, groupingMode } from '../../client/src/ui/source-paths.js';
import { validatePresentation } from '../../client/src/timeline/presentation.js';

const start = Date.UTC(2024, 0, 1), end = start + 86400000;
const map = { knots: [{ timeMs: start, u: '0' }, { timeMs: end, u: '1' }] };
const domain = { from: toIso(start), to: toIso(end) };

test('neighbor query timestamps enclose fractional view bounds without changing the displayed range', () => {
  for (const range of [
    { fromMs: `${start}.25`, toMs: `${end}.75` },
    { fromMs: '-1000.25', toMs: '-0.01' },
    { fromMs: String(MIN_TIME), toMs: String(MIN_TIME + 1000) },
    { fromMs: String(MAX_TIME - 1000), toMs: String(MAX_TIME) },
  ]) {
    const before = JSON.stringify(range), query = navigationQueryDomain(range);
    assert.equal(rangeInside(query, range), true);
    assert.equal(JSON.stringify(range), before);
    assert.ok(Number(range.fromMs) - Number(toMs(query.from)) < 1);
    assert.ok(Number(toMs(query.to)) - Number(range.toMs) < 1);
  }
  assert.throws(() => navigationQueryDomain({ fromMs: 0, toMs: 0 }), RangeError);
  assert.throws(() => navigationQueryDomain({ fromMs: MIN_TIME - 1, toMs: 0 }), RangeError);
  assert.throws(() => navigationQueryDomain({ fromMs: 0, toMs: MAX_TIME + 1 }), RangeError);
});

test('compiled gesture projection matches the canonical map through adaptive sections and calendar bounds', () => {
  const dense = { knots: [{ timeMs: start, u: '0' }, { timeMs: start + 3600000, u: '0.6' }, { timeMs: end, u: '1' }] };
  const before = JSON.stringify(dense);
  for (const width of [390, 1600]) {
    const project = createPanProjector(dense, start + 1000, start + 7200000, width);
    for (const offset of [-1e15, -6000, -100, 0, 500, 5000, 1e15]) {
      const actual = project(offset), expected = navigatePan(dense, start + 1000, start + 7200000, offset, width);
      assert.ok(Math.abs(actual.offset - expected.offset) < 1e-5);
      assert.ok(Math.abs(Number(actual.range.fromMs) - Number(expected.range.fromMs)) < .05);
      assert.ok(Math.abs(Number(actual.range.toMs) - Number(expected.range.toMs)) < .05);
    }
    assert.throws(() => project(Infinity));
  }
  assert.equal(JSON.stringify(dense), before);
});

test('navigation continues beyond both query edges and zooms out beyond the dataset', () => {
  const original = JSON.stringify(map);
  for (const dx of [-5000, 5000]) {
    const result = navigatePan(map, start + 3600000, start + 7200000, dx, 100);
    assert.ok(Math.abs(result.offset - dx) < 1e-8);
    assert.ok(dx > 0 ? Number(result.range.toMs) < start : Number(result.range.fromMs) > end);
    assert.ok(Math.abs(Number(result.range.toMs) - Number(result.range.fromMs) - 3600000) < 0.01);
  }
  const zoom = navigateZoom(map, start, end, 0.25);
  assert.ok(Number(zoom.fromMs) < start && Number(zoom.toMs) > end);
  assert.equal(JSON.stringify(map), original);
});

test('rolling overview recenters without accumulating history or changing settled pages', () => {
  const center = { fromMs: String(start + 36000000), toMs: String(start + 39600000) };
  assert.equal(followingOverview(domain, center), domain);
  const outside = { fromMs: String(end + 3600000), toMs: String(end + 7200000) };
  const next = followingOverview(domain, outside);
  assert.equal(toMs(next.to) - toMs(next.from), end - start);
  assert.ok(toMs(next.from) < Number(outside.fromMs) && toMs(next.to) > Number(outside.toMs));
  assert.equal(followingOverview(next, outside), next);
});

test('navigation only stops at supported calendar boundaries', () => {
  const past = navigatePan(map, start, end, 1e15, 100).range;
  const future = navigatePan(map, start, end, -1e15, 100).range;
  assert.equal(Number(past.fromMs), MIN_TIME); assert.equal(Number(future.toMs), MAX_TIME);
  assert.doesNotThrow(() => followingOverview(domain, future));
});

test('path favorites are origin-scoped, deduplicated and never restore unapproved IDs as all sources', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const sources = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(loadPathPreferences(storage, 'origin-a', sources).selected, ['a', 'b']);
  assert.equal(savePathPreferences(storage, 'origin-a', { selected: ['old'], favorites: ['a', 'a', 'bad'] }), true);
  assert.deepEqual(loadPathPreferences(storage, 'origin-a', sources), { selected: [], favorites: ['a'], retained: true });
  assert.deepEqual(loadPathPreferences(storage, 'origin-b', sources).selected, ['a', 'b']);
  assert.equal(savePathPreferences(null, 'origin-a', {}), false);
});

test('ALL and NAMESPACE change grouping without changing other model settings', () => {
  const model = { version: 1, labels: { maxLines: 2 }, nesting: { enabled: true } };
  const grouped = groupedPresentation(model, 'namespace');
  assert.equal(groupingMode(grouped), 'namespace'); assert.equal(grouped.grouping.field, '/data/namespace');
  const all = groupedPresentation(grouped, 'all');
  assert.equal(validatePresentation(all).valid, true); assert.equal(validatePresentation(grouped).valid, true);
  assert.equal(groupingMode(all), 'all'); assert.deepEqual(all.labels, model.labels); assert.deepEqual(all.nesting, model.nesting);
  assert.equal(model.grouping, undefined);
});
