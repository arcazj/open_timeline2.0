export function createChangeMonitor(host, { delay = 250 } = {}) {
  let source = null, generation = null, baseline = 0, latest = 0, mode = 'pinned';
  let required = null, inFlight = false, disposed = false, unsubscribe, timer, session = 0;
  const snapshot = () => ({ active: !!source, generation, baseline, latest, mode, required, inFlight, pending: latest > baseline });
  const paint = () => host.render(snapshot());
  const boundaryRequired = () => ['authorization-lost', 'generation-changed', 'replay-gap'].includes(required);
  const cancelTimer = () => { clearTimeout(timer); timer = null; };
  function schedule() {
    if (disposed || !source || required || mode !== 'live' || latest <= baseline || inFlight || timer) return;
    timer = setTimeout(() => { timer = null; void refresh(false); }, delay);
  }
  async function refresh(explicit) {
    if (disposed || !source || inFlight || host.blocked()) { if (!explicit) schedule(); return false; }
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
  function stop() { session++; unsubscribe?.(); unsubscribe = null; cancelTimer(); source = null; inFlight = false; }
  function start(provider, metadata) {
    stop(); disposed = false; source = provider; generation = metadata.generation;
    baseline = metadata.revision; latest = baseline; required = null; mode = 'pinned';
    const ticket = session;
    paint();
    unsubscribe = provider.subscribeChanges(event => {
      if (disposed || ticket !== session || source !== provider) return;
      if (event.type === 'authorization-lost') {
        required = 'authorization-lost'; cancelTimer(); paint(); host.authorizationLost(event); return;
      }
      if (event.type === 'generation-changed') {
        required = event.code === 'replay_gap' ? 'replay-gap' : 'generation-changed'; cancelTimer(); paint(); host.refreshRequired(event); return;
      }
      if (event.type === 'server-unavailable') { host.unavailable(event); return; }
      if (event.type !== 'changed' || event.generation !== generation) return;
      // Empty pages can still advance the scope's high-water mark after source reassignment.
      latest = Math.max(latest, event.throughRevision); paint(); schedule();
    }, { generation, afterRevision: baseline, scope: metadata.changeScope });
  }
  return {
    start,
    stop() { stop(); generation = null; baseline = 0; latest = 0; required = null; mode = 'pinned'; paint(); },
    acknowledge(query) {
      if (!source || boundaryRequired() || query?.generation !== generation || !Number.isSafeInteger(query.revision)) return;
      baseline = Math.max(baseline, query.revision); latest = Math.max(latest, baseline); paint(); schedule();
    },
    setMode(value) { if (!['pinned', 'live'].includes(value)) throw new TypeError('Invalid change-monitor mode'); mode = value; cancelTimer(); paint(); schedule(); },
    reload: () => refresh(true),
    get state() { return Object.freeze(snapshot()); },
    dispose() { stop(); disposed = true; },
  };
}
