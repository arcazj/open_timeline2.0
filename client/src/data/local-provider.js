import { ProviderError, abortIfNeeded, clone, freeze, uuid, sha256, canonicalJson } from './data-provider.js';
import { validateSnapshot, validateRecord, validateRelationships, normalizedTimes, LOCAL_LIMITS } from './snapshot.js';
import { createQueryDataAsync } from './query-core.js';
import { scopedQueryCounts } from './query-relationships.js';
import { compileExpression, compileSearch, createRegexBudget } from './filter-expression.js';
import queryCapabilities from '../../../shared/query-capabilities.json' with { type: 'json' };
import { migrateLegacyFilter } from './legacy-filter-migration.js';
import { buildLayout } from '../timeline/layout.js';
import { toMs } from '../timeline/time-scale.js';
import { validateDefinition, findModel, modelUsage, applyModelCommand } from './model-catalog.js';
import { normalizeTableInput, buildRecordTable } from './record-table.js';
import { createCursorKey, sealCursor, openCursor } from './query-cursor.js';
import { CONFIGURATION_FAMILIES, normalizeConfiguration, applyConfigurationCommand, validateResourceDefinition, configurationUsage as usageGraph, effectiveSettings } from './configuration-catalog.js';
import { configurationResource, configurationActions, configurationReadable, configurationSummary, compareConfigurationNames } from './configuration-access.js';
import { applySettingsCommand } from './settings-commands.js';
import { assertSourceWritable, validateRecordData } from './record-schema.js';
import { snapshotContent } from './snapshot-content.js';
import { prepareRecordBatch } from './record-batch.js';

import { MUTABLE_RECORD_FIELDS, patchRecord, recordReplacement, partialUpdatePatch } from './record-commands.js';
const MUTABLE = new Set(MUTABLE_RECORD_FIELDS);
const assertCommandId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ProviderError('invalid_command_id', 'Invalid command identity', 422);
};

export class LocalProvider {
  constructor(snapshot) {
    this.input = snapshot;
    this.identity = `local:${uuid()}`;
    this.generation = uuid();
    this.revision = 1;
    this.queries = new Map();
    this.listeners = new Set();
    this.outcomes = new Map();
    this.impacts = new Map();
    this.disposed = false;
    this.modified = false;
    this.queue = Promise.resolve();
    this.actor = Object.freeze({ id: 'local', name: 'Local author', verified: false, capabilities: ['*'] });
  }

  async initialize(options = {}) {
    this._assert();
    abortIfNeeded(options.signal);
    if (!this.snapshot) {
      const snapshot = await validateSnapshot(this.input);
      this._assert();
      abortIfNeeded(options.signal);
      const localPrincipal = snapshot.manifest.localPreferencesPrincipalId;
      if (localPrincipal !== undefined) {
        if (typeof localPrincipal !== 'string' || !localPrincipal.trim() || [...localPrincipal].length > 128) throw new ProviderError('invalid_snapshot', 'Local preference principal must be a bounded nonempty string', 422);
        this.actor = Object.freeze({ ...this.actor, id: localPrincipal });
      }
      this.snapshot = freeze(snapshot);
      this.legacyImportedIds = Object.fromEntries(['filters', 'views'].map(family => {
        const owned = new Set(snapshot.manifest.legacy?.preferencesCatalogIds?.[family] ?? []);
        return [family, new Set(snapshot[family].filter(resource => !owned.has(resource.id)).map(resource => resource.id))];
      }));
      this.input = null;
    }
    return this.getStatus();
  }

  _assert() { if (this.disposed) throw new ProviderError('provider_disposed', 'Source is no longer active', 409); }

  _legacyReadOnly() { return this.snapshot?.manifest.legacy?.readOnly === true; }

  _legacyPreferencesEnabled() { return this._legacyReadOnly() && this.snapshot.manifest.legacy.preferencesEnabled === true; }

  _configurationActions(family, resource) {
    if (!this._legacyReadOnly()) return configurationActions(resource, this.actor, family);
    if (!this._legacyPreferencesEnabled() || !['filters', 'views'].includes(family)) return [];
    const actions = configurationActions(resource, this.actor, family);
    return this.legacyImportedIds[family].has(resource.id) ? actions.filter(action => ['duplicate', 'apply'].includes(action)) : actions;
  }

  _assertConfigurationWritable(kind, command) {
    if (!this._legacyReadOnly()) return;
    if (!this._legacyPreferencesEnabled()) return this._assertWritable();
    if (kind === 'settings') return;
    if (!['filters', 'views'].includes(command.family)) throw new ProviderError('legacy_read_only', 'Only app-owned filters and views can be changed; legacy data and models remain read-only.', 403);
    if (this.legacyImportedIds[command.family].has(command.resourceId) && !['duplicate', 'apply'].includes(command.type)) throw new ProviderError('legacy_read_only', 'Duplicate an imported legacy definition before editing it.', 403);
  }

  _assertWritable() {
    if (this._legacyReadOnly()) throw new ProviderError('legacy_read_only', 'Legacy snapshots are read-only; records, models and configuration cannot be changed.', 403);
  }

  async getStatus() {
    this._assert();
    if (!this.snapshot) throw new ProviderError('not_initialized', 'Initialize the source first', 409);
    const m = this.snapshot.manifest;
    const effective = effectiveSettings(this.snapshot, { principalId: this.actor.id });
    const readOnly = this._legacyReadOnly();
    const preferences = this._legacyPreferencesEnabled();
    const actor = readOnly ? { ...this.actor, name: preferences ? 'Local preferences author' : 'Local reader', capabilities: ['records.read', 'configuration.read', 'export', ...(preferences ? ['configuration.personal'] : [])] } : this.actor;
    return clone({ identity: this.identity, providerId: this.identity, sourceName: m.sourceName, sourceKind: m.sourceKind === 'sample' ? 'sample' : 'local', workspaceId: m.workspaceId, generation: this.generation, revision: this.revision, snapshotAt: m.snapshotAt, origin: m, ...(m.legacy ? { legacy: m.legacy } : {}), ...(preferences ? { preferencesDurability: 'memory-only' } : {}), recordCount: this.snapshot.records.filter(r => !r.deletedAt).length, completeness: m.completeness, modified: this.modified, durability: readOnly ? 'read-only-snapshot' : 'memory-only', settings: effective.values, preferenceRevision: effective.preferenceRevision, defaultsRevision: this.snapshot.defaults.revision, actor: { ...actor, sourceIds: m.scope.sourceIds }, models: this.snapshot.models, sourceIds: m.scope.sourceIds, capabilities: { query: queryCapabilities, recordCrud: !readOnly, importExport: true, modelManagement: !readOnly, modelPublication: !readOnly, configurationManagement: !readOnly || preferences, serverAdministration: false, limits: LOCAL_LIMITS } });
  }

  _query(id) {
    this._assert();
    const query = this.queries.get(id);
    if (!query || Date.now() > query.expiresAt) {
      this.queries.delete(id);
      throw new ProviderError('snapshot_expired', 'Query expired or belongs to another source', 409);
    }
    return query;
  }

  async createQuery(input, options = {}) {
    this._assert(); abortIfNeeded(options.signal);
    for (const [id, query] of this.queries) if (Date.now() > query.expiresAt) this.queries.delete(id);
    if (this.queries.size + (this.pendingQueries ?? 0) >= 2) throw new ProviderError('query_capacity', 'Release an old query before creating another', 429);
    const snapshot = this.snapshot, revision = this.revision, generation = this.generation;
    this.pendingQueries = (this.pendingQueries ?? 0) + 1;
    try {
      const data = await createQueryDataAsync(snapshot, clone(input), { signal: options.signal });
      this._assert(); abortIfNeeded(options.signal);
      const queryId = uuid();
      const manifest = { queryId, snapshotId: uuid(), mapId: data.map.mapId, providerId: this.identity, generation, revision, baseTotal: data.records.length, matchTotal: data.matches.size, overviewTotal: data.overviewRecords.length, overviewMatchTotal: data.overviewRecords.filter(r => data.matches.has(r.id)).length, fieldTypes: data.fieldTypes, state: 'ready' };
      if (data.definitionVersion === 2) Object.assign(manifest, { definitionVersion: 2, relationshipMode: data.relationshipMode,
        baseTotal: data.eligibleIds.size, counts: scopedQueryCounts(data, data.map.domain, revision, generation, data.density.complete) });
      this.queries.set(queryId, { ...data, manifest, layouts: new Map(), tables: new Map(), expiresAt: Date.now() + 300000 });
      return clone(manifest);
    } finally { this.pendingQueries--; }
  }

  async getQuery(id) { return clone(this._query(id).manifest); }
  async migrateLegacyFilter(queryId, input, options = {}) {
    const query = this._query(queryId); abortIfNeeded(options.signal);
    return clone({ ...migrateLegacyFilter(input, { fieldTypes: query.fieldTypes }), scope: {
      queryId, generation: query.manifest.generation, revision: query.manifest.revision, domain: query.map.domain, complete: query.density.complete,
    } });
  }
  async findMatch(queryId, input = {}, options = {}) {
    const query = this._query(queryId); abortIfNeeded(options.signal);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['afterId', 'direction'].includes(key)) ||
        !['next', 'previous'].includes(input.direction ?? 'next') || (input.afterId != null && (typeof input.afterId !== 'string' || input.afterId.length > 128))) throw new ProviderError('invalid_find', 'Specify a finding identity and next or previous direction', 422);
    const records = query.hasSearch ? query.records.filter(record => query.matches.has(record.id)).sort((a, b) => toMs(a.start) - toMs(b.start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : [];
    const current = records.findIndex(record => record.id === input.afterId), previous = input.direction === 'previous';
    const next = current < 0 ? (previous ? records.length - 1 : 0) : current + (previous ? -1 : 1);
    const index = records.length ? (next + records.length) % records.length : -1;
    return clone({ queryId, record: index < 0 ? null : records[index], position: index + 1, total: records.length, wrapped: current >= 0 && (next < 0 || next >= records.length) });
  }
  async getQueryRecord(queryId, recordId, options = {}) {
    const query = this._query(queryId); abortIfNeeded(options.signal);
    const byId = new Map([...query.records, ...(query.contextRecords || [])].map(record => [record.id, record]));
    const record = byId.get(recordId);
    if (!record) throw new ProviderError('record_not_found', 'Record is not available in this query', 404);
    const ancestors = [];
    let parent = byId.get(record.parentSessionId);
    while (parent && ancestors.length < 32) {
      const { id, title, kind, start, end } = parent;
      ancestors.push({ id, title, kind, start, end }); parent = byId.get(parent.parentSessionId);
    }
    let explanation;
    if (query.explanationDefinition) {
      const regexBudget = createRegexBudget({ signal: options.signal }), settings = { fieldTypes: query.fieldTypes, regexBudget };
      const compiled = query.explanationDefinition.expressions.map(expression => compileExpression(expression, settings));
      if (query.hasSearch && query.matches.has(recordId)) compiled.push(compileSearch(query.explanationDefinition.search, settings));
      const reports = compiled.filter(item => typeof item.explain === 'function').map(item => item.explain(record));
      const rules = reports.flatMap(report => report.rules);
      explanation = { rules: rules.slice(0, 16), truncated: rules.length > 16 || reports.some(report => report.truncated) };
    }
    return clone({ record, ancestors, ancestorsTruncated: !!parent, searchActive: query.hasSearch,
      ...(explanation ? { explanation } : {}), ...(query.provenance ? { provenance: query.provenance[recordId] } : {}) });
  }
  async getDensity(id) { return clone(this._query(id).density); }
  async getMap(id, mapId) {
    const map = this._query(id).map;
    if (mapId && mapId !== map.mapId) throw new ProviderError('map_mismatch', 'Map does not belong to query', 409);
    return clone(map);
  }
  async getZones(id) {
    const query = this._query(id);
    const from = toMs(query.map.domain.from);
    const to = toMs(query.map.domain.to);
    return clone({ items: query.zones.filter(zone => toMs(zone.start) < to && toMs(zone.end) > from) });
  }

  async getOverview(id) {
    const query = this._query(id);
    const records = query.overviewRecords.filter(r => !query.hasSearch || query.matches.has(r.id));
    if (records.length > 1000) {
      const cells = query.overviewBins.map(bin => ({ ...bin, count: query.hasSearch ? bin.matched : bin.total }));
      return { items: cells.filter(c => c.count).map(c => ({ id: `aggregate:${c.from}`, kind: 'session', start: new Date(c.from).toISOString(), end: new Date(c.to).toISOString(), color: '#557a88', title: `${c.count} records`, count: c.count })), total: query.overviewRecords.length, matched: query.overviewRecords.filter(r => query.matches.has(r.id)).length, matchActive: query.hasSearch, aggregated: true, domain: clone(query.map.domain) };
    }
    return { items: records.map(r => ({ id: r.id, kind: r.kind, start: r.start, end: r.end, color: r.render?.color ?? '#39788a', title: r.title, sourceId: r.sourceId, render: clone(r.render ?? {}) })), total: query.overviewRecords.length, matched: query.overviewRecords.filter(r => query.matches.has(r.id)).length, matchActive: query.hasSearch, aggregated: false, domain: clone(query.map.domain) };
  }

  async createLayout(queryId, input, options = {}) {
    const query = this._query(queryId); abortIfNeeded(options.signal);
    input = this._versionedInput(query, input);
    if (input.mapId && input.mapId !== query.map.mapId) throw new ProviderError('map_mismatch', 'Map belongs to a different query', 409);
    if (query.layouts.size >= 2) throw new ProviderError('layout_capacity', 'Release an old layout before creating another', 429);
    const layout = buildLayout(query.records, query.map, input, query.matches);
    if (query.provenance) for (const item of layout.items) item.provenance = query.provenance[item.record.id];
    abortIfNeeded(options.signal);
    const layoutId = uuid();
    const manifest = { layoutId, mapId: query.map.mapId, totalRows: layout.totalRows, detailTotal: layout.detailTotal, detailMatchTotal: layout.detailMatchTotal, renderInstanceTotal: layout.renderInstanceTotal, rowHeight: layout.rowHeight, pageCapacity: layout.pageCapacity, from: layout.from, to: layout.to, width: layout.width };
    if (query.definitionVersion === 2) Object.assign(manifest, { definitionVersion: 2, logicalGroupTotal: layout.logicalGroupTotal, collapsedGroupTotal: layout.collapsedGroupTotal, hiddenItemTotal: layout.hiddenItemTotal });
    if (layout.presentation) manifest.presentation = layout.presentation;
    query.layouts.set(layoutId, { ...layout, manifest, cursors: new Map() });
    return clone(manifest);
  }

  _layout(queryId, layoutId) {
    const layout = this._query(queryId).layouts.get(layoutId);
    if (!layout) throw new ProviderError('layout_expired', 'Layout expired or belongs to another query', 409);
    return layout;
  }

  async getLayout(queryId, layoutId) { return clone(this._layout(queryId, layoutId).manifest); }

  async getRows(queryId, layoutId, options = {}) {
    const layout = this._layout(queryId, layoutId); abortIfNeeded(options.signal);
    let startRow = 0;
    if (options.cursor) {
      if (!layout.cursors.has(options.cursor)) throw new ProviderError('cursor_mismatch', 'Cursor is stale or incompatible', 409);
      startRow = layout.cursors.get(options.cursor);
    }
    const endRow = Math.min(layout.totalRows, startRow + layout.pageCapacity);
    const items = layout.items.filter(item => item.row >= startRow && item.row < endRow);
    const enclosureData = layout.enclosures ? { enclosures: layout.enclosures.filter(enclosure => enclosure.startRow < endRow && enclosure.endRow > startRow).map(enclosure => ({ ...enclosure, visibleStartRow: Math.max(startRow, enclosure.startRow), visibleEndRow: Math.min(endRow, enclosure.endRow), continuedBefore: enclosure.startRow < startRow, continuedAfter: enclosure.endRow > endRow })) } : {};
    if (items.length > 1000 || new TextEncoder().encode(JSON.stringify({ items, ...enclosureData })).length > 2 * 1024 * 1024) throw new ProviderError('row_payload_limit', 'This row range exceeds the first-slice payload limit; reduce row capacity', 413);
    const cursor = row => this._cursor(layout, row);
    return clone({ ...layout.manifest, items, ...enclosureData, rows: layout.rows.filter(row => row.row >= startRow && row.row < endRow), startRow, endRow, pageIndex: Math.floor(startRow / layout.pageCapacity), pageCount: Math.max(1, Math.ceil(layout.totalRows / layout.pageCapacity)), previousCursor: startRow > 0 ? cursor(Math.max(0, startRow - layout.pageCapacity)) : null, nextCursor: endRow < layout.totalRows ? cursor(endRow) : null, pageComplete: true, loadedCount: items.length });
  }

  async getPlacement(queryId, layoutId, recordId) {
    const layout = this._layout(queryId, layoutId);
    const item = layout.items.find(candidate => candidate.record.id === recordId);
    if (!item) return { outsideLayout: true, recordId };
    const start = Math.floor(item.row / layout.pageCapacity) * layout.pageCapacity;
    const cursor = this._cursor(layout, start);
    return { recordId, row: item.row, cursor, outsideLayout: false };
  }

  _cursor(layout, row) {
    for (const [token, position] of layout.cursors) if (position === row) return token;
    const token = uuid();
    layout.cursors.set(token, row);
    return token;
  }

  async getRecord(id, options = {}) {
    this._assert(); abortIfNeeded(options.signal);
    const record = this.snapshot.records.find(r => r.id === id);
    if (!record || (record.deletedAt && !options.includeDeleted)) throw new ProviderError('record_not_found', 'Record is unavailable', 404);
    return clone(record);
  }

  async queryRecords(queryId, input = {}, options = {}) {
    const query = this._query(queryId); abortIfNeeded(options.signal);
    input = this._versionedInput(query, input);
    const parameters = normalizeTableInput(input, query.map.domain, query.fieldTypes), key = canonicalJson(parameters);
    const fingerprint = await sha256(key);
    query.tableCursorKey ??= createCursorKey();
    const cursorKey = await query.tableCursorKey;
    let page = 0;
    if (input.cursor) {
      const saved = await openCursor(input.cursor, cursorKey);
      if (saved.key !== fingerprint || !Number.isSafeInteger(saved.page) || saved.page < 0) throw new ProviderError('invalid_table_cursor', 'Table cursor belongs to another sort or scope', 400);
      page = saved.page;
    }
    let table = query.tables.get(key);
    if (!table) {
      table = { ...buildRecordTable(query, parameters), tableId: fingerprint };
      abortIfNeeded(options.signal); this._query(queryId);
      if (query.tables.size >= 2) query.tables.delete(query.tables.keys().next().value);
      query.tables.set(key, table);
    }
    const pageCount = Math.max(1, table.boundaries.length - 1);
    if (page >= pageCount) throw new ProviderError('invalid_table_cursor', 'Table cursor is outside the result', 400);
    const startIndex = table.boundaries[page] ?? 0, endIndex = table.boundaries[page + 1] ?? 0;
    const cursor = index => sealCursor({ key: fingerprint, page: index }, cursorKey);
    const previousCursor = page > 0 ? await cursor(page - 1) : null, nextCursor = page + 1 < pageCount ? await cursor(page + 1) : null;
    abortIfNeeded(options.signal); this._query(queryId);
    return clone({ queryId, snapshotId: query.manifest.snapshotId, generation: query.manifest.generation, revision: query.manifest.revision,
      tableId: table.tableId, ...parameters, total: table.total, baseTotal: table.baseTotal, matchTotal: table.matchTotal, matchActive: table.matchActive,
      ...(query.definitionVersion === 2 ? { contextTotal: table.contextTotal } : {}),
      items: table.items.slice(startIndex, endIndex), startIndex, endIndex, pageIndex: page, pageCount,
      previousCursor, nextCursor, pageComplete: true });
  }

  _versionedInput(query, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProviderError('invalid_query', 'Query input must be an object', 422);
    if (input.definitionVersion !== undefined && input.definitionVersion !== (query.definitionVersion || 1)) throw new ProviderError('query_definition_mismatch', 'Layout and table definition must match the pinned query', 409);
    return query.definitionVersion === 2 ? { ...input, definitionVersion: 2 } : input;
  }

  executeCommand(command, options = {}) {
    const queuedCommand = clone(command), queuedOptions = { ...options };
    const operation = this.queue.then(() => this._execute(queuedCommand, queuedOptions));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async _execute(command, options) {
    this._assert(); abortIfNeeded(options.signal);
    this._assertWritable();
    if (!command.generation) throw new ProviderError('precondition_required', 'Source generation is required', 428);
    if (command.generation !== this.generation) throw new ProviderError('generation_mismatch', 'Draft belongs to a different source generation', 409);
    if (!command.clientCommandId) throw new ProviderError('idempotency_required', 'Client command identity is required', 428);
    assertCommandId(command.clientCommandId);
    const fingerprint = canonicalJson(command);
    const prior = this.outcomes.get(command.clientCommandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new ProviderError('idempotency_conflict', 'Command identity was reused with different content', 409);
      return clone(prior.result);
    }
    if (!Number.isSafeInteger(this.revision) || this.revision >= Number.MAX_SAFE_INTEGER) throw new ProviderError('revision_capacity', 'Workspace revision capacity reached', 413);
    const records = clone(this.snapshot.records);
    const now = new Date().toISOString();
    let payload = clone(command.payload === undefined ? {} : command.payload);
    if (command.type !== 'patch') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ProviderError('invalid_record', 'Record payload must be an object');
      for (const key of Object.keys(payload)) if (!MUTABLE.has(key)) throw new ProviderError('immutable_field', `Field ${key} cannot be assigned`);
    }
    let record;
    if (command.type === 'create') {
      if (records.length >= LOCAL_LIMITS.records) throw new ProviderError('record_limit', 'Local record capacity reached', 413);
      const policy = assertSourceWritable(this.snapshot, payload.sourceId ?? this.snapshot.manifest.scope.sourceIds[0] ?? 'default', 'create');
      if (policy.defaultSchema && payload.schemaId === undefined && payload.schemaVersion === undefined) Object.assign(payload, { schemaId: policy.defaultSchema.id, schemaVersion: policy.defaultSchema.version });
      record = { id: uuid(), workspaceId: this.snapshot.manifest.workspaceId, kind: 'event', title: '', start: now, end: null, parentSessionId: null, order: 0, sourceId: this.snapshot.manifest.scope.sourceIds[0] ?? 'default', groupIds: [], tags: [], data: {}, render: { color: '#39788a' }, extensions: {}, schemaId: null, schemaVersion: null, originalStart: null, originalEnd: null, ...payload, version: 1, createdAt: now, updatedAt: now, createdBy: 'local', updatedBy: 'local', deletedAt: null };
      records.push(record);
    } else {
      record = records.find(r => r.id === command.recordId);
      if (!record || (record.deletedAt && command.type !== 'restore')) throw new ProviderError('record_not_found', 'Record is unavailable', 404);
      assertSourceWritable(this.snapshot, record.sourceId, command.type);
      if (command.expectedVersion == null) throw new ProviderError('precondition_required', 'Expected record version is required', 428);
      if (record.version !== command.expectedVersion) throw new ProviderError('record_version_conflict', 'Record changed; retain your draft and reload', 412);
      if (record.version >= Number.MAX_SAFE_INTEGER) throw new ProviderError('revision_capacity', 'Record revision capacity reached', 413);
      if (command.type === 'update') payload = patchRecord(record, partialUpdatePatch(payload));
      if (command.type === 'patch') payload = patchRecord(record, payload);
      if (command.type === 'replace') payload = recordReplacement(payload);
      if (['delete', 'restore'].includes(command.type) && Object.keys(payload).length) throw new ProviderError('invalid_record', 'Delete and restore do not accept record fields', 422);
      if (payload.sourceId !== undefined && payload.sourceId !== record.sourceId) assertSourceWritable(this.snapshot, payload.sourceId, 'reassign');
      if (['update', 'replace', 'patch'].includes(command.type)) {
        if (Object.hasOwn(payload, 'kind') && payload.kind !== record.kind) throw new ProviderError('immutable_kind', 'Record kind is immutable');
        Object.assign(record, payload);
      } else if (command.type === 'delete') {
        if (records.some(r => r.parentSessionId === record.id && !r.deletedAt)) throw new ProviderError('active_children', 'Delete or reassign active children first', 409);
        record.deletedAt = now;
      } else if (command.type === 'restore') {
        if (!record.deletedAt) throw new ProviderError('record_not_deleted', 'Only deleted records can be restored', 409);
        record.deletedAt = null;
      }
      else throw new ProviderError('unsupported_command', 'Unsupported command type');
      record.version++;
      record.updatedAt = now;
      record.updatedBy = 'local';
    }
    normalizedTimes(record);
    validateRecord(record, this.snapshot);
    if (record.groupIds.some(id => !this.snapshot.groups.some(group => group.id === id))) throw new ProviderError('group_unavailable', 'Record group is not in the workspace catalog', 422);
    validateRelationships(records, this.snapshot.manifest.workspaceId, this.snapshot.manifest.scope.sourceIds, this.snapshot);
    abortIfNeeded(options.signal);
    const manifest = { ...this.snapshot.manifest, recordCount: records.length };
    delete manifest.contentSha256;
    const candidate = { ...this.snapshot, records, manifest };
    if (new TextEncoder().encode(JSON.stringify(candidate)).length > LOCAL_LIMITS.bundleBytes) throw new ProviderError('snapshot_size_limit', 'Record change would exceed the Local snapshot limit', 413);
    this.snapshot = freeze(candidate);
    this.revision++;
    this.modified = true;
    const result = { record: clone(record), durability: 'memory-only', generation: this.generation, revision: this.revision };
    this.outcomes.set(command.clientCommandId, { fingerprint, result: clone(result) });
    for (const listener of this.listeners) { try { listener({ type: 'changed', generation: this.generation, revision: this.revision }); } catch { /* Observer errors cannot roll back an accepted command. */ } }
    return result;
  }

  async getCommandOutcome(id) {
    this._assert();
    return this.outcomes.has(id) ? { state: 'committed', result: clone(this.outcomes.get(id).result) } : { state: 'not-found' };
  }

  executeBatch(command, options = {}) {
    const intent = clone(command), pendingOptions = { ...options };
    const operation = this.queue.then(() => this._executeBatch(intent, pendingOptions));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async _executeBatch(command, options) {
    this._assert(); abortIfNeeded(options.signal);
    this._assertWritable();
    if (!command.generation || !command.clientCommandId) throw new ProviderError('precondition_required', 'Batch requires generation and command identity', 428);
    assertCommandId(command.clientCommandId);
    if (command.generation !== this.generation) throw new ProviderError('generation_mismatch', 'Batch belongs to another source generation', 409);
    if (Object.keys(command).some(key => !['generation', 'clientCommandId', 'operations'].includes(key))) throw new ProviderError('invalid_batch', 'Unsupported batch command fields');
    const fingerprint = canonicalJson({ kind: 'record-batch', command }), prior = this.outcomes.get(command.clientCommandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new ProviderError('idempotency_conflict', 'Command identity was reused with different content', 409);
      return clone(prior.result);
    }
    if (this.revision >= Number.MAX_SAFE_INTEGER) throw new ProviderError('revision_capacity', 'Workspace revision capacity reached', 413);
    const { records, items } = prepareRecordBatch(this.snapshot, command.operations, this.actor.id);
    const manifest = { ...this.snapshot.manifest, recordCount: records.length }; delete manifest.contentSha256;
    const candidate = { ...this.snapshot, records, manifest };
    if (new TextEncoder().encode(JSON.stringify(candidate)).length > LOCAL_LIMITS.bundleBytes) throw new ProviderError('snapshot_size_limit', 'Batch would exceed the Local snapshot limit', 413);
    abortIfNeeded(options.signal);
    this.snapshot = freeze(candidate); this.revision++; this.modified = true;
    const result = { status: 'committed', commandId: command.clientCommandId, generation: this.generation,
      revision: this.revision, affectedCount: items.length, items: clone(items), durability: 'memory-only' };
    this.outcomes.set(command.clientCommandId, { fingerprint, result: clone(result) });
    for (const listener of this.listeners) { try { listener({ type: 'changed', generation: this.generation, revision: this.revision }); } catch { /* Observers cannot undo a commit. */ } }
    return result;
  }

  async listModels(options = {}) {
    this._assert(); abortIfNeeded(options.signal);
    return clone({ items: this.snapshot.models.filter(model => options.includeArchived !== false || model.lifecycle !== 'archived'), active: { modelId: this.snapshot.settings.modelId, version: this.snapshot.settings.modelVersion }, generation: this.generation, revision: this.revision });
  }

  async getModel(id, options = {}) {
    this._assert(); abortIfNeeded(options.signal);
    const model = findModel(this.snapshot.models, id);
    return clone({ model, usage: modelUsage(this.snapshot.settings, id), generation: this.generation, revision: this.revision });
  }

  async validateModel(definition, options = {}) {
    this._assert(); abortIfNeeded(options.signal);
    return validateDefinition(definition);
  }

  _configurationEnvelope(family) { return { family, generation: this.generation, revision: this.revision }; }

  async listConfiguration(family, input = {}, options = {}) {
    this._assert(); abortIfNeeded(options.signal);
    if (!CONFIGURATION_FAMILIES.includes(family)) throw new ProviderError('invalid_configuration', 'Unknown configuration family', 422);
    const items = this.snapshot[family].filter(resource => configurationReadable(resource, this.actor) && (input.includeArchived !== false || resource.lifecycle !== 'archived'))
      .map(resource => ({ ...configurationSummary(resource, this.actor, family), allowedActions: this._configurationActions(family, resource) })).sort(compareConfigurationNames);
    return { ...this._configurationEnvelope(family), items, total: items.length };
  }

  async getConfiguration(family, id, options = {}) {
    this._assert(); abortIfNeeded(options.signal);
    const resource = configurationResource(this.snapshot, family, id, this.actor);
    return { ...this._configurationEnvelope(family), resource: clone(resource), allowedActions: this._configurationActions(family, resource) };
  }

  async validateConfiguration(family, definition, context = {}, options = {}) {
    this._assert(); abortIfNeeded(options.signal);
    if (Object.keys(context).some(key => !['resourceId', 'visibility'].includes(key))) throw new ProviderError('invalid_configuration', 'Unknown validation context', 422);
    const resource = context.resourceId ? configurationResource(this.snapshot, family, context.resourceId, this.actor) : null;
    return validateResourceDefinition(family, definition, { snapshot: this.snapshot, actor: this.actor,
      ownerId: resource?.ownerId ?? this.actor.id, visibility: context.visibility ?? resource?.visibility ?? 'personal', newReference: true });
  }

  async configurationUsage(family, id, version, options = {}) {
    this._assert(); abortIfNeeded(options.signal);
    configurationResource(this.snapshot, family, id, this.actor);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ProviderError('invalid_page', 'Usage limit must be 1-1000', 422);
    const signature = canonicalJson({ family, id, version: version ?? null, revision: this.revision, generation: this.generation });
    if (options.cursor && this.configurationCursors?.get(options.cursor)?.signature !== signature) throw new ProviderError('cursor_mismatch', 'Usage changed; reload references', 409);
    const offset = options.cursor ? this.configurationCursors.get(options.cursor).offset : 0;
    const items = usageGraph(this.snapshot, family, id, version), end = Math.min(items.length, offset + limit);
    let nextCursor = null;
    if (end < items.length) {
      this.configurationCursors ??= new Map();
      if (this.configurationCursors.size >= 256) this.configurationCursors.delete(this.configurationCursors.keys().next().value);
      nextCursor = uuid(); this.configurationCursors.set(nextCursor, { signature, offset: end });
    }
    return { ...this._configurationEnvelope(family), items: clone(items.slice(offset, end)), total: items.length, deletionBlocked: items.length > 0, nextCursor };
  }

  async getEffectiveSettings(input = {}, options = {}) {
    this._assert(); abortIfNeeded(options.signal);
    if (Object.keys(input).some(key => !['viewId', 'viewVersion', 'transient'].includes(key))) throw new ProviderError('invalid_settings', 'Unknown effective settings input', 422);
    return { generation: this.generation, revision: this.revision, principalId: this.actor.id, defaultsRevision: this.snapshot.defaults.revision,
      ...effectiveSettings(this.snapshot, { ...input, principalId: this.actor.id }) };
  }

  mutateConfiguration(command, options = {}) { return this._queueConfiguration('configuration', command, options); }
  mutateSettings(command, options = {}) { return this._queueConfiguration('settings', command, options); }

  _queueConfiguration(kind, input, options) {
    const command = clone(input), queuedOptions = { ...options };
    const operation = this.queue.then(() => this._executeConfiguration(kind, command, queuedOptions));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async _executeConfiguration(kind, command, options) {
    this._assert(); abortIfNeeded(options.signal);
    this._assertConfigurationWritable(kind, command);
    if (!command.generation || !command.clientCommandId) throw new ProviderError('precondition_required', 'Source generation and command identity are required', 428);
    assertCommandId(command.clientCommandId);
    if (command.generation !== this.generation) throw new ProviderError('generation_mismatch', 'Command belongs to a different source generation', 409);
    const fingerprint = canonicalJson({ kind, command }), prior = this.outcomes.get(command.clientCommandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new ProviderError('idempotency_conflict', 'Command identity was reused with different content', 409);
      return clone(prior.result);
    }
    if (this.revision >= Number.MAX_SAFE_INTEGER) throw new ProviderError('revision_capacity', 'Workspace revision capacity reached', 413);
    const input = { ...this.snapshot, manifest: { ...this.snapshot.manifest, generation: this.generation } };
    const next = kind === 'configuration' ? applyConfigurationCommand(input, command, { actor: this.actor }) : applySettingsCommand(input, command, this.actor);
    const candidate = normalizeConfiguration(next.snapshot, this.actor);
    if (this._legacyPreferencesEnabled()) {
      const revision = (this.snapshot.manifest.preferencesRevision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new ProviderError('revision_capacity', 'Preferences revision capacity reached', 413);
      candidate.manifest.preferencesRevision = revision;
      candidate.manifest.legacy = { ...candidate.manifest.legacy, preferencesSource: 'local-memory', preferencesRevision: revision,
        ...(this.snapshot.manifest.legacy.preferencesSource === 'application-json' ? { serverPreferencesRevision: this.snapshot.manifest.legacy.preferencesRevision ?? 0 } : {}),
        preferencesCatalogIds: Object.fromEntries(['filters', 'views'].map(family => [family, candidate[family].filter(resource => !this.legacyImportedIds[family].has(resource.id)).map(resource => resource.id)])) };
    }
    if (new TextEncoder().encode(JSON.stringify(candidate)).length > LOCAL_LIMITS.bundleBytes) throw new ProviderError('snapshot_size_limit', 'Configuration would exceed the Local snapshot limit', 413);
    abortIfNeeded(options.signal); this._assert();
    this.snapshot = freeze(candidate); this.revision++; this.modified = true; this.configurationCursors?.clear();
    const result = { status: 'committed', durability: 'memory', commandId: command.clientCommandId, generation: this.generation, revision: this.revision,
      ...(kind === 'configuration' ? { family: command.family, resource: clone(next.resource) } : { settings: clone(next.settings) }),
      ...(next.effectiveSettings ? { effectiveSettings: clone(next.effectiveSettings) } : {}), ...(next.resetTransientKeys ? { resetTransientKeys: clone(next.resetTransientKeys) } : {}) };
    this.outcomes.set(command.clientCommandId, { fingerprint, result: clone(result) });
    for (const listener of this.listeners) { try { listener({ type: 'configuration-changed', generation: this.generation, revision: this.revision }); } catch { /* Observers do not participate in commits. */ } }
    return result;
  }

  async previewSchemaImpact(schemaId, input, options = {}) {
    this._assert(); abortIfNeeded(options.signal);
    input = clone(input);
    const resource = configurationResource(this.snapshot, 'schemas', schemaId, this.actor);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProviderError('invalid_request', 'Request body must be a JSON object', 400);
    if (Object.keys(input).some(key => !['version', 'definition', 'limit', 'cursor'].includes(key)) || Object.hasOwn(input, 'version') === Object.hasOwn(input, 'definition')) throw new ProviderError('invalid_configuration', 'Choose one candidate definition or version', 422);
    if (Object.hasOwn(input, 'version') && !Number.isSafeInteger(input.version)) throw new ProviderError('invalid_configuration', 'Impact version must be an integer', 422);
    const definition = Object.hasOwn(input, 'definition') ? input.definition : resource.versions.find(item => item.version === input.version)?.definition;
    if (definition === undefined) throw new ProviderError('configuration_version_unavailable', 'Schema publication is unavailable', 409);
    const validation = validateResourceDefinition('schemas', definition);
    if (!validation.valid) throw new ProviderError('invalid_configuration_definition', 'Impact schema is invalid', 422, { errors: validation.errors });
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || input.limit === null) throw new ProviderError('invalid_configuration', 'Impact limit must be 1-1000', 422);
    const signature = canonicalJson({ schemaId, definition, generation: this.generation });
    const binding = { kind: 'impact', scope: this.identity, signature, limit };
    let analysis, analysisId, offset = 0;
    if (input.cursor) {
      let cursor;
      try {
        cursor = await openCursor(input.cursor, await this.impactCursorKey);
      } catch { throw new ProviderError('invalid_cursor', 'Configuration cursor is invalid', 400); }
      analysisId = cursor.analysisId; analysis = this.impacts.get(analysisId);
      if (!analysis || Object.entries(binding).some(([key, value]) => cursor[key] !== value) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= analysis.items.length) throw new ProviderError('stale_cursor', 'Impact analysis expired or its inputs changed', 409);
      offset = cursor.offset;
    } else {
      const probe = { schemas: [{ ...resource, visibility: 'workspace', versions: [{ version: 1, definition }] }] };
      const affected = this.snapshot.records.filter(record => record.schemaId === schemaId).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const items = affected.map(record => {
        let errors = [];
        try { validateRecordData({ ...record, schemaVersion: 1 }, probe); }
        catch (error) { errors = (error.errors ?? [{ path: '/data', code: error.code, message: error.message }]).slice(0, 100); }
        return { id: record.id, schemaId: record.schemaId, schemaVersion: record.schemaVersion, deleted: record.deletedAt !== null, errors };
      });
      analysisId = uuid();
      analysis = freeze({ generation: this.generation, revision: this.revision, schemaId, totalAffected: items.length, totalInvalid: items.filter(item => item.errors.length).length, items });
      this.impacts.set(analysisId, analysis);
      if (this.impacts.size > 2) this.impacts.delete(this.impacts.keys().next().value);
    }
    this.impactCursorKey ??= createCursorKey();
    const end = Math.min(analysis.items.length, offset + limit);
    const nextCursor = end < analysis.items.length ? await sealCursor({ ...binding, analysisId, offset: end }, await this.impactCursorKey) : null;
    this._assert(); abortIfNeeded(options.signal);
    return clone({ ...analysis, items: analysis.items.slice(offset, end), nextCursor });
  }

  executeModelCommand(command, options = {}) {
    const queuedCommand = clone(command), queuedOptions = { ...options };
    const operation = this.queue.then(() => this._executeModel(queuedCommand, queuedOptions));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async _executeModel(command, options) {
    this._assert(); abortIfNeeded(options.signal);
    this._assertWritable();
    if (!command.generation) throw new ProviderError('precondition_required', 'Source generation is required', 428);
    if (command.generation !== this.generation) throw new ProviderError('generation_mismatch', 'Model command belongs to a different source generation', 409);
    if (!command.clientCommandId) throw new ProviderError('idempotency_required', 'Client command identity is required', 428);
    assertCommandId(command.clientCommandId);
    const fingerprint = canonicalJson({ resource: 'model', command });
    const prior = this.outcomes.get(command.clientCommandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new ProviderError('idempotency_conflict', 'Command identity was reused with different content', 409);
      return clone(prior.result);
    }
    if (!Number.isSafeInteger(this.revision) || this.revision >= Number.MAX_SAFE_INTEGER) throw new ProviderError('revision_capacity', 'Workspace revision capacity reached', 413);
    const next = applyModelCommand(this.snapshot.models, this.snapshot.settings, command);
    abortIfNeeded(options.signal);
    const manifest = { ...this.snapshot.manifest };
    delete manifest.contentSha256;
    const candidate = { ...this.snapshot, models: next.models, settings: next.settings, manifest };
    if (new TextEncoder().encode(JSON.stringify(candidate)).length > LOCAL_LIMITS.bundleBytes) throw new ProviderError('snapshot_size_limit', 'Model change would exceed the Local snapshot limit', 413);
    this.snapshot = freeze(candidate);
    this.revision++;
    this.modified = true;
    const result = { model: clone(next.model), settings: clone(next.settings), durability: 'memory-only', generation: this.generation, revision: this.revision };
    this.outcomes.set(command.clientCommandId, { fingerprint, result: clone(result) });
    for (const listener of this.listeners) { try { listener({ type: 'models-changed', modelId: next.model?.id ?? command.modelId, generation: this.generation, revision: this.revision }); } catch { /* Observer errors cannot reverse a committed memory command. */ } }
    return result;
  }

  subscribeChanges(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async exportSnapshot() {
    this._assert();
    const snapshot = clone(this.snapshot);
    const exportedAt = new Date().toISOString();
    snapshot.manifest = { ...snapshot.manifest, bundleId: uuid(), generation: this.generation, revision: this.revision, snapshotAt: this._legacyReadOnly() ? this.snapshot.manifest.snapshotAt : exportedAt, ...(this._legacyReadOnly() ? { exportedAt } : {}), sourceKind: 'local', origin: this.snapshot.manifest.origin ?? clone(this.snapshot.manifest), recordCount: snapshot.records.length };
    snapshot.manifest.contentSha256 = await sha256(snapshotContent(snapshot));
    return snapshot;
  }

  async releaseQuery(id) { this.queries.delete(id); }
  async releaseLayout(queryId, layoutId) { this._query(queryId).layouts.delete(layoutId); }
  dispose() { this.disposed = true; this.queries.clear(); this.listeners.clear(); this.outcomes.clear(); this.impacts.clear(); this.configurationCursors?.clear(); this.snapshot = null; this.input = null; }
}
