import test from 'node:test';
import assert from 'node:assert/strict';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { createQueryData, createQueryDataAsync } from '../../client/src/data/query-core.js';
import { LocalProvider } from '../../client/src/data/local-provider.js';

function snapshot(count = 10000) {
  const value = structuredClone(initial), base = initial.records.find(record => record.kind === 'event');
  value.records = Array.from({ length: count }, (_, index) => ({ ...base, id: `60000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: `Activity ${index}`, kind: index % 3 ? 'session' : 'event',
    start: new Date(Date.parse(value.settings.overview.from) + (index % 97) * 60000).toISOString(),
    end: index % 3 ? value.settings.overview.to : null, parentSessionId: null, data: { status: index % 2 ? 'ready' : 'waiting' } }));
  value.manifest.recordCount = count; delete value.manifest.contentSha256;
  return value;
}
const input = { definitionVersion: 2, domain: initial.settings.overview, search: 'ready', scaleMode: 'adaptive', bins: 256 };
const comparable = result => ({ ...result, map: { ...result.map, mapId: 'ignored-per-query-identity' } });

test('sync and cooperative query drivers share exact records, provenance, density and map semantics', async () => {
  const value = snapshot(1000);
  let yields = 0;
  const sync = createQueryData(value, input);
  const async = await createQueryDataAsync(value, input, { sliceMs: 0, yieldControl: async () => { yields++; } });
  assert.ok(yields > 5);
  assert.deepEqual(comparable(async), comparable(sync));
});

test('v2 overview uses cached temporal order and ID ties while v1 retains input order', () => {
  const value = snapshot(3), [first, second, third] = value.records;
  second.start = first.start;
  value.records = [third, second, first];
  const request = { domain: value.settings.overview };
  assert.deepEqual(createQueryData(value, request).overviewRecords.map(record => record.id), [third.id, second.id, first.id]);
  assert.deepEqual(createQueryData(value, { ...request, definitionVersion: 2 }).overviewRecords.map(record => record.id), [first.id, second.id, third.id]);
  assert.deepEqual(value.records.map(record => record.id), [third.id, second.id, first.id]);
});

test('density prefix sums match an independent bin-by-bin oracle at half-open boundaries', () => {
  let seed = 71429;
  const random = maximum => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
  for (const duration of [2, 31, 1000]) {
    const value = snapshot(800), from = Date.parse(initial.settings.overview.from), to = from + duration;
    value.records.forEach((record, index) => {
      const start = from - duration + random(duration * 3);
      record.start = new Date(start).toISOString();
      record.kind = index % 3 ? 'session' : 'event';
      record.end = index % 5 ? new Date(start + random(duration * 2)).toISOString() : null;
    });
    for (const count of [16, 31, 256]) {
      const query = createQueryData(value, { domain: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, bins: count, search: 'ready' });
      let selected = 0;
      const expected = query.density.bins.map(bin => ({ from: bin.from, to: bin.to, points: 0, overlap: 0n, endpoints: 0, total: 0, matched: 0 }));
      for (const record of value.records) {
        const start = Date.parse(record.start), end = record.end === null ? record.kind === 'event' ? start : to : Date.parse(record.end);
        const point = record.kind === 'event' || start === end;
        if (point ? start < from || start >= to : start >= to || end <= from) continue;
        selected++;
        for (const bin of expected) {
          if (point) {
            if (bin.from <= start && start < bin.to) { bin.points++; bin.total++; if (record.data.status === 'ready') bin.matched++; }
          } else {
            const overlap = Math.max(0, Math.min(end, bin.to) - Math.max(start, bin.from));
            bin.overlap += BigInt(overlap);
            if (overlap) { bin.total++; if (record.data.status === 'ready') bin.matched++; }
            if (bin.from <= start && start < bin.to) bin.endpoints++;
            if (record.end !== null && bin.from <= end && end < bin.to) bin.endpoints++;
          }
        }
      }
      assert.equal(query.density.total, selected);
      for (const [index, bin] of expected.entries()) {
        assert.deepEqual(query.density.bins[index], { from: bin.from, to: bin.to, points: bin.points, overlapMs: String(bin.overlap), endpoints: bin.endpoints, density: bin.points + Number(bin.overlap) / (bin.to - bin.from) + 0.5 * bin.endpoints });
        assert.deepEqual(query.overviewBins[index], { from: bin.from, to: bin.to, total: bin.total, matched: bin.matched });
      }
    }
  }
});

test('cooperative preparation processes cancellation before completing the full scan', async () => {
  const controller = new AbortController(); let yields = 0;
  await assert.rejects(createQueryDataAsync(snapshot(), input, { signal: controller.signal, sliceMs: 0, yieldControl: async () => {
    if (++yields === 2) controller.abort();
  } }), { name: 'AbortError' });
  assert.equal(yields, 2);
});

test('Local query admission includes preparing work and releases canceled reservations', async () => {
  const provider = new LocalProvider(snapshot()); await provider.initialize();
  const controller = new AbortController();
  const pending = provider.createQuery(input, { signal: controller.signal });
  const other = provider.createQuery(input);
  try {
    await assert.rejects(provider.createQuery(input), { code: 'query_capacity' });
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    const ready = await other;
    assert.equal(provider.pendingQueries, 0); assert.equal(provider.queries.size, 1);
    assert.equal(ready.baseTotal, 10000);
    const replacement = await provider.createQuery(input);
    assert.equal(provider.queries.size, 2);
    await provider.releaseQuery(replacement.queryId);
  } finally { provider.dispose(); }
});

test('writes during yielded preparation cannot mix the captured snapshot with a newer revision', async () => {
  const provider = new LocalProvider(snapshot()); await provider.initialize();
  const before = provider.snapshot.records[0], revision = provider.revision;
  const pending = provider.createQuery(input);
  try {
    await provider.executeCommand({ type: 'update', recordId: before.id, expectedVersion: before.version, generation: provider.generation,
      clientCommandId: crypto.randomUUID(), payload: { title: 'Changed after query preparation began' } });
    const manifest = await pending;
    assert.equal(provider.revision, revision + 1);
    assert.equal(manifest.revision, revision); assert.equal(manifest.counts.revision, revision);
    const table = await provider.queryRecords(manifest.queryId, { sort: [{ field: 'title', direction: 'asc', order: 'natural' }], limit: 1 });
    assert.equal(table.items[0].record.id, before.id); assert.equal(table.items[0].record.title, before.title);
    assert.notEqual((await provider.getRecord(before.id)).title, before.title);
  } finally { provider.dispose(); }
});

test('disposal while preparation yields never republishes data into the inactive provider', async () => {
  const provider = new LocalProvider(snapshot()); await provider.initialize();
  const pending = provider.createQuery(input);
  provider.dispose();
  await assert.rejects(pending, { code: 'provider_disposed' });
  assert.equal(provider.pendingQueries, 0); assert.equal(provider.queries.size, 0);
});
