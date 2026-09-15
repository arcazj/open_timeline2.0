import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { LocalProvider } from '../client/src/data/local-provider.js';

const snapshot = JSON.parse(await readFile(new URL('../shared/fixtures/initial-snapshot.json', import.meta.url), 'utf8'));
const count = 10000, repetitions = 5;
const base = Date.parse(snapshot.settings.overview.from), duration = Date.parse(snapshot.settings.overview.to) - base;
const prototype = snapshot.records[0];
snapshot.records = Array.from({ length: count }, (_, index) => {
  const start = base + Math.floor(index * (duration - 1) / count), session = index % 3 !== 0;
  return { ...structuredClone(prototype), id: `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    title: `Generic ${session ? 'session' : 'event'} ${index}`, kind: session ? 'session' : 'event',
    sourceId: index % 2 ? 'operations' : 'verification', start: new Date(start).toISOString(),
    end: session ? new Date(start + (index % 37 === 0 ? duration : 30 * 60000)).toISOString() : null, order: index };
});
snapshot.manifest.recordCount = count;
delete snapshot.manifest.contentSha256;
const runs = [];
for (let run = 0; run < repetitions; run++) {
  const provider = new LocalProvider(snapshot), timings = {};
  async function measure(name, operation) {
    const start = performance.now(), result = await operation();
    timings[name] = Math.round((performance.now() - start) * 100) / 100;
    return result;
  }
  try {
    await measure('initializeMs', () => provider.initialize());
    const query = await measure('queryAndDensityMs', () => provider.createQuery({ definitionVersion: 2,
      domain: snapshot.settings.overview, scaleMode: 'adaptive', bins: 256, ratio: 8 }));
    const map = await provider.getMap(query.queryId, query.mapId);
    const table = { sort: [{ field: 'title', direction: 'asc', order: 'natural', caseSensitive: true }], limit: 1000 };
    const found = new Set();
    await measure('naturalTableTraversalMs', async () => {
      let cursor;
      do {
        const page = await provider.queryRecords(query.queryId, { ...table, cursor });
        for (const { record } of page.items) {
          if (found.has(record.id)) throw new Error('Duplicate table ID');
          found.add(record.id);
        }
        cursor = page.nextCursor;
      } while (cursor);
    });
    if (found.size !== count) throw new Error('Incomplete table traversal');
    for (const [name, fraction] of [['past', 0.1], ['center', 0.4], ['future', 0.7]]) {
      const from = new Date(base + duration * fraction).toISOString(), to = new Date(base + duration * (fraction + 0.2)).toISOString();
      const layout = await measure(`${name}LayoutMs`, () => provider.createLayout(query.queryId, {
        mapId: map.mapId, from, to, width: 1500, availableHeight: 500, rowHeight: 32, fontSize: 13, groupBy: 'sourceId',
        groupOrder: { order: 'natural' } }));
      const page = await measure(`${name}FirstPageMs`, () => provider.getRows(query.queryId, layout.layoutId, {}));
      if (!page.items.length || layout.logicalGroupTotal !== 2) throw new Error('Grouped navigation did not return both source groups');
      await provider.releaseLayout(query.queryId, layout.layoutId);
    }
    runs.push({ run: run + 1, traversed: found.size, timings });
  } finally { provider.dispose(); }
}
const sourceSha256 = {};
for (const name of ['scripts/profile-sorting-v2.mjs', 'client/src/data/query-core.js', 'client/src/data/query-relationships.js',
  'client/src/data/query-work.js', 'client/src/data/local-provider.js', 'client/src/data/record-table.js', 'client/src/timeline/layout-presentation.js']) {
  sourceSha256[name] = createHash('sha256').update(await readFile(new URL(`../${name}`, import.meta.url))).digest('hex');
}
const report = { format: 'sorting-v2-engine-profile-v1', at: new Date().toISOString(), count, repetitions,
  engine: 'Node LocalProvider v2; not browser frame/pan latency, HTTP startup, cold-disk performance or formal percentile certification',
  runtime: process.version, platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model,
  snapshotSha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), sourceSha256, runs,
  summary: Object.fromEntries(Object.keys(runs[0].timings).map(key => {
    const values = runs.map(run => run.timings[key]).sort((a, b) => a - b);
    return [key, { min: values[0], median: values[Math.floor(values.length / 2)], max: values.at(-1) }];
  })) };
await mkdir('artifacts/performance', { recursive: true });
await writeFile('artifacts/performance/sorting-v2-10k.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ count, repetitions, summary: report.summary }));
