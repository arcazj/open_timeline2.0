import { parseStrictJson } from '../data/snapshot.js';
import { validateDefinition } from '../data/model-catalog.js';
import { timeDecimal, toMs } from '../timeline/time-scale.js';
import { compileSearch } from '../data/filter-expression.js';

export const SHARE_LIMIT = 16384;
const fail = message => { throw new Error(message); };
function keys(object, names) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !names.includes(key))) fail('Invalid shared-view fields');
}
const text = (value, max = 256) => typeof value === 'string' && value.length <= max;
export function validateSharedView(value) {
  keys(value, ['version', 'range', 'domain', 'settings', 'filters', 'search', 'view', 'scaleStrategy', 'selectedId', 'generation', ...(value?.version === 2 ? ['relationshipMode', 'groupOrder', 'collapsedGroups'] : [])]);
  if (![1, 2].includes(value.version)) fail('Unsupported shared-view version');
  keys(value.range, ['fromMs', 'toMs']); keys(value.domain, ['from', 'to']);
  for (const item of Object.values(value.range)) if (!text(item, 100) || !/^-?\d+(?:\.\d+)?$/.test(item)) fail('Invalid shared time range');
  const from = timeDecimal(value.range.fromMs), to = timeDecimal(value.range.toMs);
  if (to.minus(from).lt(1) || from.lt(toMs(value.domain.from)) || to.gt(toMs(value.domain.to))) fail('Shared range must fit its overview');
  if (!validateDefinition(value.settings).valid) fail('Unsupported shared display settings');
  if (!['timeline', 'table', 'split'].includes(value.view) || !['automatic', 'manual'].includes(value.scaleStrategy)) fail('Invalid shared view mode');
  keys(value.filters, ['sourceId', 'kind', 'sourceIds', 'kinds', 'expression', 'schemaRefs', 'filterId', 'filterVersion']);
  if (value.filters.sourceId !== undefined && !text(value.filters.sourceId)) fail('Invalid shared source');
  if (value.filters.kind !== undefined && !['all', 'event', 'session'].includes(value.filters.kind)) fail('Invalid shared record kind');
  if (value.filters.sourceIds !== undefined && (!Array.isArray(value.filters.sourceIds) || value.filters.sourceIds.length > 100 || value.filters.sourceIds.some(item => !text(item)))) fail('Invalid shared source list');
  keys(value.search, ['search', 'searchMode', 'searchCaseSensitive', 'searchFields', ...(value.version === 2 ? ['definitionVersion', 'searchFlags', 'searchMatchMode', 'searchDialect'] : [])]);
  if (!text(value.search.search, 4096) || !['any', 'all', 'phrase', ...(value.version === 2 ? ['regex'] : [])].includes(value.search.searchMode)) fail('Invalid shared search');
  if (value.search.searchMode !== 'regex' && typeof value.search.searchCaseSensitive !== 'boolean') fail('Invalid shared search');
  if (value.search.searchFields !== undefined && (!Array.isArray(value.search.searchFields) || value.search.searchFields.length > 100 || value.search.searchFields.some(item => !text(item)))) fail('Invalid shared search fields');
  if (value.version === 1 && value.filters.expression?.version === 2) fail('Version 2 filters require a version 2 shared view');
  if (value.version === 2) {
    if (value.search.definitionVersion !== 2 || !['independent', 'family'].includes(value.relationshipMode)) fail('Invalid shared query version');
    keys(value.groupOrder, ['order', 'caseSensitive']);
    if (!['codepoint', 'natural'].includes(value.groupOrder.order) || typeof value.groupOrder.caseSensitive !== 'boolean') fail('Invalid shared group order');
    if (!Array.isArray(value.collapsedGroups) || value.collapsedGroups.length > 1000 || new Set(value.collapsedGroups).size !== value.collapsedGroups.length || value.collapsedGroups.some(item => !text(item, 1024))) fail('Invalid shared collapsed groups');
    compileSearch(value.search, { fieldTypes: Object.fromEntries((value.search.searchFields || ['/title']).map(field => [field, 'string'])) });
  }
  if (value.selectedId !== null && (!text(value.selectedId, 128) || !/^[0-9a-f-]{36}$/.test(value.selectedId))) fail('Invalid shared selection');
  if (value.generation !== null && !text(value.generation, 128)) fail('Invalid shared source generation');
  return value;
}

export function encodeSharedView(view) {
  const bytes = new TextEncoder().encode(JSON.stringify(validateSharedView(view)));
  if (bytes.length > SHARE_LIMIT * .75) fail('This view is too large for a link. Reduce the filter or presentation settings.');
  const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `#view=${encoded}`;
}
export function decodeSharedView(link) {
  if (typeof link !== 'string' || link.length > SHARE_LIMIT + 4096) fail('Shared link is too large');
  const hash = link.startsWith('#') ? link : new URL(link).hash;
  const encoded = hash.slice(6);
  if (!hash.startsWith('#view=') || !encoded || encoded.length > SHARE_LIMIT || !/^[A-Za-z0-9_-]+$/.test(encoded)) fail('Invalid shared-view link');
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  return validateSharedView(parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
export function sharedViewLink(locationHref, view) {
  const url = new URL(locationHref), fragment = encodeSharedView(view);
  if (url.protocol === 'file:') return fragment;
  if (!['http:', 'https:'].includes(url.protocol)) fail('Unsupported application URL');
  url.username = ''; url.password = ''; url.search = ''; url.hash = fragment;
  return url.href;
}
