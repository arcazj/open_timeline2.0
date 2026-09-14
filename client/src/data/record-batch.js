import { ProviderError, clone, inspectJson, uuid } from './data-provider.js';
import { MUTABLE_RECORD_FIELDS, patchRecord, recordReplacement } from './record-commands.js';
import { assertSourceWritable } from './record-schema.js';
import { normalizedTimes, validateRecord, validateRelationships, LOCAL_LIMITS } from './snapshot.js';

const mutable = new Set(MUTABLE_RECORD_FIELDS);
export const BATCH_BYTES = 8 * 1024 * 1024;

export function prepareRecordBatch(snapshot, operations, actor = 'local') {
  inspectJson({ operations });
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 500) throw new ProviderError('batch_capacity', 'Batch requires 1 to 500 operations', 413);
  if (new TextEncoder().encode(JSON.stringify({ operations })).length > BATCH_BYTES) throw new ProviderError('batch_capacity', 'Batch request exceeds 8 MiB', 413);
  const records = clone(snapshot.records), byId = new Map(records.map(record => [record.id, record])), seen = new Set(), items = [];
  for (const [index, operation] of operations.entries()) {
    try {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation) || Object.keys(operation).some(key => !['type', 'recordId', 'expectedVersion', 'payload'].includes(key))) throw new ProviderError('invalid_batch', 'Unsupported batch operation fields');
      const type = operation.type;
      if (!['create', 'update', 'replace', 'patch', 'delete', 'restore'].includes(type)) throw new ProviderError('invalid_command', 'Unsupported batch operation');
      let record, payload = clone(operation.payload === undefined ? {} : operation.payload);
      const now = new Date().toISOString();
      if (type === 'create') {
        if (Object.hasOwn(operation, 'recordId') || Object.hasOwn(operation, 'expectedVersion')) throw new ProviderError('immutable_field', 'Create IDs and versions are provider-owned');
        record = { id: uuid(), workspaceId: snapshot.manifest.workspaceId, kind: 'event', title: '', start: now, end: null,
          parentSessionId: null, order: 0, sourceId: snapshot.manifest.scope.sourceIds[0], groupIds: [], tags: [], data: {},
          render: { color: '#39788a' }, extensions: {}, schemaId: null, schemaVersion: null, originalStart: null, originalEnd: null,
          version: 1, createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor, deletedAt: null };
      } else {
        if (typeof operation.recordId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(operation.recordId)) throw new ProviderError('invalid_id', 'Record IDs must be canonical UUIDs');
        if (seen.has(operation.recordId)) throw new ProviderError('duplicate_batch_record', 'A record may occur only once in a batch');
        seen.add(operation.recordId); record = byId.get(operation.recordId);
        if (!record) throw new ProviderError('record_not_found', 'Record does not exist', 404);
        if (!Number.isSafeInteger(operation.expectedVersion)) throw new ProviderError('precondition_required', 'Every existing record requires expectedVersion', 428);
        if (operation.expectedVersion !== record.version) throw new ProviderError('version_conflict', 'A record changed; refresh before retrying', 412);
        if (record.version >= Number.MAX_SAFE_INTEGER) throw new ProviderError('revision_capacity', 'Record version capacity reached', 413);
        if (record.deletedAt && type !== 'restore') throw new ProviderError('record_deleted', 'Record is deleted', 409);
        assertSourceWritable(snapshot, record.sourceId, type);
        if (type === 'patch') payload = patchRecord(record, payload);
        if (type === 'replace') payload = recordReplacement(payload);
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ProviderError('invalid_record', 'Record payload must be an object');
      if (['delete', 'restore'].includes(type)) {
        if (Object.keys(payload).length) throw new ProviderError('invalid_request', 'Delete and restore do not accept record fields');
        if (type === 'restore' && !record.deletedAt) throw new ProviderError('record_not_deleted', 'Only deleted records can be restored', 409);
        record.deletedAt = type === 'delete' ? now : null;
      } else {
        if (Object.keys(payload).some(key => !mutable.has(key))) throw new ProviderError('immutable_field', 'Record identity, versions and audit fields are provider-owned');
        const sourceId = Object.hasOwn(payload, 'sourceId') ? payload.sourceId : record.sourceId;
        const policy = assertSourceWritable(snapshot, sourceId, type === 'create' ? 'create' : sourceId !== record.sourceId ? 'reassign' : 'update');
        if (type === 'create' && !Object.hasOwn(payload, 'schemaId') && !Object.hasOwn(payload, 'schemaVersion') && policy.defaultSchema) Object.assign(payload, { schemaId: policy.defaultSchema.id, schemaVersion: policy.defaultSchema.version });
        if (type !== 'create' && Object.hasOwn(payload, 'kind') && payload.kind !== record.kind) throw new ProviderError('immutable_kind', 'Record kind cannot be changed');
        Object.assign(record, payload);
      }
      if (type !== 'create') { record.version++; record.updatedAt = now; record.updatedBy = actor; }
      normalizedTimes(record); validateRecord(record, snapshot);
      if (record.groupIds.some(id => !snapshot.groups.some(group => group.id === id))) throw new ProviderError('group_unavailable', 'Record group is not in the workspace catalog');
      if (type === 'create') { records.push(record); byId.set(record.id, record); }
      items.push({ index, record });
    } catch (error) {
      if (error instanceof ProviderError) error.errors = [{ index, code: error.code, message: error.message }];
      throw error;
    }
  }
  if (records.length > LOCAL_LIMITS.records) throw new ProviderError('record_limit', 'Local record capacity reached', 413);
  try { validateRelationships(records, snapshot.manifest.workspaceId, snapshot.manifest.scope.sourceIds, snapshot); }
  catch (error) {
    if (error instanceof ProviderError) error.errors = [{ index: null, code: error.code, message: 'The final batch would leave an invalid parent relationship' }];
    throw error;
  }
  return { records, items };
}
