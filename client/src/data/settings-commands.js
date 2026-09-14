import { clone, ProviderError, inspectJson } from './data-provider.js';
import { normalizeConfiguration, effectiveSettings } from './configuration-catalog.js';
import definitions from '../../../shared/schemas/configuration-definition.schema.json' with { type: 'json' };

const fail = (code, message, status = 422) => { throw new ProviderError(code, message, status); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

function patchMaps(target, incoming) {
  for (const [key, value] of Object.entries(incoming)) {
    if (['range', 'overview', 'search'].includes(key) && plain(value)) target[key] = { ...target[key], ...clone(value) };
    else Object.defineProperty(target, key, { value: clone(value), enumerable: true, writable: true, configurable: true });
  }
}

export function applySettingsCommand(input, command, actor) {
  inspectJson(command);
  if (!plain(command) || Object.keys(command).some(key => !['scope', 'type', 'expectedRevision', 'generation', 'clientCommandId', 'payload'].includes(key))) fail('invalid_settings', 'Unknown settings command fields');
  if (!['personal', 'workspace'].includes(command.scope)) fail('settings_scope', 'This provider supports personal and workspace overrides', 422);
  if (!['replace', 'patch', 'reset'].includes(command.type) || !plain(command.payload)) fail('invalid_settings', 'Invalid settings operation or payload');
  if (command.generation == null || command.expectedRevision == null) fail('precondition_required', 'Generation and settings revision are required', 428);
  if (command.generation !== input.manifest.generation) fail('generation_mismatch', 'Settings belong to another generation', 409);
  const has = name => actor.capabilities.includes('*') || actor.capabilities.includes(name);
  if (!has('configuration.manage') && !(command.scope === 'personal' && has('configuration.personal'))) fail('configuration_forbidden', 'Settings permission is required', 403);
  const snapshot = normalizeConfiguration(input, actor);
  let settings = command.scope === 'workspace' ? snapshot.defaults : snapshot.preferences.find(item => item.principalId === actor.id);
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== (settings?.revision ?? 0)) fail('settings_revision_conflict', 'Settings changed; reload before editing', 412);
  if ((settings?.revision ?? 0) === Number.MAX_SAFE_INTEGER) fail('settings_capacity', 'Settings revision capacity reached', 413);
  if (!settings) { settings = { principalId: actor.id, revision: 0, values: {} }; snapshot.preferences.push(settings); }
  if (command.type === 'replace') settings.values = clone(command.payload);
  else if (command.type === 'patch') patchMaps(settings.values, command.payload);
  else {
    if (Object.keys(command.payload).length !== 1 || !own(command.payload, 'paths')) fail('invalid_settings', 'Reset requires only paths');
    const paths = command.payload.paths;
    if (paths === null) settings.values = {};
    else {
      if (!Array.isArray(paths) || !paths.length || paths.length > 100 || new Set(paths).size !== paths.length) fail('invalid_settings', 'Reset paths must be null or 1-100 unique JSON pointers');
      for (const path of paths) {
        if (typeof path !== 'string' || !path.startsWith('/') || /~(?![01])/.test(path)) fail('invalid_settings', 'Reset requires valid JSON pointers');
        const parts = path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
        if (parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part)) || parts.length > 2 || (parts.length === 2 && !['range', 'overview', 'search'].includes(parts[0]))) fail('invalid_settings', 'Reset requires a settings field or declared map member');
        if (!own(definitions.$defs.settings.properties, parts[0]) || (parts.length === 2 && !(parts[0] === 'search' ? ['text', 'mode', 'caseSensitive', 'fields'] : ['from', 'to']).includes(parts[1]))) fail('invalid_settings', 'Unknown settings reset path');
        let target = settings.values;
        for (const part of parts.slice(0, -1)) target = plain(target) && own(target, part) ? target[part] : undefined;
        if (plain(target)) delete target[parts.at(-1)];
        if (parts.length === 2 && plain(settings.values[parts[0]]) && !Object.keys(settings.values[parts[0]]).length) delete settings.values[parts[0]];
      }
    }
  }
  settings.revision++;
  delete snapshot.manifest.contentSha256;
  const validated = normalizeConfiguration(snapshot, actor);
  const effective = effectiveSettings(validated, { principalId: actor.id });
  return { snapshot: validated, settings: clone(settings), effectiveSettings: effective };
}
