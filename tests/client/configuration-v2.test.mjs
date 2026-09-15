import test from 'node:test';
import assert from 'node:assert/strict';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { normalizeConfiguration, validateResourceDefinition, applyConfigurationCommand, effectiveSettings, configurationUsage } from '../../client/src/data/configuration-catalog.js';
import { applySettingsCommand } from '../../client/src/data/settings-commands.js';
import { resolveQueryConfiguration } from '../../client/src/data/query-configuration.js';

const actor = { id: 'admin', capabilities: ['*'] }, now = '2026-09-14T00:00:00.000Z';
const regexSearch = { text: '^Activity_', mode: 'regex', fields: ['/title'], flags: ['i'], matchMode: 'search', dialect: 're2-common-v1' };
const filter = () => ({ definitionVersion: 2, relationshipMode: 'family', sourceIds: null, kinds: ['event', 'session'], schemaRefs: [], expression: { version: 2, root: { op: 'regex', field: '/title', pattern: 'Activity', ruleId: 'activity' } }, search: structuredClone(regexSearch) });
let sequence = 0;
function command(snapshot, family, type, payload, resource) {
  return applyConfigurationCommand(snapshot, { family, type, generation: snapshot.manifest.generation, clientCommandId: `v2-${++sequence}`, payload, ...(resource ? { resourceId: resource.id, expectedRevision: resource.revision } : {}), ...(type === 'apply' ? { expectedPreferenceRevision: snapshot.preferences.find(item => item.principalId === actor.id)?.revision ?? 0 } : {}) }, { actor, now, createId: () => `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}` });
}
function publish(snapshot, family, definition) {
  let result = command(snapshot, family, 'create', { name: `${family} v2`, visibility: 'workspace', definition });
  if (!result.resource.versions.length) result = command(result.snapshot, family, 'publish', {}, result.resource);
  return result;
}

test('catalog version boundary keeps regex and relationship definitions explicit', () => {
  assert.equal(validateResourceDefinition('filters', filter()).valid, true);
  for (const invalid of [{ ...filter(), definitionVersion: 1 }, { ...filter(), search: { ...regexSearch, caseSensitive: false } }, { ...filter(), expression: { version: 2, root: { op: 'regex', field: '/title', pattern: '(?=unsafe)' } } }]) assert.equal(validateResourceDefinition('filters', invalid).valid, false);
  const legacy = { ...filter() }; delete legacy.definitionVersion;
  assert.equal(validateResourceDefinition('filters', legacy).valid, false);
  const migration = { format: 'legacy-filter-migration', version: 1, original: { include: 'status=ready', exclude: '', sortBy: 'NONE' }, acknowledged: ['help-equality-repair'] };
  assert.equal(validateResourceDefinition('filters', { ...filter(), migration }).valid, true);
  assert.equal(validateResourceDefinition('filters', { ...filter(), migration: { ...migration, original: { ...migration.original, include: 'x'.repeat(4097) } } }).valid, false);
});

test('v2 saved filter/view pins survive publication, effective resolution, apply and usage', () => {
  const published = publish(normalizeConfiguration(structuredClone(initial), actor), 'filters', filter());
  const definition = { definitionVersion: 2, model: { id: 'light', version: 1 }, filter: { id: published.resource.id, version: 1 }, settings: { definitionVersion: 2, groupOrder: { order: 'natural', caseSensitive: false }, sort: [{ field: '/title', direction: 'asc', order: 'natural', caseSensitive: false }], collapsedGroups: ['string:SOURCE1'], relationshipMode: 'independent' } };
  assert.equal(validateResourceDefinition('views', { ...definition, definitionVersion: 1, settings: {} }, { snapshot: published.snapshot }).valid, false);
  const view = publish(published.snapshot, 'views', definition);
  const applied = command(view.snapshot, 'views', 'apply', { version: 1 }, view.resource);
  assert.equal(applied.effectiveSettings.values.definitionVersion, 2);
  assert.deepEqual(applied.effectiveSettings.values.search, regexSearch);
  assert.equal(applied.effectiveSettings.values.relationshipMode, 'independent');
  assert.deepEqual(applied.effectiveSettings.values.groupOrder, definition.settings.groupOrder);
  assert.equal(configurationUsage(applied.snapshot, 'groups', 'string:SOURCE1').length, 0);
  const overridden = effectiveSettings(applied.snapshot, { principalId: actor.id, transient: { definitionVersion: 2, search: { text: 'literal', mode: 'any', caseSensitive: false, fields: ['/title'] } } });
  assert.deepEqual(overridden.values.search, { text: 'literal', mode: 'any', caseSensitive: false, fields: ['/title'] });
});

test('typed v2 sorting/collapse validation and mode-changing settings patches remain strict', () => {
  const base = { definitionVersion: 2, model: { id: 'light', version: 1 }, filter: null, settings: { definitionVersion: 2 } };
  for (const settings of [{ sort: [{ field: '/order', direction: 'asc', order: 'natural' }] }, { collapsedGroups: ['resource-group-id'] }, { collapsedGroups: ['string:e\u0301'] }]) assert.equal(validateResourceDefinition('views', { ...base, settings: { ...base.settings, ...settings } }).valid, false);
  let snapshot = normalizeConfiguration(structuredClone(initial), actor), revision = 0;
  for (const search of [regexSearch, { text: 'Activity', mode: 'any', caseSensitive: true, fields: ['/title'] }, regexSearch]) {
    const result = applySettingsCommand(snapshot, { scope: 'personal', type: 'patch', expectedRevision: revision++, generation: snapshot.manifest.generation, clientCommandId: `settings-${revision}`, payload: { definitionVersion: 2, search } }, actor);
    assert.deepEqual(result.settings.values.search, search); assert.deepEqual(result.effectiveSettings.values.search, search);
    snapshot = result.snapshot;
  }
});

test('saved query search mode overrides remove inherited options and retain relationship semantics', () => {
  for (const savedSearch of [regexSearch, { text: 'Activity', mode: 'any', caseSensitive: false, fields: ['/title'] }]) {
    const saved = publish(normalizeConfiguration(structuredClone(initial), actor), 'filters', { ...filter(), search: savedSearch });
    const input = { definitionVersion: 2, filters: { filterId: saved.resource.id, filterVersion: 1 } };
    assert.equal(resolveQueryConfiguration(saved.snapshot, input, actor).relationshipMode, 'family');
    assert.equal(resolveQueryConfiguration(saved.snapshot, { ...input, relationshipMode: 'independent' }, actor).relationshipMode, 'independent');
    assert.throws(() => resolveQueryConfiguration(saved.snapshot, { ...input, definitionVersion: 1 }, actor), { code: 'unsupported_query_definition' });
    const override = savedSearch.mode === 'regex' ? { searchMode: 'phrase', search: 'literal' } : { searchMode: 'regex', search: '^literal$', searchFlags: [] };
    const resolved = resolveQueryConfiguration(saved.snapshot, { ...input, ...override }, actor);
    assert.equal(resolved.search.matches({ title: 'literal' }), true);
    assert.equal(resolved.search.matches({ title: 'unrelated' }), false);
    assert.throws(() => resolveQueryConfiguration(saved.snapshot, { ...input, ...override, ...(override.searchMode === 'regex' ? { searchCaseSensitive: false } : { searchFlags: [] }) }, actor), { code: 'invalid_search' });
  }
});

test('v2 table settings validate, merge and reset without changing v1 definitions', () => {
  const base = { definitionVersion: 2, model: { id: 'light', version: 1 }, filter: null, settings: { definitionVersion: 2, table: { scope: 'window', projection: 'matches', limit: 250 } } };
  assert.equal(validateResourceDefinition('views', base).valid, true);
  assert.equal(validateResourceDefinition('views', { ...base, definitionVersion: 1, settings: { table: base.settings.table } }).valid, false);
  for (const table of [{ scope: 'visible' }, { projection: 'findings' }, { limit: 1001 }, { cursor: 'stale' }]) assert.equal(validateResourceDefinition('views', { ...base, settings: { definitionVersion: 2, table } }).valid, false);
  let snapshot = normalizeConfiguration(structuredClone(initial), actor), revision = 0;
  for (const [type, payload] of [['patch', base.settings], ['patch', { table: { limit: 50 } }], ['reset', { paths: ['/table/projection'] }]]) {
    const result = applySettingsCommand(snapshot, { scope: 'personal', type, expectedRevision: revision++, generation: snapshot.manifest.generation, clientCommandId: `table-${revision}`, payload }, actor);
    snapshot = result.snapshot;
  }
  assert.deepEqual(effectiveSettings(snapshot, { principalId: actor.id }).values.table, { scope: 'window', limit: 50 });
});
