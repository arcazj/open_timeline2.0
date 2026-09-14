import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { LocalProvider } from '../client/src/data/local-provider.js';
import { ServerProvider } from '../client/src/data/server-provider.js';

const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:8768' }, token: { type: 'string' } } });
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const snapshot = await readJson('output/hazard-parity/hazard-range-snapshot.json');
const originals = await readJson('output/hazard-parity/legacy/verification.json');
const raw = (await readJson('output/hazard-parity/legacy/records.json')).events;
const domain = snapshot.manifest.legacy.declaredRange;
const detail = { from: '2026-09-12T12:00:00.000Z', to: '2026-09-12T16:00:00.000Z' };
const selected = range => raw.filter(record => Date.parse(record.start) >= Date.parse(range.from) && Date.parse(record.start) < Date.parse(range.to));
const expected = selected(detail), report = { generatedAt: new Date().toISOString(), domain, detail, limitations: ['Read-only bounded real-data comparison, not whole-archive visual certification.', 'Timings are one warm run under concurrent validation load, not a performance budget certification.'], providers: {} };
assert.equal(raw.every(record => !record.end || record.end === record.start), true, 'This independent raw predicate is for point-only hazard fixtures');
assert.equal(snapshot.records.length, selected(domain).length);
const providers = { local: new LocalProvider(snapshot), server: new ServerProvider({ baseUrl: values.url, token: values.token || process.env.OPENBEXI_API_TOKEN }) };
try {
  for (const [name, provider] of Object.entries(providers)) {
    const info = await provider.initialize(), started = performance.now();
    const query = await provider.createQuery({ domain, scaleMode: 'uniform', search: 'Kilauea' });
    const map = await provider.getMap(query.queryId, query.mapId);
    const density = await provider.getDensity(query.queryId), overview = await provider.getOverview(query.queryId);
    const layout = await provider.createLayout(query.queryId, { ...detail, mapId: query.mapId, width: 2000, availableHeight: 96, rowHeight: 32, fontSize: 12, groupBy: 'none', presentation: snapshot.settings.presentation });
    const items = [], pages = []; let cursor;
    do {
      const page = await provider.getRows(query.queryId, layout.layoutId, cursor ? { cursor } : {});
      assert.equal(page.pageComplete, true); items.push(...page.items.filter(item => item.record));
      pages.push({ startRow: page.startRow, endRow: page.endRow, records: page.loadedCount }); cursor = page.nextCursor;
      assert.ok(pages.length <= 100);
    } while (cursor);
    assert.equal(items.length, expected.length); assert.equal(new Set(items.map(item => item.record.id)).size, expected.length);
    assert.deepEqual(items.map(item => item.record.extensions.legacy.id).sort(), expected.map(record => record.id).sort());
    assert.equal(overview.matched, selected(domain).filter(record => record.data.title.includes('Kilauea')).length);
    assert.deepEqual(await provider.getMap(query.queryId, query.mapId), map, 'Pages must not replace the map');
    report.providers[name] = { admittedRecords: info.recordCount, records: items.length, totalRows: layout.totalRows, pages, overviewTotal: overview.total, searchMatches: overview.matched, elapsedMs: Math.round(performance.now() - started),
      placements: items.map(item => ({ id: item.record.id, row: item.row, icon: item.record.render.icon, x: item.xStart, iconX: item.iconX, labelX: item.labelX, labelWidth: item.labelWidth })), density: density.bins, knots: map.knots };
    await provider.releaseQuery(query.queryId);
  }
  const a = report.providers.local, b = report.providers.server;
  assert.deepEqual(a.pages, b.pages); assert.equal(a.totalRows, b.totalRows);
  assert.deepEqual(a.placements, b.placements);
  assert.deepEqual(a.density, b.density); assert.deepEqual(a.knots, b.knots);
  for (const file of originals.files) assert.equal(createHash('sha256').update(await readFile(file.path)).digest('hex'), file.sha256, file.path);
  report.unchangedFixtureFiles = originals.files.length;
  report.buildSha256 = createHash('sha256').update(await readFile('dist/index.html')).digest('hex');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.message; throw error; }
finally {
  for (const provider of Object.values(providers)) await provider.dispose();
  await writeFile('output/hazard-parity/data-verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, providers: Object.fromEntries(Object.entries(report.providers).map(([name, value]) => [name, { records: value.records, rows: value.totalRows, pages: value.pages.length, searchMatches: value.searchMatches, elapsedMs: value.elapsedMs }])) }));
}
