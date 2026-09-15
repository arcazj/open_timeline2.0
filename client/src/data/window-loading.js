import { timeDecimal, toIso, toMs } from '../timeline/time-scale.js';
import { MIN_TIME, MAX_TIME } from '../timeline/navigation-domain.js';

export function bufferedWindow(range, ratio = .25, direction = 0, speed = 0) {
  const from = timeDecimal(range.fromMs), to = timeDecimal(range.toMs), span = to.minus(from);
  if (!span.gt(0) || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new RangeError('Invalid loading window');
  const lead = Math.min(1, Math.max(0, Math.abs(speed))) * ratio;
  return {
    from: toIso(from.minus(span.times(ratio + (direction < 0 ? lead : 0))).clamp(MIN_TIME, MAX_TIME).floor()),
    to: toIso(to.plus(span.times(ratio + (direction > 0 ? lead : 0))).clamp(MIN_TIME, MAX_TIME).ceil()),
  };
}

// One active request, one replaceable intent, and a small expiring coverage cache.
export function createWindowLoader(provider, { ratio = .25, delayMs = 180, ttlMs = 15000,
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer, active = null, latest = null, disposed = false, scope = null;
  const cached = [];
  const inside = (a, b) => toMs(a.from) >= toMs(b.from) && toMs(a.to) <= toMs(b.to);
  const schedule = () => { if (!timer && !active && latest && !disposed) timer = setTimer(run, delayMs); };
  async function run() {
    timer = null;
    if (disposed || active || !latest) return;
    const intent = latest; latest = null;
    const domain = bufferedWindow(intent.range, ratio, intent.direction, intent.speed);
    if (cached.some(item => item.until > now() && item.scope === intent.scope && inside(domain, item.domain))) { schedule(); return; }
    const controller = new AbortController(); active = controller;
    try {
      const result = await provider.prefetchWindow({ domain, filters: intent.filters }, { signal: controller.signal });
      if (!disposed && !controller.signal.aborted && scope === intent.scope && result.status === 'cached') {
        cached.push({ domain, scope, until: now() + ttlMs });
        if (cached.length > 6) cached.shift();
      }
    } catch { /* Speculation never replaces the visible source or reports empty data. */ }
    finally { if (active === controller) active = null; schedule(); }
  }
  return {
    request(range, filters, { direction = 0, speed = 0 } = {}) {
      if (disposed) return;
      const key = JSON.stringify(filters);
      if (scope !== key) { scope = key; cached.length = 0; active?.abort(); }
      latest = { range: { ...range }, filters: structuredClone(filters), scope: key, direction, speed };
      schedule();
    },
    pause() { clearTimer(timer); timer = null; latest = null; active?.abort(); },
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
