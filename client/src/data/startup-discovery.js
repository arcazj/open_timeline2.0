const phases = {
  configuration: 'Reading configuration', 'reading-legacy': 'Reading legacy JSON',
  'validating-records': 'Validating records', 'indexing-timeline': 'Indexing timeline',
  'recovering-storage': 'Opening storage', 'recovering-identity': 'Opening access settings',
  'loading-services': 'Preparing queries',
};

export function startupMessage(progress) {
  const counts = ['filesRead', 'recordsRead'].map((key, i) => Number.isSafeInteger(progress[key]) && progress[key] >= 0
    ? `${progress[key].toLocaleString('en-US')} ${i ? 'records' : 'files'} read` : '').filter(Boolean);
  return `Server starting: ${phases[progress.phase] || 'Preparing data'}${counts.length ? ` (${counts.join(', ')})` : ''}. Local snapshot remains active.`;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const aborted = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
});

// Retry only an explicitly starting local server, never an unrelated HTTP host.
export async function discoverStartupCatalog({ signal = new AbortController().signal, onProgress = () => {},
  fetcher = fetch, wait = sleep, now = () => performance.now(), budgetMs = 360000, requestMs = 2000, pollMs = 1000 } = {}) {
  const deadline = now() + budgetMs;
  async function request(path) {
    signal.throwIfAborted();
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), Math.min(requestMs, Math.max(1, deadline - now())));
    try {
      const response = await fetcher(path, { headers: { 'X-OpenBEXI-Local': '1' }, credentials: 'omit', cache: 'no-store', signal: controller.signal });
      const body = await response.json();
      signal.throwIfAborted();
      return { response, body };
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
  }
  try {
    let result = await request('/api/v1/local-sources');
    if (result.response.status === 503 && result.body.code === 'startup_failed') return { state: 'failed' };
    if (result.response.status === 503 && result.body.code === 'server_starting') {
      onProgress({ status: 'starting', phase: 'configuration' });
      while (now() < deadline) {
        const health = await request('/health/ready');
        if (health.response.ok && health.body.status === 'ready') { result = await request('/api/v1/local-sources'); break; }
        if (health.body.status === 'failed') return { state: 'failed' };
        if (health.response.status !== 503 || health.body.status !== 'starting') return { state: 'unavailable' };
        onProgress(health.body);
        await wait(Math.min(pollMs, Math.max(1, deadline - now())), signal);
      }
      if (now() >= deadline) return { state: 'timeout' };
    }
    if (!result.response.ok) return { state: 'unsupported' };
    const catalog = result.body;
    if (catalog.mode !== 'local-read-only' || !Array.isArray(catalog.sources) || catalog.sources.length > 100
      || catalog.sources.some(source => typeof source.id !== 'string' || typeof source.path !== 'string' || typeof source.namespace !== 'string')) return { state: 'unsupported' };
    return { state: 'ready', catalog };
  } catch { return { state: signal.aborted ? 'cancelled' : 'unavailable' }; }
}
