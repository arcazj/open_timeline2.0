import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { LocalProvider } from '../client/src/data/local-provider.js';

const count = Number(process.argv[2] || 25000);
if (!Number.isInteger(count) || count < 1 || count > 25000) throw new Error('Record count must be 1-25000');
const snapshot = JSON.parse(await readFile(new URL('../shared/fixtures/initial-snapshot.json', import.meta.url), 'utf8'));
const base = Date.parse(snapshot.settings.overview.from), duration = Date.parse(snapshot.settings.overview.to) - base;
const prototype = snapshot.records[0];
snapshot.records = Array.from({ length: count }, (_, index) => {
  const start = base + Math.floor(index * (duration - 1) / count), session = index % 3 !== 0;
  return { ...structuredClone(prototype), id: `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, title: `Generic ${session ? 'session' : 'event'} ${index}`, kind: session ? 'session' : 'event', start: new Date(start).toISOString(), end: session ? new Date(start + (index % 37 === 0 ? duration : 30 * 60000)).toISOString() : null, order: index };
});
snapshot.manifest.recordCount = count; delete snapshot.manifest.contentSha256;
const provider = new LocalProvider(snapshot), timings = {};
async function measure(name, operation) { const start = performance.now(); const value = await operation(); timings[name] = Math.round((performance.now() - start) * 100) / 100; return value; }
try {
  await measure('initializeMs', () => provider.initialize());
  const query = await measure('queryAndDensityMs', () => provider.createQuery({ domain: snapshot.settings.overview, filters: {}, search: '', scaleMode: 'adaptive', bins: 128, ratio: 4 }));
  const map = await provider.getMap(query.queryId, query.mapId);
  const layout = await measure('globalLayoutMs', () => provider.createLayout(query.queryId, { mapId: map.mapId, ...snapshot.settings.range, width: 1500, availableHeight: 500, rowHeight: 32, fontSize: 13, groupBy: 'none' }));
  const rows = await measure('firstRowPageMs', () => provider.getRows(query.queryId, layout.layoutId, {}));
  const traversed = new Set();
  await measure('completeTableTraversalMs', async () => {
    let cursor;
    do {
      const page = await provider.queryRecords(query.queryId, { limit: 1000, cursor });
      for (const item of page.items) { if (traversed.has(item.record.id)) throw new Error('Duplicate table ID'); traversed.add(item.record.id); }
      cursor = page.nextCursor;
    } while (cursor);
  });
  if (traversed.size !== count) throw new Error('Incomplete dataset traversal');
  const exported = await measure('completeExportMs', () => provider.exportSnapshot());
  if (exported.records.length !== count) throw new Error('Incomplete export');
  const report = { at: new Date().toISOString(), runtime: process.version, platform: process.platform, engine: 'Node LocalProvider; not a browser responsiveness certification', count, bytes: Buffer.byteLength(JSON.stringify(snapshot)), timings, loadedRecords: rows.loadedCount, logicalRows: layout.totalRows, traversed: traversed.size, memory: process.memoryUsage(), resourceUsage: process.resourceUsage() };
  await mkdir('artifacts/performance', { recursive: true });
  await writeFile('artifacts/performance/local-latest.json', JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally { provider.dispose(); }
