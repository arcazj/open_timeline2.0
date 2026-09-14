import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { startServer } from './server-fixture.mjs';
import { prepareScaledQuery } from '../../client/src/timeline/optimize-scale.js';

let fixture, server;
before(async () => {
  fixture = JSON.parse(await readFile(new URL('../../shared/fixtures/initial-snapshot.json', import.meta.url), 'utf8'));
  server = await startServer();
});
after(async () => { await server?.stop(); });

test('row-aware scaling agrees on the Python server and complete Local dataset up to 32x', async () => {
  const local = new LocalProvider(structuredClone(fixture));
  const remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token, workspaceId: 'default' });
  await local.initialize(); await remote.initialize();
  try {
    const input = { domain: fixture.settings.overview, filters: {}, scaleMode: 'adaptive', ratio: 32, bins: 128 };
    const prepare = provider => prepareScaledQuery(provider, input, (query, map) => provider.createLayout(query.queryId, {
      ...fixture.settings.range, mapId: map.mapId, width: 1100, availableHeight: 64, rowHeight: 32, fontSize: 13,
    }));
    const left = await prepare(local), right = await prepare(remote);
    assert.equal(left.map.ratio, right.map.ratio);
    assert.equal(left.layout.totalRows, right.layout.totalRows);
    assert.ok(left.layout.totalRows <= left.baselineRows);
    assert.equal((await collect(local, left.query.queryId, left.layout.layoutId)).length,
      (await collect(remote, right.query.queryId, right.layout.layoutId)).length);
    await local.releaseQuery(left.query.queryId); await remote.releaseQuery(right.query.queryId);
  } finally { await local.dispose(); await remote.dispose(); }
});

async function collect(provider, queryId, layoutId) {
  const rows = [];
  let cursor;
  for (let i = 0; i < 100; i++) {
    const page = await provider.getRows(queryId, layoutId, cursor ? { cursor } : {});
    assert.equal(page.pageComplete, true);
    rows.push(...page.items.filter(item => item.record).map(item => ({
      id: item.record.id, row: item.row, xStart: item.xStart, xEnd: item.xEnd,
      labelX: item.labelX, labelWidth: item.labelWidth, match: item.match,
    })));
    if (!page.nextCursor) return rows;
    cursor = page.nextCursor;
  }
  throw new Error('Pagination did not terminate');
}

for (const mode of ['uniform', 'adaptive']) {
  test(`${mode}: real Python HTTP and Local agree on full-filter density, map, rows and search`, async () => {
    const local = new LocalProvider(structuredClone(fixture));
    const remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token, workspaceId: 'default' });
    await local.initialize(); await remote.initialize();
    try {
      const input = { domain: fixture.settings.overview, filters: { sourceId: 'all', kind: 'all' }, search: 'Telemetry', scaleMode: mode, ratio: 4, bins: 128 };
      const lq = await local.createQuery(input), rq = await remote.createQuery(input);
      for (const name of ['baseTotal', 'matchTotal', 'overviewTotal', 'overviewMatchTotal']) assert.equal(lq[name], rq[name], name);
      assert.equal(lq.baseTotal, 48); assert.equal(lq.matchTotal, 5);
      const ld = await local.getDensity(lq.queryId), rd = await remote.getDensity(rq.queryId);
      assert.equal(ld.bins.length, rd.bins.length);
      for (let i = 0; i < ld.bins.length; i++) {
        for (const name of ['from', 'to', 'points', 'endpoints']) assert.equal(ld.bins[i][name], rd.bins[i][name], `${i}:${name}`);
        assert.equal(String(ld.bins[i].overlapMs), String(rd.bins[i].overlapMs));
        assert.ok(Math.abs(ld.bins[i].density - rd.bins[i].density) < 1e-9);
      }
      const lm = await local.getMap(lq.queryId, lq.mapId), rm = await remote.getMap(rq.queryId, rq.mapId);
      assert.equal(lm.knots.length, rm.knots.length);
      lm.knots.forEach((k, i) => {
        assert.equal(k.timeMs, rm.knots[i].timeMs);
        assert.ok(Math.abs(Number(k.u) - Number(rm.knots[i].u)) < 1e-12);
      });
      const layoutInput = { ...fixture.settings.range, width: 1100, availableHeight: 128, rowHeight: 32, fontSize: 13, groupBy: 'none', renderProfileId: 'noto-sans-latin-v1' };
      const ll = await local.createLayout(lq.queryId, { ...layoutInput, mapId: lq.mapId });
      const rl = await remote.createLayout(rq.queryId, { ...layoutInput, mapId: rq.mapId });
      assert.equal(ll.totalRows, rl.totalRows); assert.equal(ll.detailTotal, rl.detailTotal);
      const left = await collect(local, lq.queryId, ll.layoutId), right = await collect(remote, rq.queryId, rl.layoutId);
      assert.equal(left.length, right.length);
      left.forEach((item, i) => {
        for (const name of ['id', 'row', 'match']) assert.equal(item[name], right[i][name], `${i}:${name}`);
        for (const name of ['xStart', 'xEnd', 'labelX', 'labelWidth']) assert.ok(Math.abs(item[name] - right[i][name]) < 0.01, `${i}:${name}: ${item[name]} / ${right[i][name]}`);
      });
      assert.equal(new Set(left.map(item => item.id)).size, left.length);
      const lo = await local.getOverview(lq.queryId), ro = await remote.getOverview(rq.queryId);
      assert.deepEqual(lo.items.map(i => i.id).sort(), ro.items.map(i => i.id).sort());
      assert.equal(lo.items.length, 5);
      await local.releaseQuery(lq.queryId); await remote.releaseQuery(rq.queryId);
    } finally { await local.dispose(); await remote.dispose(); }
  });
}

test('server data is private and complete export is explicit, not a query-page cache', async () => {
  const url = `${server.baseUrl}/api/v1/workspaces/default`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(`${url}/snapshot`, { headers: { Authorization: `Bearer ${server.token}` } });
  assert.equal(response.status, 200);
  const exported = await response.json();
  assert.equal(exported.format, 'timeline-snapshot');
  assert.equal(exported.records.length, exported.manifest.recordCount);
  assert.equal(exported.records.length, fixture.records.length);
  assert.equal(exported.manifest.completeness, 'complete-for-declared-universe');
  assert.equal(JSON.stringify(exported).includes(server.token), false);
});
