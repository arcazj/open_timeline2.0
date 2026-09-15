import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeOverviewPreview, OVERVIEW_PREVIEW_LIMITS } from '../../client/src/timeline/navigation-overview.js';

const stamp = hour => new Date(Date.UTC(2026, 0, 1, hour)).toISOString();
const range = (from, to) => ({ from: stamp(from), to: stamp(to) });
const scope = { providerId: 'fixture', generation: 'generation-1', revision: 1, preferencesRevision: 2, querySignature: 'filters:all;search:none' };
const event = (id, at, extra = {}) => ({ id, kind: 'event', start: stamp(at), end: stamp(at), title: id, ...extra });
const session = (id, from, to, extra = {}) => ({ id, kind: 'session', start: stamp(from), end: to == null ? null : stamp(to), title: id, ...extra });
const zone = (id, from, to) => ({ id, start: stamp(from), end: stamp(to), color: '#ffaa00', opacity: .2 });
const packet = (from, to, items, extra = {}) => ({ scope, overview: { domain: range(from, to), items, matchActive: false, aggregated: false }, zones: [], ...extra });
const merge = (base, entries, from = 0, to = 4, extra = {}) => mergeOverviewPreview({ domain: range(from, to), scope, base, entries, ...extra });
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

test('rolling overview merges all overview records, clips zones and sessions, and deduplicates adjacent windows', () => {
  const crossing = session('crossing', -2, 8), open = session('open', 3, null);
  const base = freeze(packet(0, 2, [event('a', 0), crossing, event('not-selected-row', 1)], { zones: [zone('z', -1, 8)] }));
  const next = freeze(packet(2, 4, [crossing, event('b', 2), open], { zones: [zone('z', -1, 8)] }));
  const result = merge(base, [next]);
  assert.deepEqual(result.items.map(item => item.id).sort(), ['a', 'b', 'crossing', 'not-selected-row', 'open']);
  assert.deepEqual(result.items.find(item => item.id === 'crossing'), session('crossing', 0, 4));
  assert.equal(result.items.find(item => item.id === 'open').end, stamp(4));
  assert.deepEqual(result.zones, [zone('z', 0, 4)]);
  assert.equal(result.coverage.complete, true); assert.equal(result.coverage.zonesComplete, true);
  assert.equal(result.coverage.countsExact, true); assert.equal(result.coverage.visibleRecordCount, 5);
  assert.equal(base.overview.items[1].start, stamp(-2));
});

test('search, filter scope, source selection and all revision identities are isolated', () => {
  const base = packet(0, 2, [event('base', 1)]);
  for (const override of [{ revision: 2 }, { preferencesRevision: 3 }, { generation: 'next' }, { providerId: 'other' }, { querySignature: 'search:needle' }]) {
    const result = merge(base, [packet(2, 4, [event('leak', 3)], { scope: { ...scope, ...override } })]);
    assert.deepEqual(result.items.map(item => item.id), ['base']);
    assert.equal(result.coverage.state, 'partial'); assert.equal(result.coverage.ignoredPackets, 1);
  }
  const wrongSearch = packet(2, 4, [event('leak', 3)]); wrongSearch.overview.matchActive = true;
  assert.equal(merge(base, [wrongSearch]).items.length, 1);
  const search = packet(0, 4, [event('only-finding', 2)]); search.overview.matchActive = true;
  assert.deepEqual(merge(search, [base], 0, 4, { matchActive: true }).items.map(item => item.id), ['only-finding']);
  const scoped = packet(0, 4, [event('selected-source', 1)], { sourceIds: ['second', 'first'] });
  assert.equal(merge(base, [scoped], 0, 4, { sourceIds: ['first', 'second'] }).items[0].id, 'selected-source');
  assert.equal(merge(base, [scoped]).coverage.ignoredPackets, 1);
});

test('unknown, missing and incomplete intervals never become a complete empty overview', () => {
  const empty = merge(undefined, []);
  assert.equal(empty.coverage.state, 'unavailable'); assert.equal(empty.coverage.countsExact, false);
  assert.deepEqual(empty.coverage.intervals, [{ ...range(0, 4), complete: false, loaded: false }]);
  const gap = merge(packet(0, 1, []), [packet(2, 4, [])]);
  assert.equal(gap.coverage.complete, false);
  assert.ok(gap.coverage.intervals.some(interval => interval.from === stamp(1) && interval.to === stamp(2) && !interval.loaded));
  const provisional = packet(0, 4, [event('loaded', 1)], { coverage: { complete: false } });
  assert.equal(merge(provisional, []).coverage.state, 'partial');
  assert.equal(merge(packet(0, 4, []), [provisional]).coverage.complete, true);
  assert.equal(merge(packet(0, 4, []), [provisional]).items.length, 0, 'complete pinned packet wins over partial overlap');
  const missingZones = packet(0, 4, []); delete missingZones.zones;
  assert.equal(merge(missingZones, []).coverage.zonesComplete, false);
});

test('overlapping aggregate windows never sum duplicate bins or invent distinct totals', () => {
  const aggregate = (from, to, count) => {
    const result = packet(from, to, [session(`aggregate:${from}`, from, to, { count })]); result.overview.aggregated = true; return result;
  };
  const result = merge(aggregate(0, 3, 20), [aggregate(2, 4, 30)]);
  assert.deepEqual(result.items.map(item => [item.start, item.end, item.count]), [[stamp(0), stamp(2), 20], [stamp(2), stamp(4), 30]]);
  assert.equal(result.items[0].countExact, false); assert.equal(result.items[1].countExact, true);
  assert.deepEqual(result.items[0].countDomain, range(0, 3));
  assert.equal(result.coverage.visibleRecordCount, null); assert.equal(result.coverage.countsExact, false);
  assert.equal(result.coverage.aggregateCountsApproximate, true);
  const mixed = merge(aggregate(0, 3, 20), [packet(2, 4, [event('individual', 3)])]);
  assert.ok(mixed.items.every(item => !item.count || item.end <= stamp(2)));
  assert.equal(mixed.items.filter(item => item.id === 'individual').length, 1);
});

test('end-exclusive clipping, duplicate inputs, bounded packets and output limits stay deterministic', () => {
  const item = event('duplicate', 1);
  const clipped = merge(packet(-1, 5, [event('past', -1), item, item, event('edge', 4)]), []);
  assert.deepEqual(clipped.items.map(item => item.id), ['duplicate']);
  const packets = Array.from({ length: 8 }, (_, index) => packet(index, index + 1, [event(String(index), index)]));
  const bounded = merge(undefined, packets, 0, 8);
  assert.equal(bounded.items.length, OVERVIEW_PREVIEW_LIMITS.entries); assert.equal(bounded.coverage.complete, false);
  const tooMany = packet(0, 4, Array.from({ length: 1001 }, (_, index) => event(`event-${index}`, 1)));
  const limited = merge(tooMany, []);
  assert.equal(limited.items.length, 1000); assert.equal(limited.coverage.limitedPackets, 1); assert.equal(limited.coverage.complete, false);
  const full = Array.from({ length: 6 }, (_, index) => packet(index, index + 1, Array.from({ length: 1000 }, (_, number) => event(`${index}-${number}`, index))));
  const capped = merge(undefined, full, 0, 6);
  assert.equal(capped.items.length, OVERVIEW_PREVIEW_LIMITS.items); assert.equal(capped.coverage.truncated, true); assert.equal(capped.coverage.countsExact, false);
  const invalid = packet(0, 4, [{ id: 'bad', kind: 'event', start: 'bad' }]);
  assert.equal(merge(invalid, []).coverage.complete, false);
});
