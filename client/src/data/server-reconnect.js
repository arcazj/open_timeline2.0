import { ProviderError, canonicalJson, clone, inspectJson } from './data-provider.js';
import { ServerProvider } from './server-provider.js';

const runtimeKeys = new Set(['provider', 'query', 'map', 'layout', 'rows', 'selected', 'selectedContext',
  'queryId', 'layoutId', 'mapId', 'snapshotId', 'preparationDrains', 'controllers']);

function authority(info) {
  if (!info || typeof info.workspaceId !== 'string' || !info.workspaceId || typeof info.generation !== 'string' || !info.generation
    || typeof info.actor?.id !== 'string' || !info.actor.id || !Array.isArray(info.actor.capabilities) || !Array.isArray(info.sourceIds)
    || [...info.actor.capabilities, ...info.sourceIds].some(value => typeof value !== 'string')) {
    throw new ProviderError('invalid_response', 'Server reconnect metadata did not identify its workspace and authorization scope', 502);
  }
  return canonicalJson({ principalId: info.actor.id, role: info.actor.role ?? null,
    capabilities: [...new Set(info.actor.capabilities)].sort(), sourceIds: [...new Set(info.sourceIds)].sort(), changeScope: info.changeScope ?? null });
}

export async function prepareServerReconnect({ provider, info, view, signal, isCurrent = () => true, timeout = 2500 }) {
  if (!(provider instanceof ServerProvider) || provider.disposed) throw new ProviderError('invalid_reconnect_source', 'Reconnect requires the currently confirmed server source', 409);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new TypeError('Reconnect timeout must be positive');
  const check = () => { if (signal?.aborted || !isCurrent()) throw new DOMException('Reconnect canceled', 'AbortError'); };
  check();
  const previous = clone(info), scope = authority(previous);
  if (!view || typeof view !== 'object' || Array.isArray(view) || Object.keys(view).some(key => runtimeKeys.has(key))) {
    throw new ProviderError('invalid_reconnect_view', 'Reconnect accepts view configuration, not previous provider handles or record details', 422);
  }
  inspectJson(view);
  const captured = clone(view);
  const candidate = new ServerProvider({ baseUrl: provider.baseUrl, workspaceId: provider.workspaceId, token: provider.token, localBrowser: provider.localBrowser });
  const controller = new AbortController(), boundedTimeout = Math.min(timeout, 5000);
  let timer, relay;
  const interrupted = new Promise((resolve, reject) => {
    relay = () => { controller.abort(); reject(new DOMException('Reconnect canceled', 'AbortError')); };
    signal?.addEventListener('abort', relay, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new ProviderError('reconnect_timeout', 'The confirmed server did not respond before the reconnect deadline', 408)); }, boundedTimeout);
    if (signal?.aborted) relay();
  });
  try {
    const fresh = await Promise.race([candidate.initialize({ signal: controller.signal, timeout: boundedTimeout }), interrupted]);
    check();
    if (fresh.workspaceId !== previous.workspaceId || fresh.workspaceId !== candidate.workspaceId) {
      throw new ProviderError('permission_scope_changed', 'The confirmed endpoint now identifies a different workspace', 409);
    }
    const authorizationChanged = authority(fresh) !== scope, generationChanged = fresh.generation !== previous.generation;
    if (authorizationChanged || generationChanged) {
      candidate.dispose();
      return { status: authorizationChanged ? 'authorization-changed' : 'generation-changed', info: fresh, authorizationChanged, generationChanged };
    }
    return { status: 'ready', provider: candidate, info: fresh, view: captured };
  } catch (error) { candidate.dispose(); check(); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', relay); }
}
