export function createNavigationLayoutCache({ prepare, release }) {
  let slot = null, cleanup = Promise.resolve();
  function discard() {
    const prior = slot; slot = null;
    if (!prior) return cleanup;
    prior.controller.abort();
    cleanup = prior.promise.then(async value => { if (value) await release(value, prior.context); }).catch(() => {});
    return cleanup;
  }
  return {
    request(context, key, range) {
      if (slot) return false;
      const controller = new AbortController(), current = { context, key, controller };
      slot = current;
      current.promise = cleanup.then(() => {
        if (controller.signal.aborted) return null;
        return prepare(context, range, controller.signal);
      }).catch(() => null);
      return true;
    },
    async take(context, key) {
      const current = slot;
      if (!current || current.context !== context || current.key !== key) { await discard(); return null; }
      const value = await current.promise;
      if (slot !== current || current.controller.signal.aborted) return null;
      slot = null; return value;
    },
    discard,
    get pending() { return !!slot; },
  };
}
