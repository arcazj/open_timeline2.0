import { ProviderError } from './data-provider.js';

const aborted = () => new DOMException('Operation aborted', 'AbortError');

export function createPreparationAdmission({ maxPending = 64 } = {}) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new RangeError('maxPending must be a positive safe integer');
  const queue = [];
  let active = false;

  function grantNext() {
    if (active || !queue.length) return;
    const waiter = queue.shift();
    waiter.signal?.removeEventListener('abort', waiter.abort);
    active = true;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true; active = false; grantNext();
    });
  }

  return {
    get active() { return active; },
    get pendingCount() { return Number(active) + queue.length; },
    acquire({ signal } = {}) {
      if (signal?.aborted) return Promise.reject(aborted());
      if (Number(active) + queue.length >= maxPending) {
        return Promise.reject(new ProviderError('preparation_capacity', 'Too many foreground views are waiting to be prepared', 429));
      }
      return new Promise((resolve, reject) => {
        const waiter = { signal, resolve, abort: null };
        waiter.abort = () => {
          const index = queue.indexOf(waiter);
          if (index < 0) return;
          queue.splice(index, 1); signal.removeEventListener('abort', waiter.abort);
          reject(aborted()); grantNext();
        };
        signal?.addEventListener('abort', waiter.abort, { once: true });
        queue.push(waiter);
        if (signal?.aborted) waiter.abort();
        else grantNext();
      });
    },
  };
}
