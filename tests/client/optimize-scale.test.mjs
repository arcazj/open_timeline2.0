import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareScaledQuery } from '../../client/src/timeline/optimize-scale.js';
import { LocalProvider } from '../../client/src/data/local-provider.js';

const input = { scaleMode: 'adaptive', ratio: 32 };
function mock(counts) {
  const live = new Map(), tried = [];
  const provider = {
    async createQuery(request) {
      const query = { queryId: String(request.ratio), mapId: String(request.ratio), generation: 'g', revision: 1 };
      live.set(query.queryId, query); tried.push(request.ratio);
      assert.ok(live.size <= 1);
      return query;
    },
    async getMap(id) { return { mapId: id, ratio: Number(id) }; },
    async releaseQuery(id) { live.delete(id); },
  };
  return { live, tried, provider, layout: async query => ({ totalRows: counts[query.queryId] ?? 12, detailTotal: 50 }) };
}

test('chooses fewer full-layout rows, including above 4x; ties prefer less distortion', async () => {
  const m = mock({ 1: 12, 2: 10, 4: 8, 8: 6, 16: 3, 32: 3 });
  const result = await prepareScaledQuery(m.provider, input, m.layout);
  assert.equal(result.map.ratio, 16);
  assert.equal(result.layout.totalRows, 3);
  assert.equal(result.baselineRows, 8);
  assert.deepEqual([...m.live.keys()], ['16']);
});
test('simultaneous items retain required rows and do not force maximum distortion', async () => {
  const m = mock({});
  const result = await prepareScaledQuery(m.provider, input, m.layout);
  assert.equal(result.map.ratio, 4);
  assert.equal(result.layout.totalRows, 12);
});
test('manual mode applies the selected ratio without optimization', async () => {
  const m = mock({});
  const result = await prepareScaledQuery(m.provider, input, m.layout, { optimize: false });
  assert.deepEqual(m.tried, [32]); assert.equal(result.map.ratio, 32);
});

test('candidate preparation waits for cleanup and rechecks navigation intent', async () => {
  const m = mock({}); let finish, current = true;
  m.provider.awaitPreparationCleanup = () => new Promise(resolve => { finish = resolve; });
  const pending = prepareScaledQuery(m.provider, input, m.layout, { isCurrent: () => current });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(m.tried, []);
  current = false; finish();
  assert.equal(await pending, null);
  assert.equal(m.live.size, 0);
});

test('every candidate drains cleanup left by a retryable layout error', async () => {
  const m = mock({ 8: 1 }); let pendingCleanup = false, drains = 0;
  const createQuery = m.provider.createQuery;
  m.provider.createQuery = request => { assert.equal(pendingCleanup, false); return createQuery(request); };
  m.provider.awaitPreparationCleanup = async () => { pendingCleanup = false; drains++; };
  const result = await prepareScaledQuery(m.provider, input, async query => {
    if (query.queryId === '4') { pendingCleanup = true; throw Object.assign(new Error('Wide label'), { code: 'label_width_limit' }); }
    return m.layout(query);
  });
  assert.equal(result.map.ratio, 8); assert.equal(drains, 2);
  assert.deepEqual([...m.live.keys()], ['8']);
});
test('canceled preparations release every unpublished query', async () => {
  const m = mock({}); let active = true;
  const result = await prepareScaledQuery(m.provider, input, async q => { active = false; return m.layout(q); }, { isCurrent: () => active });
  assert.equal(result, null); assert.equal(m.live.size, 0);
});
test('failed preparations release both best and candidate handles', async () => {
  const m = mock({});
  await assert.rejects(prepareScaledQuery(m.provider, input, async q => {
    if (q.queryId === '8') throw new Error('offline'); return m.layout(q);
  }), /offline/);
  assert.equal(m.live.size, 0);
});
test('live revisions are never compared or mixed', async () => {
  const m = mock({}), original = m.provider.createQuery;
  m.provider.createQuery = async r => ({ ...await original(r), revision: r.ratio === 4 ? 1 : 2 });
  const result = await prepareScaledQuery(m.provider, input, m.layout);
  assert.equal(result.query.revision, 2); assert.deepEqual([...m.live.keys()], ['8']);
});
test('real Local layouts reduce clustered label rows and remain fixed across pages', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../../shared/fixtures/initial-snapshot.json', import.meta.url), 'utf8'));
  const template = snapshot.records[0];
  snapshot.records = Array.from({ length: 16 }, (_, i) => ({ ...structuredClone(template),
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, title: `Cluster label ${i}`,
    kind: 'event', start: new Date(Date.parse('2026-09-12T08:00:00Z') + i * 30000).toISOString(),
    end: null, parentSessionId: null, render: {},
  }));
  snapshot.manifest.recordCount = snapshot.records.length;
  delete snapshot.manifest.contentSha256;
  const provider = new LocalProvider(snapshot); await provider.initialize();
  try {
    const query = { ...input, domain: snapshot.settings.overview, filters: {}, bins: 128 };
    const displayed = await provider.createQuery({ ...query, ratio: 4 });
    const result = await prepareScaledQuery(provider, query, (q, map) => provider.createLayout(q.queryId, {
      ...snapshot.settings.overview, width: 1100, availableHeight: 32, rowHeight: 32, fontSize: 13, mapId: map.mapId,
    }));
    assert.ok(result.layout.totalRows < result.baselineRows);
    assert.ok(result.map.ratio > 4);
    assert.equal((await provider.getQuery(displayed.queryId)).queryId, displayed.queryId);
    assert.equal(provider.queries.size, 2);
    const mapping = await provider.getMap(result.query.queryId, result.map.mapId);
    let cursor, pages = 0;
    do {
      const page = await provider.getRows(result.query.queryId, result.layout.layoutId, { cursor });
      cursor = page.nextCursor; pages++;
      assert.deepEqual(await provider.getMap(result.query.queryId, result.map.mapId), mapping);
    } while (cursor);
    assert.ok(pages > 1);
  } finally { await provider.dispose(); }
});
