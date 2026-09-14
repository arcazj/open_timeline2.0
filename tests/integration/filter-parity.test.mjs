import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server-fixture.mjs';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { publishSchema, schemaPin } from './configuration-fixture.mjs';

let server, local, remote, schema;
const records = [];
const from = '2031-01-01T10:00:00.000Z', to = '2031-01-01T11:00:00.000Z';
const tag = { op: 'contains', field: '/tags', value: 'filter-fixture' };
const overlap = { op: 'overlaps', from, to };
const expression = node => ({ version: 1, root: { op: 'and', args: [tag, overlap, ...(node ? [node] : [])] } });
const query = node => ({ domain: { from, to }, filters: { expression: expression(node), schemaRefs: [{ id: schema.id, version: 1 }] }, scaleMode: 'adaptive', bins: 16, ratio: 4 });
const leaf = (op, field, value) => ({ op, field, value });
before(async () => {
  server = await startServer(); remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token }); await remote.initialize();
  schema = await publishSchema(remote, 'Nullable filter status', { testStatus: { type: ['string', 'null'] } });
  const values = [
    { title: 'Alpha Beta', data: { status: 'Ready', description: 'first' }, start: from, tags: ['Urgent', 'STRASSE'] },
    { title: 'alpha', data: { status: null, description: 'Beta' }, start: '2031-01-01T10:10:00Z' },
    { title: 'Stra\u00dfe', data: { description: 'third' }, start: '2031-01-01T10:20:00Z' },
    { title: 'literal .* token', data: { status: 'Done' }, kind: 'session', start: '2031-01-01T09:30:00Z', end: '2031-01-01T10:30:00Z' },
    { title: 'Boundary before', data: { status: 'Ready' }, kind: 'session', start: '2031-01-01T09:00:00Z', end: from },
    { title: 'Boundary after', data: { status: 'Ready' }, start: to },
    { title: '\u00c9lan', data: { status: 'Ready', description: '\u03a3\u03c2' }, kind: 'session', start: '2031-01-01T10:30:00Z', end: '2031-01-01T10:30:00Z' },
    { title: 'Ongoing "quoted" path\\name', data: { status: 'Error' }, kind: 'session', start: '2031-01-01T09:00:00Z' },
  ];
  for (let i = 0; i < values.length; i++) {
    const data = { ...values[i].data };
    if (Object.hasOwn(data, 'status')) { data.testStatus = data.status; delete data.status; }
    const payload = { kind: 'event', end: null, sourceId: 'operations', order: i, ...values[i], data, ...schemaPin(schema), tags: ['filter-fixture', ...(values[i].tags ?? [])] };
    records.push((await remote.executeCommand({ type: 'create', generation: remote.metadata.generation, clientCommandId: crypto.randomUUID(), payload })).record);
  }
  local = new LocalProvider(await remote.exportSnapshot()); await local.initialize();
});
after(async () => { local?.dispose(); remote?.dispose(); await server?.stop(); });

async function run(input, expected, expectedMatches = expected) {
  const left = await local.createQuery(input), right = await remote.createQuery(input);
  try {
    for (const field of ['baseTotal', 'matchTotal', 'overviewTotal', 'overviewMatchTotal', 'state']) assert.deepEqual(left[field], right[field], field);
    const lt = await local.queryRecords(left.queryId, { sort: [{ field: 'order', direction: 'asc' }] }), rt = await remote.queryRecords(right.queryId, { sort: [{ field: 'order', direction: 'asc' }] });
    assert.deepEqual(lt.items, rt.items);
    assert.deepEqual(lt.items.map(item => item.record.id), expected.map(index => records[index].id));
    assert.deepEqual(lt.items.filter(item => item.match).map(item => item.record.id), expectedMatches.map(index => records[index].id));
    assert.deepEqual(await local.getDensity(left.queryId), await remote.getDensity(right.queryId));
    const lm = await local.getMap(left.queryId, left.mapId), rm = await remote.getMap(right.queryId, right.mapId);
    assert.equal(lm.knots.length, rm.knots.length);
    lm.knots.forEach((knot, i) => { assert.equal(knot.timeMs, rm.knots[i].timeMs); assert.ok(Math.abs(Number(knot.u) - Number(rm.knots[i].u)) < 1e-12); });
    assert.deepEqual(await local.getOverview(left.queryId), await remote.getOverview(right.queryId));
    return { density: await local.getDensity(left.queryId), knots: lm.knots };
  } finally { await local.releaseQuery(left.queryId); await remote.releaseQuery(right.queryId); }
}

test('every typed expression operator agrees over real JSON records and exact overlap boundaries', async () => {
  const cases = [
    [leaf('eq', '/data/testStatus', 'Ready'), [0, 6]], [leaf('ne', '/data/testStatus', 'Ready'), [1, 3, 7]],
    [leaf('lt', '/order', 3), [0, 1, 2]], [leaf('lte', '/order', 3), [0, 1, 2, 3]],
    [leaf('gt', '/order', 3), [6, 7]], [leaf('gte', '/order', 3), [3, 6, 7]],
    [{ op: 'in', field: '/data/testStatus', values: ['Ready', null] }, [0, 1, 6]],
    [leaf('contains', '/title', 'STRASSE'), [2]], [leaf('contains', '/tags', 'urgent'), [0]],
    [leaf('exists', '/data/testStatus', false), [2]], [leaf('exists', '/data/testStatus', true), [0, 1, 3, 6, 7]],
    [{ op: 'not', arg: leaf('contains', '/data/testStatus', 'Ready') }, [3, 7]],
    [{ op: 'or', args: [leaf('eq', '/order', 0), leaf('eq', '/order', 2)] }, [0, 2]],
    [leaf('eq', '/start', '2031-01-01T05:00:00-05:00'), [0]],
  ];
  await run(query(), [0, 1, 2, 3, 6, 7]);
  for (const [node, expected] of cases) await run(query(node), expected);
});

test('contextual Any/All/Phrase, fields, escapes and Unicode search retain unchanged C density', async () => {
  const expected = [0, 1, 2, 3, 6, 7], baseline = await run(query(), expected);
  const cases = [
    [{ search: 'alpha beta', searchMode: 'any' }, [0, 1]],
    [{ search: 'alpha beta', searchMode: 'all' }, [0, 1]],
    [{ search: 'alpha beta', searchMode: 'phrase' }, [0]],
    [{ search: 'alpha', searchCaseSensitive: true }, [1]],
    [{ search: 'beta', searchFields: ['/title'] }, [0]],
    [{ search: 'STRASSE' }, [2]], [{ search: '\u03c3\u03c3' }, [6]], [{ search: 'e\u0301lan' }, [6]],
    [{ search: '.*' }, [3]], [{ search: '6', searchFields: ['/order'] }, [6]],
    [{ search: '"Alpha Beta";Stra\u00dfe' }, [0, 2]], [{ search: '\\"quoted\\"' }, [7]],
  ];
  for (const [options, hits] of cases) {
    const result = await run({ ...query(), ...options }, expected, hits);
    assert.deepEqual(result.density, baseline.density); assert.deepEqual(result.knots, baseline.knots);
  }
});

test('unsafe and wrong-type filter/search requests return validation errors, never provider-specific defaults or TypeErrors', async () => {
  const bad = [
    { filters: null }, { filters: { kind: null } }, { filters: { sourceId: null } }, { ratio: null }, { bins: null }, { scaleMode: null },
    { search: null }, { searchMode: null }, { searchFields: null }, { searchCaseSensitive: null }, { searchFields: [['/title']] },
    { searchFields: ['/tags'] }, { search: 'bad\\q' }, { search: '"unfinished' },
    { filters: { expression: { version: 1, root: leaf('eq', ['/title'], 'Alpha') } } },
    { filters: { expression: { version: 1, root: leaf('lt', '/order', '3') } } },
    { filters: { expression: { version: 1, root: { op: 'and', args: [] } } } },
  ];
  for (const patch of bad) for (const provider of [local, remote]) await assert.rejects(provider.createQuery({ ...query(), ...patch }), error => error.status === 422);
  for (const filters of [null, [], 'all', 1, { kind: null }, { kind: [] }, { kind: {} }, { sourceId: null }, { sourceId: [] }, { sourceId: 1 }]) {
    for (const provider of [local, remote]) await assert.rejects(provider.createQuery({ ...query(), filters }), { status: 422, code: 'invalid_filter' });
  }
});

test('wrong built-in/custom record types reject before commit, and invalid operands cannot hide behind boolean siblings', async () => {
  for (const provider of [local, remote]) {
    const pinned = await provider.createQuery(query());
    try {
      const before = await provider.queryRecords(pinned.queryId, {}), status = await provider.getStatus();
      for (const data of [{ status: 42 }, { status: null }, { status: true }, { testStatus: 42 }, { testStatus: false }]) {
        await assert.rejects(provider.executeCommand({ type: 'create', generation: status.generation, clientCommandId: crypto.randomUUID(), payload: {
          title: 'Wrong declared type', kind: 'event', start: from, end: null, sourceId: 'operations', ...schemaPin(schema), data, tags: ['filter-fixture'],
        } }), { code: 'invalid_record_data', status: 422 });
      }
      assert.equal((await provider.getStatus()).revision, status.revision);
      assert.deepEqual((await provider.queryRecords(pinned.queryId, {})).items, before.items);
      for (const op of ['and', 'or']) {
        const input = query({ op, args: [leaf('eq', '/title', op === 'or' ? 'Alpha Beta' : 'Never'), leaf('eq', '/data/testStatus', 42)] });
        await assert.rejects(provider.createQuery(input), error => error.status === 422);
      }
    } finally { await provider.releaseQuery(pinned.queryId); }
  }
});
