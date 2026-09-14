import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server-fixture.mjs';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { toMs, toIso } from '../../client/src/timeline/time-scale.js';
import { DEFAULT_DEFINITION } from '../../client/src/data/model-catalog.js';
import { publishSchema, schemaPin } from './configuration-fixture.mjs';

let server, remote, local, parentId;
const from = '2030-03-18T10:00:00.000Z', to = '2030-03-18T11:00:00.000Z';
const t = toMs(from), stamp = offset => toIso(t + offset);
const modelDefinition = { ...DEFAULT_DEFINITION, presentation: { version: 1, bands: { primary: { backgroundColor: '#ffffff', textColor: '#222222', sessionColor: '#449966', eventColor: '#cc7733', axisPosition: 'top', intervalUnit: 'MINUTE', dateFormat: 'MM/dd-hh:mm' }, overview: { backgroundColor: '#ddeeff', dateColor: '#990033', intervalUnit: 'DAY', dateFormat: 'yyyy mmm dd' } }, sourceStyles: [{ sourceId: 'operations', backgroundColor: '#000000', textColor: '#ffffff', dateColor: '#ffffff' }, { sourceId: 'verification', backgroundColor: '#d3d3d3', textColor: '#000000' }], labels: { fields: ['/title', '/data/value'], maxLines: 3, fontWeight: 700, fontStyle: 'italic' }, inspector: { fields: [{ field: '/data/value', label: 'Value' }] }, nesting: { enabled: true }, baseline: { enabled: true } } };

before(async () => {
  server = await startServer();
  remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token }); await remote.initialize();
  const schemas = new Map();
  const create = async payload => {
    const groupType = payload.data.groupValue == null ? 'string' : typeof payload.data.groupValue;
    const valueType = typeof payload.data.value, key = `${groupType}/${valueType}`;
    if (!schemas.has(key)) schemas.set(key, await publishSchema(remote, `Presentation ${key}`, { groupValue: { type: [groupType, 'null'] }, value: { type: valueType } }));
    return (await remote.executeCommand({ type: 'create', generation: remote.metadata.generation, clientCommandId: crypto.randomUUID(), payload: { ...payload, ...schemaPin(schemas.get(key)) } })).record;
  };
  const parent = await create({ title: 'Parent measured activity group', kind: 'session', start: stamp(10000), end: stamp(3500000), sourceId: 'operations', render: { color: '#2e7c8c' }, data: { status: 'Parent', value: 1e-7 } });
  parentId = parent.id;
  const values = [1, '1', false, true, null, undefined, 'A', 'B', 'e\u0301', '\u00e9'];
  for (let i = 0; i < 16; i++) await create({
    title: `${i < 4 ? 'Child' : 'Styled'} ${i} jj title with measured words ${'extended '.repeat(i % 4)}`,
    kind: i % 3 === 0 ? 'event' : 'session', start: stamp(100000 + i * 145000), end: i % 3 === 0 ? null : stamp(800000 + i * 145000),
    sourceId: i < 4 || i % 2 ? 'operations' : 'verification', parentSessionId: i < 4 ? parentId : null, order: 4 - i,
    originalStart: stamp(20000 + i * 135000), originalEnd: i % 3 === 0 ? null : stamp(1000000 + i * 140000),
    render: { fontSize: 11 + i % 14, fontWeight: i % 2 ? 400 : 700, fontStyle: i % 4 < 2 ? 'normal' : 'italic', barHeight: 3 + i % 18, pointRadius: 1 + i % 10, ...(i % 3 === 0 ? { icon: ['flag', 'star', 'clock'][i % 3] } : {}), ...(i % 4 === 0 ? { backgroundColor: '#fff4cc' } : {}) },
    data: { ...(values[i % values.length] === undefined ? {} : { groupValue: values[i % values.length] }), value: [0.1, 1e-7, false, 'ASCII value'][i % 4] },
  });
  local = new LocalProvider(await remote.exportSnapshot()); await local.initialize();
});
after(async () => { local?.dispose(); remote?.dispose(); await server?.stop(); });

function nearlyEqual(a, b, path = '') {
  if (typeof a === 'number' && typeof b === 'number') { assert.ok(Math.abs(a - b) <= 1e-7, `${path}: ${a} != ${b}`); return; }
  if (Array.isArray(a) && Array.isArray(b)) { assert.equal(a.length, b.length, path); a.forEach((value, i) => nearlyEqual(value, b[i], `${path}/${i}`)); return; }
  if (a && b && typeof a === 'object' && typeof b === 'object') { assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), path); for (const key of Object.keys(a)) nearlyEqual(a[key], b[key], `${path}/${key}`); return; }
  assert.deepEqual(a, b, path);
}
const itemFields = ['record', 'row', 'xStart', 'xEnd', 'labelX', 'labelWidth', 'labelLines', 'labelInkOffsets', 'labelLineHeight', 'labelOffsetY', 'geometryOffsetY', 'fullLabel', 'displayTitle', 'overflow', 'style', 'parentId', 'ancestorIds', 'depth', 'iconX', 'baselineStart', 'baselineEnd', 'baselineOffsetY', 'footprintStart', 'footprintEnd', 'match'];
const projectItem = item => Object.fromEntries(itemFields.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));

async function compareLayout(presentation, { width = 480, height = 320, search = '', filters = {}, scaleMode = 'uniform', viewFromMs, viewToMs } = {}) {
  const request = { domain: { from, to }, filters, search, scaleMode, bins: 16, ratio: 4 };
  const lq = await local.createQuery(request), rq = await remote.createQuery(request);
  try {
    const common = { from, to, viewFromMs, viewToMs, width, availableHeight: height, rowHeight: 32, fontSize: 13, theme: 'dark', groupBy: 'none', displayUnit: 'MINUTE', ...(presentation === undefined ? {} : { presentation }) };
    const ll = await local.createLayout(lq.queryId, { ...common, mapId: lq.mapId }), rl = await remote.createLayout(rq.queryId, { ...common, mapId: rq.mapId });
    for (const field of ['totalRows', 'detailTotal', 'detailMatchTotal', 'renderInstanceTotal', 'rowHeight', 'pageCapacity', 'presentation']) nearlyEqual(ll[field], rl[field], field);
    let leftCursor, rightCursor, ids = [];
    do {
      const lp = await local.getRows(lq.queryId, ll.layoutId, { cursor: leftCursor }), rp = await remote.getRows(rq.queryId, rl.layoutId, { cursor: rightCursor });
      for (const field of ['startRow', 'endRow', 'pageIndex', 'pageCount', 'loadedCount', 'pageComplete', 'rows', 'enclosures']) nearlyEqual(lp[field], rp[field], field);
      nearlyEqual(lp.items.map(projectItem), rp.items.map(projectItem), 'items');
      ids.push(...lp.items.map(item => item.record.id)); leftCursor = lp.nextCursor; rightCursor = rp.nextCursor;
      assert.equal(Boolean(leftCursor), Boolean(rightCursor));
    } while (leftCursor);
    assert.equal(ids.length, ll.detailTotal); assert.equal(new Set(ids).size, ids.length);
    nearlyEqual(await local.getOverview(lq.queryId), await remote.getOverview(rq.queryId), 'overview');
    return { layout: ll, ids };
  } finally { await local.releaseQuery(lq.queryId); await remote.releaseQuery(rq.queryId); }
}

test('real Python and Local agree on four fonts, multiline labels, icons, baselines and nested row pages', async () => {
  for (const width of [320, 640, 1000]) {
    const result = await compareLayout(modelDefinition.presentation, { width });
    assert.equal(result.layout.detailTotal, 17); assert.equal(result.ids[0], parentId);
  }
});

test('custom primitive grouping and source palettes agree across providers, including NFC/null/missing', async () => {
  for (const field of ['/data/groupValue', '/sourceId', '/kind']) for (const direction of ['asc', 'desc']) await compareLayout({ ...modelDefinition.presentation, grouping: { field, direction }, nesting: { enabled: false } });
});

test('adaptive fractional views and search preserve matching sets, geometry and page-independent styling', async () => {
  await compareLayout(modelDefinition.presentation, { scaleMode: 'adaptive', search: 'Child', viewFromMs: `${t + 20000}.5`, viewToMs: `${t + 3300000}.5` });
  await compareLayout(modelDefinition.presentation, { filters: { kind: 'event' }, width: 640 });
  await compareLayout(undefined, { width: 640 });
});

test('presentation validation and record-render rejection agree without silently accepting unsafe fields', async () => {
  const invalid = [
    { version: 2 }, { version: 1, descriptor: 'alert(1)' }, { version: 1, labels: { fields: ['/data/__proto__'] } },
    { version: 1, sourceStyles: [{ sourceId: 'operations' }, { sourceId: 'operations' }] },
    { version: 1, labels: { fontWeight: 500 } }, { version: 1, bands: { primary: { dateFormat: 'YYYY' } } },
  ];
  for (const presentation of invalid) for (const provider of [local, remote]) assert.equal((await provider.validateModel({ ...DEFAULT_DEFINITION, presentation })).valid, false);
  for (const provider of [local, remote]) {
    await assert.rejects(provider.executeCommand({ type: 'create', generation: (await provider.getStatus()).generation, clientCommandId: crypto.randomUUID(), payload: { title: 'Unsafe icon', kind: 'event', start: from, end: null, sourceId: 'operations', render: { icon: 'https://example.test/icon.svg' } } }), error => error.status === 422);
  }
});

test('published presentation and record overrides survive server restart and portable integrity round trip', async () => {
  async function command(type, model, payload = {}) { return remote.executeModelCommand({ type, modelId: model?.id, expectedRevision: model?.revision, generation: (await remote.getStatus()).generation, clientCommandId: crypto.randomUUID(), payload }); }
  const old = (await remote.listModels()).items[0];
  let result = await command('create', null, { name: 'Presentation parity', definition: modelDefinition });
  result = await command('publish', result.model); const model = result.model;
  await command('apply', model, { version: 1 });
  const before = await remote.exportSnapshot();
  await server.restart(); await remote.initialize();
  const after = await remote.exportSnapshot();
  assert.deepEqual(after.models, before.models); assert.deepEqual(after.records, before.records); assert.deepEqual(after.settings.presentation, modelDefinition.presentation);
  const imported = new LocalProvider(after); await imported.initialize(); assert.deepEqual((await imported.getStatus()).settings.presentation, modelDefinition.presentation); imported.dispose();
  result = await command('apply', old, { version: 1 }); assert.equal(Object.hasOwn(result.settings, 'presentation'), false);
  assert.deepEqual((await remote.getModel(model.id)).model.versions[0].definition.presentation, modelDefinition.presentation);
});
