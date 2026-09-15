export function createChangeMonitor(host, { delay = 250 } = {}) {
  let source = null, generation = null, baseline = 0, latest = 0, mode = 'pinned';
  let required = null, inFlight = false, disposed = false, unsubscribe, timer, session = 0;
  let explicitPending = false, explicitWaiters = [];
  const snapshot = () => ({ active: !!source, generation, baseline, latest, mode, required, inFlight, pending: latest > baseline });
  const paint = () => host.render(snapshot());
  const boundaryRequired = () => ['authorization-lost', 'generation-changed', 'replay-gap'].includes(required);
  const cancelTimer = () => { clearTimeout(timer); timer = null; };
  function cancelExplicit() {
    explicitPending = false;
    const waiters = explicitWaiters; explicitWaiters = [];
    waiters.forEach(resolve => resolve(false));
  }
  function markBoundary(provider, value) {
    if (!['authorization-lost', 'generation-changed', 'replay-gap'].includes(value)) throw new TypeError('Invalid change-monitor boundary');
    if (disposed || !source || source !== provider || required === 'authorization-lost' && value !== required) return false;
    required = value; cancelTimer(); cancelExplicit(); paint(); return true;
  }
  function schedule() {
    if (disposed || !source || inFlight || timer || !explicitPending && (required || mode !== 'live' || latest <= baseline)) return;
    timer = setTimeout(() => {
      timer = null;
      if (!explicitPending) { void refresh(false); return; }
      if (host.blocked()) { schedule(); return; }
      const waiters = explicitWaiters; explicitWaiters = []; explicitPending = false;
      void refresh(true).then(result => waiters.forEach(resolve => resolve(result)));
    }, delay);
  }
  async function refresh(explicit) {
    if (disposed || !source) return false;
    if (inFlight || host.blocked() || explicit && explicitPending) {
      // Keep one explicit read intent while layout, gestures, or drafts are busy.
      if (explicit) {
        explicitPending = true;
        const result = new Promise(resolve => explicitWaiters.push(resolve));
        schedule(); return result;
      }
      schedule(); return false;
    }
    if (!explicit && (required || mode !== 'live' || latest <= baseline)) return false;
    const ticket = session, previous = baseline;
    inFlight = true; cancelTimer(); paint();
    try {
      const query = await host.reload({ provider: source, generation, explicit });
      if (ticket !== session || disposed || boundaryRequired()) return false;
      if (!query || query.generation !== generation || !Number.isSafeInteger(query.revision)) {
        required = 'refresh-required'; return false;
      }
      baseline = Math.max(baseline, query.revision); latest = Math.max(latest, baseline);
      required = null;
      if (!explicit && baseline === previous && latest > baseline) required = 'refresh-required';
      return true;
    } catch (error) {
      if (ticket === session && !disposed && !boundaryRequired()) { required = 'refresh-required'; host.error?.(error); }
      return false;
    } finally {
      if (ticket === session && !disposed) { inFlight = false; paint(); schedule(); }
    }
  }
  function stop() { session++; unsubscribe?.(); unsubscribe = null; cancelTimer(); cancelExplicit(); source = null; inFlight = false; }
  function start(provider, metadata) {
    stop(); disposed = false; source = provider; generation = metadata.generation;
    baseline = metadata.revision; latest = baseline; required = null; mode = 'pinned';
    const ticket = session;
    paint();
    unsubscribe = provider.subscribeChanges(event => {
      if (disposed || ticket !== session || source !== provider) return;
      if (event.type === 'authorization-lost') {
        if (markBoundary(provider, 'authorization-lost')) host.authorizationLost(event);
        return;
      }
      if (event.type === 'generation-changed') {
        if (markBoundary(provider, event.code === 'replay_gap' ? 'replay-gap' : 'generation-changed')) host.refreshRequired(event);
        return;
      }
      if (event.type === 'server-unavailable') { cancelTimer(); cancelExplicit(); host.unavailable(event); return; }
      if (event.type !== 'changed' || event.generation !== generation) return;
      // Empty pages can still advance the scope's high-water mark after source reassignment.
      latest = Math.max(latest, event.throughRevision); paint(); schedule();
    }, { generation, afterRevision: baseline, scope: metadata.changeScope });
  }
  return {
    start,
    markBoundary,
    stop() { stop(); generation = null; baseline = 0; latest = 0; required = null; mode = 'pinned'; paint(); },
    acknowledge(query) {
      if (!source || boundaryRequired() || query?.generation !== generation || !Number.isSafeInteger(query.revision)) return;
      baseline = Math.max(baseline, query.revision); latest = Math.max(latest, baseline); paint(); schedule();
    },
    setMode(value) { if (!['pinned', 'live'].includes(value)) throw new TypeError('Invalid change-monitor mode'); mode = value; cancelTimer(); paint(); schedule(); },
    cancelQueuedReload() { cancelTimer(); cancelExplicit(); },
    reload: () => refresh(true),
    get state() { return Object.freeze(snapshot()); },
    dispose() { stop(); disposed = true; },
  };
}
