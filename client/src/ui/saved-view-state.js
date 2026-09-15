import { canonicalJson } from '../data/data-provider.js';

const copy = value => structuredClone(value);
const ordered = values => [...new Set(values)].sort();
const intersect = (left, right) => left === null ? right === null ? null : [...right] : right === null ? [...left] : left.filter(value => right.includes(value));
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const pin = value => {
  if (!value || typeof value.id !== 'string' || !Number.isInteger(value.version) || value.version < 1) throw new Error('A published model or filter version is required.');
  return { id: value.id, version: value.version };
};

export function captureFilterDefinition(capture, saved = null) {
  const filters = capture.filters || {}, version = capture.definitionVersion ?? 1;
  if (![1, 2].includes(version)) throw new Error('Unsupported filter definition version.');
  if (filters.filterId != null && !saved) throw new Error('The current published filter must be loaded before capturing this view.');
  let sourceIds = intersect(saved?.sourceIds ?? null, filters.sourceIds ?? null);
  if (filters.sourceId && filters.sourceId !== 'all') sourceIds = intersect(sourceIds, [filters.sourceId]);
  let kinds = intersect(saved?.kinds ?? ['event', 'session'], filters.kinds ?? ['event', 'session']);
  if (filters.kind && filters.kind !== 'all') kinds = intersect(kinds, [filters.kind]);
  const schemaRefs = saved?.schemaRefs ?? filters.schemaRefs ?? [];
  if (saved && filters.schemaRefs && !same(filters.schemaRefs, saved.schemaRefs)) throw new Error('The current filter and temporary schema pins differ. Resolve the schema scope before saving.');
  const expressions = [saved?.expression, filters.expression].filter(Boolean);
  let expression = expressions[0] ?? null;
  if (expressions.length === 2 && !same(expressions[0], expressions[1])) expression = { version, root: { op: 'and', args: expressions.map(value => copy(value.root)) } };
  if (version === 1 && expressions.some(value => value.version === 2)) throw new Error('Version 2 conditions cannot be saved as a version 1 filter.');
  if (capture.migration && saved?.migration && !same(capture.migration, saved.migration)) throw new Error('Two different migration histories are active. Save each reviewed filter separately before combining them.');
  const migration = capture.migration ?? saved?.migration;
  const search = copy(capture.search ?? saved?.search ?? { text: '', mode: 'any', caseSensitive: false, fields: ['/title'] });
  if (version === 1 && (migration || search.mode === 'regex')) throw new Error('Regex search and migration metadata require definition version 2.');
  return {
    ...(version === 2 ? { definitionVersion: 2, relationshipMode: capture.relationshipMode ?? 'independent' } : {}),
    sourceIds: sourceIds === null ? null : ordered(sourceIds), kinds: ordered(kinds), schemaRefs: copy(schemaRefs), expression: copy(expression), search,
    ...(migration ? { migration: copy(migration) } : {}),
  };
}

function normalizedFilter(definition) {
  return { ...copy(definition), definitionVersion: definition.definitionVersion ?? 1,
    ...(definition.definitionVersion === 2 ? { relationshipMode: definition.relationshipMode ?? 'independent' } : {}),
    sourceIds: definition.sourceIds === null ? null : ordered(definition.sourceIds), kinds: ordered(definition.kinds),
    schemaRefs: [...definition.schemaRefs].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : left.version - right.version),
  };
}

export function exactPublishedFilter(resources, definition, preferred) {
  const key = canonicalJson(normalizedFilter(definition)), matches = [];
  for (const resource of resources) {
    if (resource.lifecycle === 'archived') continue;
    for (const publication of resource.versions || []) if (canonicalJson(normalizedFilter(publication.definition)) === key) matches.push({ id: resource.id, version: publication.version, visibility: resource.visibility });
  }
  return matches.find(value => value.id === preferred?.id && value.version === preferred?.version) ?? matches[0] ?? null;
}

export function captureViewDefinition(capture, filterPin) {
  const settings = copy(capture.settings || {}), version = capture.definitionVersion ?? 1;
  for (const key of ['modelId', 'modelVersion', 'filterId', 'filterVersion', 'viewId', 'viewVersion']) delete settings[key];
  settings.search = copy(capture.search);
  if (version === 2) { settings.definitionVersion = 2; settings.relationshipMode = capture.relationshipMode ?? 'independent'; }
  else {
    delete settings.definitionVersion;
    for (const key of ['relationshipMode', 'groupOrder', 'table']) if (settings[key] !== undefined) throw new Error(`${key} requires a version 2 view; it cannot be omitted silently.`);
  }
  return { ...(version === 2 ? { definitionVersion: 2 } : {}), model: pin(capture.model), filter: pin(filterPin), settings };
}

export function portableViewDraft(family, definition, name, visibility = 'personal') {
  return { format: 'timeline-configuration', formatVersion: 1, family, name, description: '', tags: [], visibility, definition: copy(definition) };
}
