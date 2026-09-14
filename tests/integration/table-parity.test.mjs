import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server-fixture.mjs';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { publishSchema, schemaPin } from './configuration-fixture.mjs';

const server = await startServer();
test.after(() => server.stop());
const remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token });
await remote.initialize();
const fields = ['scope', 'window', 'projection', 'sort', 'limit', 'total', 'baseTotal', 'matchTotal', 'matchActive', 'items', 'startIndex', 'endIndex', 'pageIndex', 'pageCount', 'pageComplete'];
function compare(a, b) { for (const field of fields) assert.deepEqual(a[field], b[field], field); }

test('real HTTP table parity covers complete sorts, independent scopes, search and fractional windows', async () => {
  const snapshot = await remote.exportSnapshot(), local = new LocalProvider(snapshot); await local.initialize();
  const request = { domain: snapshot.settings.overview, search: 'Telemetry; "Archive checksum"' };
  const a = await local.createQuery(request), b = await remote.createQuery(request);
  try {
    for (const sort of [[{ field: 'title', direction: 'asc' }], [{ field: 'end', direction: 'desc' }], [{ field: 'sourceId', direction: 'asc' }, { field: 'start', direction: 'desc' }]]) {
      let leftCursor, rightCursor; const ids = [];
      do {
        const input = { sort, limit: 7 };
        const left = await local.queryRecords(a.queryId, { ...input, cursor: leftCursor }), right = await remote.queryRecords(b.queryId, { ...input, cursor: rightCursor });
        compare(left, right); ids.push(...right.items.map(item => item.record.id)); leftCursor = left.nextCursor; rightCursor = right.nextCursor;
      } while (rightCursor);
      assert.equal(new Set(ids).size, snapshot.records.filter(record => !record.deletedAt).length);
    }
    for (const projection of ['context', 'matches']) {
      const input = { scope: 'window', window: { from: '2026-09-12T12:10:00.000Z', to: '2026-09-12T12:20:00.000Z', viewFromMs: `${Date.parse('2026-09-12T12:10:00Z')}.5`, viewToMs: `${Date.parse('2026-09-12T12:20:00Z')}.5` }, projection };
      compare(await local.queryRecords(a.queryId, input), await remote.queryRecords(b.queryId, input));
    }
  } finally { local.dispose(); await remote.releaseQuery(b.queryId); }
});
test('real HTTP table pages remain pinned through writes and reject altered query semantics', async () => {
  const snapshot = await remote.exportSnapshot(), query = await remote.createQuery({ domain: snapshot.settings.overview });
  const input = { limit: 7, sort: [{ field: 'title', direction: 'asc' }] };
  try {
    const first = await remote.queryRecords(query.queryId, input), before = first.items[0].record;
    await remote.executeCommand({ type: 'update', recordId: before.id, expectedVersion: before.version, generation: remote.metadata.generation, clientCommandId: crypto.randomUUID(), payload: { title: 'ZZZZ moved after the last sorted record' } });
    assert.deepEqual((await remote.queryRecords(query.queryId, input)).items[0].record, before);
    await assert.rejects(remote.queryRecords(query.queryId, { ...input, limit: 8, cursor: first.nextCursor }), { code: 'invalid_table_cursor' });
    await assert.rejects(remote.queryRecords(query.queryId, { ...input, cursor: first.nextCursor + 'x' }), { code: 'invalid_table_cursor' });
  } finally { await remote.releaseQuery(query.queryId); }
});
test('canonical byte pagination agrees across providers for large records and numeric custom data', async () => {
  const schema = await publishSchema(remote, 'Large table numeric arrays', { numbers: { type: 'array', items: { type: 'number' } } });
  for (let index = 0; index < 12; index++) await remote.executeCommand({ type: 'create', generation: remote.metadata.generation, clientCommandId: crypto.randomUUID(), payload: { kind: 'event', title: `Large table item ${index}`, sourceId: 'operations', start: '2026-09-12T12:00:00.000Z', end: null, ...schemaPin(schema), data: { description: 'x'.repeat(200000), numbers: [1.0, 0.00001, 1e-7, 2.5], status: 'large' } } });
  const snapshot = await remote.exportSnapshot(), local = new LocalProvider(snapshot); await local.initialize();
  const input = { domain: snapshot.settings.overview }, a = await local.createQuery(input), b = await remote.createQuery(input);
  try {
    let leftCursor, rightCursor, count = 0;
    do {
      const left = await local.queryRecords(a.queryId, { limit: 1000, cursor: leftCursor }), right = await remote.queryRecords(b.queryId, { limit: 1000, cursor: rightCursor });
      compare(left, right); assert.ok(Buffer.byteLength(JSON.stringify(right)) <= 2 * 1024 * 1024);
      count += right.items.length; leftCursor = left.nextCursor; rightCursor = right.nextCursor;
    } while (rightCursor);
    assert.equal(count, snapshot.records.filter(record => !record.deletedAt).length);
  } finally { local.dispose(); await remote.releaseQuery(b.queryId); }
});
