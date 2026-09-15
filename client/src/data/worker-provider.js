import { LocalProvider } from './local-provider.js';
import { ProviderError, abortIfNeeded, clone, uuid } from './data-provider.js';

const EMBEDDED_SOURCE = typeof __OPENBEXI_LOCAL_WORKER_SOURCE__ === 'string' ? __OPENBEXI_LOCAL_WORKER_SOURCE__ : '';
const MUTATIONS = new Set(['executeCommand', 'executeModelCommand', 'mutateConfiguration', 'mutateSettings', 'executeBatch']);
const ALLOCATIONS = new Set(['createQuery', 'createLayout']);
const METHODS = { getStatus: 0, createQuery: 1, getQuery: 1, getDensity: 1, getMap: 2, getZones: 1, getOverview: 1, createLayout: 2, getLayout: 2, getRows: 2, getPlacement: 3, getRecord: 1, queryRecords: 2, executeCommand: 1, executeBatch: 1, getCommandOutcome: 1, listModels: 0, getModel: 1, validateModel: 1, executeModelCommand: 1, exportSnapshot: 0, releaseQuery: 1, releaseLayout: 2, listConfiguration: 2, getConfiguration: 2, validateConfiguration: 3, configurationUsage: 3, mutateConfiguration: 1, getEffectiveSettings: 1, mutateSettings: 1, previewSchemaImpact: 2 };
const aborted = () => new DOMException('Operation aborted', 'AbortError');
METHODS.getQueryRecord = 2;
METHODS.findMatch = 2;
METHODS.migrateLegacyFilter = 2;
const unknownWrite = () => new ProviderError('write_outcome_unknown', 'Local write outcome is unknown; keep this source open and check the original command identity', 503);
const lostWorker = () => new ProviderError('local_worker_lost', 'The Local worker stopped. Unsaved changes cannot be recovered by reopening the original snapshot', 503);
const cleanupPending = () => new ProviderError('local_allocation_pending', 'Canceled Local allocation cleanup is not yet confirmed; keep this source open and retry after it finishes', 503);
const cleanupFailed = () => new ProviderError('local_allocation_cleanup_failed', 'Local view cleanup failed and new views are blocked. Export unsaved changes before reopening this source', 503);

function directProvider(input, reason) {
  const provider = new LocalProvider(input), status = provider.getStatus.bind(provider);
  provider.executionMode = 'direct';
  provider.getStatus = async options => ({ ...await status(options), execution: { mode: 'direct', fallbackReason: reason } });
  return provider;
}

function waitWithSignal(promise, signal) {
  abortIfNeeded(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(aborted()); };
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}

export function createLocalProvider(input, { preferWorker = true, workerSource = EMBEDDED_SOURCE, ...options } = {}) {
  if (!preferWorker) return directProvider(input, 'disabled');
  if (!workerSource || typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL.createObjectURL !== 'function') return directProvider(input, 'unavailable');
  return new WorkerLocalProvider(input, { ...options, workerSource });
}

export class WorkerLocalProvider {
  constructor(input, { workerSource = EMBEDDED_SOURCE, bootTimeout = 2000, workerFactory = url => new Worker(url) } = {}) {
    this.input = typeof input === 'string' ? input : clone(input);
    this.workerSource = workerSource;
    this.bootTimeout = bootTimeout;
    this.workerFactory = workerFactory;
    this.identity = `local:${uuid()}`;
    this.generation = null;
    this.revision = null;
    this.executionMode = 'worker';
    this.pending = new Map();
    this.listeners = new Set();
    this.disposed = false;
    this.failed = false;
    this.initialization = null;
  }

  _assert() {
    if (this.disposed) throw new ProviderError('provider_disposed', 'Source is no longer active', 409);
    if (this.failed) throw lostWorker();
  }

  initialize(options = {}) {
    this._assert();
    abortIfNeeded(options.signal);
    if (this.initialized) return this.getStatus(options);
    this.initialization ??= this._initialize().then(status => { this.initialized = true; return status; });
    return waitWithSignal(this.initialization, options.signal);
  }

  async _initialize() {
    try { await this._boot(); }
    catch (error) {
      this._assert();
      this.worker?.terminate();
      this.worker = null;
      this._revoke();
      this.executionMode = 'direct';
      this.direct = directProvider(this.input, 'startup-failed');
      this.direct.subscribeChanges(event => this._change(event));
      const status = await this.direct.initialize();
      this.input = null;
      this._metadata(status);
      return status;
    }
    this._assert();
    const input = this.input;
    this.input = null;
    const status = await this._rpc('initialize', [input], {});
    this._metadata(status);
    return this._status(status);
  }

  _boot() {
    return new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => reject(new Error('Worker startup timed out')), this.bootTimeout);
      this.rejectBoot = reject;
      try {
        this.workerUrl = URL.createObjectURL(new Blob([this.workerSource], { type: 'text/javascript' }));
        this.worker = this.workerFactory(this.workerUrl);
        this.worker.addEventListener('message', ({ data }) => {
          if (data?.type === 'ready' && !ready) {
            ready = true; clearTimeout(timer); this.rejectBoot = null; this._revoke(); resolve(); return;
          }
          if (ready) this._message(data);
        });
        const fail = event => {
          event.preventDefault?.();
          if (!ready) { clearTimeout(timer); reject(new Error('Worker startup failed')); }
          else this._fail();
        };
        this.worker.addEventListener('error', fail);
        this.worker.addEventListener('messageerror', fail);
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  }

  _revoke() { if (this.workerUrl) { URL.revokeObjectURL(this.workerUrl); this.workerUrl = null; } }
  _metadata(value) {
    if (!value || this.disposed) return;
    for (const key of ['identity', 'generation', 'revision', 'modified']) if (value[key] !== undefined) this[key] = value[key];
  }
  _status(status) {
    const cleanup = [...this.pending.values()].find(request => request.allocation && request.cancelError);
    return { ...status, execution: { mode: this.executionMode, ...(cleanup ? { allocationCleanup: cleanup.cleanupError ? 'failed' : 'pending' } : {}) } };
  }
  _change(event) {
    this._metadata(event);
    for (const listener of this.listeners) { try { listener(clone(event)); } catch { /* Observers cannot change a committed result. */ } }
  }

  _message(message) {
    if (this.disposed || this.failed) return;
    this._metadata(message?.metadata);
    if (message?.type === 'change') { this._change(message.event); return; }
    if (message?.type !== 'response') return;
    const request = this.pending.get(message.id);
    if (!request) return;
    if (request.allocation && request.cancelError) {
      if (request.releasing) return;
      if (message.error) { this._finishCanceledAllocation(message.id, request); return; }
      request.releasing = true;
      const method = request.method === 'createQuery' ? 'releaseQuery' : 'releaseLayout';
      const args = request.method === 'createQuery' ? [message.result.queryId] : [request.args[0], message.result.layoutId];
      const acknowledge = response => {
        if (!response.error || (method === 'releaseLayout' && response.error.code === 'snapshot_expired')) this._finishCanceledAllocation(message.id, request);
        else this._allocationCleanupFailed(request, true);
      };
      // Retain the allocation slot until release is acknowledged, even if the caller's deadline expires.
      this._rpc(method, args, { timeout: Math.max(1, request.deadline - Date.now()) }, { cleanup: true, acknowledge })
        .catch(error => this._allocationCleanupFailed(request, error.code !== 'local_allocation_pending'));
      return;
    }
    this.pending.delete(message.id);
    request.cleanup();
    request.acknowledge?.(message);
    if (request.settled) return;
    if (message.error) {
      const error = message.error.name === 'AbortError' ? aborted() : new ProviderError(message.error.code ?? 'local_worker_error', message.error.message, message.error.status ?? 500, { errors: message.error.errors });
      if (message.error.diagnostic) error.diagnostic = clone(message.error.diagnostic);
      request.reject(error);
    } else request.resolve(request.method === 'getStatus' ? this._status(message.result) : message.result);
  }

  _finishCanceledAllocation(id, request) {
    if (this.pending.get(id) !== request) return;
    this.pending.delete(id); request.cleanup();
    if (!request.settled) { request.settled = true; request.reject(request.cancelError); }
  }

  _allocationCleanupFailed(request, terminal = false) {
    if (terminal) request.cleanupError ??= cleanupFailed();
    if (!request.settled) { request.settled = true; request.cleanup(); request.reject(request.cleanupError || cleanupPending()); }
  }

  _rpc(method, args, options, internal = {}) {
    this._assert(); abortIfNeeded(options.signal);
    const blocked = ALLOCATIONS.has(method) && [...this.pending.values()].find(request => request.allocation && request.cancelError);
    if (blocked) return Promise.reject(blocked.cleanupError || cleanupPending());
    if (this.pending.size >= (internal.cleanup ? 128 : 64)) return Promise.reject(new ProviderError('worker_capacity', 'Too many pending Local operations', 429));
    const signal = options.signal, mutation = MUTATIONS.has(method), id = uuid();
    const timeout = Number.isFinite(options.timeout) && options.timeout > 0 ? Math.min(options.timeout, 120000) : 60000;
    const { signal: ignoredSignal, timeout: ignoredTimeout, ...wireOptions } = options;
    return new Promise((resolve, reject) => {
      const request = { method, args, resolve, reject, mutation, allocation: ALLOCATIONS.has(method),
        deadline: Date.now() + timeout, acknowledge: internal.acknowledge, settled: false, cleanup: () => {} };
      const cancel = timedOut => {
        if (request.settled) return;
        if (internal.cleanup) {
          request.settled = true; request.cleanup();
          // Stop waiting at the deadline, but keep the release and its late acknowledgement alive.
          reject(cleanupPending());
          return;
        }
        if (request.allocation) {
          request.cancelError ??= timedOut ? new ProviderError('local_request_timeout', 'Local work timed out', 503) : aborted();
          signal?.removeEventListener('abort', relay);
          try { this.worker.postMessage({ type: 'cancel', id }); } catch { /* Keep the allocation blocked until cleanup or worker loss is confirmed. */ }
          if (timedOut) this._allocationCleanupFailed(request);
          return;
        }
        request.settled = true;
        request.cleanup();
        try { this.worker.postMessage({ type: 'cancel', id }); } catch { /* Failure is handled by the original request outcome. */ }
        reject(mutation ? unknownWrite() : timedOut ? new ProviderError('local_request_timeout', 'Local work timed out; it may still be finishing', 503) : aborted());
      };
      const relay = () => cancel(false), timer = setTimeout(() => cancel(true), timeout);
      request.cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', relay); };
      signal?.addEventListener('abort', relay, { once: true });
      this.pending.set(id, request);
      try { this.worker.postMessage({ type: 'request', id, method, args, options: wireOptions }); }
      catch (error) { this.pending.delete(id); request.cleanup(); reject(new ProviderError('worker_dispatch_failed', 'Local request was not dispatched', 500, { cause: error })); }
    });
  }

  _invoke(method, args, options = {}) {
    // Capture intent before the first await, including a caller-owned options object.
    const capturedArgs = clone(args), capturedOptions = { ...options };
    return (async () => {
      this._assert(); abortIfNeeded(capturedOptions.signal);
      await waitWithSignal(this.initialization ?? this.initialize(), capturedOptions.signal);
      this._assert(); abortIfNeeded(capturedOptions.signal);
      if (this.direct) {
        const result = await this.direct[method](...capturedArgs, capturedOptions);
        this._metadata(this.direct);
        return result;
      }
      return this._rpc(method, capturedArgs, capturedOptions);
    })();
  }

  subscribeChanges(listener) { this._assert(); this.listeners.add(listener); return () => this.listeners.delete(listener); }

  _fail() {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.worker?.terminate();
    this._revoke();
    for (const request of this.pending.values()) { request.cleanup(); if (!request.settled) request.reject(request.mutation ? unknownWrite() : lostWorker()); }
    this.pending.clear();
    this._change({ type: 'worker-lost', generation: this.generation, revision: this.revision });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectBoot?.(new ProviderError('provider_disposed', 'Source is no longer active', 409));
    this.worker?.terminate();
    this._revoke();
    this.direct?.dispose();
    for (const request of this.pending.values()) { request.cleanup(); if (!request.settled) request.reject(request.mutation ? unknownWrite() : aborted()); }
    this.pending.clear(); this.listeners.clear(); this.input = null;
  }
}

for (const [method, count] of Object.entries(METHODS)) {
  Object.defineProperty(WorkerLocalProvider.prototype, method, { value: function (...parameters) {
    const args = Array.from({ length: count }, (_, index) => parameters[index]);
    if (method === 'queryRecords' && args[1] === undefined) args[1] = {};
    return this._invoke(method, args, parameters[count] ?? {});
  } });
}
