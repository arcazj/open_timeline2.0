import { timeDecimal, toIso, toMs } from '../timeline/time-scale.js';
import { MIN_TIME, MAX_TIME } from '../timeline/navigation-domain.js';
import { canonicalJson } from './data-provider.js';

export function bufferedWindow(range, ratio = .25, direction = 0, speed = 0) {
  const from = timeDecimal(range.fromMs), to = timeDecimal(range.toMs), span = to.minus(from);
  if (!span.gt(0) || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new RangeError('Invalid loading window');
  const lead = Math.min(1, Math.max(0, Math.abs(speed))) * ratio;
  return {
    from: toIso(from.minus(span.times(ratio + (direction < 0 ? lead : 0))).clamp(MIN_TIME, MAX_TIME).floor()),
    to: toIso(to.plus(span.times(ratio + (direction > 0 ? lead : 0))).clamp(MIN_TIME, MAX_TIME).ceil()),
  };
}

export function predictiveWindow(range, { ratio = .25, direction = 0, speed = 0, viewportWidth,
  latencyMs = 250, delayMs = 180, maxLeadMs = 1600, maxLeadRatio = 1.5 } = {}) {
  const from = timeDecimal(range.fromMs), to = timeDecimal(range.toMs), span = to.minus(from);
  if (!span.gt(0) || !Number.isFinite(ratio) || ratio < 0 || ratio > 1 ||
      !Number.isFinite(latencyMs) || latencyMs < 0 || !Number.isFinite(delayMs) || delayMs < 0 ||
      !Number.isFinite(maxLeadMs) || maxLeadMs < 120 || maxLeadMs > 10000 ||
      !Number.isFinite(maxLeadRatio) || maxLeadRatio < 0 || maxLeadRatio > 3) throw new RangeError('Invalid predictive loading window');
  const leadMs = Math.min(maxLeadMs, Math.max(120, latencyMs + delayMs + 80));
  const velocity = Number.isFinite(speed) ? Math.abs(speed) : 0;
  const leadRatio = Number.isFinite(viewportWidth) && viewportWidth > 0
    ? Math.min(maxLeadRatio, velocity / viewportWidth * leadMs)
    : Math.min(1, velocity) * ratio;
  return { domain: {
    from: toIso(from.minus(span.times(ratio + (direction < 0 ? leadRatio : 0))).clamp(MIN_TIME, MAX_TIME).floor()),
    to: toIso(to.plus(span.times(ratio + (direction > 0 ? leadRatio : 0))).clamp(MIN_TIME, MAX_TIME).ceil()),
  }, leadMs, leadRatio: direction ? leadRatio : 0 };
}

// Prefetch only warms server record files; it cannot certify archive coverage or render readiness.
export function createWindowLoader(provider, { ratio = .25, delayMs = 180, ttlMs = 15000, initialLatencyMs = 250,
  maxLeadMs = 1600, maxLeadRatio = 1.5, maxWindowRatio = 4, timeoutMs = 5000, retryMs = 300, maxRetries = 2,
  onStatus = () => {}, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  for (const [value, min, max] of [[ratio, 0, 1], [delayMs, 0, 2000], [ttlMs, 1, 60000], [initialLatencyMs, 0, 10000],
    [maxLeadMs, 120, 10000], [maxLeadRatio, 0, 3], [maxWindowRatio, 1, 8], [timeoutMs, 1, 10000], [retryMs, 1, 5000]]) {
    if (!Number.isFinite(value) || value < min || value > max) throw new RangeError('Invalid window loader bounds');
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3 || typeof onStatus !== 'function' || maxWindowRatio < 1 + 2 * ratio) throw new RangeError('Invalid window loader options');
  let timer = null, active = null, latest = null, desired = null, disposed = false, scope = null, ordinal = 0;
  let latency = initialLatencyMs, deviation = 0, samples = 0;
  let status = { state: 'idle', reason: null };
  const cached = [], metrics = { requests: 0, cacheHits: 0, aborted: 0, failures: 0, coalesced: 0 };
  const scopeKey = (filters, context) => {
    const key = canonicalJson({ provider: provider.identity ?? null, scope: context, filters });
    if (key.length > 65536) throw new RangeError('Window loading scope exceeds its size limit');
    return key;
  };
  const inside = (a, b) => toMs(a.from) >= toMs(b.from) && toMs(a.to) <= toMs(b.to);
  const overlaps = (a, b) => toMs(a.from) <= toMs(b.to) && toMs(a.to) >= toMs(b.from);
  const prune = () => { for (let index = cached.length - 1; index >= 0; index--) if (cached[index].until <= now() || cached[index].scope !== scope) cached.splice(index, 1); };
  const estimate = () => Math.min(10000, Math.max(0, latency + 2 * deviation));
  function coverage(domain) {
    prune();
    if (!domain) return 'not-loaded';
    const intervals = cached.filter(item => overlaps(domain, item.domain)).map(item => item.domain).sort((a, b) => toMs(a.from) - toMs(b.from));
    let reached = toMs(domain.from);
    for (const interval of intervals) {
      if (toMs(interval.from) > reached) break;
      reached = Math.max(reached, toMs(interval.to));
      if (reached >= toMs(domain.to)) return 'warm';
    }
    return intervals.length ? 'partial' : 'not-loaded';
  }
  function snapshot() {
    const covered = coverage(desired?.domain), expired = status.state === 'warm' && covered !== 'warm';
    return structuredClone({ ...status, ...(expired ? { state: 'not-loaded', reason: 'coverage-expired' } : {}), requestedDomain: desired?.domain ?? null, visibleDomain: desired?.visibleDomain ?? null,
      scopeKey: scope, coverage: covered, layer: 'server-record-cache', renderReady: false,
      estimatedLatencyMs: estimate(), latencySamples: samples, leadMs: desired?.leadMs ?? 0, leadRatio: desired?.leadRatio ?? 0,
      active: !!active, pending: !!latest, cacheEntries: cached.length, disposed, metrics });
  }
  function emit(state, reason = null, details = {}) {
    status = { state, reason, ...details };
    if (!disposed) { try { onStatus(snapshot()); } catch { /* Observers cannot change loader scheduling. */ } }
  }
  function observeLatency(ms) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 30000 || disposed) return snapshot();
    const value = Math.min(10000, ms);
    if (!samples) { latency = value; deviation = value * .1; }
    else { deviation = .75 * deviation + .25 * Math.abs(value - latency); latency = .75 * latency + .25 * value; }
    samples++;
    return snapshot();
  }
  const schedule = (delay = delayMs) => {
    if (timer === null && !active && latest && !disposed) timer = setTimer(run, delay);
  };
  function abortActive(reason) {
    if (active && !active.controller.signal.aborted) { active.reason = reason; metrics.aborted++; active.controller.abort(); }
  }
  function mergePending(previous, next) {
    if (!previous || previous.scope !== next.scope || previous.direction !== next.direction || !overlaps(previous.domain, next.domain)) return next;
    const domain = { from: toMs(previous.domain.from) < toMs(next.domain.from) ? previous.domain.from : next.domain.from,
      to: toMs(previous.domain.to) > toMs(next.domain.to) ? previous.domain.to : next.domain.to };
    if (timeDecimal(toMs(domain.to)).minus(toMs(domain.from)).gt(timeDecimal(next.range.toMs).minus(next.range.fromMs).times(maxWindowRatio))) return next;
    metrics.coalesced++;
    return { ...next, domain };
  }
  async function run() {
    timer = null;
    if (disposed || active || !latest) return;
    const intent = latest; latest = null;
    if (coverage(intent.domain) === 'warm') { metrics.cacheHits++; emit('warm', 'cache-hit'); schedule(); return; }
    const controller = new AbortController(), operation = { controller, intent, reason: null };
    active = operation;
    const started = now();
    let deadline, onAbort;
    const aborted = new Promise(resolve => {
      onAbort = () => resolve({ status: 'aborted' });
      controller.signal.addEventListener('abort', onAbort, { once: true });
      deadline = setTimer(() => { operation.reason = 'timeout'; controller.abort(); }, timeoutMs);
    });
    metrics.requests++;
    emit('warming');
    let retryDelay = delayMs;
    try {
      const pending = controller.signal.aborted ? Promise.resolve({ status: 'aborted' }) : provider.prefetchWindow({ domain: intent.domain, filters: intent.filters }, { signal: controller.signal, timeout: timeoutMs });
      const result = await Promise.race([pending, aborted]);
      if (disposed || scope !== intent.scope || controller.signal.aborted && operation.reason !== 'timeout') return;
      if (result?.status === 'cached' && !controller.signal.aborted) {
        observeLatency(Math.max(0, now() - started));
        cached.push({ domain: intent.domain, scope: intent.scope, until: now() + ttlMs });
        if (cached.length > 6) cached.shift();
        if (desired && coverage(desired.domain) === 'warm') { latest = null; emit('warm', 'prefetch-complete'); }
        else emit(latest ? 'queued' : 'not-loaded', 'outside-warmed-window');
      } else {
        const reason = operation.reason === 'timeout' ? 'timeout' : result?.status === 'busy' ? 'busy' : 'provider-not-cached';
        metrics.failures++;
        emit('not-loaded', reason);
        if (!latest && desired?.scope === intent.scope && coverage(desired.domain) !== 'warm' && intent.attempt < maxRetries) {
          latest = { ...desired, attempt: intent.attempt + 1 };
          retryDelay = Math.min(4000, retryMs * 2 ** intent.attempt);
        }
      }
    } catch (error) {
      if (disposed || scope !== intent.scope || controller.signal.aborted) return;
      metrics.failures++;
      emit('error', 'prefetch-failed', { error: { code: typeof error?.code === 'string' ? error.code : 'prefetch_failed' } });
      if (!latest && desired?.scope === intent.scope && coverage(desired.domain) !== 'warm' && intent.attempt < maxRetries) {
        latest = { ...desired, attempt: intent.attempt + 1 };
        retryDelay = Math.min(4000, retryMs * 2 ** intent.attempt);
      }
    } finally {
      clearTimer(deadline);
      controller.signal.removeEventListener('abort', onAbort);
      if (active === operation) active = null;
      schedule(retryDelay);
      if (!disposed) {
        if (latest && status.state === 'warming') status = { state: 'queued', reason: 'pending-window' };
        try { onStatus(snapshot()); } catch { /* Status reporting is observational. */ }
      }
    }
  }
  return {
    request(range, filters = {}, { direction = 0, speed = 0, viewportWidth, scope: context = {} } = {}) {
      if (disposed) return snapshot();
      const input = structuredClone(filters), key = scopeKey(input, context);
      direction = Number.isFinite(direction) ? Math.sign(direction) : 0;
      const prediction = predictiveWindow(range, { ratio, direction, speed, viewportWidth, latencyMs: estimate(), delayMs, maxLeadMs,
        maxLeadRatio: Math.min(maxLeadRatio, maxWindowRatio - 1 - 2 * ratio) });
      if (scope !== key) { scope = key; cached.length = 0; latest = null; clearTimer(timer); timer = null; abortActive('scope-changed'); }
      const intent = { ...prediction, id: ++ordinal, range: { ...range }, filters: input, scope: key, direction: Math.sign(direction), attempt: 0,
        visibleDomain: bufferedWindow(range, 0) };
      desired = intent;
      if (coverage(intent.domain) === 'warm') {
        latest = null; clearTimer(timer); timer = null;
        if (active && !overlaps(active.intent.domain, intent.domain)) abortActive('outside-window');
        metrics.cacheHits++; emit('warm', 'cache-hit'); return snapshot();
      }
      if (active && inside(intent.domain, active.intent.domain) && !active.controller.signal.aborted) { latest = null; metrics.coalesced++; emit('warming', 'in-flight'); return snapshot(); }
      latest = mergePending(latest, intent);
      if (active && !overlaps(active.intent.domain, intent.visibleDomain)) abortActive('outside-window');
      emit(active ? 'warming' : 'queued', active ? 'pending-window' : null);
      schedule();
      return snapshot();
    },
    observeLatency,
    getStatus: snapshot,
    getCoverage(range, filters = {}, { scope: context = {} } = {}) {
      const domain = bufferedWindow(range, 0), key = scopeKey(filters, context);
      return { domain, scopeKey: key, coverage: !disposed && key === scope ? coverage(domain) : 'not-loaded', layer: 'server-record-cache', renderReady: false };
    },
    pause() { clearTimer(timer); timer = null; latest = null; abortActive('paused'); emit('paused', 'paused'); },
    dispose() { disposed = true; this.pause(); cached.length = 0; },
  };
}

export async function startupTarget({ protocol = location.protocol, fetcher = fetch, timeoutMs = 5000 } = {}) {
  if (protocol === 'file:') return { mode: 'standalone' };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher('/api/v1/bootstrap', { headers: { 'X-OpenBEXI-Local': '1' },
      credentials: 'omit', cache: 'no-store', signal: controller.signal });
    if (response.status === 404) return { mode: 'standalone' };
    if (response.ok && response.headers?.get('content-type')?.includes('text/html')) return { mode: 'standalone' };
    if (!response.ok) throw new Error('Server configuration is unavailable');
    const target = await response.json();
    if (target.mode !== 'configured-server' || target.localBrowser !== true || typeof target.sourceName !== 'string') throw new Error('Invalid server configuration');
    return target;
  } catch { return { mode: 'unavailable', sourceName: 'Configured server' }; }
  finally { clearTimeout(timer); }
}
