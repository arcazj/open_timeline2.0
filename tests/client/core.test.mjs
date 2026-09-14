import test from 'node:test';
import assert from 'node:assert/strict';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { validateSnapshot, parseStrictJson } from '../../client/src/data/snapshot.js';
import { foldText, parseSearch } from '../../client/src/data/query-core.js';
import { buildLayout, measureText, overlaps } from '../../client/src/timeline/layout.js';
import { createTimeMap, projectTime, invertPosition, mapTime, unmapTime, panRange, zoomRange, overviewBodyDrag, overviewResize, toMs, toIso, TIME_UNITS, generateTicks } from '../../client/src/timeline/time-scale.js';

const fixtureMap = { knots: [{ timeMs: 0, u: '0' }, { timeMs: 3600000, u: '0.1' }, { timeMs: 7200000, u: '0.5' }, { timeMs: 10800000, u: '0.9' }, { timeMs: 14400000, u: '1' }] };
const close = (a, b, epsilon = 1e-8) => assert.ok(Math.abs(Number(a) - Number(b)) <= epsilon, `${a} != ${b}`);
const stamp = hour => `2026-09-12T${String(hour).padStart(2, '0')}:00:00.000Z`;
const queryInput = { domain: { from: stamp(0), to: '2026-09-13T00:00:00.000Z' }, filters: { sourceId: 'all', kind: 'all' }, search: '', scaleMode: 'adaptive', bins: 128, ratio: 4 };

function snapshotWith(records) {
  const snapshot = structuredClone(initial);
  snapshot.records = records;
  snapshot.manifest.recordCount = records.length;
  snapshot.manifest.scope.sourceIds = [...new Set(records.map(r => r.sourceId))];
  delete snapshot.manifest.contentSha256;
  return snapshot;
}

function rowFixture() {
  return snapshotWith(Array.from({ length: 5 }, (_, i) => ({ ...structuredClone(initial.records[0]), id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, kind: 'session', title: `P0${i + 1}`, start: stamp(10), end: stamp(11), parentSessionId: null, sourceId: 'SOURCE1' })));
}

test('strict canonical timestamps, historical years and 11 calendar units', () => {
  for (const value of ['0001-01-01T00:00:00.000Z', '0099-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z']) assert.equal(toIso(toMs(value)), value);
  for (const value of ['2026-02-29T00:00:00Z', '2026-01-01', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00.1234Z', '-000000-01-01T00:00:00Z']) assert.throws(() => toMs(value));
  assert.equal(toMs('2026-09-12T12:00:00+02:00'), toMs(stamp(10)));
  for (const unit of TIME_UNITS) {
    const ticks = generateTicks('2026-01-01T00:00:00.000Z', '4026-01-01T00:00:00.000Z', unit, { maxTicks: 4 });
    assert.ok(ticks.length > 0, unit);
    assert.ok(ticks.every((t, i) => !i || t.timeMs > ticks[i - 1].timeMs));
  }
  const dst = generateTicks('2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', 'HOUR', { timeZone: 'America/New_York' });
  assert.equal(dst.length, 23);
  assert.ok(!dst.some(tick => tick.label === '02:00'));
});

test('AS-MAP-01 projection, inverse, nonlinear pan and zoom', () => {
  for (const [minute, x] of [[30, 50], [90, 300], [150, 700], [210, 950]]) close(projectTime(fixtureMap, minute * 60000, 0, 14400000, 1000), x);
  close(projectTime(fixtureMap, 75 * 60000, 0, 14400000, 1000), 200);
  close(projectTime(fixtureMap, 135 * 60000, 0, 14400000, 1000), 600);
  const pan = panRange(fixtureMap, 3600000, 7200000, 100, 1000);
  assert.equal(pan.a, '0.06'); assert.equal(pan.b, '0.46');
  close(pan.fromMs, 36 * 60000); close(pan.toMs, 114 * 60000);
  const zoom = zoomRange(fixtureMap, 3600000, 7200000, 2);
  assert.equal(zoom.a, '0.2'); assert.equal(zoom.b, '0.4');
  close(zoom.fromMs, 75 * 60000); close(zoom.toMs, 105 * 60000);
  assert.ok(Number(zoom.toMs) - Number(zoom.fromMs) < 3600000);
  const out = zoomRange(fixtureMap, 3600000, 7200000, 0.5);
  assert.ok(Number(out.toMs) - Number(out.fromMs) > 3600000);
  const body = overviewBodyDrag(fixtureMap, 3600000, 7200000, 90 * 60000, 165 * 60000);
  assert.equal(body.a, '0.6'); assert.equal(body.b, '1');
  close(overviewResize(fixtureMap, 3600000, 7200000, 'end', 150 * 60000).toMs, 150 * 60000);
  assert.throws(() => createTimeMap({ knots: [{ timeMs: 1, u: '0' }, { timeMs: 1, u: '1' }] }));
});

test('1,000 seeded monotonicity and projection/inverse properties', () => {
  let seed = 20260912;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 1000; i++) {
    const t = Math.floor(random() * 14400000);
    const x = projectTime(fixtureMap, t, 0, 14400000, 1000);
    close(invertPosition(fixtureMap, x, 0, 14400000, 1000), t, 0.001);
    close(unmapTime(fixtureMap, mapTime(fixtureMap, t)), t, 0.001);
    const next = Math.min(14400000, t + 1);
    assert.ok(projectTime(fixtureMap, next, 0, 14400000, 1000) >= x);
  }
});

test('1 ms detail precision inside a millennia-wide analysis domain', () => {
  const from = toMs('0001-01-01T00:00:00.000Z');
  const to = toMs('9999-12-31T23:59:59.999Z');
  const map = { knots: [{ timeMs: from, u: '0' }, { timeMs: to, u: '1' }] };
  const left = to - 2;
  const right = to - 1;
  close(projectTime(map, String(left) + '.5', left, right, 1000), 500, 0.001);
  close(invertPosition(map, 500, left, right, 1000), left + 0.5, 0.001);
  const limited = zoomRange(map, left, right, 100);
  close(Number(limited.toMs) - Number(limited.fromMs), 1, 0.001);
});

test('1,000 seeded global packing properties preserve IDs and clearance', () => {
  let seed = 74;
  const random = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  const from = toMs(stamp(10));
  const to = toMs(stamp(11));
  const map = { knots: [{ timeMs: from, u: '0' }, { timeMs: to, u: '1' }] };
  const base = rowFixture().records;
  for (let trial = 0; trial < 1000; trial++) {
    const records = base.map((r, i) => {
      const start = from + Math.floor(random() * 3000000);
      return { ...r, title: `Record ${i} ${'W'.repeat(1 + Math.floor(random() * 30))}`, start: toIso(start), end: toIso(Math.min(to, start + Math.floor(random() * 600000))) };
    });
    const before = JSON.stringify(records);
    const layout = buildLayout(records, map, { from, to, width: 320, availableHeight: 320, rowHeight: 32, fontSize: 13 });
    assert.equal(layout.items.length, records.length);
    assert.equal(new Set(layout.items.map(i => i.record.id)).size, records.length);
    for (let i = 0; i < layout.items.length; i++) for (let j = i + 1; j < layout.items.length; j++) {
      const a = layout.items[i];
      const b = layout.items[j];
      if (a.row === b.row) assert.ok(a.footprintEnd + 4 <= b.footprintStart || b.footprintEnd + 4 <= a.footprintStart);
    }
    assert.equal(JSON.stringify(records), before);
  }
});

test('strict JSON, complete imports, Unicode full casefold and grammar', async () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), { code: 'duplicate_property' });
  assert.throws(() => parseStrictJson('{"a":1,}'), { code: 'invalid_json' });
  assert.throws(() => parseStrictJson('{"a":"\\ud800"}'), { code: 'invalid_json' });
  assert.throws(() => parseStrictJson('{"data":{"n":9007199254740993}}'), { code: 'invalid_json' });
  assert.equal(foldText('Straße'), 'strasse');
  assert.equal(foldText('Σς'), 'σσ');
  assert.deepEqual(parseSearch('Telemetry; "long phrase"'), ['telemetry', 'long phrase']);
  assert.throws(() => parseSearch('"unterminated'), { code: 'invalid_search' });
  const bad = structuredClone(initial); bad.manifest.recordCount++;
  await assert.rejects(validateSnapshot(bad), { code: 'incomplete_snapshot' });
  await assert.rejects(validateSnapshot({ items: initial.records }), { code: 'invalid_snapshot' });
  const duplicate = structuredClone(initial); duplicate.records.push(duplicate.records[0]); duplicate.manifest.recordCount++;
  await assert.rejects(validateSnapshot(duplicate), { code: 'duplicate_id' });
});

test('ROW-05 immutable global pages, density and foreign cursor rejection', async () => {
  const provider = new LocalProvider(rowFixture());
  await provider.initialize();
  const query = await provider.createQuery(queryInput);
  const density = await provider.getDensity(query.queryId);
  assert.equal(density.complete, true); assert.equal(density.total, 5);
  const layout = await provider.createLayout(query.queryId, { mapId: query.mapId, from: stamp(10), to: stamp(11), width: 1000, availableHeight: 64, rowHeight: 32, fontSize: 13, groupBy: 'none' });
  assert.equal(layout.totalRows, 5);
  let cursor;
  const counts = [];
  const ids = [];
  do {
    const page = await provider.getRows(query.queryId, layout.layoutId, { cursor });
    counts.push(page.items.length); ids.push(...page.items.map(i => i.record.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(counts, [2, 2, 1]); assert.equal(new Set(ids).size, 5);
  assert.deepEqual(await provider.getDensity(query.queryId), density);
  await assert.rejects(provider.getRows(query.queryId, layout.layoutId, { cursor: 'foreign' }), { code: 'cursor_mismatch' });
  provider.dispose();
});

test('search aggregates include crossing sessions in every bin and scoped zones', async () => {
  const base = rowFixture().records[0];
  const snapshot = snapshotWith(Array.from({ length: 1002 }, (_, i) => ({ ...base, id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, title: i < 1001 ? 'Needle session' : 'Other session', start: stamp(0), end: '2026-09-13T00:00:00.000Z' })));
  snapshot.zones.push({ id: 'outside', title: 'Outside', start: '2027-01-01T00:00:00.000Z', end: '2027-01-02T00:00:00.000Z', color: '#557a88', opacity: 0.2 });
  const provider = new LocalProvider(snapshot);
  await provider.initialize();
  const query = await provider.createQuery({ ...queryInput, bins: 16, search: 'Needle' });
  const overview = await provider.getOverview(query.queryId);
  assert.equal(overview.total, 1002);
  assert.equal(overview.matched, 1001);
  assert.equal(overview.aggregated, true);
  assert.equal(overview.items.length, 16);
  assert.ok(overview.items.every(item => item.count === 1001));
  assert.ok(!(await provider.getZones(query.queryId)).items.some(zone => zone.id === 'outside'));
  provider.dispose();
});

test('Local CRUD conflicts, pinned snapshots and complete integrity export/reimport', async () => {
  const provider = new LocalProvider(rowFixture());
  const metadata = await provider.initialize();
  const query = await provider.createQuery(queryInput);
  const id = (await provider.getOverview(query.queryId)).items[0].id;
  const original = await provider.getRecord(id);
  const command = { type: 'update', generation: metadata.generation, recordId: id, expectedVersion: original.version, payload: { title: 'Updated' }, clientCommandId: crypto.randomUUID() };
  const result = await provider.executeCommand(command);
  assert.equal(result.durability, 'memory-only');
  assert.equal(result.record.version, original.version + 1);
  assert.deepEqual(await provider.executeCommand(command), result);
  await assert.rejects(provider.executeCommand({ ...command, generation: 'foreign-source' }), { code: 'generation_mismatch' });
  await assert.rejects(provider.executeCommand({ ...command, clientCommandId: crypto.randomUUID() }), { status: 412 });
  assert.equal((await provider.getOverview(query.queryId)).items[0].title, original.title);
  const exported = await provider.exportSnapshot();
  assert.ok(exported.manifest.contentSha256);
  const restored = new LocalProvider(JSON.stringify(exported));
  await restored.initialize();
  assert.equal((await restored.getRecord(id)).title, 'Updated');
  assert.notEqual((await restored.getStatus()).generation, metadata.generation);
  exported.records[0].title = 'tampered';
  await assert.rejects(validateSnapshot(exported), { code: 'checksum_mismatch' });
  assert.equal((await provider.getStatus()).modified, true);
  provider.dispose(); restored.dispose();
});

test('measured font packing preserves records and noncolliding footprints', () => {
  assert.ok(measureText('WWW').width > measureText('iii').width);
  assert.throws(() => measureText('😀'), { code: 'unsupported_glyph' });
  const snapshot = rowFixture();
  const map = { knots: [{ timeMs: toMs(stamp(0)), u: '0' }, { timeMs: toMs('2026-09-13T00:00:00.000Z'), u: '1' }] };
  const result = buildLayout(snapshot.records, map, { from: stamp(10), to: stamp(11), width: 320, availableHeight: 320, rowHeight: 32, fontSize: 13, groupBy: 'sourceId' });
  assert.equal(result.rows.length, 1); assert.equal(result.totalRows, 6);
  assert.equal(result.items.length, 5);
  const long = { ...snapshot.records[0], title: 'W'.repeat(500) };
  const one = buildLayout([long], map, { from: stamp(10), to: stamp(11), width: 320, availableHeight: 320 });
  assert.equal(one.items[0].overflow, true);
  assert.ok(one.items[0].labelWidth < 320);
  assert.equal(one.items[0].record.title.length, 500);
  const edgePoint = { ...long, kind: 'event', start: toIso(toMs(stamp(11)) - 1000), end: null };
  const edge = buildLayout([edgePoint], map, { from: stamp(10), to: stamp(11), width: 320, availableHeight: 320 }).items[0];
  assert.ok(edge.labelX + edge.labelWidth <= edge.xStart - 10);
  assert.equal(overlaps({ ...long, end: stamp(10), start: stamp(9) }, stamp(10), stamp(11)), false);
});

test('Server adapter sends authorized preconditions and marks uncertain writes', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/default') ? { generation: 'generation', revision: 1 } : { record: {}, durability: 'server-committed', generation: 'generation', revision: 2 }), { status: 200 });
  };
  try {
    const provider = new ServerProvider({ baseUrl: 'http://127.0.0.1:9999', token: 'test-token' });
    await provider.initialize();
    await assert.rejects(provider.executeCommand({ type: 'create', generation: 'old-generation', clientCommandId: 'old', payload: {} }), { code: 'generation_mismatch' });
    await provider.executeCommand({ type: 'update', generation: 'generation', recordId: 'id', expectedVersion: 3, clientCommandId: 'command', payload: { title: 'x' } });
    assert.equal(requests[1].options.headers.Authorization, 'Bearer test-token');
    assert.equal(requests[1].options.headers['If-Match'], '"generation:3"');
    assert.equal(requests[1].options.method, 'PATCH');
    assert.equal(requests[1].options.headers['Content-Type'], 'application/json-patch+json');
    assert.deepEqual(JSON.parse(requests[1].options.body), [{ op: 'replace', path: '/title', value: 'x' }]);
    assert.equal(requests[1].options.credentials, 'omit');
    globalThis.fetch = async () => { throw new TypeError('Network failed'); };
    await assert.rejects(provider.executeCommand({ type: 'create', generation: 'generation', clientCommandId: 'other', payload: {} }), { code: 'write_outcome_unknown' });
    provider.dispose();
  } finally { globalThis.fetch = originalFetch; }
});

test('Server command outcomes normalize committed/not-found without hiding failures', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const committed = { record: { id: 'record' }, durability: 'server-committed', generation: 'generation', revision: 2 };
  const provider = new ServerProvider({ baseUrl: 'http://127.0.0.1:9999', token: 'test-token' });
  let response = { status: 200, body: committed };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (response.networkError) throw new TypeError('Disconnected');
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  try {
    assert.deepEqual(await provider.getCommandOutcome('original-command'), { state: 'committed', result: committed });
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.body, undefined);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token');
    assert.ok(requests[0].url.endsWith('/command-results/original-command'));
    response = { status: 404, body: { code: 'command_not_found', message: 'Unknown command' } };
    assert.deepEqual(await provider.getCommandOutcome('absent'), { state: 'not-found' });
    for (const [status, code] of [[401, 'authentication_required'], [403, 'forbidden'], [404, 'workspace_not_found'], [409, 'generation_mismatch']]) {
      response = { status, body: { code, message: 'Denied or unavailable' } };
      await assert.rejects(provider.getCommandOutcome('original-command'), { status, code });
    }
    response = { networkError: true };
    await assert.rejects(provider.getCommandOutcome('original-command'), { code: 'server_unavailable' });
    response = { status: 200, body: {} };
    await assert.rejects(provider.getCommandOutcome('original-command'), { code: 'invalid_response' });
    assert.ok(requests.every(request => request.options.method === 'GET' && request.options.body === undefined));
  } finally { provider.dispose(); globalThis.fetch = originalFetch; }
});
