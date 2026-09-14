import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './server-fixture.mjs';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { LocalProvider } from '../../client/src/data/local-provider.js';

test('real HTTP aggregated overview parity preserves boundary membership, search and pinned counts', async () => {
  const server = await startServer(), remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token });
  let local;
  try {
    await remote.initialize();
    const snapshot = await remote.exportSnapshot(), origin = Date.parse('2031-01-01T00:00:00.000Z'), width = 16000;
    const extra = Array.from({ length: 1600 }, (_, index) => {
      const start = origin + (index % 20 - 2) * 1000, kind = index % 4 === 0 ? 'event' : 'session';
      const end = kind === 'event' || index % 4 === 1 ? null : index % 4 === 2 ? start : start + 5000;
      return { ...snapshot.records[0], id: `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: index < 1450 ? 'Needle' : 'Other', kind, start: new Date(start).toISOString(), end: end === null ? null : new Date(end).toISOString(), parentSessionId: null, originalStart: null, originalEnd: null, tags: ['overview-fixture'] };
    });
    // Isolated stopped-server fixture construction, not a production write-path test.
    await server.pause();
    for (const record of extra) await writeFile(path.join(server.directory, 'records', `${record.id}.json`), JSON.stringify(record));
    const { records, ...metadata } = snapshot;
    metadata.manifest.recordCount += extra.length;
    delete metadata.manifest.contentSha256;
    await writeFile(path.join(server.directory, 'workspace.json'), JSON.stringify(metadata));
    await server.restart(); await remote.initialize();
    local = new LocalProvider(await remote.exportSnapshot()); await local.initialize();
    const input = { domain: { from: new Date(origin).toISOString(), to: new Date(origin + width).toISOString() }, filters: { expression: { version: 1, root: { op: 'contains', field: '/tags', value: 'overview-fixture' } } }, bins: 16, scaleMode: 'adaptive' };
    for (const search of ['', 'Needle', 'zzzz-absent-zzzz']) {
      const left = await local.createQuery({ ...input, search }), right = await remote.createQuery({ ...input, search });
      try {
        const result = await local.getOverview(left.queryId), expected = await remote.getOverview(right.queryId);
        assert.deepEqual(result, expected);
        assert.equal(result.aggregated, search !== 'zzzz-absent-zzzz');
        assert.deepEqual(await local.getDensity(left.queryId), await remote.getDensity(right.queryId));
        if (!search) {
          await remote.executeCommand({ type: 'update', generation: remote.metadata.generation, clientCommandId: crypto.randomUUID(), recordId: extra[0].id, expectedVersion: extra[0].version, payload: { title: 'Changed after pin' } });
          assert.deepEqual(await remote.getOverview(right.queryId), expected);
        }
      } finally { await local.releaseQuery(left.queryId); await remote.releaseQuery(right.queryId); }
    }
  } finally { local?.dispose(); remote.dispose(); await server.stop(); }
});
