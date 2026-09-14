import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { startLegacyServer, legacyDomain } from './legacy-server-fixture.mjs';

let server, snapshot;
before(async () => {
  server = await startLegacyServer();
  const remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token });
  try {
    await remote.initialize(); snapshot = await remote.exportSnapshot();
    // Parity compares complete datasets; cold provisional coverage is tested separately.
    const deadline = Date.now() + 10000;
    while (!(await remote.getLoadingStatus()).complete) {
      assert.ok(Date.now() < deadline, 'Legacy index must become complete for provider parity');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  finally { await remote.dispose(); }
});
after(async () => { await server?.stop(); });

const manifestFields = ['baseTotal', 'matchTotal', 'overviewTotal', 'overviewMatchTotal'];
async function providers() {
  const local = new LocalProvider(structuredClone(snapshot));
  const remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token });
  await local.initialize(); await remote.initialize();
  return [local, remote];
}
async function allRows(provider, query, layout) {
  const rows = [], pages = [], groups = [];
  let cursor;
  for (let index = 0; index < 100; index++) {
    const page = await provider.getRows(query.queryId, layout.layoutId, cursor ? { cursor } : {});
    assert.equal(page.pageComplete, true);
    pages.push({ pageIndex: page.pageIndex, startRow: page.startRow, endRow: page.endRow });
    groups.push(...page.rows.filter(row => row.type === 'group'));
    rows.push(...page.items.map(item => ({
      id: item.record?.id, kind: item.kind, row: item.row, group: item.group, match: item.match,
      xStart: item.xStart, xEnd: item.xEnd, labelX: item.labelX, labelWidth: item.labelWidth,
    })));
    if (!page.nextCursor) return { rows, pages, groups };
    cursor = page.nextCursor;
  }
  throw new Error('Legacy row pagination did not terminate');
}
function equalRows(left, right) {
  assert.deepEqual(left.pages, right.pages);
  assert.deepEqual(left.groups, right.groups);
  assert.equal(left.rows.length, right.rows.length);
  left.rows.forEach((item, index) => {
    for (const key of ['id', 'kind', 'row', 'group', 'match']) assert.deepEqual(item[key], right.rows[index][key], `${index}:${key}`);
    for (const key of ['xStart', 'xEnd', 'labelX', 'labelWidth']) {
      if (item[key] === undefined) assert.equal(right.rows[index][key], undefined);
      else assert.ok(Math.abs(item[key] - right.rows[index][key]) < .01, `${index}:${key}`);
    }
  });
}

for (const scaleMode of ['uniform', 'adaptive']) {
  test(`legacy ${scaleMode}: HTTP and complete Local snapshot agree on range, density, map, namespace pages and search`, async () => {
    const [local, remote] = await providers();
    try {
      const input = { domain: legacyDomain, search: 'Match_5_1', scaleMode, bins: 64, ratio: 4 };
      const queries = [await local.createQuery(input), await remote.createQuery(input)];
      for (const field of manifestFields) assert.equal(queries[0][field], queries[1][field], field);
      assert.equal(queries[0].baseTotal, 25);
      assert.equal(queries[0].matchTotal, 9);
      const densities = [await local.getDensity(queries[0].queryId), await remote.getDensity(queries[1].queryId)];
      assert.equal(densities[0].bins.length, densities[1].bins.length);
      densities[0].bins.forEach((bin, index) => {
        for (const key of ['from', 'to', 'points', 'endpoints']) assert.deepEqual(bin[key], densities[1].bins[index][key], `${index}:${key}`);
        assert.equal(String(bin.overlapMs), String(densities[1].bins[index].overlapMs));
        assert.ok(Math.abs(bin.density - densities[1].bins[index].density) < 1e-9);
      });
      const maps = [await local.getMap(queries[0].queryId, queries[0].mapId), await remote.getMap(queries[1].queryId, queries[1].mapId)];
      assert.deepEqual(maps[0].domain, maps[1].domain);
      assert.equal(maps[0].knots.length, maps[1].knots.length);
      maps[0].knots.forEach((knot, index) => {
        assert.equal(knot.timeMs, maps[1].knots[index].timeMs);
        assert.ok(Math.abs(Number(knot.u) - Number(maps[1].knots[index].u)) < 1e-12);
      });
      const layoutInput = { ...legacyDomain, width: 1100, availableHeight: 128, rowHeight: 32, fontSize: 12,
        groupBy: 'none', presentation: snapshot.settings.presentation, renderProfileId: 'noto-sans-latin-v1' };
      const layouts = [await local.createLayout(queries[0].queryId, { ...layoutInput, mapId: queries[0].mapId }),
        await remote.createLayout(queries[1].queryId, { ...layoutInput, mapId: queries[1].mapId })];
      for (const key of ['totalRows', 'detailTotal', 'pageCapacity', 'pageCount']) assert.equal(layouts[0][key], layouts[1][key], key);
      const left = await allRows(local, queries[0], layouts[0]), right = await allRows(remote, queries[1], layouts[1]);
      equalRows(left, right);
      assert.deepEqual(left.groups.map(group => group.name).sort(), ['alpha', 'beta']);
      assert.ok(left.pages.length > 1);
      const ids = left.rows.filter(row => row.id).map(row => row.id);
      assert.equal(new Set(ids).size, 25);
      assert.equal(ids.length, 25);
      for (const id of ['long', 'parent', 'child-a', 'child-b', 'at-start', 'ongoing']) {
        assert.ok(snapshot.records.some(record => record.extensions.legacy.id === id && ids.includes(record.id)), id);
      }
      for (const id of ['old', 'old-child', 'at-end']) {
        assert.ok(snapshot.records.some(record => record.extensions.legacy.id === id && !ids.includes(record.id)), id);
      }
      assert.deepEqual(await local.getMap(queries[0].queryId, queries[0].mapId), maps[0]);
      assert.deepEqual(await remote.getMap(queries[1].queryId, queries[1].mapId), maps[1]);
      const overview = [await local.getOverview(queries[0].queryId), await remote.getOverview(queries[1].queryId)];
      assert.deepEqual(overview[0].items.map(item => item.id).sort(), overview[1].items.map(item => item.id).sort());
      assert.equal(overview[0].items.length, 9);
      const zones = [await local.getZones(queries[0].queryId), await remote.getZones(queries[1].queryId)];
      assert.deepEqual(zones[0], zones[1]);
      assert.equal(zones[0].items.length, 2);
    } finally { await local.dispose(); await remote.dispose(); }
  });
}

test('legacy table sorting, cursor pages and search scopes agree without using the full archive as query rows', async () => {
  const [local, remote] = await providers();
  try {
    const request = { domain: legacyDomain, search: 'Match_5_1' };
    const queries = [await local.createQuery(request), await remote.createQuery(request)];
    for (const projection of ['context', 'matches']) {
      let a, b; const ids = [];
      do {
        const input = { projection, sort: [{ field: 'title', direction: 'asc' }], limit: 3 };
        const left = await local.queryRecords(queries[0].queryId, { ...input, cursor: a });
        const right = await remote.queryRecords(queries[1].queryId, { ...input, cursor: b });
        for (const key of ['scope', 'projection', 'sort', 'limit', 'total', 'baseTotal', 'matchTotal', 'items', 'startIndex', 'endIndex', 'pageIndex', 'pageCount', 'pageComplete']) {
          assert.deepEqual(left[key], right[key], key);
        }
        ids.push(...left.items.map(item => item.record.id));
        a = left.nextCursor; b = right.nextCursor;
        assert.equal(Boolean(a), Boolean(b));
      } while (b);
      assert.equal(ids.length, projection === 'context' ? 25 : 9);
      assert.equal(new Set(ids).size, ids.length);
    }
  } finally { await local.dispose(); await remote.dispose(); }
});

test('legacy complete export retains records outside the viewed day and never modifies source files', async () => {
  assert.equal(snapshot.manifest.legacy.readOnly, true);
  assert.equal(snapshot.manifest.recordCount, snapshot.records.length);
  assert.equal(snapshot.records.length, 28);
  assert.equal(snapshot.manifest.legacy.allRecordCount, 28);
  assert.equal(snapshot.manifest.legacy.declaredRange, null);
  assert.ok(snapshot.records.some(record => record.extensions.legacy.id === 'old'));
  assert.ok(snapshot.records.some(record => record.extensions.legacy.id === 'at-end'));
  const forbidden = await fetch(`${server.baseUrl}/api/v1/workspaces/default/records`, {
    method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Not allowed', kind: 'event', start: legacyDomain.from }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, 'legacy_read_only');
  for (const [filename, bytes] of server.originals) assert.deepEqual(await readFile(filename), bytes, filename);
});

test('legacy source filters and navigation to older partitions remain available in both providers', async () => {
  const [local, remote] = await providers();
  try {
    const alpha = snapshot.sources.find(source => source.name === 'alpha').id;
    for (const [input, expected] of [
      [{ domain: legacyDomain, filters: { sourceId: alpha, kind: 'all' }, search: 'Match_5_1' }, { base: 21, match: 7 }],
      [{ domain: { from: '2023-12-31T00:00:00.000Z', to: '2024-01-01T00:00:00.000Z' } }, { base: 2, match: 2 }],
    ]) {
      const left = await local.createQuery(input), right = await remote.createQuery(input);
      for (const field of manifestFields) assert.equal(left[field], right[field], field);
      assert.equal(left.baseTotal, expected.base);
      assert.equal(left.matchTotal, expected.match);
      const lrows = await local.queryRecords(left.queryId, {}), rrows = await remote.queryRecords(right.queryId, {});
      assert.deepEqual(lrows.items, rrows.items);
      await local.releaseQuery(left.queryId); await remote.releaseQuery(right.queryId);
    }
  } finally { await local.dispose(); await remote.dispose(); }
});

test('selected server paths scope both records and zones identically, including an empty selection', async () => {
  const [local, remote] = await providers();
  try {
    const alpha = snapshot.sources.find(source => source.name === 'alpha').id;
    const beta = snapshot.sources.find(source => source.name === 'beta').id;
    for (const [sourceIds, count, zoneCount] of [[[alpha, beta], 25, 2], [[alpha], 21, 1], [[], 0, 0]]) {
      const input = { domain: legacyDomain, filters: { sourceIds, kind: 'all' }, scaleMode: 'adaptive' };
      const left = await local.createQuery(input), right = await remote.createQuery(input);
      assert.equal(left.baseTotal, count); assert.equal(right.baseTotal, count);
      const localZones = await local.getZones(left.queryId), remoteZones = await remote.getZones(right.queryId);
      assert.deepEqual(localZones, remoteZones); assert.equal(localZones.items.length, zoneCount);
      await local.releaseQuery(left.queryId); await remote.releaseQuery(right.queryId);
    }
  } finally { await local.dispose(); await remote.dispose(); }
});
