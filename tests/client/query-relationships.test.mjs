import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRelationships } from '../../client/src/data/query-relationships.js';

const start = '2031-01-01T10:00:00Z', end = '2031-01-01T11:00:00Z';
const record = (id, parentSessionId = null, sourceId = 'SOURCE1') => ({ id, title: id, kind: 'session', parentSessionId, sourceId, start, end });
const records = [record('P'), record('C1', 'P'), record('C2', 'P'), record('E', null, 'SOURCE2')];
const config = (relationshipMode = 'independent', hardPredicate = () => true) => ({ relationshipMode, hardPredicate,
  directPredicate: item => item.id === 'C1', search: { active: true, matches: item => item.id === 'C1' } });
const run = (input = records, configuration = config()) => resolveRelationships(input, configuration, Date.parse(start), Date.parse(end));

test('independent child adds parent context but no siblings or false parent search match', () => {
  const result = run();
  assert.deepEqual([...result.eligibleIds], ['C1']);
  assert.deepEqual(result.records.map(item => item.id), ['C1', 'P']);
  assert.deepEqual([...result.matches], ['C1']);
  assert.deepEqual(result.provenance.P, { role: 'ancestor-context', directPredicate: false, match: false, descendantMatchCount: 1 });
});
test('explicit family mode adds only members of the same scoped root', () => {
  const result = run(records, config('family'));
  assert.deepEqual([...result.eligibleIds], ['P', 'C1', 'C2']);
  assert.equal(result.provenance.C2.role, 'family-context');
  assert.deepEqual([...result.matches], ['C1']);
});
test('hard scope is never broadened and unavailable parent identity is redacted', () => {
  const result = run(records, config('family', item => item.id !== 'P'));
  assert.deepEqual([...result.eligibleIds], ['C1']);
  assert.equal(result.records[0].parentSessionId, null);
  assert.deepEqual(Object.keys(result.provenance), ['C1']);
});
test('out-of-domain ancestors are descriptor context only', () => {
  const values = records.map(item => item.id === 'P' ? { ...item, start: '2030-12-01T00:00:00Z', end: start } : item);
  const result = run(values);
  assert.deepEqual(result.records.map(item => item.id), ['C1']);
  assert.equal(result.contextTotal, 1); assert.equal(result.visibleContextTotal, 0);
});
test('cycles, non-session parents and duplicate identities fail closed', () => {
  for (const values of [[record('P', 'C1'), record('C1', 'P')], [...records, record('P')], [{ ...record('P'), kind: 'event' }, record('C1', 'P')]]) {
    assert.throws(() => run(values), { code: 'invalid_relationship' });
  }
});
