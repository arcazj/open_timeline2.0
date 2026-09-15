import { ProviderError, uuid, clone } from './data-provider.js';
import { partialUpdatePatch } from './record-commands.js';

export class ServerProvider {
  constructor({ baseUrl = '', token = '', workspaceId = 'default', localBrowser = false } = {}) {
    if (localBrowser && (typeof location === 'undefined' || new URL(baseUrl, location.href).origin !== location.origin || location.protocol !== 'http:')) throw new Error('Local paths require the same HTTP origin.');
    this.localBrowser = localBrowser;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.workspaceId = workspaceId;
    this.base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;
    this.identity = `server:${uuid()}`;
    this.controllers = new Set();
    this.changeSubscriptions = new Set();
    this.preparationWaiters = new Set();
    this.metadata = null;
    this.disposed = false;
  }

  async _request(path, options = {}) {
    if (this.disposed) throw new ProviderError('provider_disposed', 'Server source has been disposed', 409);
    const controller = new AbortController();
    if (!options.preparationAllocation) this.controllers.add(controller);
    const relay = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', relay, { once: true });
    if (options.signal?.aborted) relay();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), options.timeout ?? 30000);
    const headers = { Accept: 'application/json', ...(this.localBrowser ? { 'X-OpenBEXI-Local': '1' } : this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...options.headers };
    if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(this.baseUrl + path, { method: options.method ?? 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal, credentials: 'omit', cache: 'no-store' });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { throw new ProviderError(options.mutation ? 'write_outcome_unknown' : 'invalid_response', options.mutation ? 'Write reply was malformed; check the original command outcome' : 'Server returned malformed JSON', 502); }
      if (!response.ok) throw new ProviderError(body?.code ?? 'http_error', body?.message ?? body?.detail ?? `Server returned ${response.status}`, response.status, { requestId: body?.requestId, errors: body?.errors, diagnostic: body?.diagnostic });
      return body;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if ((options.signal?.aborted || this.disposed) && !options.mutation) throw new DOMException('Operation aborted', 'AbortError');
      throw new ProviderError(options.mutation ? 'write_outcome_unknown' : 'server_unavailable', options.mutation ? 'Server write outcome is unknown; reconnect and check its original command identity' : 'Server is unavailable or the request timed out', 503, { cause: error });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', relay);
      this.controllers.delete(controller);
    }
  }

  async initialize(options = {}) {
    const metadata = await this._request(this.base, options);
    this.metadata = { ...metadata, identity: this.identity, providerId: this.identity, sourceKind: 'server', durability: metadata.legacy?.readOnly ? 'read-only-files' : 'server-committed' };
    return clone(this.metadata);
  }
  async getStatus(options = {}) { return this.initialize(options); }
  async probe(options = {}) { return this._request('/api/v1/health', { timeout: 2000, ...options }); }
  async getOpenApi(options = {}) { return this._request(`${this.base}/openapi.json`, { timeout: 5000, ...options }); }
  reloadLegacy(options = {}) { return this._request(`${this.base}/legacy/reload`, { ...options, method: 'POST', timeout: options.timeout ?? 330000 }); }
  getLoadingStatus(options = {}) { return this._request(`${this.base}/legacy/loading`, { timeout: 2500, ...options }); }
  prefetchWindow(input, options = {}) { return this._request(`${this.base}/legacy/prefetch`, { timeout: 5000, ...options, method: 'POST', body: input }); }
  releaseNavigationQuery(id) {
    if (!this.localBrowser || !id) return;
    void fetch(`${this.baseUrl}${this.base}/query-sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { 'X-OpenBEXI-Local': '1' }, credentials: 'omit', cache: 'no-store', keepalive: true,
    }).then(response => response.body?.cancel()).catch(() => {});
  }
  getLegacyDescriptor(id, options = {}) { return this._request(`${this.base}/records/${encodeURIComponent(id)}/legacy-descriptor`, options); }
  subscribeChanges(listener, options = {}) {
    if (this.disposed) throw new ProviderError('provider_disposed', 'Server source has been disposed', 409);
    if (typeof listener !== 'function') throw new TypeError('A change listener is required');
    const generation = options.generation ?? this.metadata?.generation;
    let after = options.afterRevision ?? this.metadata?.revision;
    let scope = options.scope ?? this.metadata?.changeScope;
    if (!generation || !Number.isSafeInteger(after) || after < 0) throw new ProviderError('not_initialized', 'An initialized change baseline is required', 409);
    const signal = options.signal;
    const controller = new AbortController();
    let timer, stopped = false, unavailable = false;
    const stop = () => {
      stopped = true; clearTimeout(timer); controller.abort();
      signal?.removeEventListener('abort', stop); this.changeSubscriptions.delete(stop);
    };
    const emit = (event) => {
      if (!stopped && !this.disposed) {
        try { listener(event); } catch { /* Consumer failures must not strand the polling lifecycle. */ }
      }
    };
    const poll = async () => {
      if (stopped || this.disposed) return;
      let delay = 1000;
      try {
        const params = new URLSearchParams({ generation, afterRevision: String(after), limit: '100' });
        if (scope !== undefined) params.set('scope', scope);
        const page = await this._request(`${this.base}/changes?${params}`, { signal: controller.signal, timeout: 5000 });
        if (stopped || this.disposed) return;
        const revisions = page?.changes?.map(item => item.revision);
        if (!page || page.generation !== generation || !/^[0-9a-f]{64}$/.test(page.scope) || (scope !== undefined && page.scope !== scope)
          || !Number.isSafeInteger(page.throughRevision) || !Number.isSafeInteger(page.nextRevision) || page.nextRevision < after || page.nextRevision > page.throughRevision
          || !Array.isArray(page.changes) || page.changes.length > 100 || typeof page.hasMore !== 'boolean'
          || page.changes.some((item, index) => !Number.isSafeInteger(item.revision) || item.revision <= (index ? revisions[index - 1] : after) || item.revision > page.nextRevision || typeof item.family !== 'string' || !Array.isArray(item.recordIds) || item.recordIds.some(id => typeof id !== 'string') || item.requiresReload !== true)
          || (page.hasMore && (!page.changes.length || page.nextRevision !== revisions.at(-1) || page.nextRevision >= page.throughRevision))
          || (!page.hasMore && page.nextRevision !== page.throughRevision)) {
          throw new ProviderError('invalid_response', 'Server returned an invalid change page', 502);
        }
        const advanced = page.nextRevision > after;
        scope = page.scope; after = page.nextRevision;
        if (advanced || page.changes.length || unavailable) emit({ ...page, recovered: unavailable, type: 'changed' });
        unavailable = false;
        if (page.hasMore) delay = 0;
      } catch (error) {
        if (stopped || this.disposed || controller.signal.aborted) return;
        const type = error.status === 401 || error.status === 403 || error.code === 'permission_scope_changed' ? 'authorization-lost'
          : ['generation_mismatch', 'replay_gap'].includes(error.code) ? 'generation-changed' : 'server-unavailable';
        emit({ type, code: error.code ?? 'server_unavailable', status: error.status ?? 503 });
        if (type !== 'server-unavailable') { stop(); return; }
        unavailable = true;
      }
      if (!stopped && !this.disposed) timer = setTimeout(poll, delay);
    };
    this.changeSubscriptions.add(stop);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    else void poll();
    return stop;
  }
  _prepare(path, input, options, kind, queryId) {
    if (this.disposed) return Promise.reject(new ProviderError('provider_disposed', 'Server source has been disposed', 409));
    if (options.signal?.aborted) return Promise.reject(new DOMException('Operation aborted', 'AbortError'));
    const baseUrl = this.baseUrl, token = this.token, base = this.base, localBrowser = this.localBrowser;
    return new Promise((resolve, reject) => {
      let finished = false, cleanupStarted = false, handlePath, initial;
      const polling = new AbortController();
      const detach = () => { options.signal?.removeEventListener('abort', stop); this.preparationWaiters.delete(stop); };
      const cleanup = () => {
        if (!handlePath || cleanupStarted) return;
        cleanupStarted = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        // Release only this source's ephemeral allocation, including a late reply after disposal.
        void fetch(baseUrl + handlePath, { method: 'DELETE', headers: { Accept: 'application/json', ...(localBrowser ? { 'X-OpenBEXI-Local': '1' } : token ? { Authorization: `Bearer ${token}` } : {}) },
          credentials: 'omit', cache: 'no-store', signal: controller.signal }).then(response => response.body?.cancel()).catch(() => {}).finally(() => clearTimeout(timer));
      };
      const stop = () => {
        if (finished) return;
        finished = true; polling.abort(); cleanup(); detach(); reject(new DOMException('Operation aborted', 'AbortError'));
      };
      const pause = () => new Promise((resume, fail) => {
        const aborted = () => { clearTimeout(timer); polling.signal.removeEventListener('abort', aborted); fail(new DOMException('Operation aborted', 'AbortError')); };
        const timer = setTimeout(() => { polling.signal.removeEventListener('abort', aborted); resume(); }, 100);
        polling.signal.addEventListener('abort', aborted, { once: true });
        if (polling.signal.aborted) aborted();
      });
      this.preparationWaiters.add(stop);
      options.signal?.addEventListener('abort', stop, { once: true });
      void (async () => {
        try {
          // Keep the bounded allocation reply alive so cancellation can release a returned handle.
          let manifest = await this._request(path, { ...options, signal: undefined, method: 'POST', body: input,
            preparationAllocation: true, headers: { ...options.headers, Prefer: 'respond-async' } });
          const id = manifest?.[kind === 'query' ? 'queryId' : 'layoutId'];
          if (typeof id !== 'string' || !id) throw new ProviderError('invalid_response', 'Preparation returned no owned handle', 502);
          handlePath = kind === 'query' ? `${base}/query-sessions/${encodeURIComponent(id)}`
            : `${base}/query-sessions/${encodeURIComponent(queryId)}/layouts/${encodeURIComponent(id)}`;
          initial = manifest;
          if (finished) { cleanup(); return; }
          const deadline = Date.now() + 35000;
          while (manifest.state === 'preparing') {
            if (Date.now() >= deadline) throw new ProviderError('preparation_timeout', 'Preparation did not become ready before its deadline', 408);
            await pause();
            manifest = await this._request(handlePath, { signal: polling.signal, timeout: 5000 });
            if (finished) { cleanup(); return; }
            for (const field of ['queryId', 'layoutId', 'snapshotId', 'mapId', 'generation', 'revision']) {
              if (initial[field] !== undefined && manifest?.[field] !== undefined && initial[field] !== manifest[field]) {
                throw new ProviderError('invalid_response', 'Preparation status changed its captured identity', 502);
              }
            }
          }
          if (manifest?.state === 'failed') throw new ProviderError(manifest.error?.code ?? 'preparation_failed', manifest.error?.message ?? 'Preparation failed', manifest.error?.status ?? 500, { diagnostic: manifest.error?.diagnostic });
          if (!manifest || manifest[kind === 'query' ? 'queryId' : 'layoutId'] !== id || (manifest.state !== undefined && manifest.state !== 'ready')) {
            throw new ProviderError('invalid_response', 'Preparation returned an invalid ready manifest', 502);
          }
          finished = true; detach(); resolve(manifest);
        } catch (error) {
          cleanup();
          if (!finished) { finished = true; detach(); reject(error); }
        }
      })();
    });
  }
  createQuery(input, options = {}) {
    if (input?.definitionVersion === 2 && !this.metadata?.capabilities?.query?.definitionVersions?.includes(2)) return Promise.reject(new ProviderError('unsupported_query_definition', 'This server has not advertised query definition version 2', 422));
    return this._prepare(`${this.base}/query-sessions`, input, options, 'query');
  }
  getQuery(id, options = {}) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(id)}`, options); }
  getDensity(id, options = {}) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(id)}/density`, options); }
  getMap(id, mapId, options = {}) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(id)}/maps/${encodeURIComponent(mapId)}`, options); }
  getOverview(id, options = {}) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(id)}/overview`, options); }
  getZones(id, options = {}) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(id)}/zones`, options); }
  createLayout(id, input, options = {}) { return this._prepare(`${this.base}/query-sessions/${encodeURIComponent(id)}/layouts`, input, options, 'layout', id); }
  getLayout(id, layoutId, options = {}) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(id)}/layouts/${encodeURIComponent(layoutId)}`, options); }
  getRows(id, layoutId, options = {}) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(id)}/layouts/${encodeURIComponent(layoutId)}/rows${options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : ''}`, options); }
  getPlacement(id, layoutId, recordId, options = {}) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(id)}/layouts/${encodeURIComponent(layoutId)}/placement/${encodeURIComponent(recordId)}`, options); }
  getRecord(id, options = {}) { return this._request(`${this.base}/records/${encodeURIComponent(id)}${options.includeDeleted ? '?includeDeleted=true' : ''}`, options); }
  getQueryRecord(queryId, id, options = {}) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(queryId)}/records/${encodeURIComponent(id)}`, options); }
  findMatch(queryId, input = {}, options = {}) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(queryId)}/find`, { ...options, method: 'POST', body: input }); }
  migrateLegacyFilter(queryId, input, options = {}) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(queryId)}/legacy-filter-migration`, { ...options, method: 'POST', body: input }); }
  queryRecords(id, input = {}, options = {}) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(id)}/records/query`, { ...options, method: 'POST', body: input }); }

  async executeCommand(command, options = {}) {
    command = clone(command);
    const generation = this.metadata?.generation;
    if (!generation) throw new ProviderError('not_initialized', 'Initialize Server before a write', 409);
    if (!command.generation) throw new ProviderError('precondition_required', 'Source generation is required', 428);
    if (command.generation !== generation) throw new ProviderError('generation_mismatch', 'Draft belongs to a different source generation', 409);
    if (!command.clientCommandId) throw new ProviderError('idempotency_required', 'Client command identity is required', 428);
    if (command.type !== 'create' && !Number.isSafeInteger(command.expectedVersion)) throw new ProviderError('precondition_required', 'Expected record version is required', 428);
    const headers = { 'X-Workspace-Generation': generation, 'Idempotency-Key': command.clientCommandId };
    if (command.type !== 'create') headers['If-Match'] = `"${generation}:${command.expectedVersion}"`;
    let path = `${this.base}/records`;
    let method = 'POST';
    let body = command.payload;
    if (command.type !== 'create') {
      path += `/${encodeURIComponent(command.recordId)}`;
      if (command.type === 'update' || command.type === 'patch') {
        method = 'PATCH'; headers['Content-Type'] = 'application/json-patch+json';
        if (command.type === 'update') body = partialUpdatePatch(body);
      }
      else if (command.type === 'replace') method = 'PUT';
      else if (command.type === 'delete') { method = 'DELETE'; body = undefined; }
      else if (command.type === 'restore') { path += '/restore'; body = {}; }
      else throw new ProviderError('unsupported_command', 'Unknown record command');
    }
    let result = await this._request(path, { ...options, method, body, headers, mutation: true });
    if (command.type === 'delete' && result === null) {
      try {
        const outcome = await this.getCommandOutcome(command.clientCommandId, options);
        if (outcome.state !== 'committed') throw new Error('Missing acknowledged deletion outcome');
        result = outcome.result;
      } catch (error) {
        throw new ProviderError('write_outcome_unknown', 'Deletion was acknowledged; reconnect to retrieve its original committed outcome', 503, { cause: error });
      }
    }
    if (!result || result.durability !== 'server-committed' || result.generation !== generation || !result.record) throw new ProviderError('write_outcome_unknown', 'Write reply did not identify a committed record; check the original command outcome', 502);
    if (this.metadata) Object.assign(this.metadata, { generation: result.generation, revision: result.revision });
    return result;
  }
  async getCommandOutcome(id, options = {}) {
    try {
      const result = await this._request(`${this.base}/command-results/${encodeURIComponent(id)}`, { ...options, method: 'GET', body: undefined, mutation: false });
      if (!result || !['server-committed', 'json-files'].includes(result.durability)) throw new ProviderError('invalid_response', 'Server returned an invalid command outcome', 502);
      return { state: 'committed', result };
    } catch (error) {
      if (error.status === 404 && error.code === 'command_not_found') return { state: 'not-found' };
      throw error;
    }
  }
  async executeBatch(input, options = {}) {
    const command = clone(input), generation = this.metadata?.generation;
    if (!generation) throw new ProviderError('not_initialized', 'Initialize Server before a batch', 409);
    if (!command.generation || !command.clientCommandId) throw new ProviderError('precondition_required', 'Batch requires generation and command identity', 428);
    if (command.generation !== generation) throw new ProviderError('generation_mismatch', 'Batch belongs to another source generation', 409);
    if (Object.keys(command).some(key => !['generation', 'clientCommandId', 'operations'].includes(key))) throw new ProviderError('invalid_batch', 'Unsupported batch command fields');
    const result = await this._request(`${this.base}/records/batch`, { ...options, method: 'POST', mutation: true,
      body: { operations: command.operations }, headers: { 'X-Workspace-Generation': generation, 'Idempotency-Key': command.clientCommandId } });
    if (!result || result.status !== 'committed' || result.commandId !== command.clientCommandId || result.generation !== generation || result.durability !== 'server-committed' || !Array.isArray(result.items)) throw new ProviderError('write_outcome_unknown', 'Batch reply did not identify this commit; check the original command outcome', 502);
    if (this.metadata) this.metadata.revision = result.revision;
    return result;
  }
  listModels(options = {}) {
    return this._request(`${this.base}/models${options.includeArchived === false ? '?includeArchived=false' : ''}`, options);
  }
  getModel(id, options = {}) { return this._request(`${this.base}/models/${encodeURIComponent(id)}`, options); }
  validateModel(definition, options = {}) { return this._request(`${this.base}/models/validate`, { ...options, method: 'POST', body: { definition } }); }
  listConfiguration(family, input = {}, options = {}) {
    return this._request(`${this.base}/${encodeURIComponent(family)}?includeArchived=${input.includeArchived !== false}`, options);
  }
  getConfiguration(family, id, options = {}) {
    const query = new URLSearchParams({ family, id });
    return this._request(`${this.base}/configuration/resource?${query}`, options);
  }
  validateConfiguration(family, definition, context = {}, options = {}) {
    return this._request(`${this.base}/${encodeURIComponent(family)}/validate`, { ...options, method: 'POST', body: { definition, context } });
  }
  configurationUsage(family, id, version, options = {}) {
    const query = new URLSearchParams({ family, id, limit: String(options.limit ?? 100) });
    if (version !== undefined) query.set('version', String(version));
    if (options.cursor) query.set('cursor', options.cursor);
    return this._request(`${this.base}/configuration/usage?${query}`, options);
  }
  getEffectiveSettings(input = {}, options = {}) {
    return this._request(`${this.base}/settings/effective`, { ...options, method: 'POST', body: input });
  }
  previewSchemaImpact(id, input, options = {}) {
    return this._request(`${this.base}/schemas/${encodeURIComponent(id)}/impact`, { ...options, method: 'POST', body: input });
  }
  mutateConfiguration(command, options = {}) { return this._configurationWrite('configuration', command, options); }
  mutateSettings(command, options = {}) { return this._configurationWrite('settings', command, options); }
  async _configurationWrite(kind, input, options) {
    const command = clone(input), generation = this.metadata?.generation;
    if (!generation) throw new ProviderError('not_initialized', 'Initialize Server before changing configuration', 409);
    if (!command.generation || !command.clientCommandId) throw new ProviderError('precondition_required', 'Generation and command identity are required', 428);
    if (command.generation !== generation) throw new ProviderError('generation_mismatch', 'Command belongs to a different source generation', 409);
    if (kind === 'settings' || command.type !== 'create') {
      if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < (kind === 'settings' && command.scope === 'personal' ? 0 : 1)) throw new ProviderError('precondition_required', 'Expected resource revision is required', 428);
    }
    const headers = { 'X-Workspace-Generation': generation, 'Idempotency-Key': command.clientCommandId };
    if (command.expectedRevision !== undefined) headers['If-Match'] = `"${generation}:${command.expectedRevision}"`;
    const result = await this._request(`${this.base}/${kind}/commands`, { ...options, method: 'POST', body: command, headers, mutation: true });
    if (!result || result.status !== 'committed' || result.durability !== 'json-files' || result.commandId !== command.clientCommandId || result.generation !== generation) {
      throw new ProviderError('write_outcome_unknown', 'Configuration reply did not identify this commit; check the original command outcome', 502);
    }
    if (this.metadata) {
      this.metadata.revision = result.revision;
      if (result.effectiveSettings) { this.metadata.settings = clone(result.effectiveSettings.values); this.metadata.preferenceRevision = result.effectiveSettings.preferenceRevision; }
    }
    return result;
  }
  async executeModelCommand(command, options = {}) {
    const generation = this.metadata?.generation;
    if (!generation) throw new ProviderError('not_initialized', 'Initialize Server before changing models', 409);
    if (!command.generation) throw new ProviderError('precondition_required', 'Source generation is required', 428);
    if (command.generation !== generation) throw new ProviderError('generation_mismatch', 'Model command belongs to a different source generation', 409);
    if (!command.clientCommandId) throw new ProviderError('idempotency_required', 'Client command identity is required', 428);
    if (!['create', 'update', 'publish', 'archive', 'unarchive', 'delete', 'apply'].includes(command.type)) throw new ProviderError('unsupported_command', 'Unknown model command');
    const headers = { 'X-Workspace-Generation': generation, 'Idempotency-Key': command.clientCommandId };
    let path = `${this.base}/models`;
    let method = 'POST';
    let body = command.payload === undefined ? {} : command.payload;
    if (command.type !== 'create') {
      if (command.expectedRevision == null) throw new ProviderError('precondition_required', 'Expected model revision is required', 428);
      if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) throw new ProviderError('model_revision_conflict', 'Expected model revision must be a positive safe integer', 412);
      headers['If-Match'] = `"${generation}:${command.expectedRevision}"`;
      path += `/${encodeURIComponent(command.modelId)}`;
      if (command.type === 'update') method = 'PUT';
      else if (command.type === 'delete') {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ProviderError('invalid_model', 'Delete payload must be empty');
        method = 'DELETE'; body = undefined;
      }
      else path += `/${command.type}`;
    }
    const result = await this._request(path, { ...options, method, body, headers, mutation: true });
    if (this.metadata) Object.assign(this.metadata, { generation: result.generation, revision: result.revision, settings: result.settings });
    return result;
  }
  exportSnapshot(options = {}) { return this._request(`${this.base}/snapshot`, options); }
  releaseQuery(id) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  releaseLayout(id, layoutId) { return this._request(`${this.base}/query-sessions/${encodeURIComponent(id)}/layouts/${encodeURIComponent(layoutId)}`, { method: 'DELETE' }); }
  dispose() { this.disposed = true; for (const stop of this.preparationWaiters) stop(); for (const stop of this.changeSubscriptions) stop(); for (const controller of this.controllers) controller.abort(); this.controllers.clear(); this.token = ''; this.metadata = null; }
}
