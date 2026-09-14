export class ProviderError extends Error {
  constructor(code, message, status = 422, extra = {}) {
    super(message);
    this.name = 'ProviderError';
    Object.assign(this, { code, status }, extra);
  }
}

export function abortIfNeeded(signal) {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
}

export function clone(value) { return structuredClone(value); }

export function inspectJson(value, depth = 0) {
  if (depth > 64) throw new ProviderError('nesting_limit', 'JSON nesting exceeds 64 levels', 413);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new ProviderError('invalid_json', 'Nonfinite numbers are not allowed', 400);
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new ProviderError('invalid_json', 'Integer exceeds the supported exact range', 400);
  if (typeof value === 'string') {
    for (const character of value) if (character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff) throw new ProviderError('invalid_json', 'Unpaired Unicode surrogate', 400);
  }
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    inspectJson(key, depth + 1);
    inspectJson(child, depth + 1);
  }
}

export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export const uuid = () => crypto.randomUUID();

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonicalJson(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
