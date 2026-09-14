import { ProviderError, canonicalJson } from './data-provider.js';

const encode = value => btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
export const createCursorKey = () => crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function sealCursor(payload, key) {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const signature = await crypto.subtle.sign('HMAC', key, bytes);
  return `${encode(bytes)}.${encode(new Uint8Array(signature))}`;
}

export async function openCursor(cursor, key) {
  try {
    if (typeof cursor !== 'string' || cursor.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Malformed cursor');
    const [body, signature] = cursor.split('.'), bytes = decode(body);
    if (!await crypto.subtle.verify('HMAC', key, decode(signature), bytes)) throw new Error('Invalid signature');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new ProviderError('invalid_table_cursor', 'Table cursor is invalid or belongs to another query', 400); }
}
