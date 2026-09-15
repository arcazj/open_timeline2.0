import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { startLegacyServer, legacyDomain } from './legacy-server-fixture.mjs';
import { publishConfiguration } from './configuration-fixture.mjs';

test('saved source scope has exact local/HTTP record and zone parity on real legacy JSON', async () => {
  const server = await startLegacyServer({ preferences: true }), remote = new ServerProvider(server); let local;
  try {
    await remote.initialize(); const initial = await remote.exportSnapshot();
    const alpha = initial.sources.find(source => source.name === 'alpha').id, beta = initial.sources.find(source => source.name === 'beta').id;
    const filter = await publishConfiguration(remote, 'filters', 'Alpha only', { definitionVersion: 2, relationshipMode: 'independent',
      sourceIds: [alpha], kinds: ['event', 'session'], schemaRefs: [], expression: null,
      search: { text: '', mode: 'all', fields: ['/title'], caseSensitive: false } }, 'personal');
    const snapshot = await remote.exportSnapshot();
    local = new LocalProvider(snapshot); await local.initialize();
    const deadline = Date.now() + 10000;
    while (!(await remote.getLoadingStatus()).complete) {
      assert.ok(Date.now() < deadline, 'Bounded fixture index preparation'); await new Promise(resolve => setTimeout(resolve, 20));
    }
    for (const sourceId of ['all', alpha, beta]) {
      const results = [];
      for (const provider of [local, remote]) {
        const saved = await provider.createQuery({ definitionVersion: 2, domain: legacyDomain, filters: { filterId: filter.id, filterVersion: 1, sourceId } });
        const explicit = await provider.createQuery({ definitionVersion: 2, domain: legacyDomain, filters: { sourceIds: [alpha], sourceId } });
        try {
          assert.equal(saved.baseTotal, explicit.baseTotal);
          const zones = await provider.getZones(saved.queryId);
          assert.deepEqual(zones, await provider.getZones(explicit.queryId));
          assert.equal(zones.items.length, sourceId === beta ? 0 : 1);
          assert.ok(zones.items.every(zone => zone.legacy.sourceId === alpha));
          results.push({ baseTotal: saved.baseTotal, zones });
        } finally { await provider.releaseQuery(saved.queryId); await provider.releaseQuery(explicit.queryId); }
      }
      assert.deepEqual(results[0], results[1]);
    }
    for (const [file, bytes] of server.originals) assert.deepEqual(await readFile(file), bytes);
  } finally { local?.dispose(); remote.dispose(); await server.stop(); }
});
