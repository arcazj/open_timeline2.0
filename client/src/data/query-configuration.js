import { compileExpression, compileSearch, createRegexBudget } from './filter-expression.js';
import { filterFieldTypes } from './configuration-catalog.js';
import { configurationResource } from './configuration-access.js';
import { ProviderError, canonicalJson } from './data-provider.js';

export function resolveQueryConfiguration(snapshot, input, actor = { id: 'local', capabilities: ['*'] }, options = {}) {
  const definitionVersion = input.definitionVersion === undefined ? 1 : input.definitionVersion;
  if (![1, 2].includes(definitionVersion)) throw new ProviderError('unsupported_query_definition', 'Supported query definition versions are 1 and 2', 422);
  if (definitionVersion === 1 && input.relationshipMode !== undefined) throw new ProviderError('unsupported_query_definition', 'Relationship modes require query definition version 2', 422);
  const filters = input.filters === undefined ? {} : input.filters;
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).some(key => !['kind', 'sourceId', 'expression', 'sourceIds', 'kinds', 'schemaRefs', 'filterId', 'filterVersion'].includes(key))) throw new ProviderError('invalid_filter', 'Unknown filter field', 422);
  if ((filters.filterId == null) !== (filters.filterVersion == null)) throw new ProviderError('invalid_filter', 'Filter ID and version must occur together', 422);
  let saved;
  if (filters.filterId != null) {
    const resource = configurationResource(snapshot, 'filters', filters.filterId, actor);
    saved = resource.versions.find(item => item.version === filters.filterVersion)?.definition;
    if (!saved) throw new ProviderError('configuration_version_unavailable', 'Saved filter publication is unavailable', 409);
    if (filters.schemaRefs !== undefined && canonicalJson(filters.schemaRefs) !== canonicalJson(saved.schemaRefs)) throw new ProviderError('invalid_filter', 'A saved filter retains its published schema scope', 422);
  }
  if (definitionVersion === 1 && saved?.definitionVersion === 2) throw new ProviderError('unsupported_query_definition', 'Version 2 saved filters require query definition version 2', 422);
  const relationshipMode = input.relationshipMode ?? saved?.relationshipMode ?? 'independent';
  if (!['independent', 'family'].includes(relationshipMode)) throw new ProviderError('invalid_relationship_mode', 'Choose independent records or family context', 422);
  const schemaRefs = saved?.schemaRefs ?? filters.schemaRefs ?? [];
  if (!Array.isArray(schemaRefs) || schemaRefs.length > 100 || schemaRefs.some(pin => !pin || typeof pin.id !== 'string' || !Number.isSafeInteger(pin.version) || pin.version < 1 || Object.keys(pin).some(key => !['id', 'version'].includes(key)))) throw new ProviderError('invalid_filter', 'Schema scope requires bounded exact version pins', 422);
  for (const pin of schemaRefs) configurationResource(snapshot, 'schemas', pin.id, actor);
  const fieldTypes = filterFieldTypes(snapshot, schemaRefs);
  if (definitionVersion === 1 && [filters.expression, saved?.expression].some(expression => expression?.version === 2)) throw new ProviderError('unsupported_query_definition', 'Version 2 expressions require query definition version 2', 422);
  const regexBudget = createRegexBudget(options);
  const predicate = compileExpression(filters.expression, { fieldTypes, regexBudget });
  const savedPredicate = compileExpression(saved?.expression, { fieldTypes, regexBudget });
  const savedSearch = saved?.search;
  const searchInput = saved ? { search: savedSearch.text, searchMode: savedSearch.mode,
    ...(savedSearch.mode === 'regex' ? { searchFlags: savedSearch.flags, searchMatchMode: savedSearch.matchMode, searchDialect: savedSearch.dialect } : { searchCaseSensitive: savedSearch.caseSensitive }),
    searchFields: savedSearch.fields, ...input } : input;
  if (saved && input.searchMode !== undefined && input.searchMode !== savedSearch.mode) {
    for (const key of input.searchMode === 'regex' ? ['searchCaseSensitive'] : ['searchFlags', 'searchMatchMode', 'searchDialect']) {
      if (!(key in input)) delete searchInput[key];
    }
  }
  const search = compileSearch(searchInput, { fieldTypes, regexBudget });
  const required = snapshot.manifest?.legacy?.configuration?.sourcePredicates ?? {};
  if (!required || typeof required !== 'object' || Array.isArray(required) || Object.keys(required).length > 100 || Object.keys(required).some(id => !snapshot.manifest.scope.sourceIds.includes(id))) throw new ProviderError('invalid_source_predicate', 'Source predicates must identify configured sources', 422);
  const sourcePredicates = new Map(Object.entries(required).map(([id, expression]) => [id, compileExpression(expression, { fieldTypes: { ...fieldTypes, '/data/namespace': 'string' }, regexBudget })]));
  const kind = filters.kind === undefined ? 'all' : filters.kind, source = filters.sourceId === undefined ? 'all' : filters.sourceId;
  if (!['all', 'event', 'session'].includes(kind) || typeof source !== 'string') throw new ProviderError('invalid_filter', 'Unknown record kind or source', 422);
  const sourceIds = filters.sourceIds === undefined ? null : filters.sourceIds, kinds = filters.kinds === undefined ? ['event', 'session'] : filters.kinds;
  if (sourceIds !== null && (!Array.isArray(sourceIds) || sourceIds.length > 100 || sourceIds.some(id => typeof id !== 'string') || new Set(sourceIds).size !== sourceIds.length)) throw new ProviderError('invalid_filter', 'Invalid source list', 422);
  if (!Array.isArray(kinds) || kinds.length > 2 || kinds.some(value => !['event', 'session'].includes(value)) || new Set(kinds).size !== kinds.length) throw new ProviderError('invalid_filter', 'Invalid kinds list', 422);
  const schemaKeys = new Set(schemaRefs.map(pin => `${pin.id}:${pin.version}`));
  const sourceSelected = sourceId => (source === 'all' || sourceId === source) && (sourceIds === null || sourceIds.includes(sourceId))
    && (!saved || saved.sourceIds === null || saved.sourceIds.includes(sourceId));
  function hardPredicate(record) {
    return !record.deletedAt && (kind === 'all' || record.kind === kind) && sourceSelected(record.sourceId) && kinds.includes(record.kind)
      && (!saved || saved.kinds.includes(record.kind))
      && (!schemaKeys.size || schemaKeys.has(`${record.schemaId}:${record.schemaVersion}`)) && (!sourcePredicates.has(record.sourceId) || sourcePredicates.get(record.sourceId)(record));
  }
  const directPredicate = record => savedPredicate(record) && predicate(record);
  return { search, fieldTypes, definitionVersion, relationshipMode, sourceSelected, hardPredicate, directPredicate,
    explanationDefinition: { expressions: [saved?.expression, filters.expression].filter(Boolean), search: searchInput },
    predicate: record => hardPredicate(record) && directPredicate(record) };
}
