import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server-fixture.mjs';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { publishSchema, schemaPin } from './configuration-fixture.mjs';

const domain = { from: '2030-03-18T10:00:00.000Z', to: '2030-03-18T11:00:00.000Z' };
const server = await startServer();
const remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token });
await remote.initialize();
let local;
test.after(async () => { local?.dispose(); remote.dispose(); await server.stop(); });
const schema = await publishSchema(remote, 'Version 2 ordering parity', { namespace: { type: ['string', 'null'] } });
const values = ['SOURCE2', 'SOURCE10', 'SOURCE1', 'SOURCE02', null, undefined, '(missing)'];
const ids = [];
for (const [index, namespace] of values.entries()) {
  const response = await remote.executeCommand({ type: 'create', generation: remote.metadata.generation, clientCommandId: crypto.randomUUID(), payload: {
    title: `Ordering ${index}`, kind: 'session', sourceId: 'operations', ...schemaPin(schema),
    start: '2030-03-18T10:10:00.000Z', end: '2030-03-18T10:50:00.000Z', data: namespace === undefined ? {} : { namespace },
  } });
  ids.push(response.record.id);
}
local = new LocalProvider(await remote.exportSnapshot()); await local.initialize();
const request = { definitionVersion: 2, domain, filters: { schemaRefs: [{ id: schema.id, version: 1 }] } };

test('real HTTP and local natural sorting traverse every ID and bind all ordering options to cursors', async () => {
  const lq = await local.createQuery(request), rq = await remote.createQuery(request);
  try {
    for (const [direction, indices] of [['asc', [6, 2, 0, 3, 1, 4, 5]], ['desc', [1, 3, 0, 2, 6, 4, 5]]]) {
      const input = { sort: [{ field: '/data/namespace', direction, order: 'natural' }], limit: 2 };
      let lc, rc, first;
      const found = [];
      do {
        const lp = await local.queryRecords(lq.queryId, { ...input, cursor: lc }), rp = await remote.queryRecords(rq.queryId, { ...input, cursor: rc });
        for (const field of ['definitionVersion', 'items', 'sort', 'total', 'baseTotal', 'contextTotal', 'matchTotal', 'startIndex', 'endIndex']) assert.deepEqual(lp[field], rp[field], field);
        assert.equal(rp.baseTotal, values.length); assert.equal(rp.contextTotal, 0);
        first ??= { lp, rp }; found.push(...rp.items.map(item => item.record.id)); lc = lp.nextCursor; rc = rp.nextCursor;
      } while (rc);
      assert.deepEqual(found, indices.map(index => ids[index]));
      assert.equal(new Set(found).size, ids.length);
      for (const [provider, query, cursor] of [[local, lq, first.lp.nextCursor], [remote, rq, first.rp.nextCursor]]) {
        await assert.rejects(provider.queryRecords(query.queryId, { ...input, sort: [{ ...input.sort[0], order: 'codepoint' }], cursor }), { code: 'invalid_table_cursor' });
        await assert.rejects(provider.queryRecords(query.queryId, { ...input, sort: [{ ...input.sort[0], caseSensitive: false }], cursor }), { code: 'invalid_table_cursor' });
      }
    }
  } finally { await local.releaseQuery(lq.queryId); await remote.releaseQuery(rq.queryId); }
});

test('natural namespace group order agrees over HTTP without changing geometry or membership', async () => {
  const lq = await local.createQuery(request), rq = await remote.createQuery(request);
  try {
    for (const [direction, names] of [
      ['asc', ['(missing)', 'SOURCE1', 'SOURCE2', 'SOURCE02', 'SOURCE10', '(null)', '(missing)']],
      ['desc', ['SOURCE10', 'SOURCE02', 'SOURCE2', 'SOURCE1', '(missing)', '(null)', '(missing)']],
    ]) {
      const input = { ...domain, width: 1000, availableHeight: 128, groupOrder: { order: 'natural' }, presentation: { version: 1, grouping: { field: '/data/namespace', direction } } };
      const ll = await local.createLayout(lq.queryId, { ...input, mapId: lq.mapId }), rl = await remote.createLayout(rq.queryId, { ...input, mapId: rq.mapId });
      try {
        let lc, rc;
        const groups = new Map(), found = [];
        do {
          const lp = await local.getRows(lq.queryId, ll.layoutId, { cursor: lc }), rp = await remote.getRows(rq.queryId, rl.layoutId, { cursor: rc });
          assert.deepEqual(lp.rows, rp.rows); assert.equal(lp.items.length, rp.items.length);
          for (const [index, item] of lp.items.entries()) {
            const remoteItem = rp.items[index];
            assert.equal(item.record.id, remoteItem.record.id); assert.equal(item.row, remoteItem.row);
            for (const field of ['xStart', 'xEnd', 'labelX', 'footprintStart', 'footprintEnd']) assert.ok(Math.abs(item[field] - remoteItem[field]) < 1e-7, field);
          }
          for (const row of lp.rows) if (!groups.has(row.key)) groups.set(row.key, row.name);
          found.push(...rp.items.map(item => item.record.id)); lc = lp.nextCursor; rc = rp.nextCursor;
        } while (rc);
        assert.deepEqual([...groups.values()], names);
        assert.equal(new Set(groups.keys()).size, names.length);
        assert.deepEqual(found.toSorted(), ids.toSorted());
      } finally { await local.releaseLayout(lq.queryId, ll.layoutId); await remote.releaseLayout(rq.queryId, rl.layoutId); }
    }
  } finally { await local.releaseQuery(lq.queryId); await remote.releaseQuery(rq.queryId); }
});

test('v2 continuation pages and collapse preserve pinned density, findings and complete placement', async () => {
  const added = [];
  for (let index = 0; index < 9; index++) {
    const result = await remote.executeCommand({ type: 'create', generation: remote.metadata.generation, clientCommandId: crypto.randomUUID(), payload: {
      title: `Continuation ${index}`, kind: 'session', sourceId: 'operations', ...schemaPin(schema),
      start: '2030-03-18T10:10:00.000Z', end: '2030-03-18T10:50:00.000Z',
      parentSessionId: index > 0 && index < 8 ? added[0] : null,
      data: { namespace: index < 8 ? 'SOURCE2' : 'SOURCE10' },
    } });
    added.push(result.record.id);
  }
  const standalone = new LocalProvider(await remote.exportSnapshot()); await standalone.initialize();
  const scoped = { ...request, search: 'Continuation', filters: { ...request.filters, expression: { version: 1, root: { op: 'contains', field: '/title', value: 'Continuation' } } } };
  const lq = await standalone.createQuery(scoped), rq = await remote.createQuery(scoped);
  try {
    const before = { local: await standalone.getDensity(lq.queryId), remote: await remote.getDensity(rq.queryId) };
    for (const collapsedGroups of [[], ['string:SOURCE2'], ['string:SOURCE2', 'string:SOURCE10']]) {
      const input = { ...domain, width: 1000, availableHeight: 132, collapsedGroups, groupOrder: { order: 'natural' }, presentation: { version: 1, grouping: { field: '/data/namespace' }, nesting: { enabled: true } } };
      const ll = await standalone.createLayout(lq.queryId, { ...input, mapId: lq.mapId }), rl = await remote.createLayout(rq.queryId, { ...input, mapId: rq.mapId });
      try {
        const lastIndex = Math.max(0, Math.ceil(ll.totalRows / ll.pageCapacity) - 1);
        const directLocal = await standalone.getRows(lq.queryId, ll.layoutId, { pageIndex: lastIndex });
        const directRemote = await remote.getRows(rq.queryId, rl.layoutId, { pageIndex: lastIndex });
        for (const field of ['rows', 'startRow', 'endRow', 'pageIndex', 'pageCount', 'loadedCount']) assert.deepEqual(directLocal[field], directRemote[field], field);
        assert.deepEqual(directLocal.items.map(item => [item.record.id, item.row]), directRemote.items.map(item => [item.record.id, item.row]));
        for (const field of ['definitionVersion', 'totalRows', 'detailTotal', 'detailMatchTotal', 'renderInstanceTotal', 'pageCapacity', 'logicalGroupTotal', 'collapsedGroupTotal', 'hiddenItemTotal']) assert.equal(ll[field], rl[field], field);
        assert.equal(ll.detailTotal, 9); assert.equal(ll.detailMatchTotal, 9); assert.equal(ll.logicalGroupTotal, 2);
        assert.equal(ll.hiddenItemTotal, collapsedGroups.length === 0 ? 0 : collapsedGroups.length === 1 ? 8 : 9);
        assert.equal(ll.renderInstanceTotal, 9 - ll.hiddenItemTotal);
        let lc, rc, continued = 0;
        const found = [];
        do {
          const lp = await standalone.getRows(lq.queryId, ll.layoutId, { cursor: lc }), rp = await remote.getRows(rq.queryId, rl.layoutId, { cursor: rc });
          assert.deepEqual(await standalone.getRows(lq.queryId, ll.layoutId, { pageIndex: lp.pageIndex }), lp);
          assert.deepEqual(await remote.getRows(rq.queryId, rl.layoutId, { pageIndex: rp.pageIndex }), rp);
          assert.deepEqual(lp.rows, rp.rows);
          assert.deepEqual(lp.items.map(item => [item.record.id, item.row]), rp.items.map(item => [item.record.id, item.row]));
          assert.ok(lp.items.length || lp.rows.some(row => row.collapsed), 'Only deliberately collapsed groups may have header-only pages');
          for (const row of lp.rows) {
            if (row.continuation) { continued++; assert.equal(row.row % ll.pageCapacity, 0); }
            if (!row.collapsed) assert.ok(row.row % ll.pageCapacity < ll.pageCapacity - 1);
          }
          found.push(...lp.items.map(item => item.record.id)); lc = lp.nextCursor; rc = rp.nextCursor;
        } while (rc);
        assert.equal(new Set(found).size, found.length);
        assert.deepEqual(found.toSorted(), (collapsedGroups.length === 0 ? added : collapsedGroups.length === 1 ? [added[8]] : []).toSorted());
        if (!collapsedGroups.length) assert.ok(continued > 0);
        for (const [provider, query, packed] of [[standalone, lq, ll], [remote, rq, rl]]) {
          for (const id of found) {
            const placement = await provider.getPlacement(query.queryId, packed.layoutId, id);
            const page = await provider.getRows(query.queryId, packed.layoutId, { cursor: placement.cursor });
            assert.ok(page.items.some(item => item.record.id === id));
          }
          if (collapsedGroups.length) assert.equal((await provider.getPlacement(query.queryId, packed.layoutId, added[0])).outsideLayout, true);
          assert.equal((await provider.queryRecords(query.queryId, { projection: 'matches' })).total, 9);
        }
        assert.deepEqual(await standalone.getDensity(lq.queryId), before.local);
        assert.deepEqual(await remote.getDensity(rq.queryId), before.remote);
      } finally { await standalone.releaseLayout(lq.queryId, ll.layoutId); await remote.releaseLayout(rq.queryId, rl.layoutId); }
    }
  } finally { await standalone.releaseQuery(lq.queryId); await remote.releaseQuery(rq.queryId); standalone.dispose(); }
});
