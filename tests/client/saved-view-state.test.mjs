import test from 'node:test';
import assert from 'node:assert/strict';
import { captureFilterDefinition, captureViewDefinition, exactPublishedFilter, portableViewDraft } from '../../client/src/ui/saved-view-state.js';

const expression = { version: 2, root: { op: 'eq', field: '/kind', value: 'event', ruleId: 'type' } };
const search = { text: '^launch', mode: 'regex', fields: ['/title'], flags: ['i'], matchMode: 'search', dialect: 're2-common-v1' };
const migration = { format: 'legacy-filter-migration', version: 1, original: { include: 'type:event', exclude: '', sortBy: 'namespace' }, acknowledged: ['legacy_colon_and'] };
const capture = () => ({ definitionVersion: 2, relationshipMode: 'family', filters: { sourceId: 'all', sourceIds: ['b', 'a'], kind: 'all', expression }, search,
  model: { id: 'legacy-model', version: 3 }, settings: { modelId: 'legacy-model', modelVersion: 3, mode: 'split', groupOrder: { order: 'natural', caseSensitive: false }, collapsedGroups: ['string:a'], sort: [{ field: '/title', direction: 'desc', order: 'natural', caseSensitive: false }], columns: [{ field: '/title', visible: true, width: 200 }], table: { projection: 'matches', scope: 'window', limit: 100 } }, migration });

test('saved filter capture intersects all selectors and retains schema pins, both ASTs and migration', () => {
  const input = capture(), before = structuredClone(input);
  input.filters.filterId = 'filter-a'; input.filters.filterVersion = 2; input.filters.kind = 'event';
  const saved = { sourceIds: ['a', 'c'], kinds: ['session', 'event'], schemaRefs: [{ id: 'schema', version: 5 }], expression: { version: 1, root: { op: 'exists', field: '/title', value: true } }, search: { text: '', mode: 'any', caseSensitive: false, fields: ['/title'] } };
  const definition = captureFilterDefinition(input, saved);
  assert.deepEqual(definition.sourceIds, ['a']); assert.deepEqual(definition.kinds, ['event']);
  assert.deepEqual(definition.schemaRefs, [{ id: 'schema', version: 5 }]);
  assert.deepEqual(definition.expression, { version: 2, root: { op: 'and', args: [saved.expression.root, expression.root] } });
  assert.deepEqual(definition.search, search); assert.deepEqual(definition.migration, migration);
  assert.deepEqual(input.settings, before.settings); assert.deepEqual(input.filters.expression, before.filters.expression);
  assert.throws(() => captureFilterDefinition(input), /must be loaded/);
});

test('only an exact accessible publication can pin a view, never an unpublished draft', () => {
  const definition = captureFilterDefinition(capture());
  const resources = [
    { id: 'draft', lifecycle: 'active', versions: [], draft: definition },
    { id: 'archived', lifecycle: 'archived', versions: [{ version: 1, definition }] },
    { id: 'saved', lifecycle: 'active', visibility: 'personal', versions: [{ version: 1, definition: { ...definition, sourceIds: ['a'] } }, { version: 2, definition: { ...definition, sourceIds: ['b', 'a'], kinds: ['session', 'event'] } }] },
  ];
  assert.deepEqual(exactPublishedFilter(resources, definition), { id: 'saved', version: 2, visibility: 'personal' });
  assert.equal(exactPublishedFilter(resources, { ...definition, search: { ...search, text: 'changed' } }), null);
  const view = captureViewDefinition(capture(), exactPublishedFilter(resources, definition));
  assert.deepEqual(view.model, { id: 'legacy-model', version: 3 }); assert.deepEqual(view.filter, { id: 'saved', version: 2 });
  assert.equal(view.settings.modelId, undefined); assert.equal(view.settings.modelVersion, undefined);
  assert.deepEqual(view.settings.search, search); assert.deepEqual(view.settings.table, { projection: 'matches', scope: 'window', limit: 100 });
  assert.equal(view.settings.definitionVersion, 2); assert.equal(view.settings.relationshipMode, 'family');
  assert.equal(portableViewDraft('views', view, 'Review').format, 'timeline-configuration');
});

test('version 1 stays version 1 and incompatible definitions cannot be silently downgraded', () => {
  const input = { definitionVersion: 1, filters: {}, search: { text: '', mode: 'all', caseSensitive: false, fields: ['/title'] }, model: { id: 'v1-model', version: 1 }, settings: { sort: [{ field: 'start', direction: 'asc' }] } };
  const definition = captureFilterDefinition(input);
  assert.equal(definition.definitionVersion, undefined); assert.equal(definition.relationshipMode, undefined);
  assert.equal(captureViewDefinition(input, { id: 'filter', version: 1 }).definitionVersion, undefined);
  assert.throws(() => captureFilterDefinition({ ...capture(), definitionVersion: 1 }), /Version 2 conditions/);
  assert.throws(() => captureViewDefinition({ ...input, settings: { table: { projection: 'matches' } } }, { id: 'filter', version: 1 }), /cannot be omitted/);
  assert.throws(() => captureFilterDefinition({ ...capture(), filters: { filterId: 'old', expression: null } }, { ...definition, migration: { ...migration, original: { ...migration.original, include: 'other' } } }), /Two different migration/);
});
