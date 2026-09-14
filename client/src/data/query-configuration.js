import { compileExpression, compileSearch } from './filter-expression.js';
import { filterFieldTypes } from './configuration-catalog.js';
import { configurationResource } from './configuration-access.js';
import { ProviderError, canonicalJson } from './data-provider.js';

export function resolveQueryConfiguration(snapshot, input, actor = { id: 'local', capabilities: ['*'] }) {
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
  const schemaRefs = saved?.schemaRefs ?? filters.schemaRefs ?? [];
  if (!Array.isArray(schemaRefs) || schemaRefs.length > 100 || schemaRefs.some(pin => !pin || typeof pin.id !== 'string' || !Number.isSafeInteger(pin.version) || pin.version < 1 || Object.keys(pin).some(key => !['id', 'version'].includes(key)))) throw new ProviderError('invalid_filter', 'Schema scope requires bounded exact version pins', 422);
  for (const pin of schemaRefs) configurationResource(snapshot, 'schemas', pin.id, actor);
  const fieldTypes = filterFieldTypes(snapshot, schemaRefs);
  const predicate = compileExpression(filters.expression, { fieldTypes });
  const savedPredicate = compileExpression(saved?.expression, { fieldTypes });
  const searchInput = saved ? { search: saved.search.text, searchMode: saved.search.mode, searchCaseSensitive: saved.search.caseSensitive, searchFields: saved.search.fields, ...input } : input;
  const search = compileSearch(searchInput, { fieldTypes });
  const kind = filters.kind === undefined ? 'all' : filters.kind, source = filters.sourceId === undefined ? 'all' : filters.sourceId;
  if (!['all', 'event', 'session'].includes(kind) || typeof source !== 'string') throw new ProviderError('invalid_filter', 'Unknown record kind or source', 422);
  const sourceIds = filters.sourceIds === undefined ? null : filters.sourceIds, kinds = filters.kinds === undefined ? ['event', 'session'] : filters.kinds;
  if (sourceIds !== null && (!Array.isArray(sourceIds) || sourceIds.length > 100 || sourceIds.some(id => typeof id !== 'string') || new Set(sourceIds).size !== sourceIds.length)) throw new ProviderError('invalid_filter', 'Invalid source list', 422);
  if (!Array.isArray(kinds) || kinds.length > 2 || kinds.some(value => !['event', 'session'].includes(value)) || new Set(kinds).size !== kinds.length) throw new ProviderError('invalid_filter', 'Invalid kinds list', 422);
  const schemaKeys = new Set(schemaRefs.map(pin => `${pin.id}:${pin.version}`));
  return { search, fieldTypes, predicate(record) {
    return !record.deletedAt && (kind === 'all' || record.kind === kind) && (source === 'all' || record.sourceId === source)
      && (sourceIds === null || sourceIds.includes(record.sourceId)) && kinds.includes(record.kind)
      && (!saved || ((saved.sourceIds === null || saved.sourceIds.includes(record.sourceId)) && saved.kinds.includes(record.kind)))
      && (!schemaKeys.size || schemaKeys.has(`${record.schemaId}:${record.schemaVersion}`)) && savedPredicate(record) && predicate(record);
  } };
}
