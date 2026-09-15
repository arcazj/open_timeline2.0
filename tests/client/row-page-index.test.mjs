import test from 'node:test';
import assert from 'node:assert/strict';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';

const domain = { from: '2026-09-12T10:00:00.000Z', to: '2026-09-12T11:00:00.000Z' };
async function fixture(count = 9, definitionVersion = 2) {
  const snapshot = structuredClone(initial);
  snapshot.records = Array.from({ length: count }, (_, index) => ({ ...structuredClone(initial.records[0]),
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, title: `Page ${index}`,
    kind: 'session', start: domain.from, end: domain.to, parentSessionId: null }));
  snapshot.manifest.recordCount = count;
  delete snapshot.manifest.contentSha256;
  const provider = new LocalProvider(snapshot); await provider.initialize();
  const query = await provider.createQuery({ domain, definitionVersion });
  const layout = await provider.createLayout(query.queryId, { ...domain, width: 1000, availableHeight: 132,
    rowHeight: 32, fontSize: 13, presentation: { version: 1, grouping: { field: '/sourceId' } } });
  return { provider, query, layout, get: options => provider.getRows(query.queryId, layout.layoutId, options) };
}

for (const version of [1, 2]) test(`direct row pages preserve v${version} cursor pages, groups and pinned geometry`, async () => {
  const { provider, get, query, layout } = await fixture(9, version);
  try {
    const density = await provider.getDensity(query.queryId), map = await provider.getMap(query.queryId);
    const pageCount = Math.ceil(layout.totalRows / layout.pageCapacity);
    assert.ok(pageCount > 2);
    const last = await get({ pageIndex: pageCount - 1 });
    assert.equal(last.pageIndex, pageCount - 1);
    let cursor;
    const pages = [];
    do {
      const page = await get({ cursor }); pages.push(page); cursor = page.nextCursor;
    } while (cursor);
    for (let index = pages.length - 1; index >= 0; index--) assert.deepEqual(await get({ pageIndex: index }), pages[index]);
    assert.deepEqual(last, pages.at(-1));
    assert.equal(new Set(pages.flatMap(page => page.items.map(item => item.record.id))).size, 9);
    if (version === 2) assert.ok(pages.slice(1).some(page => page.rows.some(row => row.continuation)));
    assert.deepEqual(await provider.getDensity(query.queryId), density);
    assert.deepEqual(await provider.getMap(query.queryId), map);
    await assert.rejects(get({ pageIndex: pageCount }), { code: 'invalid_page_index', status: 400 });
    await assert.rejects(get({ pageIndex: Number.MAX_SAFE_INTEGER }), { code: 'invalid_page_index', status: 400 });
    await assert.rejects(get({ cursor: 'foreign' }), { code: 'cursor_mismatch' });
  } finally { provider.dispose(); }
});

test('empty layouts expose only direct page zero', async () => {
  const { provider, get } = await fixture(0);
  try {
    assert.deepEqual(await get({ pageIndex: 0 }), await get({}));
    const page = await get({ pageIndex: 0 });
    assert.equal(page.pageCount, 1); assert.equal(page.loadedCount, 0); assert.equal(page.totalRows, 0);
    await assert.rejects(get({ pageIndex: 1 }), { code: 'invalid_page_index', status: 400 });
  } finally { provider.dispose(); }
});

test('both providers reject ambiguous or unsafe direct pages before sending requests', async () => {
  const local = await fixture(), remote = new ServerProvider();
  const requests = [];
  remote._request = async (path, options) => { requests.push({ path, options }); return { pageIndex: options.pageIndex }; };
  try {
    for (const get of [local.get, options => remote.getRows('query/id', 'layout/id', options)]) {
      for (const pageIndex of [-1, 0.5, null, true, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(get({ pageIndex }), { code: 'invalid_page_index', status: 422 });
      }
      for (const cursor of ['', 'cursor']) await assert.rejects(get({ pageIndex: 0, cursor }), { code: 'invalid_pagination', status: 422 });
    }
    assert.equal(requests.length, 0);
    await remote.getRows('query/id', 'layout/id', { pageIndex: 0, cursor: null });
    await remote.getRows('q', 'l', { pageIndex: 12 });
    await remote.getRows('q', 'l', { cursor: 'a+b/=' });
    assert.ok(requests[0].path.endsWith('/query%2Fid/layouts/layout%2Fid/rows?pageIndex=0'));
    assert.ok(requests[1].path.endsWith('/rows?pageIndex=12'));
    assert.ok(requests[2].path.endsWith('/rows?cursor=a%2Bb%2F%3D'));
  } finally { local.provider.dispose(); remote.dispose(); }
});
