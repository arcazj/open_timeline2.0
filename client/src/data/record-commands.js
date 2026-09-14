import jsonpatch from 'fast-json-patch';
import { ProviderError, clone, inspectJson } from './data-provider.js';

export const MUTABLE_RECORD_FIELDS = Object.freeze(['title', 'start', 'end', 'parentSessionId', 'order', 'sourceId', 'groupIds', 'tags', 'data', 'render', 'extensions', 'schemaId', 'schemaVersion', 'originalStart', 'originalEnd', 'kind']);
const mutable = new Set(MUTABLE_RECORD_FIELDS), unsafe = new Set(['__proto__', 'prototype', 'constructor']);

export function recordReplacement(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object' || Object.keys(payload).length !== mutable.size || Object.keys(payload).some(key => !mutable.has(key))) {
    throw new ProviderError('incomplete_replacement', 'PUT requires every mutable record field, including originalStart and originalEnd');
  }
  inspectJson(payload);
  return clone(payload);
}

function pointer(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || [...value].length > 1024 || /~(?![01])/u.test(value)) throw new ProviderError('invalid_patch', 'Patch paths must be bounded JSON Pointers');
  const parts = value.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (!mutable.has(parts[0]) || parts.some(part => unsafe.has(part))) throw new ProviderError('immutable_field', 'Patch paths must remain within mutable record fields');
}

export function patchRecord(record, operations) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 100) throw new ProviderError('invalid_patch', 'JSON Patch requires 1 to 100 operations');
  inspectJson(operations);
  let candidate = Object.fromEntries(MUTABLE_RECORD_FIELDS.map(key => [key, clone(record[key])]));
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new ProviderError('invalid_patch', 'Each patch operation must be an object');
    const fields = ['op', 'path'];
    if (['add', 'replace', 'test'].includes(operation.op)) fields.push('value');
    else if (['move', 'copy'].includes(operation.op)) fields.push('from');
    else if (operation.op !== 'remove') throw new ProviderError('invalid_patch', 'Unsupported JSON Patch operation');
    if (Object.keys(operation).length !== fields.length || fields.some(key => !Object.hasOwn(operation, key))) throw new ProviderError('invalid_patch', 'Patch operation fields do not match its operation');
    pointer(operation.path);
    if (Object.hasOwn(operation, 'from')) pointer(operation.from);
    try { candidate = jsonpatch.applyPatch(candidate, [clone(operation)], true, false, true).newDocument; }
    catch (error) { throw new ProviderError(error.name === 'TEST_OPERATION_FAILED' ? 'patch_test_failed' : 'invalid_patch', 'JSON Patch cannot be applied to the current record', error.name === 'TEST_OPERATION_FAILED' ? 409 : 422); }
  }
  return recordReplacement(candidate);
}

export function partialUpdatePatch(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object' || !Object.keys(payload).length) throw new ProviderError('invalid_patch', 'An update requires at least one mutable field');
  return Object.entries(payload).map(([key, value]) => {
    if (!mutable.has(key)) throw new ProviderError('immutable_field', 'Record identity, versions and audit fields are server-owned');
    return { op: 'replace', path: `/${key}`, value: clone(value) };
  });
}
