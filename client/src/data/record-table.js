import { ProviderError, canonicalJson } from './data-provider.js';
import { decimalString, timeDecimal, toIso, toMs } from '../timeline/time-scale.js';
import { overlaps } from '../timeline/layout.js';
import { fieldValue } from './filter-expression.js';
import { compareCodepoints, compareOrderedText, normalizeStringOrder } from './string-order.js';

export const TABLE_FIELDS = ['start', 'end', 'title', 'kind', 'sourceId', 'order', 'version', 'createdAt', 'updatedAt', 'data.status'];
const DATE_FIELDS = new Set(['start', 'end', 'createdAt', 'updatedAt']);
const NUMBER_FIELDS = new Set(['order', 'version']);
const pointer = field => field.startsWith('/') ? field : `/${field.startsWith('data.') ? `data/${field.slice(5)}` : field}`;
const DEFAULT_TYPES = Object.fromEntries(TABLE_FIELDS.map(field => [pointer(field), DATE_FIELDS.has(field) ? 'date' : NUMBER_FIELDS.has(field) ? 'number' : 'string']));
const canonicalField = field => TABLE_FIELDS.find(candidate => pointer(candidate) === pointer(field)) ?? pointer(field);
const ITEM_BUDGET = 2 * 1024 * 1024 - 16 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (message, code = 'invalid_table_query') => { throw new ProviderError(code, message, 422); };

export const compareText = compareCodepoints;

export function normalizeTableInput(input = {}, domain, fieldTypes = DEFAULT_TYPES) {
  if (!object(input) || Object.keys(input).some(key => !['definitionVersion', 'scope', 'window', 'projection', 'sort', 'limit', 'cursor'].includes(key))) invalid('Unknown table query field');
  const definitionVersion = input.definitionVersion ?? 1;
  if (input.definitionVersion === null || ![1, 2].includes(definitionVersion)) invalid('Table definition version must be 1 or 2');
  const scope = input.scope ?? 'all', projection = input.projection ?? 'context', limit = input.limit ?? 100;
  if (!['all', 'window'].includes(scope) || !['context', 'matches'].includes(projection)) invalid('Invalid table scope or projection');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) invalid('Table limit must be an integer from 1 to 1000');
  if (input.cursor !== undefined && input.cursor !== null && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 4096)) invalid('Invalid table cursor');
  const sort = input.sort ?? [{ field: 'start', direction: 'asc' }];
  if (!Array.isArray(sort) || !sort.length || sort.length > 3) invalid('Specify one to three sort fields', 'invalid_table_sort');
  const seen = new Set(), normalizedSort = [];
  for (const item of sort) {
    const keys = definitionVersion === 2 ? ['field', 'direction', 'order', 'caseSensitive'] : ['field', 'direction'];
    if (!object(item) || Object.keys(item).some(key => !keys.includes(key)) || typeof item.field !== 'string' || !Object.hasOwn(fieldTypes, pointer(item.field)) || fieldTypes[pointer(item.field)] === 'strings' || !['asc', 'desc'].includes(item.direction) || seen.has(pointer(item.field))) invalid('Invalid or repeated sort field', 'invalid_table_sort');
    seen.add(pointer(item.field));
    const normalized = { field: canonicalField(item.field), direction: item.direction };
    if (definitionVersion === 2 && fieldTypes[pointer(item.field)] === 'string') {
      try { Object.assign(normalized, normalizeStringOrder(Object.fromEntries(Object.entries(item).filter(([key]) => ['order', 'caseSensitive'].includes(key))), 2)); }
      catch (error) { invalid(error.message, 'invalid_table_sort'); }
    } else if (Object.hasOwn(item, 'order') || Object.hasOwn(item, 'caseSensitive')) invalid('Text ordering options apply only to string fields', 'invalid_table_sort');
    normalizedSort.push(normalized);
  }
  let window = null;
  if (scope === 'window') {
    const supplied = input.window;
    if (!object(supplied) || Object.keys(supplied).some(key => !['from', 'to', 'viewFromMs', 'viewToMs'].includes(key)) || !supplied.from || !supplied.to) invalid('Window scope requires explicit time bounds');
    try {
      const fromMs = toMs(supplied.from), toMsValue = toMs(supplied.to);
      const left = timeDecimal(supplied.viewFromMs ?? fromMs), right = timeDecimal(supplied.viewToMs ?? toMsValue);
      if (!right.gt(left) || left.lt(toMs(domain.from)) || right.gt(toMs(domain.to))) invalid('Table window must remain within the analysis domain');
      window = { from: toIso(left.floor()), to: toIso(right.ceil()), viewFromMs: decimalString(left), viewToMs: decimalString(right) };
    } catch (error) { if (error instanceof ProviderError) throw error; invalid(error.message); }
  } else if (input.window !== undefined && input.window !== null) invalid('All scope does not accept a window');
  return { ...(definitionVersion === 2 ? { definitionVersion } : {}), scope, window, projection, sort: normalizedSort, limit };
}

function sortable(record, field, fieldTypes) {
  const value = fieldValue(record, pointer(field));
  const type = fieldTypes[pointer(field)];
  if (value === undefined) return { rank: 2, value: null };
  if (value === null) return { rank: 1, value: null };
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`Sort field ${field} must contain numbers`, 'invalid_table_sort');
    return { rank: 0, value };
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') invalid(`Sort field ${field} must contain booleans`, 'invalid_table_sort');
    return { rank: 0, value: Number(value) };
  }
  if (typeof value !== 'string') invalid(`Sort field ${field} must contain strings`, 'invalid_table_sort');
  return { rank: 0, value: type === 'date' ? toMs(value) : value };
}

export function buildRecordTable(query, parameters) {
  const base = query.records.filter(record => parameters.scope === 'all' || overlaps(record, parameters.window.viewFromMs, parameters.window.viewToMs));
  const version2 = query.definitionVersion === 2;
  const baseTotal = version2 ? base.filter(record => query.eligibleIds.has(record.id)).length : base.length;
  const matchTotal = base.filter(record => query.matches.has(record.id)).length;
  const projected = parameters.projection === 'matches' ? base.filter(record => query.matches.has(record.id)) : base;
  const decorated = projected.map(record => ({ record, values: parameters.sort.map(item => sortable(record, item.field, query.fieldTypes ?? DEFAULT_TYPES)) }));
  decorated.sort((left, right) => {
    for (let i = 0; i < parameters.sort.length; i++) {
      const a = left.values[i], b = right.values[i];
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.rank) continue;
      const comparison = typeof a.value === 'string' ? parameters.definitionVersion === 2 ? compareOrderedText(a.value, b.value, parameters.sort[i]) : compareText(a.value, b.value) : a.value - b.value;
      if (comparison) return parameters.sort[i].direction === 'desc' ? -comparison : comparison;
    }
    return compareText(left.record.id, right.record.id);
  });
  const items = decorated.map(({ record }) => ({ record, match: query.matches.has(record.id), ...(version2 ? { provenance: query.provenance[record.id] } : {}) }));
  const boundaries = [0];
  let count = 0, bytes = 0;
  for (let index = 0; index < items.length; index++) {
    const cost = new TextEncoder().encode(canonicalJson(items[index])).length + 1;
    if (cost > ITEM_BUDGET) throw new ProviderError('table_record_limit', 'A record exceeds the table response budget', 413);
    if (count && (count >= parameters.limit || bytes + cost > ITEM_BUDGET)) { boundaries.push(index); count = 0; bytes = 0; }
    count++; bytes += cost;
  }
  if (items.length) boundaries.push(items.length);
  return { parameters, key: canonicalJson(parameters), items, boundaries, total: items.length, baseTotal, ...(version2 ? { contextTotal: base.length - baseTotal } : {}), matchTotal, matchActive: query.hasSearch };
}
