const STORAGE_KEY = 'openbexi:model-command-recovery:v1';
const operations = new Set(['create', 'update', 'publish', 'apply', 'archive', 'unarchive', 'delete']);
const memory = new Map();
const confirmed = new Set();

function safeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = ['baseUrl', 'workspaceId', 'generation', 'clientCommandId', 'type', 'modelId'];
  if (Object.keys(value).some(key => !allowed.includes(key))) return null;
  if (!operations.has(value.type) || !['workspaceId', 'generation', 'clientCommandId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 200)) return null;
  if (value.modelId !== undefined && (typeof value.modelId !== 'string' || value.modelId.length > 200)) return null;
  try {
    const url = new URL(value.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return { baseUrl: `${url.origin}${url.pathname.replace(/\/$/, '')}`, workspaceId: value.workspaceId, generation: value.generation, clientCommandId: value.clientCommandId, type: value.type, ...(value.modelId ? { modelId: value.modelId } : {}) };
  } catch { return null; }
}

function sourceKey(value) { return JSON.stringify([value.baseUrl, value.workspaceId, value.generation]); }

export function createModelCommandRecovery({ provider, generation, local, logicalKey }) {
  let warning = '', storage = null;
  const source = local ? null : safeIdentity({ baseUrl: provider.baseUrl || location.origin, workspaceId: provider.workspaceId, generation, clientCommandId: 'source-check', type: 'create' });
  const key = source ? sourceKey(source) : `memory:${logicalKey}:${generation}`;
  function storageFailed() { storage = null; warning = 'Recovery is memory-only: browser storage is unavailable. Reloading can lose an unconfirmed command identity.'; }
  if (source) {
    try { storage = window.localStorage; const probe = `${STORAGE_KEY}:probe`; storage.setItem(probe, '1'); storage.removeItem(probe); }
    catch { storageFailed(); }
    if (storage && location.protocol === 'file:') warning = 'Recovery storage for file URLs is browser-dependent. Keep this page open until the original outcome is confirmed.';
  } else if (!local) storageFailed();

  function stored() {
    if (!storage) return [];
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length > 1000 || parsed.some(entry => !safeIdentity(entry))) throw new Error('Invalid recovery identities');
      return parsed.map(safeIdentity);
    } catch { storageFailed(); return []; }
  }
  function write(entries) {
    if (!storage) return;
    try {
      if (entries.length) storage.setItem(STORAGE_KEY, JSON.stringify(entries));
      else storage.removeItem(STORAGE_KEY);
    } catch { storageFailed(); }
  }
  function read() {
    const entries = stored().filter(entry => sourceKey(entry) === key && !confirmed.has(entry.clientCommandId));
    for (const entry of entries) memory.set(`${key}:${entry.clientCommandId}`, entry);
    return [...memory.entries()].filter(([id, entry]) => id.startsWith(`${key}:`) && !confirmed.has(entry.clientCommandId)).map(([, entry]) => ({ ...entry }));
  }
  return {
    read,
    warning: () => warning,
    remember(command) {
      const entry = source ? safeIdentity({ baseUrl: source.baseUrl, workspaceId: source.workspaceId, generation, clientCommandId: command.clientCommandId, type: command.type, ...(command.modelId ? { modelId: command.modelId } : {}) }) : { generation, clientCommandId: command.clientCommandId, type: command.type, ...(command.modelId ? { modelId: command.modelId } : {}) };
      if (!entry) throw new Error('A safe model-command recovery identity could not be created. No command was sent.');
      const entries = stored();
      const exists = entries.some(item => item.clientCommandId === entry.clientCommandId && sourceKey(item) === key);
      if (source && storage && !exists && entries.length >= 1000) throw new Error('Recovery storage is full. Resolve existing command outcomes before sending another command.');
      memory.set(`${key}:${entry.clientCommandId}`, entry);
      if (source && !exists) write([...entries, entry]);
      return { ...entry };
    },
    clear(commandId) {
      confirmed.add(commandId); memory.delete(`${key}:${commandId}`);
      write(stored().filter(entry => !(sourceKey(entry) === key && entry.clientCommandId === commandId)));
    },
  };
}
