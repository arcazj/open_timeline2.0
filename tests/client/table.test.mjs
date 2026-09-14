import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { compareText, buildRecordTable, normalizeTableInput } from '../../client/src/data/record-table.js';

const sample = JSON.parse(await readFile(new URL('../../shared/fixtures/initial-snapshot.json', import.meta.url), 'utf8'));
function fixture(count = 260) {
  const value = structuredClone(sample), template = value.records.find(record => record.kind === 'event');
  delete value.manifest.contentSha256;
  value.records = Array.from({ length: count }, (_, i) => ({ ...structuredClone(template), id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, title: `Record ${String(count - i).padStart(4, '0')}`, start: new Date(Date.parse('2026-09-12T10:00:00Z') + i * 60000).toISOString(), end: null, parentSessionId: null, order: i, data: { status: i % 3 ? 'ready' : 'waiting' } }));
  value.manifest.recordCount = count;
  return value;
}
async function setup(value = fixture()) {
  const provider = new LocalProvider(value); await provider.initialize();
  const query = await provider.createQuery({ domain: value.settings.overview, search: 'ready' });
  return { provider, query, value };
}
async function traverse(provider, query, input) {
  const records = []; let cursor, pages = 0;
  do {
    const result = await provider.queryRecords(query.queryId, { ...input, ...(cursor ? { cursor } : {}) });
    assert.equal(result.startIndex, records.length); assert.equal(result.pageIndex, pages++);
    records.push(...result.items.map(item => item.record)); cursor = result.nextCursor;
    assert.equal(result.endIndex, records.length);
    if (!cursor) assert.equal(result.total, records.length);
  } while (cursor);
  return records;
}
test('table sorting and paging traverse the complete filtered snapshot independently of rows', async () => {
  const { provider, query, value } = await setup();
  const input = { sort: [{ field: 'title', direction: 'asc' }], limit: 25 };
  const records = await traverse(provider, query, input);
  assert.equal(records.length, 260); assert.equal(new Set(records.map(record => record.id)).size, 260);
  assert.deepEqual(records.map(record => record.title), value.records.map(record => record.title).sort());
  const first = await provider.queryRecords(query.queryId, input);
  await provider.executeCommand({ type: 'update', recordId: records[0].id, expectedVersion: 1, generation: provider.generation, clientCommandId: crypto.randomUUID(), payload: { title: 'ZZZZ changed' } });
  assert.equal((await provider.queryRecords(query.queryId, input)).items[0].record.title, records[0].title);
  await assert.rejects(provider.queryRecords(query.queryId, { ...input, limit: 50, cursor: first.nextCursor }), { code: 'invalid_table_cursor' });
  await provider.queryRecords(query.queryId, { sort: [{ field: 'order', direction: 'desc' }] });
  await provider.queryRecords(query.queryId, { sort: [{ field: 'sourceId', direction: 'asc' }] });
  assert.equal((await provider.queryRecords(query.queryId, { ...input, cursor: first.nextCursor })).startIndex, 25);
  assert.ok(provider.queries.get(query.queryId).tables.size <= 2);
  const other = await provider.createQuery({ domain: value.settings.overview });
  await assert.rejects(provider.queryRecords(other.queryId, { ...input, cursor: first.nextCursor }), { code: 'invalid_table_cursor' });
  provider.dispose();
});
test('table exact-window overlap and search projection have independent truthful counts', async () => {
  const value = fixture(4);
  value.records[0] = { ...value.records[0], kind: 'session', start: '2026-09-12T08:00:00.000Z', end: '2026-09-12T13:00:00.000Z' };
  value.records[1].start = '2026-09-12T10:00:00.000Z';
  value.records[2].start = '2026-09-12T11:00:00.000Z';
  value.records[3].start = '2027-01-01T00:00:00.000Z';
  const { provider, query } = await setup(value);
  const window = { from: '2026-09-12T10:00:00.000Z', to: '2026-09-12T11:00:00.000Z' };
  const context = await provider.queryRecords(query.queryId, { scope: 'window', window });
  assert.equal(context.total, 2); assert.equal(context.matchTotal, 1); assert.equal(context.matchActive, true);
  const matches = await provider.queryRecords(query.queryId, { scope: 'window', window, projection: 'matches' });
  assert.equal(matches.total, 1); assert.equal(matches.baseTotal, 2);
  assert.equal((await provider.queryRecords(query.queryId)).total, 4);
  const fraction = await provider.queryRecords(query.queryId, { scope: 'window', window: { ...window, viewFromMs: `${Date.parse(window.from)}.5`, viewToMs: `${Date.parse(window.to)}.5` } });
  assert.equal(fraction.window.to, '2026-09-12T11:00:00.001Z');
  assert.deepEqual(fraction.items.map(item => item.record.id), [value.records[0].id, value.records[2].id]);
  provider.dispose();
});
test('table ordering is codepoint-stable with null/missing last and rejects invalid fields anywhere', async () => {
  assert.ok(compareText('\uE000', '\u{10000}') < 0); assert.equal(compareText('e\u0301', '\u00E9'), 0);
  const value = fixture(4); value.records[0].data.status = null; delete value.records[1].data.status;
  value.records[2].data.status = 'Alpha'; value.records[3].data.status = 'Zulu';
  const parameters = normalizeTableInput({ sort: [{ field: 'data.status', direction: 'desc' }] }, value.settings.overview);
  const result = buildRecordTable({ records: value.records, matches: new Set(), hasSearch: false }, parameters);
  assert.deepEqual(result.items.map(item => item.record.data.status), ['Zulu', 'Alpha', null, undefined]);
  await assert.rejects(setup(value), { code: 'invalid_record_data' });
  const { provider, query } = await setup(fixture(4));
  await assert.rejects(provider.queryRecords(query.queryId, { sort: [{ field: 'data.executable', direction: 'asc' }] }), { code: 'invalid_table_sort' });
  await assert.rejects(provider.queryRecords(query.queryId, { limit: true }), { code: 'invalid_table_query' });
  const invalid = fixture(200); invalid.records.at(-1).data.status = 42;
  await assert.rejects(setup(invalid), { code: 'invalid_record_data' });
  assert.throws(() => buildRecordTable({ records: invalid.records, matches: new Set(), hasSearch: false }, parameters), { code: 'invalid_table_sort' });
  provider.dispose();
});
test('table byte pages preserve every record within the response ceiling', async () => {
  const value = fixture(18);
  value.records.forEach(record => { record.data.description = 'x'.repeat(200000); });
  const { provider, query } = await setup(value);
  const first = await provider.queryRecords(query.queryId, { limit: 1000 });
  assert.ok(first.items.length < 18); assert.ok(new TextEncoder().encode(JSON.stringify(first)).length < 2 * 1024 * 1024);
  assert.equal((await traverse(provider, query, { limit: 1000 })).length, 18);
  provider.dispose();
});
