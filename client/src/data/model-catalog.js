import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import definitionSchema from '../../../shared/schemas/visual-definition.schema.json' with { type: 'json' };
import modelSchema from '../../../shared/schemas/visual-model.schema.json' with { type: 'json' };
import snapshotSchema from '../../../shared/schemas/snapshot.schema.json' with { type: 'json' };
import presentationSchema from '../../../shared/schemas/presentation.schema.json' with { type: 'json' };
import renderSchema from '../../../shared/schemas/record-render.schema.json' with { type: 'json' };
import timeZones from '../../../shared/fixtures/time-zones.json' with { type: 'json' };
import { ProviderError, clone, uuid, inspectJson } from './data-provider.js';
import { toMs, instantFormat } from '../timeline/time-scale.js';
import { validatePresentation } from '../timeline/presentation.js';

export const DEFAULT_DEFINITION = Object.freeze({ theme: 'light', rowHeight: 32, fontSize: 13, groupBy: 'none', displayUnit: 'HOUR', timeZone: 'UTC', scaleMode: 'uniform', ratio: 4, bins: 128 });
export const MODEL_LIMITS = Object.freeze({ models: 100, versions: 32 });
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TIME_ZONES = new Set(timeZones.zones);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const pointer = value => String(value).replace(/~/g, '~0').replace(/\//g, '~1');

export function registerModelSchemas(ajv) {
  ajv.addFormat('timeline-instant', instantFormat);
  if (!ajv.getSchema(presentationSchema.$id)) ajv.addSchema(presentationSchema);
  if (!ajv.getSchema(renderSchema.$id)) ajv.addSchema(renderSchema);
  if (!ajv.getSchema(definitionSchema.$id)) ajv.addSchema(definitionSchema);
  if (!ajv.getSchema(modelSchema.$id)) ajv.addSchema(modelSchema);
}

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
addFormats(ajv);
registerModelSchemas(ajv);
const checkDefinition = ajv.getSchema(definitionSchema.$id);
const checkModel = ajv.getSchema(modelSchema.$id);
const checkLegacy = ajv.compile(snapshotSchema.definitions.legacyPreset);

function schemaErrors(errors) {
  return (errors ?? []).map(error => {
    const property = error.params?.missingProperty ?? error.params?.additionalProperty;
    return { path: `${error.instancePath}${property === undefined ? '' : `/${pointer(property)}`}` || '/', code: error.keyword, message: error.message ?? 'Invalid value' };
  });
}

export function validateDefinition(definition) {
  const errors = checkDefinition(definition) ? [] : schemaErrors(checkDefinition.errors);
  if (definition && typeof definition === 'object' && !Array.isArray(definition)) {
    if (own(definition, 'presentation')) errors.push(...validatePresentation(definition.presentation).errors.map(error => ({ ...error, path: `/presentation${error.path === '/' ? '' : error.path}` })));
    if (typeof definition.rowHeight === 'number' && typeof definition.fontSize === 'number' && definition.rowHeight < definition.fontSize + 19) errors.push({ path: '/rowHeight', code: 'row_height', message: 'Row height must be at least font size + 19' });
    if (typeof definition.timeZone === 'string') {
      try {
        if (!TIME_ZONES.has(definition.timeZone)) throw new RangeError('Unsupported zone');
        new Intl.DateTimeFormat('en', { timeZone: definition.timeZone }).format(0);
      } catch { errors.push({ path: '/timeZone', code: 'time_zone', message: 'Use UTC or an available named IANA time zone' }); }
    }
  }
  return { valid: errors.length === 0, errors };
}

function requireDefinition(definition) {
  const result = validateDefinition(definition);
  if (!result.valid) throw new ProviderError('invalid_model_definition', 'Visual definition is invalid', 422, { errors: result.errors });
}

export function validateModelEnvelope(model) {
  inspectJson(model);
  if (!checkModel(model)) throw new ProviderError('invalid_model', 'Invalid visual model', 422, { errors: schemaErrors(checkModel.errors) });
  if (!model.name.trim() || model.tags.some(tag => !tag.trim())) throw new ProviderError('invalid_model', 'Model name and tags must not be blank');
  if (!Number.isSafeInteger(model.revision)) throw new ProviderError('invalid_model', 'Model revision exceeds the supported integer range');
  try { toMs(model.createdAt); toMs(model.updatedAt); } catch { throw new ProviderError('invalid_model', 'Model timestamps must be valid ISO dates with millisecond precision'); }
  if (model.versions.length === 0 && model.draft === null) throw new ProviderError('invalid_model', 'A model needs a draft or a published definition');
  if (model.draft !== null) requireDefinition(model.draft);
  model.versions.forEach((version, index) => {
    if (version.version !== index + 1) throw new ProviderError('invalid_model', 'Published versions must be contiguous starting at one');
    try { toMs(version.publishedAt); } catch { throw new ProviderError('invalid_model', 'Published timestamps must be valid ISO dates with millisecond precision'); }
    requireDefinition(version.definition);
  });
  return model;
}

export function normalizeCatalog(models, snapshotAt) {
  if (!Array.isArray(models) || !models.length) throw new ProviderError('invalid_model', 'A snapshot requires at least one model');
  if (models.length > MODEL_LIMITS.models) throw new ProviderError('model_capacity', 'The catalog supports at most 100 models', 413);
  toMs(snapshotAt);
  const seen = new Set();
  return models.map(input => {
    let model = clone(input);
    if (!model || !own(model, 'versions')) {
      if (!checkLegacy(model)) throw new ProviderError('invalid_model', 'Unsupported or invalid flat visual preset', 422, { errors: schemaErrors(checkLegacy.errors) });
      const definition = { ...DEFAULT_DEFINITION, theme: model.theme, rowHeight: model.rowHeight, fontSize: model.fontSize, groupBy: model.groupBy };
      model = { id: model.id, name: model.name, description: '', tags: [], revision: 1, lifecycle: 'active', createdAt: snapshotAt, updatedAt: snapshotAt, draft: null, versions: [{ version: 1, publishedAt: snapshotAt, definition }] };
    }
    validateModelEnvelope(model);
    if (seen.has(model.id)) throw new ProviderError('duplicate_id', `Duplicate model ID ${model.id}`);
    seen.add(model.id);
    return model;
  });
}

export function normalizeSnapshotModels(snapshot) {
  const oldDefault = snapshot.models.find(model => model.id === snapshot.settings.modelId);
  const legacyDefault = oldDefault && !own(oldDefault, 'versions');
  const changed = snapshot.models.some(model => !own(model, 'versions'));
  const models = normalizeCatalog(snapshot.models, snapshot.manifest.snapshotAt);
  const settings = clone(snapshot.settings);
  if (!own(settings, 'modelVersion') && legacyDefault) settings.modelVersion = 1;
  validateModelReference(models, settings);
  snapshot.models = models;
  snapshot.settings = settings;
  if (changed) delete snapshot.manifest.contentSha256;
  return snapshot;
}

export function validateModelReference(models, settings) {
  if (own(settings, 'presentation')) {
    const validation = validatePresentation(settings.presentation);
    if (!validation.valid) throw new ProviderError('invalid_presentation', 'Settings presentation is invalid', 422, { errors: validation.errors });
  }
  const model = models.find(item => item.id === settings.modelId);
  if (!model) throw new ProviderError('missing_model', 'The selected model is missing');
  if (!Number.isSafeInteger(settings.modelVersion) || !model.versions.some(version => version.version === settings.modelVersion)) throw new ProviderError('model_version_unavailable', 'Settings must pin an existing published model version', 409);
}

export function modelUsage(settings, modelId) {
  return settings.modelId === modelId ? [{ kind: 'workspace-default', modelId, version: settings.modelVersion }] : [];
}

export function findModel(models, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new ProviderError('invalid_model_id', 'Invalid model identity');
  const model = models.find(item => item.id === id);
  if (!model) throw new ProviderError('model_not_found', 'Visual model is unavailable', 404);
  return model;
}

function payloadFields(payload, allowed, required = []) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ProviderError('invalid_model', 'Model command payload must be an object');
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) throw new ProviderError('invalid_model', `Unsupported model command field: ${key}`);
  for (const key of required) if (!own(payload, key)) throw new ProviderError('invalid_model', `Required model command field: ${key}`);
}

export function applyModelCommand(catalog, currentSettings, command, { now = new Date().toISOString(), createId = uuid } = {}) {
  const models = clone(catalog);
  const settings = clone(currentSettings);
  const payload = command.payload === undefined ? {} : command.payload;
  inspectJson(payload);
  let model;
  if (command.type === 'create') {
    if (models.length >= MODEL_LIMITS.models) throw new ProviderError('model_capacity', 'The catalog supports at most 100 models', 413);
    payloadFields(payload, ['name', 'description', 'tags', 'definition'], ['name', 'definition']);
    requireDefinition(payload.definition);
    model = { id: createId(), name: payload.name, description: own(payload, 'description') ? payload.description : '', tags: own(payload, 'tags') ? clone(payload.tags) : [], revision: 1, lifecycle: 'active', createdAt: now, updatedAt: now, draft: clone(payload.definition), versions: [] };
    models.push(model);
  } else {
    if (!['update', 'publish', 'archive', 'unarchive', 'delete', 'apply'].includes(command.type)) throw new ProviderError('unsupported_command', 'Unknown model command');
    model = findModel(models, command.modelId);
    if (command.expectedRevision == null) throw new ProviderError('precondition_required', 'Expected model revision is required', 428);
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== model.revision) throw new ProviderError('model_revision_conflict', 'Model changed; reload before applying your draft', 412);
    if (model.lifecycle === 'archived' && ['update', 'publish', 'apply'].includes(command.type)) throw new ProviderError('model_archived', 'Unarchive this model before editing, publishing or applying it', 409);
    if (command.type === 'update') {
      payloadFields(payload, ['name', 'description', 'tags', 'draft']);
      if (!Object.keys(payload).length) throw new ProviderError('invalid_model', 'A model update needs at least one field');
      if (own(payload, 'draft')) requireDefinition(payload.draft);
      for (const key of Object.keys(payload)) model[key] = clone(payload[key]);
    } else if (command.type === 'apply') {
      payloadFields(payload, ['version'], ['version']);
      if (!Number.isSafeInteger(payload.version) || payload.version < 1 || payload.version > MODEL_LIMITS.versions) throw new ProviderError('invalid_model', 'Apply requires a positive published version number from 1 to 32');
      const version = model.versions.find(item => item.version === payload.version);
      if (!version) throw new ProviderError('model_version_unavailable', 'The selected published version is unavailable', 409);
      Object.assign(settings, clone(version.definition), { modelId: model.id, modelVersion: version.version });
      if (!own(version.definition, 'presentation')) delete settings.presentation;
    } else {
      payloadFields(payload, []);
      if (command.type === 'publish') {
        if (!model.draft) throw new ProviderError('model_draft_missing', 'Save a draft before publishing', 409);
        if (model.versions.length >= MODEL_LIMITS.versions) throw new ProviderError('model_version_capacity', 'Model history supports at most 32 published versions', 413);
        model.versions.push({ version: model.versions.length + 1, publishedAt: now, definition: clone(model.draft) });
        model.draft = null;
      } else if (command.type === 'archive' || command.type === 'unarchive') {
        const lifecycle = command.type === 'archive' ? 'archived' : 'active';
        if (model.lifecycle === lifecycle) throw new ProviderError('model_lifecycle_conflict', `Model is already ${lifecycle}`, 409);
        model.lifecycle = lifecycle;
      } else if (command.type === 'delete') {
        if (modelUsage(settings, model.id).length) throw new ProviderError('model_referenced', 'The workspace default still references this model', 409);
        if (models.length === 1) throw new ProviderError('last_model', 'The last catalog model cannot be deleted', 409);
        models.splice(models.indexOf(model), 1);
        model = null;
      }
    }
    if (model && command.type !== 'apply') {
      if (model.revision === Number.MAX_SAFE_INTEGER) throw new ProviderError('model_revision_capacity', 'Model revision capacity reached', 413);
      model.revision++; model.updatedAt = now;
    }
  }
  if (model) validateModelEnvelope(model);
  validateModelReference(models, settings);
  return { models, settings, model };
}
