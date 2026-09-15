import test from 'node:test';
import assert from 'node:assert/strict';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { publishConfiguration } from '../integration/configuration-fixture.mjs';

for (const version of [1, 2]) test(`v${version} saved source filters and explicit source filters retain identical records and zones`, async () => {
  const snapshot = structuredClone(initial), zone = snapshot.zones[0];
  snapshot.zones = [
    { ...zone, id: '80000000-0000-4000-8000-000000000001', legacy: { sourceId: 'operations' } },
    { ...zone, id: '80000000-0000-4000-8000-000000000002', legacy: { sourceId: 'verification' } },
    { ...zone, id: '80000000-0000-4000-8000-000000000003' },
  ];
  const provider = new LocalProvider(snapshot); await provider.initialize();
  try {
    const filter = await publishConfiguration(provider, 'filters', 'Operations only', {
      ...(version === 2 ? { definitionVersion: 2, relationshipMode: 'independent' } : {}),
      sourceIds: ['operations'], kinds: ['event', 'session'], schemaRefs: [], expression: null,
      search: { text: '', mode: 'all', fields: ['/title'], caseSensitive: false },
    }, 'personal');
    for (const sourceId of ['all', 'operations', 'verification']) {
      const request = { definitionVersion: version, domain: snapshot.settings.overview };
      const saved = await provider.createQuery({ ...request, filters: { filterId: filter.id, filterVersion: 1, sourceId } });
      const explicit = await provider.createQuery({ ...request, filters: { sourceIds: ['operations'], sourceId } });
      try {
        assert.equal(saved.baseTotal, explicit.baseTotal);
        const selected = await provider.getZones(saved.queryId);
        assert.deepEqual(selected, await provider.getZones(explicit.queryId));
        assert.deepEqual(selected.items.map(item => item.id).sort(), sourceId === 'verification' ? [snapshot.zones[2].id] : [snapshot.zones[0].id, snapshot.zones[2].id]);
      } finally { await provider.releaseQuery(saved.queryId); await provider.releaseQuery(explicit.queryId); }
    }
  } finally { provider.dispose(); }
});
