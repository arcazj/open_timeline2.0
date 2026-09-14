import test from 'node:test';
import assert from 'node:assert/strict';
import { compileExpression, compileSearch, parseSearch, foldText } from '../../client/src/data/filter-expression.js';
import { createQueryData } from '../../client/src/data/query-core.js';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };

const record = (overrides = {}) => ({ id: 'A', title: 'Alpha', kind: 'event', sourceId: 'operations', start: '2026-09-12T10:00:00.000Z', end: null, order: 4, version: 1, tags: ['Urgent', 'STRASSE'], data: { status: 'Ready', system: 'Control' }, ...overrides });
const tree = root => ({ version: 1, root });
const evaluate = (root, value = record()) => compileExpression(tree(root))(value);
const eq = (field, value) => ({ op: 'eq', field, value });

test('every scalar filter comparison is typed and compares calendar instants rather than ISO spelling', () => {
  for (const [op, value, expected] of [['eq', 4, true], ['ne', 4, false], ['lt', 5, true], ['lte', 4, true], ['gt', 3, true], ['gte', 4, true], ['lt', 4, false], ['gt', 4, false]]) assert.equal(evaluate({ op, field: '/order', value }), expected, op);
  assert.equal(evaluate({ op: 'in', field: '/order', values: [1, 4, 8] }), true);
  assert.equal(evaluate(eq('/start', '2026-09-12T06:00:00-04:00')), true);
  assert.equal(evaluate({ op: 'lt', field: '/start', value: '2026-09-12T10:00:00.001Z' }), true);
  assert.equal(evaluate(eq('/title', '\u00e9'), record({ title: 'e\u0301' })), true);
  assert.equal(evaluate(eq('/title', 'ALPHA')), false);
  assert.equal(evaluate({ op: 'lt', field: '/title', value: '\u{10000}' }, record({ title: '\ue000' })), true);
  for (const [field, value] of [['/order', '4'], ['/order', true], ['/title', 4], ['/start', 1], ['/start', '2026-09-12']]) assert.throws(() => evaluate(eq(field, value)), { code: 'invalid_filter' });
});

test('null and missing remain distinct, and not uses Kleene three-valued logic', () => {
  const missing = record({ data: {} }), nullValue = record({ data: { status: null } });
  assert.equal(evaluate(eq('/data/status', null), missing), false);
  assert.equal(evaluate(eq('/data/status', null), nullValue), true);
  assert.equal(evaluate({ op: 'ne', field: '/data/status', value: null }, missing), false);
  assert.equal(evaluate({ op: 'ne', field: '/data/status', value: null }, record()), true);
  assert.equal(evaluate({ op: 'exists', field: '/data/status', value: false }, missing), true);
  assert.equal(evaluate({ op: 'exists', field: '/data/status', value: true }, nullValue), true);
  assert.equal(evaluate({ op: 'not', arg: eq('/data/status', 'Ready') }, missing), false);
  assert.equal(evaluate({ op: 'not', arg: { op: 'contains', field: '/data/status', value: 'x' } }, nullValue), false);
  assert.equal(evaluate({ op: 'in', field: '/data/status', values: [null, 'Ready'] }, nullValue), true);
  const nodes = { T: eq('/id', 'A'), F: eq('/id', 'B'), U: eq('/data/status', 'Ready') };
  for (const left of ['T', 'F', 'U']) for (const right of ['T', 'F', 'U']) {
    const andExpected = left === 'T' && right === 'T';
    const orExpected = left === 'T' || right === 'T';
    assert.equal(evaluate({ op: 'and', args: [nodes[left], nodes[right]] }, missing), andExpected, `and ${left}${right}`);
    assert.equal(evaluate({ op: 'or', args: [nodes[left], nodes[right]] }, missing), orExpected, `or ${left}${right}`);
    const andFalse = left === 'F' || right === 'F';
    assert.equal(evaluate({ op: 'not', arg: { op: 'and', args: [nodes[left], nodes[right]] } }, missing), andFalse, `not(and ${left}${right})`);
  }
});

test('contains distinguishes literal text from exact array membership and supports explicit case sensitivity', () => {
  assert.equal(evaluate({ op: 'contains', field: '/title', value: 'STRASSE' }, record({ title: 'Die Stra\u00dfe' })), true);
  assert.equal(evaluate({ op: 'contains', field: '/title', value: 'STRASSE', caseSensitive: true }, record({ title: 'Die Stra\u00dfe' })), false);
  assert.equal(evaluate({ op: 'contains', field: '/tags', value: 'urgent' }), true);
  assert.equal(evaluate({ op: 'contains', field: '/tags', value: 'urge' }), false);
  assert.equal(evaluate({ op: 'contains', field: '/tags', value: 'urgent', caseSensitive: true }), false);
  assert.equal(evaluate({ op: 'contains', field: '/title', value: '.*' }, record({ title: 'literal .* token' })), true);
  assert.equal(evaluate({ op: 'contains', field: '/title', value: '.*' }), false);
  for (const node of [{ op: 'contains', field: '/order', value: 1 }, { op: 'eq', field: '/tags', value: ['Urgent'] }, { op: 'in', field: '/tags', values: ['Urgent'] }, { op: 'contains', field: '/title', value: null }]) assert.throws(() => evaluate(node), { code: 'invalid_filter' });
});

test('overlap filtering is half-open for points, finite sessions, ongoing and zero-duration sessions', () => {
  const node = { op: 'overlaps', from: '2026-09-12T10:00:00.000Z', to: '2026-09-12T11:00:00.000Z' };
  assert.equal(evaluate(node), true);
  assert.equal(evaluate(node, record({ start: node.to })), false);
  assert.equal(evaluate(node, record({ kind: 'session', start: '2026-09-12T09:00:00Z', end: node.from })), false);
  assert.equal(evaluate(node, record({ kind: 'session', start: '2026-09-12T09:00:00Z', end: null })), true);
  assert.equal(evaluate(node, record({ kind: 'session', start: node.from, end: node.from })), true);
  assert.throws(() => evaluate({ ...node, to: node.from }), { code: 'invalid_filter' });
});

test('all filter branches validate types; invalid shapes, selectors and structure limits reject', () => {
  const wrong = record({ data: { status: 42 } });
  for (const op of ['and', 'or']) assert.throws(() => evaluate({ op, args: [eq('/id', op === 'or' ? 'A' : 'B'), eq('/data/status', 'Ready')] }, wrong), { code: 'invalid_filter' });
  const invalid = [null, {}, { op: 'and', args: [] }, { op: 'or', args: [] }, { op: 'regex', field: '/title', value: 'x' }, { op: 'exists', field: '/title', value: 1 }, { op: 'eq', field: ['/title'], value: 'Alpha' }, { op: 'eq', field: '/data/__proto__', value: 'x' }, { op: 'eq', field: '/title' }, { op: 'in', field: '/order', values: [] }, { op: 'in', field: '/order', values: Array(101).fill(1) }, { op: 'contains', field: '/title', value: 'x', caseSensitive: null }, { op: 'not', arg: eq('/id', 'A'), code: 'x' }];
  for (const root of invalid) assert.throws(() => compileExpression(tree(root)), { code: 'invalid_filter' });
  let root = eq('/id', 'A'); for (let i = 0; i < 7; i++) root = { op: 'not', arg: root };
  assert.doesNotThrow(() => compileExpression(tree(root)));
  assert.throws(() => compileExpression(tree({ op: 'not', arg: root })), { code: 'invalid_filter' });
  assert.doesNotThrow(() => compileExpression(tree({ op: 'and', args: Array.from({ length: 99 }, () => eq('/id', 'A')) })));
  assert.throws(() => compileExpression(tree({ op: 'and', args: Array.from({ length: 100 }, () => eq('/id', 'A')) })), { code: 'invalid_filter' });
  assert.equal(compileExpression(null)(record()), true);
});

test('literal search parses all/any/phrase, Unicode whitespace, quotes and the only two escapes', () => {
  assert.deepEqual(parseSearch('Alpha; "beta gamma"\u00a0Delta'), ['alpha', 'beta gamma', 'delta']);
  assert.deepEqual(parseSearch('"say \\"yes\\""; path\\\\name'), ['say "yes"', 'path\\name']);
  assert.deepEqual(parseSearch('  alpha; beta  ', 'phrase'), ['alpha; beta']);
  assert.deepEqual(parseSearch('"MiXeD"', 'any', true), ['MiXeD']);
  assert.equal(foldText('Stra\u00dfe \u03a3\u03c2'), 'strasse \u03c3\u03c3');
  assert.equal(foldText('\u0130'), 'i\u0307');
  assert.equal(parseSearch('\u00df'.repeat(512))[0].length, 1024);
  for (const value of ['bad\\q', 'unfinished\\', '"unfinished', 'x'.repeat(513), Array(21).fill('x').join(' ')]) assert.throws(() => parseSearch(value), { code: 'invalid_search' });
});

test('search field scopes respect same-field phrases and canonical scalar text, without composite/null matches', () => {
  const value = record({ title: 'Alpha', data: { description: 'Beta STRASSE', status: null }, order: 1e-7 });
  assert.equal(compileSearch({ search: 'alpha beta', searchMode: 'all' }).matches(value), true);
  assert.equal(compileSearch({ search: 'alpha beta', searchMode: 'phrase' }).matches(value), false);
  assert.equal(compileSearch({ search: 'missing beta', searchMode: 'any' }).matches(value), true);
  assert.equal(compileSearch({ search: 'Beta', searchFields: ['/title'] }).matches(value), false);
  assert.equal(compileSearch({ search: '1e-7', searchFields: ['/order'] }).matches(value), true);
  assert.equal(compileSearch({ search: 'null', searchFields: ['/data/status'] }).matches(value), false);
  assert.equal(compileSearch({ search: 'strasse', searchCaseSensitive: true }).matches(value), false);
  for (const options of [{ search: null }, { searchMode: null }, { searchFields: null }, { searchCaseSensitive: null }, { searchFields: [['/title']] }, { searchFields: ['/title', '/title'] }, { searchFields: ['/tags'] }, { searchFields: ['/data/unknown'] }, { searchFields: [] }]) assert.throws(() => compileSearch(options), { code: 'invalid_search' });
});

test('query data applies filter to complete C but search changes only M, never density or canonical styles', () => {
  const snapshot = structuredClone(initial), base = { domain: snapshot.settings.overview, filters: { expression: tree({ op: 'contains', field: '/data/status', value: 'nominal' }) } };
  const before = JSON.stringify(snapshot);
  const all = createQueryData(snapshot, base), searched = createQueryData(snapshot, { ...base, search: 'Telemetry', searchMode: 'all' });
  assert.deepEqual(all.records, searched.records); assert.deepEqual(all.density, searched.density);
  assert.deepEqual(all.map.knots, searched.map.knots); assert.ok(searched.matches.size <= all.matches.size);
  assert.equal(JSON.stringify(snapshot), before);
  for (const options of [{ filters: null }, { filters: { kind: null } }, { filters: { sourceId: null } }, { ratio: null }, { bins: null }, { scaleMode: null }]) assert.throws(() => createQueryData(snapshot, { ...base, ...options }), error => error.status === 422);
  assert.throws(() => createQueryData(snapshot, null), { code: 'invalid_query' });
});
