import test from 'node:test';
import assert from 'node:assert/strict';
import cases from '../../shared/fixtures/string-order-v2.json' with { type: 'json' };
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { compareOrderedText, normalizeStringOrder } from '../../client/src/data/string-order.js';
import { buildRecordTable, normalizeTableInput } from '../../client/src/data/record-table.js';
import { buildLayout } from '../../client/src/timeline/layout.js';
import { groupValue, compareGroups, resolvePresentation } from '../../client/src/timeline/presentation.js';

for (const fixture of cases.cases) test(`v2 strings: ${fixture.name}`, () => {
  const options = normalizeStringOrder(fixture.options, 2);
  assert.deepEqual(fixture.values.toSorted((a, b) => compareOrderedText(a, b, options)), fixture.expected);
});

test('natural ordering preserves normalization, exact huge digits, comparator laws and input spelling', () => {
  const options = { order: 'natural', caseSensitive: false };
  assert.equal(compareOrderedText('e\u03012', '\u00e92', options), 0);
  assert.ok(compareOrderedText(`N${'9'.repeat(5000)}`, `N1${'0'.repeat(5000)}`, options) < 0);
  const values = cases.cases.flatMap(fixture => fixture.values);
  for (const left of values) for (const right of values) {
    assert.equal(Math.sign(compareOrderedText(left, right, options)) + Math.sign(compareOrderedText(right, left, options)), 0);
  }
  const ordered = values.toSorted((a, b) => compareOrderedText(a, b, options));
  for (let left = 0; left < ordered.length; left++) for (let right = left; right < ordered.length; right++) assert.ok(compareOrderedText(ordered[left], ordered[right], options) <= 0);
});

const domain = initial.settings.overview;
const record = (index, value) => ({ ...structuredClone(initial.records[0]), id: `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`, kind: 'event', end: null, title: `Record ${index}`, sourceId: 'operations', parentSessionId: null, render: {}, data: value === undefined ? {} : { status: value } });

test('v2 table sorting keeps null/missing last, ID ties ascending and text options explicit', () => {
  const records = ['SOURCE2', 'SOURCE10', 'SOURCE1', 'SOURCE02', null, undefined, 'SOURCE2'].map((value, index) => record(index + 1, value));
  const query = { records, matches: new Set(), hasSearch: false };
  for (const [direction, indices] of [['asc', [3, 1, 7, 4, 2, 5, 6]], ['desc', [2, 4, 1, 7, 3, 5, 6]]]) {
    const options = normalizeTableInput({ definitionVersion: 2, sort: [{ field: 'data.status', direction, order: 'natural' }], limit: 2 }, domain);
    const result = buildRecordTable(query, options);
    assert.deepEqual(result.items.map(item => Number(item.record.id.slice(-12))), indices);
    assert.deepEqual(result.boundaries, [0, 2, 4, 6, 7]);
    assert.ok(result.items.every(item => !Object.hasOwn(item, 'provenance')));
  }
  const legacy = normalizeTableInput({ sort: [{ field: 'data.status', direction: 'asc' }] }, domain);
  assert.deepEqual(buildRecordTable(query, legacy).items.map(item => item.record.data.status), ['SOURCE02', 'SOURCE1', 'SOURCE10', 'SOURCE2', 'SOURCE2', null, undefined]);
  for (const input of [
    { sort: [{ field: 'title', direction: 'asc', order: 'natural' }] },
    { definitionVersion: 2, sort: [{ field: 'start', direction: 'asc', order: 'natural' }] },
    { definitionVersion: 2, sort: [{ field: 'title', direction: 'asc', caseSensitive: 'false' }] },
    { definitionVersion: 2, sort: [{ field: 'title', direction: 'asc', order: 'locale' }] },
    { definitionVersion: null }, { definitionVersion: 3 },
  ]) assert.throws(() => normalizeTableInput(input, domain));
});

test('v2 context totals and provenance are separate from filter membership and findings', () => {
  const records = [record(1, 'SOURCE1'), record(2, 'SOURCE1')];
  const provenance = {
    [records[0].id]: { role: 'ancestor-context', directPredicate: false, match: false, descendantMatchCount: 1 },
    [records[1].id]: { role: 'direct', directPredicate: true, match: true, descendantMatchCount: 0 },
  };
  const query = { records, definitionVersion: 2, matches: new Set([records[1].id]), eligibleIds: new Set([records[1].id]), provenance, hasSearch: true };
  for (const projection of ['context', 'matches']) {
    const table = buildRecordTable(query, normalizeTableInput({ definitionVersion: 2, projection }, domain));
    assert.equal(table.baseTotal, 1); assert.equal(table.contextTotal, 1); assert.equal(table.matchTotal, 1);
    assert.equal(table.total, projection === 'context' ? 2 : 1);
    for (const item of table.items) assert.deepEqual(item.provenance, provenance[item.record.id]);
  }
});

test('v2 group ordering keeps typed identities and ranks while layout remains temporal', () => {
  const values = ['SOURCE2', 'SOURCE10', 'SOURCE1', 'SOURCE02', null, undefined, '(missing)', 2, 10, false, true];
  const records = values.map((value, index) => record(index + 1, value));
  const presentation = resolvePresentation({ presentation: { version: 1, grouping: { field: '/data/status' } } });
  const groups = records.map(item => groupValue(item, presentation));
  for (const [direction, expected] of [
    ['asc', ['number:2', 'number:10', 'string:(missing)', 'string:SOURCE1', 'string:SOURCE2', 'string:SOURCE02', 'string:SOURCE10', 'boolean:false', 'boolean:true', 'null:', 'missing:']],
    ['desc', ['number:10', 'number:2', 'string:SOURCE10', 'string:SOURCE02', 'string:SOURCE2', 'string:SOURCE1', 'string:(missing)', 'boolean:true', 'boolean:false', 'null:', 'missing:']],
  ]) assert.deepEqual(groups.toSorted((a, b) => compareGroups(a, b, direction, { order: 'natural' })).map(group => group.key), expected);
  const start = Date.parse(domain.from), end = Date.parse(domain.to);
  const map = { knots: [{ timeMs: start, u: '0' }, { timeMs: end, u: '1' }] };
  const input = { definitionVersion: 2, from: domain.from, to: domain.to, width: 1000, availableHeight: 480, presentation: { version: 1, grouping: { field: '/data/status' } } };
  const codepoint = buildLayout(records, map, input);
  const natural = buildLayout(records.toReversed(), map, { ...input, groupOrder: { order: 'natural' } });
  assert.equal(natural.detailTotal, records.length);
  assert.notDeepEqual(natural.rows.map(row => row.key), codepoint.rows.map(row => row.key));
  for (const item of natural.items) {
    const before = codepoint.items.find(value => value.record.id === item.record.id);
    for (const field of ['xStart', 'xEnd', 'labelX', 'footprintStart', 'footprintEnd']) assert.equal(item[field], before[field]);
  }
  assert.throws(() => buildLayout(records, map, { ...input, definitionVersion: 1, groupOrder: { order: 'natural' } }), { code: 'invalid_order' });
});
