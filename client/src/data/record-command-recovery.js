export const RECORD_RECOVERY_KEY = 'openbexi:record-command-recovery:v1';
const operations = new Set(['create', 'update', 'delete', 'restore']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const memory = new Map();
const confirmed = new Set();

function safeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => !['baseUrl', 'workspaceId', 'generation', 'clientCommandId', 'type', 'recordId'].includes(key))) return null;
  if (!operations.has(value.type) || !uuid.test(value.generation) || !uuid.test(value.clientCommandId)) return null;
  if (typeof value.workspaceId !== 'string' || !value.workspaceId || value.workspaceId.length > 200) return null;
  if (value.recordId !== undefined && !uuid.test(value.recordId)) return null;
  if (value.type !== 'create' && !value.recordId) return null;
  try {
    const url = new URL(value.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, workspaceId: value.workspaceId, generation: value.generation, clientCommandId: value.clientCommandId, type: value.type, ...(value.recordId ? { recordId: value.recordId } : {}) };
  } catch { return null; }
}
const sourceKey = value => JSON.stringify([value.baseUrl, value.workspaceId, value.generation]);

export function createRecordCommandRecovery({ provider, generation, local, logicalKey = provider.identity, environment = globalThis }) {
  let warning = '', storage = null;
  const source = local ? null : safeIdentity({ baseUrl: provider.baseUrl || environment.location?.origin, workspaceId: provider.workspaceId, generation, clientCommandId: '00000000-0000-4000-8000-000000000000', type: 'create' });
  const key = source ? sourceKey(source) : `memory:${logicalKey}:${generation}`;
  const identityKey = id => `${key}:${id}`;
  const unavailable = () => { storage = null; warning = 'Record recovery is memory-only: browser storage is unavailable. Reloading can lose an unconfirmed command identity. Keep this page open until its outcome is confirmed.'; };
  if (source) {
    try { storage = environment.localStorage; if (!storage) throw new Error('Storage unavailable'); const probe = `${RECORD_RECOVERY_KEY}:probe`; storage.setItem(probe, '1'); storage.removeItem(probe); }
    catch { unavailable(); }
    if (storage && environment.location?.protocol === 'file:') warning = 'Record recovery storage for file URLs is browser-dependent. Keep this page open until the original outcome is confirmed.';
  } else if (!local) unavailable();

  function stored() {
    if (!storage) return [];
    try {
      const raw = storage.getItem(RECORD_RECOVERY_KEY);
      if (!raw) return [];
      const values = JSON.parse(raw);
      if (!Array.isArray(values) || values.length > 1000 || values.some(value => !safeIdentity(value))) throw new Error('Invalid recovery identities');
      return values.map(safeIdentity);
    } catch { unavailable(); return []; }
  }
  function write(entries) {
    if (!storage) return;
    try { if (entries.length) storage.setItem(RECORD_RECOVERY_KEY, JSON.stringify(entries)); else storage.removeItem(RECORD_RECOVERY_KEY); }
    catch { unavailable(); }
  }
  return {
    warning: () => warning,
    read() {
      for (const entry of stored().filter(entry => sourceKey(entry) === key)) if (!confirmed.has(identityKey(entry.clientCommandId))) memory.set(identityKey(entry.clientCommandId), entry);
      return [...memory.entries()].filter(([id]) => id.startsWith(`${key}:`) && !confirmed.has(id)).map(([, entry]) => ({ ...entry }));
    },
    remember(command) {
      const fields = { generation, clientCommandId: command.clientCommandId, type: command.type, ...(command.recordId ? { recordId: command.recordId } : {}) };
      if (command.generation !== generation || !operations.has(fields.type) || !uuid.test(fields.clientCommandId) || (fields.recordId !== undefined && !uuid.test(fields.recordId)) || (fields.type !== 'create' && !fields.recordId)) throw new Error('A safe record-command recovery identity could not be created. No command was sent.');
      const entry = source ? safeIdentity({ baseUrl: source.baseUrl, workspaceId: source.workspaceId, ...fields }) : fields;
      if (!entry) throw new Error('A safe record-command recovery identity could not be created. No command was sent.');
      const entries = stored(), exists = entries.some(item => sourceKey(item) === key && item.clientCommandId === entry.clientCommandId);
      if (source && storage && !exists && entries.length >= 1000) throw new Error('Record recovery storage is full. Resolve existing outcomes before another write.');
      memory.set(identityKey(entry.clientCommandId), entry);
      if (source && !exists) write([...entries, entry]);
      return { ...entry };
    },
    clear(commandId) {
      confirmed.add(identityKey(commandId)); memory.delete(identityKey(commandId));
      write(stored().filter(entry => !(sourceKey(entry) === key && entry.clientCommandId === commandId)));
    },
  };
}
