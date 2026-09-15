export function navigationTiles(offset, width, velocity = 0, latencyMs = 250) {
  if (![offset, width, velocity, latencyMs].every(Number.isFinite) || width <= 0) throw new RangeError('Invalid navigation buffer dimensions');
  const first = Math.floor(-offset / width + 1e-9), last = Math.ceil(1 - offset / width - 1e-9) - 1;
  const visible = Array.from({ length: last - first + 1 }, (_, index) => first + index);
  const direction = -Math.sign(velocity);
  const lead = Math.max(1, Math.min(3, Math.ceil(Math.abs(velocity) * Math.max(150, latencyMs) * 1.5 / width)));
  const ahead = direction ? Array.from({ length: lead }, (_, index) => direction > 0 ? last + index + 1 : first - index - 1) : [last + 1, first - 1];
  return [...new Set([...visible, ...ahead, first - 1, last + 1])].filter(index => index !== 0).slice(0, 6);
}

// Detached, render-ready pages use no retained server layout/query handles.
export function createNavigationBuffer({ prepare, changed = () => {}, now = () => performance.now(),
  maxEntries = 6, maxBytes = 16 * 1024 * 1024, timeoutMs = 8000 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new RangeError('Invalid navigation buffer limits');
  if (typeof prepare !== 'function') throw new TypeError('Navigation preview preparation is required');
  let context = null, active = null, wanted = [], sequence = 0, disposed = false, latency = 250;
  const entries = new Map(), measurements = [];
  const metrics = { requested: 0, hits: 0, discarded: 0, failed: 0, bytes: 0, lateFrames: 0, frames: 0 };
  const keyOf = value => value.query?.queryId;
  const notify = () => changed(context);
  const priority = key => { const index = wanted.indexOf(key); return index < 0 ? Infinity : index; };
  const remove = key => { metrics.bytes -= entries.get(key)?.bytes || 0; entries.delete(key); };
  function prune() {
    for (const key of [...entries.keys()].sort((a, b) => priority(b) - priority(a))) {
      if (entries.size <= maxEntries && metrics.bytes <= maxBytes) break;
      remove(key);
    }
  }
  function admit(index, bytes) {
    if (bytes > maxBytes) return false;
    // Keep higher-priority visible pages; unavailable lower-priority tiles get a retryable status.
    for (const key of [...entries.keys()].sort((a, b) => priority(b) - priority(a))) {
      if (metrics.bytes + bytes <= maxBytes) break;
      if (priority(key) > priority(index)) remove(key);
    }
    return metrics.bytes + bytes <= maxBytes;
  }
  function publishError(index, reason) {
    remove(index);
    entries.set(index, { status: 'error', reason, bytes: 0, retryAt: now() + 2000 });
    prune(); notify();
  }
  function pump() {
    if (disposed || active || !context) return;
    const index = wanted.find(key => !entries.has(key) || entries.get(key).retryAt <= now());
    if (index === undefined) return;
    const owner = context, token = sequence, controller = new AbortController(), started = now();
    const job = { controller, owner, index, promise: null, timedOut: false }; active = job; metrics.requested++;
    const timer = setTimeout(() => {
      job.timedOut = true;
      if (!disposed && token === sequence && context === owner && wanted.includes(index)) {
        metrics.failed++; publishError(index, 'Preview preparation timed out');
      }
      controller.abort();
    }, timeoutMs);
    job.promise = Promise.resolve().then(() => prepare(owner, index, controller.signal)).then(value => {
      if (disposed || token !== sequence || context !== owner || controller.signal.aborted) { metrics.discarded++; return; }
      const elapsed = Math.max(1, now() - started); measurements.push(elapsed); if (measurements.length > 64) measurements.shift();
      const sorted = [...measurements].sort((a, b) => a - b); latency = sorted[Math.ceil(sorted.length * .95) - 1];
      const bytes = value ? JSON.stringify(value).length * 2 : 0;
      remove(index);
      const entry = value && admit(index, bytes) ? { ...value, bytes, preparedAt: now(), queryKey: keyOf(owner) }
        : { status: 'error', reason: value ? 'Preview memory limit reached' : 'Preview unavailable', bytes: 0, retryAt: now() + 2000 };
      entries.delete(index); entries.set(index, entry); metrics.bytes += entry.bytes; prune(); notify();
    }).catch(error => {
      if (disposed || token !== sequence || context !== owner) return;
      if (controller.signal.aborted) { if (!job.timedOut) metrics.discarded++; return; }
      metrics.failed++;
      publishError(index, error.message);
    }).finally(() => {
      clearTimeout(timer); if (active === job) active = null;
      pump();
    });
  }
  return {
    reset(value = null) {
      sequence++; active?.controller.abort(); context = value; wanted = []; entries.clear(); metrics.bytes = 0;
    },
    suspend() { sequence++; active?.controller.abort(); wanted = []; },
    request(value, offset = 0, velocity = 0) {
      if (disposed) return;
      if (context !== value) this.reset(value);
      wanted = navigationTiles(offset, value.width, velocity, latency).slice(0, maxEntries);
      for (const index of wanted) if (entries.get(index)?.status === 'ready') metrics.hits++;
      if (active && !wanted.includes(active.index)) active.controller.abort();
      prune(); pump();
    },
    entries(value = context) { return value === context ? [...entries].map(([index, entry]) => ({ index, ...entry })) : []; },
    coverage(offset, width) {
      const first = Math.floor(-offset / width + 1e-9), last = Math.ceil(1 - offset / width - 1e-9) - 1;
      return Array.from({ length: last - first + 1 }, (_, n) => {
        const index = first + n, entry = entries.get(index);
        const left = Math.max(0, index * width + offset), right = Math.min(width, (index + 1) * width + offset);
        return { index, left, width: Math.max(0, right - left), status: index === 0 ? 'ready' : entry?.status || (active?.owner === context && active?.index === index ? 'loading' : 'not-loaded'), reason: entry?.reason };
      }).filter(span => span.width > .1);
    },
    observeFrame(late) { metrics.frames++; if (late) metrics.lateFrames++; },
    get metrics() { return { ...metrics, estimatedPreparationMs: latency, cachedPages: entries.size, activeRequests: active ? 1 : 0 }; },
    get idle() { return active?.promise || Promise.resolve(); },
    dispose() { disposed = true; this.reset(); },
  };
}
