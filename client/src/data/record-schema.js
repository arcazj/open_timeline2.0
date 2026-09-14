import Ajv2020 from 'ajv/dist/2020.js';
import { canonicalJson, ProviderError } from './data-provider.js';
import { resolvedDataSchema } from './configuration-catalog.js';

const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false, validateFormats: false, addUsedSchema: false });
const cache = new Map();
const builtIns = { description: 'string', text: 'string', system: 'string', type: 'string', status: 'string', priority: 'number' };

export function validateRecordData(record, snapshot) {
  for (const [field, type] of Object.entries(builtIns)) {
    if (Object.hasOwn(record.data, field) && (typeof record.data[field] !== type || (type === 'number' && !Number.isFinite(record.data[field])))) {
      throw new ProviderError('invalid_record_data', `Built-in data field ${field} must be ${type}`, 422);
    }
  }
  if (record.schemaId == null) {
    if (Object.keys(record.data).some(field => !Object.hasOwn(builtIns, field))) throw new ProviderError('schema_required', 'Custom data fields require a published schema ID and version', 422);
    return record;
  }
  const resource = snapshot?.schemas?.find(item => item.id === record.schemaId);
  const version = resource?.versions.find(item => item.version === record.schemaVersion);
  if (!version || resource.visibility !== 'workspace') throw new ProviderError('schema_reference', 'Record schema must be an available workspace publication', 422);
  const key = canonicalJson(version.definition);
  let validator = cache.get(key);
  if (!validator) {
    validator = ajv.compile(resolvedDataSchema(version.definition));
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(key, validator);
  }
  if (!validator(record.data)) throw new ProviderError('invalid_record_data', 'Record data does not conform to its pinned schema', 422,
    { errors: validator.errors.map(error => ({ path: `/data${error.instancePath}`, code: error.keyword, message: error.message })) });
  return record;
}

export function assertSourceWritable(snapshot, sourceId, operation) {
  const source = snapshot.sources?.find(item => item.id === sourceId);
  if (!source) throw new ProviderError('source_unavailable', 'Record source is unavailable', 422);
  const definition = source.versions.at(-1)?.definition;
  if (!definition?.writable) throw new ProviderError('source_read_only', 'This source is read-only', 403);
  if ((operation === 'create' || operation === 'reassign') && (source.lifecycle === 'archived' || !definition.enabled)) {
    throw new ProviderError('source_disabled', 'This source does not accept new records', 409);
  }
  return definition;
}
