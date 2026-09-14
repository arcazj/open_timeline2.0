export const CONFIGURATION_RECOVERY_KEY = 'openbexi:configuration-command-recovery:v1';
const families = new Set(['sources', 'groups', 'schemas', 'filters', 'views', 'settings']);
const operations = new Set(['create', 'update', 'publish', 'archive', 'unarchive', 'delete', 'duplicate', 'apply', 'replace', 'patch', 'reset']);
const memory = new Map(), confirmed = new Set();
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
function safe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['baseUrl', 'workspaceId', 'generation', 'principalId', 'clientCommandId', 'family', 'type', 'resourceId', 'scope'].includes(key))) return null;
  if (!['workspaceId', 'generation', 'principalId', 'clientCommandId'].every(key => id(value[key])) || !families.has(value.family) || !operations.has(value.type) || (value.resourceId !== undefined && !id(value.resourceId))) return null;
  if (value.family === 'settings' && !['personal', 'workspace', 'application'].includes(value.scope)) return null;
  if (value.family !== 'settings' && value.scope !== undefined) return null;
  try {
    const url = new URL(value.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, ...Object.fromEntries(['workspaceId', 'generation', 'principalId', 'clientCommandId', 'family', 'type', 'resourceId', 'scope'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) };
  } catch { return null; }
}
const sourceKey = entry => JSON.stringify([entry.baseUrl, entry.workspaceId, entry.generation, entry.principalId]);

export function createConfigurationCommandRecovery({ provider, generation, principalId, local, environment = globalThis }) {
  const source = local ? null : safe({ baseUrl: provider.baseUrl || environment.location?.origin, workspaceId: provider.workspaceId, generation, principalId, clientCommandId: 'source-check', family: 'sources', type: 'create' });
  const key = source ? sourceKey(source) : JSON.stringify(['local', provider.identity, generation, principalId]);
  let storage, warning = '';
  const unavailable = () => { storage = null; warning = 'Configuration recovery is memory-only. Browser storage is unavailable; keep this page open until the original outcome is confirmed.'; };
  if (source) {
    try { storage = environment.localStorage; if (!storage) throw new Error(); const probe = `${CONFIGURATION_RECOVERY_KEY}:probe`; storage.setItem(probe, '1'); storage.removeItem(probe); }
    catch { unavailable(); }
    if (storage && environment.location?.protocol === 'file:') warning = 'Recovery storage for file URLs is browser-dependent. Keep this page open until the original outcome is confirmed.';
  } else if (!local) unavailable();
  function stored() {
    if (!storage) return [];
    try { const raw = storage.getItem(CONFIGURATION_RECOVERY_KEY); if (!raw) return []; const entries = JSON.parse(raw); if (!Array.isArray(entries) || entries.length > 1000 || entries.some(entry => !safe(entry))) throw new Error(); return entries.map(safe); }
    catch { unavailable(); return []; }
  }
  function write(entries) { if (storage) try { if (entries.length) storage.setItem(CONFIGURATION_RECOVERY_KEY, JSON.stringify(entries)); else storage.removeItem(CONFIGURATION_RECOVERY_KEY); } catch { unavailable(); } }
  const entryKey = commandId => `${key}:${commandId}`;
  return {
    warning: () => warning,
    read() { for (const entry of stored()) if (sourceKey(entry) === key && !confirmed.has(entryKey(entry.clientCommandId))) memory.set(entryKey(entry.clientCommandId), entry); return [...memory.entries()].filter(([id]) => id.startsWith(`${key}:`) && !confirmed.has(id)).map(([, entry]) => ({ ...entry })); },
    remember(command) {
      if (command.generation !== generation || !id(command.clientCommandId) || !families.has(command.family) || !operations.has(command.type)) throw new Error('A safe configuration command identity could not be retained. No command was sent.');
      const fields = { generation, principalId, clientCommandId: command.clientCommandId, family: command.family, type: command.type, ...(command.resourceId ? { resourceId: command.resourceId } : {}), ...(command.scope ? { scope: command.scope } : {}) };
      const entry = source ? safe({ baseUrl: source.baseUrl, workspaceId: source.workspaceId, ...fields }) : fields;
      if (!entry) throw new Error('A safe configuration command identity could not be retained. No command was sent.');
      const entries = stored(), exists = entries.some(item => sourceKey(item) === key && item.clientCommandId === entry.clientCommandId);
      if (source && storage && !exists && entries.length >= 1000) throw new Error('Resolve existing configuration outcomes before sending another command. Recovery storage is full.');
      memory.set(entryKey(entry.clientCommandId), entry); if (source && !exists) write([...entries, entry]); return { ...entry };
    },
    clear(commandId) { confirmed.add(entryKey(commandId)); memory.delete(entryKey(commandId)); write(stored().filter(entry => !(sourceKey(entry) === key && entry.clientCommandId === commandId))); },
  };
}
