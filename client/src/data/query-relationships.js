import { ProviderError } from './data-provider.js';
import { overlaps } from '../timeline/layout.js';
import { drainQuerySteps } from './query-work.js';

// Build the authorized forest before applying soft predicates. A missing parent is a scope boundary.
export function resolveRelationships(records, configuration, from, to) {
  return drainQuerySteps(resolveRelationshipSteps(records, configuration, from, to));
}

export function* resolveRelationshipSteps(records, configuration, from, to, { inDomain = record => overlaps(record, from, to) } = {}) {
  const allowed = [];
  let work = 0;
  for (const record of records) {
    if (++work % 64 === 0) yield;
    if (configuration.hardPredicate(record)) allowed.push(record);
  }
  const byId = new Map();
  for (const record of allowed) {
    if (++work % 64 === 0) yield;
    if (byId.has(record.id)) throw new ProviderError('invalid_relationship', 'Duplicate record identity in query scope', 422);
    byId.set(record.id, record);
  }
  const roots = new Map();
  for (const record of allowed) {
    if (++work % 64 === 0) yield;
    const path = [], seen = new Set();
    let current = record;
    while (current && !roots.has(current.id)) {
      if (++work % 64 === 0) yield;
      if (seen.has(current.id)) throw new ProviderError('invalid_relationship', 'Session ancestry contains a cycle', 422);
      seen.add(current.id); path.push(current.id);
      const parent = byId.get(current.parentSessionId);
      if (parent && parent.kind !== 'session') throw new ProviderError('invalid_relationship', 'A parent must be a session', 422);
      current = parent;
    }
    const root = current ? roots.get(current.id) : path.at(-1);
    for (const id of path) roots.set(id, root);
  }
  const universe = [], directIds = new Set(), families = new Set();
  for (const record of allowed) {
    if (++work % 64 === 0) yield;
    if (!inDomain(record)) continue;
    universe.push(record);
    if (configuration.directPredicate(record)) { directIds.add(record.id); families.add(roots.get(record.id)); }
  }
  const eligible = [], eligibleIds = new Set(), matches = new Set();
  for (const record of universe) {
    if (++work % 64 === 0) yield;
    if (!directIds.has(record.id) && !(configuration.relationshipMode === 'family' && families.has(roots.get(record.id)))) continue;
    eligible.push(record); eligibleIds.add(record.id);
    if (configuration.search.matches(record)) matches.add(record.id);
  }
  const ancestors = new Set(), descendantMatches = new Map();
  for (const record of eligible) {
    if (++work % 64 === 0) yield;
    let parent = byId.get(record.parentSessionId);
    while (parent) {
      if (++work % 64 === 0) yield;
      const visited = ancestors.has(parent.id);
      ancestors.add(parent.id);
      if (configuration.search.active && matches.has(record.id)) descendantMatches.set(parent.id, (descendantMatches.get(parent.id) || 0) + 1);
      // Continue for matching descendants so their badge counts remain distinct.
      if (visited && !(configuration.search.active && matches.has(record.id))) break;
      parent = byId.get(parent.parentSessionId);
    }
  }
  const contextRecords = [], visibleContext = [];
  for (const record of allowed) {
    if (++work % 64 === 0) yield;
    if (!ancestors.has(record.id) || eligibleIds.has(record.id)) continue;
    contextRecords.push(record);
    if (inDomain(record)) visibleContext.push(record);
  }
  const redactBoundary = record => record.parentSessionId && !byId.has(record.parentSessionId) ? { ...record, parentSessionId: null } : record;
  const rendered = [...eligible, ...visibleContext].map(redactBoundary).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const provenance = {};
  for (const record of [...eligible, ...contextRecords]) {
    if (++work % 64 === 0) yield;
    provenance[record.id] = {
      role: directIds.has(record.id) ? 'direct' : eligibleIds.has(record.id) ? 'family-context' : 'ancestor-context',
      directPredicate: directIds.has(record.id), match: matches.has(record.id), descendantMatchCount: descendantMatches.get(record.id) || 0,
    };
  }
  return { records: rendered, eligibleRecords: eligible.map(redactBoundary), eligibleIds, directIds, matches, provenance,
    contextRecords: contextRecords.map(redactBoundary), contextTotal: contextRecords.length, visibleContextTotal: visibleContext.length };
}

export function scopedQueryCounts(data, domain, revision, generation, complete) {
  return { domain: { ...domain }, revision, generation, complete,
    filterResults: data.eligibleIds.size, directPredicateHits: data.directIds.size, searchFindings: data.hasSearch ? data.matches.size : 0,
    contextRecords: data.contextTotal, visibleContextRecords: data.visibleContextTotal };
}
