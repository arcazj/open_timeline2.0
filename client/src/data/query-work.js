import { abortIfNeeded } from './data-provider.js';

export function drainQuerySteps(steps, { signal } = {}) {
  try {
    while (true) {
      abortIfNeeded(signal);
      const result = steps.next();
      if (result.done) return result.value;
    }
  } finally { steps.return(); }
}

export async function drainQueryStepsAsync(steps, { signal, sliceMs = 8, yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  let started = performance.now();
  try {
    while (true) {
      abortIfNeeded(signal);
      const result = steps.next();
      if (result.done) return result.value;
      if (performance.now() - started >= sliceMs) {
        await yieldControl();
        started = performance.now();
      }
    }
  } finally { steps.return(); }
}
