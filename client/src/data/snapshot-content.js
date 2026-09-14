export const PORTABLE_CONTENT_FIELDS = Object.freeze(['records', 'zones', 'models', 'filters', 'settings',
  'sources', 'groups', 'schemas', 'views', 'preferences', 'defaults']);

export function snapshotContent(snapshot) {
  return Object.fromEntries(PORTABLE_CONTENT_FIELDS.filter(key => Object.hasOwn(snapshot, key)).map(key => [key, snapshot[key]]));
}
