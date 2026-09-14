const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const DECAY_MS = 700;

export function createNavigationMotion({ preview, settle, canceled = () => {}, changed = () => {},
  frame = callback => requestAnimationFrame(callback), cancelFrame = id => cancelAnimationFrame(id),
  now = () => performance.now(), reducedMotion = () => false } = {}) {
  let session = null, scheduled = null, sequence = 0;
  const schedule = () => { if (scheduled === null) scheduled = frame(tick); };
  function stopFrame() { if (scheduled !== null) cancelFrame(scheduled); scheduled = null; }
  function projected(value, elastic = true) {
    const result = session.project(value), excess = value - result.offset;
    const rubber = elastic && !reducedMotion() ? Math.sign(excess) * 32 * (1 - Math.exp(-Math.abs(excess) / 96)) : 0;
    return { ...result, offset: result.offset + rubber, constrainedOffset: result.offset };
  }
  function draw(value, elastic = true) {
    const result = projected(value, elastic); session.last = result;
    preview(result, session.context); return result;
  }
  function finish() {
    if (!session || session.phase === 'settling') return;
    stopFrame(); const current = session;
    const result = draw(current.offset, false);
    if (session !== current) return;
    current.phase = 'settling'; changed(current.phase);
    Promise.resolve().then(() => {
      if (session === current) return settle(result, current.context);
    }).finally(() => {
      if (session !== current) return;
      session = null; changed('idle');
    }).catch(() => {});
  }
  function tick(timestamp) {
    scheduled = null; if (!session) return;
    if (session.phase === 'dragging') { draw(session.offset); return; }
    if (session.phase !== 'coasting') return;
    const current = session, elapsed = Math.max(0, timestamp - current.releaseAt);
    const travel = current.velocity * DECAY_MS * (1 - Math.exp(-elapsed / DECAY_MS));
    current.offset = current.releaseOffset + travel;
    const result = draw(current.offset);
    if (session !== current) return;
    const bounded = Math.abs(result.offset - result.constrainedOffset) > 0.01;
    if (reducedMotion() || elapsed >= 4000 || Math.abs(session.velocity * Math.exp(-elapsed / DECAY_MS)) < 0.035 || bounded) finish();
    else schedule();
  }
  function cancel({ reset = true } = {}) {
    if (!session) return;
    const previous = session; session = null; ++sequence; stopFrame();
    if (reset) preview(null, previous.context);
    canceled(previous.context); changed('idle');
  }
  return {
    begin(context, project, initialOffset = 0) {
      cancel({ reset: false });
      session = { context, project, phase: 'dragging', offset: initialOffset, samples: [{ offset: initialOffset, time: now() }], token: ++sequence };
      changed('dragging'); return session.token;
    },
    move(offset) {
      if (session?.phase !== 'dragging' || !Number.isFinite(offset)) return;
      const time = now(); session.offset = offset;
      session.samples.push({ offset, time });
      session.samples = session.samples.filter(sample => time - sample.time <= 100).slice(-16);
      schedule();
    },
    release() {
      if (session?.phase !== 'dragging') return;
      const current = session;
      stopFrame(); draw(current.offset);
      if (session !== current) return;
      const time = now(), samples = session.samples, first = samples[0], last = samples.at(-1);
      const duration = last.time - first.time;
      const speedLimit = Math.min(5, (current.context?.width || 1600) * 4 / DECAY_MS);
      const velocity = duration >= 8 && time - last.time < 100 ? clamp((last.offset - first.offset) / duration, -speedLimit, speedLimit) : 0;
      if (reducedMotion() || Math.abs(velocity) < 0.05) { finish(); return; }
      Object.assign(session, { phase: 'coasting', releaseAt: time, releaseOffset: session.offset, velocity });
      changed('coasting'); schedule();
    },
    cancel,
    stop() { if (session?.phase === 'coasting' || session?.phase === 'dragging') finish(); },
    get active() { return !!session; },
    get phase() { return session?.phase || 'idle'; },
    get offset() { return session?.last?.offset ?? session?.offset ?? 0; },
    get context() { return session?.context; },
  };
}
