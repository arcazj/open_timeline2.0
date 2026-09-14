import test from 'node:test';
import assert from 'node:assert/strict';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { normalizeConfiguration, effectiveSettings } from '../../client/src/data/configuration-catalog.js';
import { exportWithPersonalPreferences, resetTransientSettings } from '../../client/src/ui/view-settings.js';
import { snapshotContent } from '../../client/src/data/snapshot-content.js';
import { sha256 } from '../../client/src/data/data-provider.js';
const actor = { id: 'server-alice', capabilities: ['*'] };

test('Apply clears exactly authored transient keys and does not mutate retained navigation settings', () => {
  const value = { range: { from: 'a', to: 'b' }, theme: 'dark', search: { text: 'gate' }, mode: 'split' };
  const next = resetTransientSettings(value, ['search', 'filterId', 'filterVersion']);
  assert.deepEqual(next, { range: { from: 'a', to: 'b' }, theme: 'dark', mode: 'split' });
  assert.equal(value.search.text, 'gate'); next.range.from = 'changed'; assert.equal(value.range.from, 'a');
});

test('complete export stores temporary settings under the active principal and hashes all expanded catalogs', async () => {
  const original = normalizeConfiguration(initial, actor), shared = structuredClone(original.settings);
  original.preferences.push({ principalId: 'someone-else', revision: 1, values: { theme: 'classic' } });
  const snapshot = await exportWithPersonalPreferences(original, { theme: 'dark', mode: 'table' }, actor);
  assert.deepEqual(snapshot.settings, shared);
  assert.deepEqual(snapshot.preferences.find(item => item.principalId === actor.id).values, { theme: 'dark', mode: 'table' });
  assert.deepEqual(snapshot.preferences.find(item => item.principalId === 'someone-else'), original.preferences[0]);
  assert.equal(snapshot.preferences.some(item => item.principalId === 'local'), false);
  assert.equal(original.preferences.length, 1);
  assert.equal(snapshot.manifest.contentSha256, await sha256(snapshotContent(snapshot)));
});

test('export does not create a preference entry when there are no actual temporary edits', async () => {
  const original = normalizeConfiguration(initial, actor), snapshot = await exportWithPersonalPreferences(original, {}, actor);
  assert.deepEqual(snapshot.preferences, original.preferences); assert.deepEqual(snapshot.settings, original.settings);
});

test('application search retains the legacy six fields while explicit authored selection remains exact', () => {
  const snapshot = normalizeConfiguration(initial, actor);
  assert.deepEqual(effectiveSettings(snapshot, { principalId: actor.id }).values.search.fields, ['/title', '/data/description', '/data/text', '/data/system', '/data/type', '/data/status']);
  snapshot.preferences.push({ principalId: actor.id, revision: 1, values: { search: { fields: ['/title'] } } });
  assert.deepEqual(effectiveSettings(snapshot, { principalId: actor.id }).values.search.fields, ['/title']);
});
