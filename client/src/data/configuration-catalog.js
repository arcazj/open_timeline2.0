import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import definitions from '../../../shared/schemas/configuration-definition.schema.json' with { type: 'json' };
import resourceSchema from '../../../shared/schemas/configuration-resource.schema.json' with { type: 'json' };
import stateSchema from '../../../shared/schemas/configuration-state.schema.json' with { type: 'json' };
import builtInFields from '../../../shared/fixtures/filter-fields.json' with { type: 'json' };
import { ProviderError, clone, inspectJson, canonicalJson, uuid } from './data-provider.js';
import { DEFAULT_DEFINITION, normalizeSnapshotModels, validateDefinition } from './model-catalog.js';
import { parseSearch, compileExpression } from './filter-expression.js';
import { validatePresentation } from '../timeline/presentation.js';
import { toMs, instantFormat } from '../timeline/time-scale.js';

export const CONFIGURATION_FAMILIES = Object.freeze(['sources', 'groups', 'schemas', 'filters', 'views']);
export const CONFIGURATION_LIMITS = Object.freeze({ resources: 100, versions: 32, definitionBytes: 65536, schemaNodes: 256, schemaDepth: 16 });
export function defaultConfigurationDefinition(family, snapshot) {
  if (family === 'sources') return { storage: 'json', enabled: true, writable: true, defaultSchema: null };
  if (family === 'groups') return { order: 0, color: null, collapsed: false };
  if (family === 'schemas') return { schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {}, additionalProperties: false } };
  if (family === 'filters') return { sourceIds: null, kinds: ['event', 'session'], schemaRefs: [], expression: null, search: { text: '', mode: 'any', caseSensitive: false, fields: ['/title'] } };
  if (family === 'views') return { model: { id: snapshot.settings.modelId, version: snapshot.settings.modelVersion }, filter: null, settings: {} };
  bad('Unknown configuration family');
}
const ajv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: false, validateFormats: true });
addFormats(ajv);
ajv.addFormat('timeline-instant', instantFormat);
ajv.addSchema(definitions).addSchema(resourceSchema).addSchema(stateSchema);
const validators = Object.fromEntries(CONFIGURATION_FAMILIES.map(family => [family, ajv.compile({ $ref: `${definitions.$id}#/$defs/${family}` })]));
const checkEnvelope = ajv.getSchema(resourceSchema.$id), checkState = ajv.getSchema(stateSchema.$id);
const checkSettings = ajv.compile({ $ref: `${definitions.$id}#/$defs/settings` });
const dataAjv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: false, validateFormats: false, addUsedSchema: false });
const builtInData = { description: 'string', text: 'string', system: 'string', type: 'string', status: 'string', priority: 'number' };
const registryBase = { ...builtInFields, '/data/priority': 'number' };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pointer = value => String(value).replace(/~/g, '~0').replace(/\//g, '~1');
const bad = (message, code = 'invalid_configuration', status = 422, extra = {}) => { throw new ProviderError(code, message, status, extra); };
const errorsFor = errors => (errors ?? []).map(error => ({ path: `${error.instancePath}${error.params?.missingProperty ? `/${pointer(error.params.missingProperty)}` : error.params?.additionalProperty ? `/${pointer(error.params.additionalProperty)}` : ''}` || '/', code: error.keyword, message: error.message }));
const assertShape = (value, validator, message) => { if (!validator(value)) bad(message, 'invalid_configuration', 422, { errors: errorsFor(validator.errors) }); };
const has = (actor, capability) => actor.capabilities.includes('*') || actor.capabilities.includes(capability);
function requireActor(actor) {
  if (!plain(actor) || typeof actor.id !== 'string' || !actor.id.trim() || [...actor.id].length > 128 || !Array.isArray(actor.capabilities) || actor.capabilities.some(value => typeof value !== 'string')) bad('An explicit authenticated actor is required', 'configuration_forbidden', 403);
  return actor;
}
function readable(resource, actor) {
  return !actor || has(actor, 'configuration.manage') || (has(actor, 'configuration.read') && resource.visibility !== 'personal') || (resource.ownerId === actor.id && has(actor, 'configuration.personal'));
}
function familyName(family) { if (!CONFIGURATION_FAMILIES.includes(family) && family !== 'models') bad('Unknown configuration resource family'); return family; }
function resourceAt(snapshot, family, id, context = {}) {
  familyName(family);
  const resource = snapshot?.[family]?.find(item => item.id === id);
  if (!resource || !readable(resource, context.actor)) bad('Configuration resource is unavailable', 'configuration_not_found', 404);
  if (context.newReference && resource.lifecycle === 'archived') bad('New references to archived resources are not permitted', 'configuration_archived', 409);
  if (resource.visibility === 'personal' && (context.visibility === 'workspace' || (context.ownerId && resource.ownerId !== context.ownerId))) bad('A reference cannot expose a private resource', 'configuration_forbidden', 403);
  return resource;
}
function publication(snapshot, family, pin, context = {}) {
  const resource = resourceAt(snapshot, family, pin.id, context);
  const version = resource.versions.find(item => item.version === pin.version);
  if (!version) bad('Published configuration version is unavailable', 'configuration_version_unavailable', 409);
  return version.definition;
}
function payloadKeys(payload, allowed, required = []) {
  if (!plain(payload) || Object.keys(payload).some(key => !allowed.includes(key)) || required.some(key => !own(payload, key))) bad('Invalid configuration command payload');
}
function timestamp(value) { try { toMs(value); } catch { bad('Configuration timestamps must be offset timestamps with millisecond precision'); } }
function definitionSize(value) {
  inspectJson(value);
  if (new TextEncoder().encode(canonicalJson(value)).length > CONFIGURATION_LIMITS.definitionBytes) bad('Definition exceeds 64 KiB', 'configuration_capacity', 413);
}

// Inspect references before compiling: a syntactically local reference may still create an unbounded graph.
export function resolvedDataSchema(definition) {
  definitionSize(definition);
  const root = clone(definition.schema);
  if (!plain(root) || root.type !== 'object' || !plain(root.properties) || root.additionalProperties !== false) bad('Data schema requires an object root, properties and additionalProperties:false');
  const keywords = new Set(['$schema', '$defs', '$ref', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'title', 'description']);
  let count = 0;
  function visit(node, depth = 1, stack = []) {
    if (!plain(node) || depth > 16 || ++count > 256) bad('Data schema exceeds its node/depth bounds');
    if (Object.keys(node).some(key => !keywords.has(key))) bad('Unsupported data schema keyword');
    if (own(node, '$schema') && node.$schema !== 'https://json-schema.org/draft/2020-12/schema') bad('Only JSON Schema 2020-12 is accepted');
    if (own(node, '$ref')) {
      if (Object.keys(node).length !== 1 || typeof node.$ref !== 'string' || !/^#\/\$defs\/[A-Za-z0-9_-]+$/.test(node.$ref)) bad('Only an isolated local $defs reference is accepted');
      const name = node.$ref.slice(8);
      if (!own(root.$defs ?? {}, name) || stack.includes(name)) bad('Data schema has a missing or recursive reference');
      visit(root.$defs[name], depth + 1, [...stack, name]);
      return;
    }
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.length || types.some(type => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)) || new Set(types).size !== types.length || types.length > 2 || (types.length === 2 && !types.includes('null'))) bad('Data schema requires one supported type, optionally nullable');
    if (own(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') bad('additionalProperties must be boolean');
    if (own(node, 'enum') && (!Array.isArray(node.enum) || node.enum.length > 100)) bad('An enum supports at most 100 values');
    if (own(node, 'properties')) {
      if (!plain(node.properties) || Object.keys(node.properties).length > 100) bad('An object supports at most 100 properties');
      for (const child of Object.values(node.properties)) visit(child, depth + 1, stack);
    }
    if (own(node, 'items')) visit(node.items, depth + 1, stack);
    if (own(node, '$defs')) {
      if (node !== root || !plain(node.$defs) || Object.keys(node.$defs).some(key => !/^[A-Za-z0-9_-]+$/.test(key))) bad('$defs is restricted to named root definitions');
      for (const [name, child] of Object.entries(node.$defs)) visit(child, depth + 1, [...stack, name]);
    }
  }
  visit(root);
  for (const [field, type] of Object.entries(builtInData)) {
    if (own(root.properties, field) && root.properties[field].type !== type) bad(`Built-in data field ${field} must retain type ${type}`);
    if (!own(root.properties, field)) Object.defineProperty(root.properties, field, { value: { type }, enumerable: true, writable: true, configurable: true });
  }
  if (!dataAjv.validateSchema(root)) bad('Invalid data schema', 'invalid_configuration', 422, { errors: errorsFor(dataAjv.errors) });
  try { dataAjv.compile(root); } catch { bad('Data schema cannot be compiled within the supported dialect'); }
  return root;
}

export function filterFieldTypes(snapshot, schemaRefs = []) {
  const registry = { ...registryBase };
  if (!Array.isArray(schemaRefs)) bad('Schema scope must be an array');
  let shared;
  const seen = new Set();
  for (const pin of schemaRefs) {
    const key = `${pin.id}:${pin.version}`;
    if (seen.has(key)) bad('Duplicate schema scope pin');
    seen.add(key);
    const root = resolvedDataSchema(publication(snapshot, 'schemas', pin));
    const fields = {};
    function visit(node, path) {
      if (node.$ref) return visit(root.$defs[node.$ref.slice(8)], path);
      const type = Array.isArray(node.type) ? node.type.find(value => value !== 'null') : node.type;
      if (type === 'object') for (const [key, child] of Object.entries(node.properties ?? {})) visit(child, `${path}/${pointer(key)}`);
      else if (['string', 'number', 'integer', 'boolean'].includes(type)) fields[path] = type === 'integer' ? 'number' : type;
      else if (type === 'array' && node.items?.type === 'string') fields[path] = 'strings';
    }
    visit(root, '/data');
    if (shared === undefined) shared = fields;
    else for (const [field, type] of Object.entries(shared)) {
      if (own(fields, field) && fields[field] !== type) bad('Schema scope contains incompatible field types');
      if (!own(fields, field)) delete shared[field];
    }
  }
  Object.assign(registry, shared ?? {});
  return registry;
}

function validateExpression(expression, registry) {
  if (expression === null) return;
  if (!plain(expression) || expression.version !== 1 || Object.keys(expression).some(key => !['version', 'root'].includes(key))) bad('Expected a version 1 filter expression');
  let count = 0;
  function visit(node, depth = 1) {
    if (!plain(node) || ++count > 100 || depth > 8) bad('Filter exceeds 100 nodes or depth 8');
    if (['and', 'or'].includes(node.op)) {
      payloadKeys(node, ['op', 'args'], ['op', 'args']);
      if (!Array.isArray(node.args) || !node.args.length || node.args.length > 100) bad('Boolean groups require 1-100 children');
      node.args.forEach(child => visit(child, depth + 1)); return;
    }
    if (node.op === 'not') { payloadKeys(node, ['op', 'arg'], ['op', 'arg']); visit(node.arg, depth + 1); return; }
    if (node.op === 'overlaps') { compileExpression({ version: 1, root: node }); return; }
    if (!own(registry, node.field)) bad('Filter field is not declared in every scoped schema');
    const type = registry[node.field];
    if (type === 'boolean') {
      if (!['exists', 'eq', 'ne', 'in'].includes(node.op)) bad('Boolean fields support equality, membership and exists');
      payloadKeys(node, node.op === 'in' ? ['op', 'field', 'values'] : ['op', 'field', 'value']);
      const values = node.op === 'in' ? node.values : [node.value];
      if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(value => typeof value !== 'boolean' && (value !== null || node.op === 'exists'))) bad('Boolean predicate has an invalid value');
      return;
    }
    const substitute = { string: '/title', number: '/order', date: '/start', strings: '/tags' }[type];
    compileExpression({ version: 1, root: { ...node, field: substitute } });
  }
  visit(expression.root);
}
function validateSearch(search, registry, partial = false) {
  const value = partial ? { text: '', mode: 'any', caseSensitive: false, fields: ['/title'], ...search } : search;
  parseSearch(value.text, value.mode, value.caseSensitive);
  if (!Array.isArray(value.fields) || !value.fields.length || value.fields.length > 16 || new Set(value.fields).size !== value.fields.length || value.fields.some(field => !own(registry, field) || registry[field] === 'strings')) bad('Search requires declared scalar fields');
}
function settingsPins(values) {
  const pins = [];
  for (const [stem, family] of [['model', 'models'], ['filter', 'filters'], ['view', 'views']]) {
    const a = `${stem}Id`, b = `${stem}Version`;
    if (own(values, a) !== own(values, b) || (own(values, a) && ((values[a] === null) !== (values[b] === null)))) bad('Setting references require paired IDs and versions');
    if (own(values, a) && values[a] !== null) pins.push({ family, pin: { id: values[a], version: values[b] } });
  }
  return pins;
}
function settingsRegistry(values, context) {
  if (context.registry) return context.registry;
  if (!context.snapshot) return registryBase;
  const personal = context.snapshot.preferences?.find(item => item.principalId === context.ownerId)?.values ?? {};
  const selection = { ...context.snapshot.settings, ...context.snapshot.defaults?.values, ...personal, ...values };
  let pin = selection.filterId == null ? null : { id: selection.filterId, version: selection.filterVersion };
  if (selection.viewId != null) pin = publication(context.snapshot, 'views', { id: selection.viewId, version: selection.viewVersion }, context).filter;
  const filter = pin && publication(context.snapshot, 'filters', pin, context);
  return filter ? filterFieldTypes(context.snapshot, filter.schemaRefs) : registryBase;
}
function validateSettings(values, context = {}, allowPins = true) {
  assertShape(values, checkSettings, 'Invalid settings override');
  const pins = settingsPins(values);
  if (!allowPins && pins.length) bad('View settings cannot duplicate model/filter/view pins');
  if (!allowPins && ['modelId', 'modelVersion', 'filterId', 'filterVersion', 'viewId', 'viewVersion'].some(key => own(values, key))) bad('View settings cannot contain resource pins');
  for (const { family, pin } of pins) if (context.snapshot) publication(context.snapshot, family, pin, context);
  for (const key of ['range', 'overview']) if (values[key]) {
    for (const value of Object.values(values[key])) timestamp(value);
    if (values[key].from && values[key].to && toMs(values[key].from) >= toMs(values[key].to)) bad('Time range must be positive');
  }
  if (values.referenceTime) timestamp(values.referenceTime);
  const visual = Object.fromEntries(Object.keys(DEFAULT_DEFINITION).filter(key => own(values, key)).map(key => [key, values[key]]));
  const validation = validateDefinition({ ...DEFAULT_DEFINITION, ...visual, rowHeight: own(visual, 'fontSize') && !own(visual, 'rowHeight') ? Math.max(DEFAULT_DEFINITION.rowHeight, visual.fontSize + 19) : visual.rowHeight ?? DEFAULT_DEFINITION.rowHeight });
  if (!validation.valid) bad('Invalid visual settings', 'invalid_configuration', 422, { errors: validation.errors });
  if (values.presentation) { const result = validatePresentation(values.presentation); if (!result.valid) bad('Invalid presentation settings', 'invalid_configuration', 422, { errors: result.errors }); }
  const registry = settingsRegistry(values, context);
  for (const key of ['columns', 'sort']) if (values[key]) {
    const fields = values[key].map(item => item.field);
    if (new Set(fields).size !== fields.length || fields.some(field => !own(registry, field.startsWith('/') ? field : `/${field.replace(/^data\./, 'data/')}`))) bad('Table fields must be unique declared fields');
    if (key === 'sort' && fields.some(field => registry[field.startsWith('/') ? field : `/${field.replace(/^data\./, 'data/')}`] === 'strings')) bad('Table sort requires scalar fields');
  }
  if (values.search) validateSearch(values.search, registry, true);
  for (const id of values.collapsedGroups ?? []) if (context.snapshot) resourceAt(context.snapshot, 'groups', id, context);
}

export function validateResourceDefinition(family, definition, context = {}) {
  const errors = [];
  try {
    if (!CONFIGURATION_FAMILIES.includes(family)) bad('Unknown configuration family');
    definitionSize(definition);
    if (!validators[family](definition)) return { valid: false, errors: errorsFor(validators[family].errors) };
    if (context.actor) requireActor(context.actor);
    const reference = (target, pin) => context.snapshot ? publication(context.snapshot, target, pin, context) : undefined;
    if (family === 'sources' && definition.defaultSchema) reference('schemas', definition.defaultSchema);
    if (family === 'schemas') resolvedDataSchema(definition);
    if (family === 'filters') {
      for (const id of definition.sourceIds ?? []) if (context.snapshot) resourceAt(context.snapshot, 'sources', id, context);
      for (const pin of definition.schemaRefs) reference('schemas', pin);
      if (definition.schemaRefs.length && !context.snapshot) bad('Schema-scoped validation requires the catalog context');
      const registry = filterFieldTypes(context.snapshot, definition.schemaRefs);
      validateExpression(definition.expression, registry); validateSearch(definition.search, registry);
    }
    if (family === 'views') {
      reference('models', definition.model);
      const filter = definition.filter && reference('filters', definition.filter);
      validateSettings(definition.settings, { ...context, registry: filter ? filterFieldTypes(context.snapshot, filter.schemaRefs) : registryBase }, false);
    }
  } catch (error) { errors.push(...(error.errors ?? [{ path: '/', code: error.code ?? 'invalid_configuration', message: error.message }])); }
  return { valid: errors.length === 0, errors };
}
function requireDefinition(family, definition, context) {
  definitionSize(definition);
  const result = validateResourceDefinition(family, definition, context);
  if (!result.valid) {
    const statuses = { configuration_forbidden: 403, configuration_not_found: 404, configuration_version_unavailable: 409, configuration_archived: 409, configuration_capacity: 413 };
    const referenceError = result.errors.find(error => own(statuses, error.code));
    if (referenceError) bad(referenceError.message, referenceError.code, statuses[referenceError.code]);
    bad('Configuration definition is invalid', 'invalid_configuration_definition', 422, { errors: result.errors });
  }
}
function validateEnvelope(resource, family) {
  assertShape(resource, checkEnvelope, 'Invalid configuration envelope');
  if (!resource.name.trim() || resource.tags.some(tag => !tag.trim()) || !resource.ownerId.trim()) bad('Configuration metadata cannot be blank');
  if (['sources', 'groups'].includes(family) && (resource.visibility !== 'workspace' || !resource.versions.length)) bad('Sources and groups require a shared published definition');
  if (!resource.versions.length && resource.draft === null) bad('Resource requires a draft or publication');
  timestamp(resource.createdAt); timestamp(resource.updatedAt);
  resource.versions.forEach((version, index) => { if (version.version !== index + 1) bad('Publication versions must be contiguous from one'); timestamp(version.publishedAt); });
}
function newResource(id, name, definition, family, actorId, now, visibility) {
  const published = ['sources', 'groups'].includes(family);
  return { formatVersion: 1, id, name, description: '', tags: [], revision: 1, lifecycle: 'active', createdAt: now, updatedAt: now, ownerId: actorId, visibility, copiedFrom: null, draft: published ? null : clone(definition), versions: published ? [{ version: 1, publishedAt: now, publishedBy: actorId, definition: clone(definition) }] : [] };
}

export function normalizeConfiguration(input, actor) {
  requireActor(actor);
  const snapshot = clone(input), before = canonicalJson(input);
  normalizeSnapshotModels(snapshot);
  const now = snapshot.manifest.snapshotAt;
  const legacyName = (id, label) => typeof id === 'string' && id.trim() ? [...id].slice(0, 100).join('') : label;
  if (!own(snapshot, 'sources')) snapshot.sources = snapshot.manifest.scope.sourceIds.map(id => newResource(id, legacyName(id, 'Imported source'), { storage: 'json', enabled: true, writable: true, defaultSchema: null }, 'sources', 'legacy-import', now, 'workspace'));
  if (!own(snapshot, 'groups')) snapshot.groups = [...new Set(snapshot.records.flatMap(record => record.groupIds ?? []))].sort().map((id, order) => newResource(id, legacyName(id, 'Imported group'), { order, color: null, collapsed: false }, 'groups', 'legacy-import', now, 'workspace'));
  if (!own(snapshot, 'schemas')) snapshot.schemas = [];
  if (!own(snapshot, 'views')) snapshot.views = [];
  if (!own(snapshot, 'defaults')) snapshot.defaults = { revision: 1, values: {} };
  if (!own(snapshot, 'preferences')) snapshot.preferences = [];
  if (!Array.isArray(snapshot.filters) || snapshot.filters.some(item => !plain(item) || item.formatVersion !== 1 || !own(item, 'versions'))) bad('Noncanonical filters require an explicit legacy migration report', 'configuration_migration_required', 422);
  inspectJson(snapshot);
  assertShape(Object.fromEntries([...CONFIGURATION_FAMILIES, 'defaults', 'preferences'].map(key => [key, snapshot[key]])), checkState, 'Invalid portable configuration');
  for (const family of CONFIGURATION_FAMILIES) {
    const seen = new Set();
    for (const resource of snapshot[family]) { validateEnvelope(resource, family); if (seen.has(resource.id)) bad('Duplicate configuration identity'); seen.add(resource.id); }
  }
  const scope = snapshot.manifest.scope.sourceIds;
  if (new Set(scope).size !== scope.length || snapshot.sources.length !== scope.length || snapshot.sources.some(item => !scope.includes(item.id))) bad('Source catalog and complete source scope differ');
  for (const family of CONFIGURATION_FAMILIES) for (const resource of snapshot[family]) {
    const context = { snapshot, visibility: resource.visibility, ownerId: resource.ownerId };
    for (const definition of [...resource.versions.map(version => version.definition), ...(resource.draft === null ? [] : [resource.draft])]) requireDefinition(family, definition, context);
  }
  const principals = new Set();
  validateSettings(snapshot.settings, { snapshot, visibility: 'workspace' });
  validateSettings(snapshot.defaults.values, { snapshot, visibility: 'workspace' });
  for (const preference of snapshot.preferences) {
    if (principals.has(preference.principalId)) bad('Duplicate principal preference'); principals.add(preference.principalId);
    validateSettings(preference.values, { snapshot, visibility: 'personal', ownerId: preference.principalId });
  }
  for (const record of snapshot.records) {
    resourceAt(snapshot, 'sources', record.sourceId);
    for (const groupId of record.groupIds ?? []) resourceAt(snapshot, 'groups', groupId);
    if ((record.schemaId == null) !== (record.schemaVersion == null)) bad('Record schema pins must appear together');
    if (record.schemaId != null) publication(snapshot, 'schemas', { id: record.schemaId, version: record.schemaVersion }, { visibility: 'workspace' });
  }
  effectiveSettings(snapshot);
  for (const preference of snapshot.preferences) effectiveSettings(snapshot, { principalId: preference.principalId });
  if (canonicalJson(snapshot) !== before) delete snapshot.manifest.contentSha256;
  return snapshot;
}

export function configurationUsage(snapshot, family, id, version) {
  familyName(family);
  const references = [];
  const add = (target, pin, descriptor) => { if (target === family && pin?.id === id && (version === undefined || pin.version === version)) references.push(descriptor); };
  for (const record of snapshot.records ?? []) {
    const descriptor = { kind: record.deletedAt ? 'tombstone' : 'record', id: record.id };
    add('sources', { id: record.sourceId }, { ...descriptor, path: '/sourceId' });
    for (const groupId of record.groupIds ?? []) add('groups', { id: groupId }, { ...descriptor, path: '/groupIds' });
    add('schemas', { id: record.schemaId, version: record.schemaVersion }, { ...descriptor, path: '/schemaId' });
  }
  const fromSettings = (values, descriptor) => {
    for (const { family: target, pin } of settingsPins(values)) add(target, pin, { ...descriptor, path: `/${target === 'models' ? 'model' : target === 'filters' ? 'filter' : 'view'}Id` });
    for (const groupId of values.collapsedGroups ?? []) add('groups', { id: groupId }, { ...descriptor, path: '/collapsedGroups' });
  };
  for (const sourceFamily of CONFIGURATION_FAMILIES) for (const resource of snapshot[sourceFamily] ?? []) {
    const versions = [...resource.versions.map(item => ({ version: item.version, definition: item.definition })), ...(resource.draft === null ? [] : [{ version: null, definition: resource.draft }])];
    for (const item of versions) {
      const descriptor = { kind: 'resource', family: sourceFamily, id: resource.id, version: item.version, visibility: resource.visibility, ownerId: resource.ownerId };
      const definition = item.definition;
      if (sourceFamily === 'sources') add('schemas', definition.defaultSchema, { ...descriptor, path: '/defaultSchema' });
      if (sourceFamily === 'filters') {
        for (const sourceId of definition.sourceIds ?? []) add('sources', { id: sourceId }, { ...descriptor, path: '/sourceIds' });
        for (const pin of definition.schemaRefs) add('schemas', pin, { ...descriptor, path: '/schemaRefs' });
      }
      if (sourceFamily === 'views') {
        add('models', definition.model, { ...descriptor, path: '/model' }); add('filters', definition.filter, { ...descriptor, path: '/filter' });
        fromSettings(definition.settings, descriptor);
      }
    }
  }
  fromSettings(snapshot.settings, { kind: 'active-settings' });
  fromSettings(snapshot.defaults?.values ?? {}, { kind: 'workspace-defaults' });
  for (const preference of snapshot.preferences ?? []) fromSettings(preference.values, { kind: 'personal-preferences', principalId: preference.principalId });
  return references;
}

const MERGED_SETTINGS = new Set(['range', 'overview', 'search']);
function mergeSettings(target, source, origins, origin) {
  function record(value, path) {
    if (plain(value)) for (const [key, child] of Object.entries(value)) record(child, `${path}/${pointer(key)}`);
    else origins[path] = origin;
  }
  for (const [key, value] of Object.entries(source)) {
    if (MERGED_SETTINGS.has(key) && plain(value)) {
      target[key] = { ...target[key], ...clone(value) };
      for (const [child, item] of Object.entries(value)) record(item, `/${pointer(key)}/${pointer(child)}`);
    } else {
      for (const path of Object.keys(origins)) if (path === `/${pointer(key)}` || path.startsWith(`/${pointer(key)}/`)) delete origins[path];
      target[key] = clone(value); record(value, `/${pointer(key)}`);
    }
  }
}
export function effectiveSettings(snapshot, { viewId, viewVersion, principalId, transient = {} } = {}) {
  const values = {}, origins = {};
  const personal = snapshot.preferences?.find(item => item.principalId === principalId)?.values ?? {};
  validateSettings(transient, { snapshot, visibility: 'personal', ownerId: principalId });
  const selector = {}, selectorOrigins = {};
  mergeSettings(selector, snapshot.settings, selectorOrigins, 'workspace-active');
  mergeSettings(selector, snapshot.defaults?.values ?? {}, selectorOrigins, 'workspace-defaults');
  mergeSettings(selector, personal, selectorOrigins, `personal:${principalId}`);
  mergeSettings(selector, transient, selectorOrigins, 'transient');
  if (viewId !== undefined || viewVersion !== undefined) {
    if (viewId === undefined || viewVersion === undefined) bad('Explicit view selection requires paired identity and version');
    mergeSettings(selector, { viewId, viewVersion }, selectorOrigins, 'preview');
  }
  settingsPins(selector);
  const context = { visibility: principalId ? 'personal' : 'workspace', ownerId: principalId };
  const view = selector.viewId == null ? null : publication(snapshot, 'views', { id: selector.viewId, version: selector.viewVersion }, context);
  const modelPin = view?.model ?? { id: selector.modelId, version: selector.modelVersion };
  const model = publication(snapshot, 'models', modelPin, context);
  const filterPin = view ? view.filter : selector.filterId == null ? null : { id: selector.filterId, version: selector.filterVersion };
  const selectedFilter = filterPin && publication(snapshot, 'filters', filterPin, context);
  mergeSettings(values, { ...DEFAULT_DEFINITION, mode: 'timeline', collapsedGroups: [], search: { text: '', mode: 'any', caseSensitive: false, fields: ['/title', '/data/description', '/data/text', '/data/system', '/data/type', '/data/status'] } }, origins, 'application');
  mergeSettings(values, snapshot.settings, origins, 'workspace-active');
  mergeSettings(values, snapshot.defaults?.values ?? {}, origins, 'workspace-defaults');
  mergeSettings(values, model, origins, `model:${modelPin.id}@${modelPin.version}`);
  if (selectedFilter) mergeSettings(values, { search: selectedFilter.search }, origins, `filter:${filterPin.id}@${filterPin.version}`);
  if (view) mergeSettings(values, view.settings, origins, `view:${selector.viewId}@${selector.viewVersion}`);
  mergeSettings(values, personal, origins, `personal:${principalId}`);
  mergeSettings(values, transient, origins, 'transient');
  const pins = { modelId: modelPin.id, modelVersion: modelPin.version };
  if (view) Object.assign(pins, { filterId: view.filter?.id ?? null, filterVersion: view.filter?.version ?? null });
  for (const [key, value] of Object.entries(pins)) mergeSettings(values, { [key]: value }, origins, view ? `view:${selector.viewId}@${selector.viewVersion}` : selectorOrigins[`/${key}`]);
  if (own(selector, 'viewId')) for (const key of ['viewId', 'viewVersion']) mergeSettings(values, { [key]: selector[key] }, origins, selectorOrigins[`/${key}`]);
  const filter = values.filterId == null ? null : publication(snapshot, 'filters', { id: values.filterId, version: values.filterVersion }, context);
  validateSettings(values, { snapshot, ...context, registry: filter ? filterFieldTypes(snapshot, filter.schemaRefs) : registryBase });
  if (values.range?.from && values.range?.to && values.overview?.from && values.overview?.to && (toMs(values.range.from) < toMs(values.overview.from) || toMs(values.range.to) > toMs(values.overview.to))) bad('Detail range must be contained by the overview');
  return { values, origins, preferenceRevision: snapshot.preferences?.find(item => item.principalId === principalId)?.revision ?? 0 };
}

function authorizeMutation(resource, actor, publish = false) {
  const permitted = has(actor, 'configuration.manage') || (resource.visibility === 'personal' && resource.ownerId === actor.id && has(actor, 'configuration.personal'));
  if (!permitted || (publish && resource.visibility === 'workspace' && !has(actor, 'configuration.publish'))) bad('Configuration permission is required', 'configuration_forbidden', 403);
}
export function applyConfigurationCommand(input, inputCommand, { actor, now = new Date().toISOString(), createId = uuid } = {}) {
  requireActor(actor);
  const command = clone(inputCommand); inspectJson(command); timestamp(now);
  payloadKeys(command, ['family', 'type', 'resourceId', 'expectedRevision', 'expectedPreferenceRevision', 'generation', 'clientCommandId', 'payload'], ['family', 'type', 'clientCommandId']);
  if (!CONFIGURATION_FAMILIES.includes(command.family)) bad('Unknown configuration family');
  if (command.generation == null) bad('Workspace generation is required', 'precondition_required', 428);
  if (command.generation !== input.manifest.generation) bad('Workspace generation changed', 'workspace_generation_conflict', 409);
  if (typeof command.clientCommandId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.clientCommandId)) bad('A valid client command identity is required');
  const snapshot = normalizeConfiguration(input, actor), family = command.family;
  const payload = command.payload ?? {}; let resource;
  const create = (definition, copiedFrom = null) => {
    if (snapshot[family].length >= 100) bad('Configuration catalog is full', 'configuration_capacity', 413);
    const visibility = payload.visibility ?? (['sources', 'groups'].includes(family) ? 'workspace' : 'personal');
    if (!['workspace', 'personal'].includes(visibility)) bad('Invalid visibility');
    resource = newResource(createId(), payload.name, definition, family, actor.id, now, visibility);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resource.id) || snapshot[family].some(item => item.id === resource.id)) bad('Provider must assign a fresh UUID');
    authorizeMutation(resource, actor, ['sources', 'groups'].includes(family));
    requireDefinition(family, definition, { snapshot, actor, visibility, ownerId: actor.id, newReference: true });
    resource.copiedFrom = copiedFrom;
    snapshot[family].push(resource);
    if (family === 'sources') snapshot.manifest.scope.sourceIds.push(resource.id);
  };
  if (command.type === 'create') {
    payloadKeys(payload, ['name', 'description', 'tags', 'visibility', 'definition'], ['name', 'definition']);
    create(payload.definition);
    if (own(payload, 'description')) resource.description = payload.description;
    if (own(payload, 'tags')) resource.tags = clone(payload.tags);
  } else {
    if (!['update', 'publish', 'archive', 'unarchive', 'delete', 'duplicate', 'apply'].includes(command.type)) bad('Unsupported configuration command');
    resource = resourceAt(snapshot, family, command.resourceId, { actor });
    if (command.expectedRevision == null) bad('Expected resource revision is required', 'precondition_required', 428);
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== resource.revision) bad('Configuration resource changed', 'configuration_revision_conflict', 412);
    if (command.type !== 'duplicate' && command.type !== 'apply') authorizeMutation(resource, actor, command.type === 'publish');
    if (resource.lifecycle === 'archived' && ['update', 'publish', 'apply'].includes(command.type)) bad('Unarchive the resource before this operation', 'configuration_archived', 409);
    const context = { snapshot, actor, visibility: resource.visibility, ownerId: resource.ownerId, newReference: true };
    if (command.type === 'update') {
      payloadKeys(payload, ['name', 'description', 'tags', 'draft']);
      if (!Object.keys(payload).length) bad('An update requires a mutable field');
      if (own(payload, 'draft')) requireDefinition(family, payload.draft, context);
      for (const [key, value] of Object.entries(payload)) resource[key] = clone(value);
    } else if (command.type === 'duplicate') {
      payloadKeys(payload, ['name', 'version', 'visibility'], ['name']);
      const old = resource;
      const version = own(payload, 'version') ? payload.version : old.draft ? null : old.versions.at(-1).version;
      if (version !== null && (!Number.isSafeInteger(version) || version < 1 || version > 32)) bad('Invalid duplicate version');
      const definition = version === null ? old.draft : publication(snapshot, family, { id: old.id, version }, { actor });
      create(definition, { family, id: old.id, version });
    } else if (command.type === 'apply') {
      payloadKeys(payload, ['version'], ['version']);
      if (!['filters', 'views'].includes(family)) bad('Only filters and views can be applied');
      if (!has(actor, 'configuration.personal') && !has(actor, 'configuration.manage')) bad('Applying settings requires configuration permission', 'configuration_forbidden', 403);
      if (!Number.isSafeInteger(payload.version) || payload.version < 1 || payload.version > 32) bad('Invalid published version');
      const definition = publication(snapshot, family, { id: resource.id, version: payload.version }, context);
      requireDefinition(family, definition, context);
      let preference = snapshot.preferences.find(item => item.principalId === actor.id);
      if (command.expectedPreferenceRevision == null) bad('Expected preference revision is required', 'precondition_required', 428);
      if (!Number.isSafeInteger(command.expectedPreferenceRevision) || command.expectedPreferenceRevision !== (preference?.revision ?? 0)) bad('Personal preferences changed', 'configuration_preference_revision_conflict', 412);
      if (preference) {
        if (preference.revision === Number.MAX_SAFE_INTEGER) bad('Preference revision capacity reached', 'configuration_capacity', 413);
        preference.revision++;
      } else {
        if (snapshot.preferences.length >= 100) bad('Preference catalog is full', 'configuration_capacity', 413);
        preference = { principalId: actor.id, revision: 1, values: {} }; snapshot.preferences.push(preference);
      }
      if (family === 'filters') Object.assign(preference.values, { filterId: resource.id, filterVersion: payload.version, viewId: null, viewVersion: null });
      else Object.assign(preference.values, { modelId: definition.model.id, modelVersion: definition.model.version, filterId: definition.filter?.id ?? null, filterVersion: definition.filter?.version ?? null, viewId: resource.id, viewVersion: payload.version });
    } else {
      payloadKeys(payload, []);
      if (command.type === 'publish') {
        if (resource.draft === null) bad('Save a draft before publishing', 'configuration_draft_missing', 409);
        if (resource.versions.length >= 32) bad('Publication history is full', 'configuration_capacity', 413);
        requireDefinition(family, resource.draft, context);
        resource.versions.push({ version: resource.versions.length + 1, publishedAt: now, publishedBy: actor.id, definition: clone(resource.draft) }); resource.draft = null;
      } else if (['archive', 'unarchive'].includes(command.type)) {
        const lifecycle = command.type === 'archive' ? 'archived' : 'active';
        if (resource.lifecycle === lifecycle) bad('Resource already has this lifecycle', 'configuration_lifecycle_conflict', 409);
        resource.lifecycle = lifecycle;
      } else {
        if (configurationUsage(snapshot, family, resource.id).length) bad('Resource is referenced', 'configuration_referenced', 409);
        snapshot[family].splice(snapshot[family].indexOf(resource), 1);
        if (family === 'sources') snapshot.manifest.scope.sourceIds = snapshot.manifest.scope.sourceIds.filter(id => id !== resource.id);
        resource = null;
      }
    }
    if (resource && !['duplicate', 'apply'].includes(command.type)) {
      if (resource.revision === Number.MAX_SAFE_INTEGER) bad('Configuration revision capacity reached', 'configuration_capacity', 413);
      resource.revision++; resource.updatedAt = now;
    }
  }
  if (resource) validateEnvelope(resource, family);
  delete snapshot.manifest.contentSha256;
  const result = { snapshot, resource };
  if (command.type === 'apply') {
    result.effectiveSettings = effectiveSettings(snapshot, { principalId: actor.id });
    const definition = resource.versions.find(version => version.version === payload.version).definition;
    result.resetTransientKeys = family === 'filters' ? ['filterId', 'filterVersion', 'viewId', 'viewVersion', 'search'] : [...new Set(['modelId', 'modelVersion', 'filterId', 'filterVersion', 'viewId', 'viewVersion', ...(definition.filter ? ['search'] : []), ...Object.keys(definition.settings)])];
  }
  return result;
}
