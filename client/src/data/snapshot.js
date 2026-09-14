import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseTree, getNodeValue } from 'jsonc-parser';
import recordSchema from '../../../shared/schemas/record.schema.json' with { type: 'json' };
import snapshotSchema from '../../../shared/schemas/snapshot.schema.json' with { type: 'json' };
import configurationDefinition from '../../../shared/schemas/configuration-definition.schema.json' with { type: 'json' };
import configurationResource from '../../../shared/schemas/configuration-resource.schema.json' with { type: 'json' };
import configurationState from '../../../shared/schemas/configuration-state.schema.json' with { type: 'json' };
import { toMs, toIso, instantFormat } from '../timeline/time-scale.js';
import { ProviderError, clone, sha256, inspectJson } from './data-provider.js';
import { registerModelSchemas, normalizeSnapshotModels } from './model-catalog.js';
import { normalizeConfiguration } from './configuration-catalog.js';
import { validateRecordData } from './record-schema.js';
import { snapshotContent } from './snapshot-content.js';

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
addFormats(ajv);
ajv.addFormat('timeline-instant', instantFormat);
ajv.addSchema(recordSchema);
ajv.addSchema(configurationDefinition).addSchema(configurationResource).addSchema(configurationState);
registerModelSchemas(ajv);
const snapshotValidator = ajv.compile(snapshotSchema);
const recordValidator = ajv.getSchema(recordSchema.$id);
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
export const LOCAL_LIMITS = Object.freeze({ records: 25000, bundleBytes: 64 * 1024 * 1024, queryCount: 2, layoutsPerQuery: 2 });

export function parseStrictJson(text) {
  if (typeof text !== 'string' || bytes(text) > LOCAL_LIMITS.bundleBytes) throw new ProviderError('snapshot_size_limit', 'Snapshot exceeds 64 MiB', 413);
  const errors = [];
  const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false });
  if (!tree || errors.length) throw new ProviderError('invalid_json', `Invalid JSON at offset ${errors[0]?.offset ?? 0}`, 400);
  function walk(node, depth = 0) {
    if (depth > 64) throw new ProviderError('nesting_limit', 'JSON nesting exceeds 64 levels', 413);
    if (node.type === 'object') {
      const seen = new Set();
      for (const property of node.children ?? []) {
        const key = property.children[0].value;
        if (seen.has(key)) throw new ProviderError('duplicate_property', `Duplicate JSON property: ${key}`, 400);
        seen.add(key);
      }
    }
    for (const child of node.children ?? []) walk(child, depth + (node.type === 'property' ? 0 : 1));
  }
  walk(tree);
  const value = getNodeValue(tree);
  inspectJson(value);
  return value;
}

export function validateRecord(record, snapshot) {
  inspectJson(record);
  if (!recordValidator(record)) throw new ProviderError('invalid_record', ajv.errorsText(recordValidator.errors));
  if (!record.title.trim() || [...record.title].length > 500) throw new ProviderError('invalid_title', 'Title must contain 1-500 codepoints');
  if (!Number.isSafeInteger(record.version) || (record.order != null && !Number.isSafeInteger(record.order))) throw new ProviderError('invalid_integer', 'Unsupported record integer');
  const start = toMs(record.start);
  const end = record.end === null ? null : toMs(record.end);
  if (record.kind === 'event' && end !== null) throw new ProviderError('event_end', 'Point events require null end');
  if (end !== null && end < start) throw new ProviderError('invalid_interval', 'End precedes start');
  for (const key of ['originalStart', 'originalEnd', 'createdAt', 'updatedAt', 'deletedAt']) if (record[key] != null) toMs(record[key]);
  if ((record.schemaId == null) !== (record.schemaVersion == null)) throw new ProviderError('schema_reference', 'Schema ID and version must occur together');
  validateRecordData(record, snapshot);
  if (bytes(record) > 256 * 1024) throw new ProviderError('record_size_limit', 'Record exceeds 256 KiB', 413);
  return record;
}

export function validateRelationships(records, workspaceId, sourceIds, snapshot) {
  const byId = new Map();
  for (const record of records) {
    validateRecord(record, snapshot);
    if (byId.has(record.id)) throw new ProviderError('duplicate_id', `Duplicate record ID ${record.id}`);
    if (record.workspaceId !== workspaceId || !sourceIds.includes(record.sourceId)) throw new ProviderError('scope_mismatch', 'Record is outside declared workspace/source scope');
    byId.set(record.id, record);
  }
  for (const record of records) {
    const seen = new Set([record.id]);
    let cursor = record;
    let depth = 0;
    while (cursor.parentSessionId) {
      const parent = byId.get(cursor.parentSessionId);
      if (!parent || parent.kind !== 'session' || parent.sourceId !== record.sourceId || (!record.deletedAt && parent.deletedAt)) throw new ProviderError('invalid_parent', 'Parent must be an available session in the same source');
      if (seen.has(parent.id) || ++depth > 8) throw new ProviderError('invalid_parent', 'Parent cycle or depth exceeds eight');
      seen.add(parent.id);
      cursor = parent;
    }
  }
}

export async function validateSnapshot(input) {
  const snapshot = typeof input === 'string' ? parseStrictJson(input) : clone(input);
  inspectJson(snapshot);
  if (bytes(snapshot) > LOCAL_LIMITS.bundleBytes) throw new ProviderError('snapshot_size_limit', 'Snapshot exceeds 64 MiB', 413);
  if (!snapshotValidator(snapshot)) throw new ProviderError('invalid_snapshot', ajv.errorsText(snapshotValidator.errors));
  if (snapshot.records.length > LOCAL_LIMITS.records) throw new ProviderError('record_limit', 'Local capacity is 25,000 records', 413);
  const manifest = snapshot.manifest;
  if (manifest.recordCount !== snapshot.records.length || manifest.scope.workspaceId !== manifest.workspaceId) throw new ProviderError('incomplete_snapshot', 'Manifest count/scope does not match the complete data');
  toMs(manifest.snapshotAt);
  validateRelationships(snapshot.records, manifest.workspaceId, manifest.scope.sourceIds, snapshot);
  for (const family of ['zones', 'models']) {
    const ids = snapshot[family].map(item => item.id);
    if (new Set(ids).size !== ids.length) throw new ProviderError('duplicate_id', `Duplicate ${family} identity`);
  }
  for (const zone of snapshot.zones) if (toMs(zone.start) >= toMs(zone.end)) throw new ProviderError('invalid_zone', 'Zone must have positive duration');
  for (const key of ['range', 'overview']) if (toMs(snapshot.settings[key].from) >= toMs(snapshot.settings[key].to)) throw new ProviderError('invalid_range', 'Settings range must be positive');
  if (!snapshot.models.some(model => model.id === snapshot.settings.modelId)) throw new ProviderError('missing_model', 'Selected model is missing');
  toMs(snapshot.settings.referenceTime);
  if (manifest.contentSha256) {
    const actual = await sha256(snapshotContent(snapshot));
    if (actual !== manifest.contentSha256) throw new ProviderError('checksum_mismatch', 'Snapshot integrity check failed');
  }
  return normalizeConfiguration(normalizeSnapshotModels(snapshot), { id: 'local', capabilities: ['*'] });
}

export function normalizedTimes(record) {
  for (const key of ['start', 'end', 'originalStart', 'originalEnd']) if (record[key] != null) record[key] = toIso(toMs(record[key]));
  return record;
}
