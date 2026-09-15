import test from 'node:test';
import assert from 'node:assert/strict';
import { canRetainDescriptor, descriptorFields, descriptorText, needsLegacyDescriptor } from '../../client/src/ui/record-descriptor.js';

test('legacy descriptor exposes authored metadata instead of the adapter wrapper', () => {
  const record = { extensions: { legacy: { id: 'event-1' } }, data: { namespace: 'SOURCE1', type: 'normalized', description: '', legacy: { title: 'Event', description: '', type: 'authored', status: 'FAILED', priority: 0, optional: null, empty: '', nested: { value: false }, text: 'Secondary note' } } };
  const original = structuredClone(record), fields = descriptorFields(record);
  assert.deepEqual(fields, [
    { label: 'type', value: 'authored' }, { label: 'status', value: 'FAILED' }, { label: 'priority', value: 0 },
    { label: 'optional', value: null }, { label: 'empty', value: '' }, { label: 'nested', value: { value: false } },
    { label: 'namespace', value: 'SOURCE1' },
  ]);
  assert.deepEqual(record, original);
  assert.equal(needsLegacyDescriptor(record), true);
});

test('canonical custom data, secondary notes, arrays, null and empty values stay distinguishable', () => {
  assert.deepEqual(descriptorFields({ data: { title: 'Selected', description: 'First note', text: 'Second note', legacy: { value: 4 }, tags: ['a', 'b'] } }), [
    { label: 'text', value: 'Second note' }, { label: 'legacy', value: { value: 4 } }, { label: 'tags', value: ['a', 'b'] },
  ]);
  assert.equal(descriptorText(null), '(null)'); assert.equal(descriptorText(undefined), '(missing)');
  assert.equal(descriptorText(''), ''); assert.equal(descriptorText(false), 'false');
  assert.equal(descriptorText({ script: '<script>unsafe()</script>' }), '{\n  "script": "<script>unsafe()</script>"\n}');
  assert.equal(descriptorText('x'.repeat(40000)).length, 40000);
});

test('sidecar loading follows legacy empty-description behavior without discarding inline notes', () => {
  for (const description of ['', '  ', null, undefined]) assert.equal(needsLegacyDescriptor({ data: { description } }), true);
  for (const description of ['Inline description', 0, false]) assert.equal(needsLegacyDescriptor({ data: { description } }), false);
  assert.equal(needsLegacyDescriptor({ data: { legacy: { description: 'Legacy description' } } }), false);
});

test('descriptor retention is limited to navigation within the same authorized query definition and data revision', () => {
  const provider = {}, selected = { id: 'record-1' };
  const previousQuery = { queryId: 'q1', definitionVersion: 2, generation: 'g1', revision: 4, preferencesRevision: 2 };
  const query = { ...previousQuery, queryId: 'q2' };
  const input = { navigationOnly: true, provider, selected, previousQuery, query, previousScope: 'scope1', scope: 'scope1',
    selectedContext: { provider, queryId: 'q1', context: { record: selected } }, unavailable: false };
  assert.equal(canRetainDescriptor(input), true);
  for (const change of [
    { navigationOnly: false }, { unavailable: true }, { scope: 'changed-filter-search-or-principal' }, { previousScope: undefined },
    { provider: {} }, { selected: { id: 'record-1' } }, { selectedContext: null },
    { query: { ...query, definitionVersion: 1 } }, { query: { ...query, generation: 'g2' } }, { query: { ...query, revision: 5 } },
    { query: { ...query, preferencesRevision: 3 } }, { query: { ...query, preferencesRevision: undefined } },
    { selectedContext: { ...input.selectedContext, queryId: 'obsolete-query' } },
  ]) assert.equal(canRetainDescriptor({ ...input, ...change }), false);
  assert.equal(canRetainDescriptor({ ...input, previousQuery: query, query: { ...query, queryId: 'q3' },
    selectedContext: { ...input.selectedContext, retainedForQueryId: 'q2' } }), true);
});
