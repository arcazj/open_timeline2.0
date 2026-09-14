const KEY = 'openbexi-source-paths-v1';

export function loadPathPreferences(storage, origin, sources) {
  const ids = new Set(sources.map(source => source.id));
  try {
    const value = JSON.parse(storage.getItem(`${KEY}:${origin}`) || 'null');
    const valid = values => Array.isArray(values) ? [...new Set(values.filter(id => ids.has(id)))] : [];
    return { selected: value && Array.isArray(value.selected) ? valid(value.selected) : [...ids], favorites: valid(value?.favorites), retained: !!value };
  } catch { return { selected: [...ids], favorites: [], retained: false }; }
}

export function savePathPreferences(storage, origin, value) {
  try { storage.setItem(`${KEY}:${origin}`, JSON.stringify({ selected: value.selected, favorites: value.favorites })); return true; }
  catch { return false; }
}

export function groupingMode(presentation) {
  const field = presentation?.grouping?.field;
  return field === '/data/namespace' ? 'namespace' : field ? 'custom' : 'all';
}

export function groupedPresentation(presentation, mode) {
  const result = { ...(presentation || { version: 1 }) };
  if (mode === 'namespace') result.grouping = { field: '/data/namespace', direction: 'asc' };
  else delete result.grouping;
  return result;
}
