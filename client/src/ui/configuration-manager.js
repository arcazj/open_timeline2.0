import { CONFIGURATION_FAMILIES, defaultConfigurationDefinition, filterFieldTypes } from '../data/configuration-catalog.js';
import { createConfigurationCommandRecovery } from '../data/configuration-command-recovery.js';
import { parseStrictJson } from '../data/snapshot.js';
import { ConfigurationFields } from './configuration-fields.js';
import { escapeHtml as esc, icon, downloadJson } from '../utils/dom.js';
import '../styles/configuration.css';
import '../styles/filters.css';

const titles = { sources: 'Sources', groups: 'Groups', schemas: 'Data schemas', filters: 'Saved filters', views: 'Saved views', settings: 'Effective settings' };
const copy = value => structuredClone(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const portableKeys = ['format', 'formatVersion', 'family', 'name', 'description', 'tags', 'visibility', 'definition'];
export function parseConfigurationDefinition(text) {
  const value = parseStrictJson(text);
  if (!plain(value) || value.format !== 'timeline-configuration' || value.formatVersion !== 1 || !CONFIGURATION_FAMILIES.includes(value.family) || Object.keys(value).some(key => !portableKeys.includes(key)) || portableKeys.some(key => !Object.hasOwn(value, key)) || typeof value.name !== 'string' || typeof value.description !== 'string' || !Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== 'string') || !['personal', 'workspace'].includes(value.visibility) || !plain(value.definition)) throw new Error('Expected a complete version-1 timeline-configuration definition without unknown fields.');
  return value;
}

export function openConfigurationManager(host) {
  const { provider, generation, actor } = host, principalId = actor.id;
  const opener = document.activeElement, controllers = new Set(), schemaCache = new Map();
  const recovery = createConfigurationCommandRecovery({ provider, generation, principalId, local: host.local });
  const catalogs = Object.fromEntries(CONFIGURATION_FAMILIES.map(family => [family, []]));
  let family = 'sources', resource = null, actions = [], definition = null, selectedVersion = null, tab = 'fields';
  let fields = null, modified = false, busy = false, closed = false, suspended = false, intent = 0, effective = null, usage = null, impact = null;
  const capabilities = new Set(actor.capabilities || []);
  const can = capability => capabilities.has('*') || capabilities.has(capability);
  const current = () => !closed && host.isCurrent(provider, generation, principalId);
  const assertCurrent = () => { if (!current()) throw new Error('This configuration editor is closed or belongs to another source, generation or principal. No command was sent.'); };
  const layer = document.createElement('div'); layer.className = 'configuration-backdrop';
  layer.innerHTML = `<section class="configuration-manager" role="dialog" aria-modal="true" aria-labelledby="configuration-title"><header class="cfg-header"><div><h2 id="configuration-title">Configuration</h2><span class="cfg-source">${esc(host.sourceName || 'Workspace')} / ${host.local ? 'Local identity, unverified' : esc(actor.name || actor.id)}</span></div><div class="cfg-header-actions"><button type="button" data-cfg-action="import" title="Import definition" aria-label="Import definition">${icon('file-up')}</button><button type="button" data-cfg-action="export" title="Export definition" aria-label="Export definition">${icon('file-down')}</button><button type="button" data-cfg-action="reload" title="Reload catalog" aria-label="Reload catalog">${icon('refresh-cw')}</button><button type="button" data-cfg-action="close" title="Close configuration" aria-label="Close configuration">${icon('x')}</button></div></header><nav class="cfg-families" aria-label="Configuration families">${[...CONFIGURATION_FAMILIES, 'settings'].map(name => `<button type="button" data-cfg-family="${name}" aria-pressed="${name === family}">${titles[name]}</button>`).join('')}</nav><div class="cfg-workspace"><aside class="cfg-catalog"><div class="cfg-catalog-tools"><input type="search" class="cfg-search" aria-label="Search configuration" placeholder="Search catalog"><button type="button" data-cfg-action="new" title="New resource" aria-label="New resource">${icon('plus')}</button></div><label class="check-label cfg-archive-toggle"><input type="checkbox" class="cfg-include-archived">Include archived</label><div class="cfg-catalog-items"></div><span class="cfg-catalog-count"></span></aside><main class="cfg-editor"></main></div><footer class="cfg-footer"><div><p class="cfg-message" role="status" aria-live="polite"></p><p class="cfg-recovery-warning subtle" role="status" hidden></p><button type="button" class="cfg-outcome-check" hidden>${icon('search-check')}Check original outcome</button></div><div class="cfg-actions"></div></footer><input type="file" class="cfg-import-file" accept=".json,application/json" hidden></section>`;
  document.body.append(layer);
  const find = selector => layer.querySelector(selector);
  const message = value => { if (!closed) find('.cfg-message').textContent = value; };
  const warn = () => { const node = find('.cfg-recovery-warning'); node.textContent = recovery.warning(); node.hidden = !node.textContent; };
  function fail(error) { message(error.message || String(error)); if (current() && [401, 403].includes(error.status)) host.onAuthorizationError?.(error); }
  const creationAllowed = (target = family, visibility = 'workspace') => ['sources', 'groups'].includes(target) ? can('configuration.manage') && can('configuration.publish') : visibility === 'workspace' ? can('configuration.manage') : can('configuration.personal');
  const pending = () => recovery.read();
  const effectiveInput = () => host.transientSettings ? { transient: host.transientSettings() } : {};
  function lock() {
    for (const node of layer.querySelectorAll('button,input,select,textarea')) {
      if (node.matches('[data-cfg-action=close]')) continue;
      if (suspended) { node.disabled = !node.matches('[data-cfg-action=export]'); continue; }
      if (busy) { if (!node.hasAttribute('data-was-disabled')) node.dataset.wasDisabled = String(node.disabled); node.disabled = true; }
      else if (node.hasAttribute('data-was-disabled')) { node.disabled = node.dataset.wasDisabled === 'true'; delete node.dataset.wasDisabled; }
    }
    find('.cfg-outcome-check').hidden = !pending().length;
    if (!busy) find('.cfg-outcome-check').disabled = suspended || !pending().length;
    warn();
  }
  async function read(method, ...args) {
    const controller = new AbortController(); controllers.add(controller);
    try { let result; if (method === 'configurationUsage') { const options = args.pop(); result = await provider[method](...args, { ...options, signal: controller.signal }); } else result = await provider[method](...args, { signal: controller.signal }); if (result?.generation !== undefined && result.generation !== generation) throw new Error('The workspace generation changed. Reopen configuration on the current source.'); return result; }
    finally { controllers.delete(controller); }
  }
  async function close(force = false) {
    if (closed) return;
    if (!force && modified && !confirm('Discard unsaved configuration edits?')) return;
    if (!force && pending().length && !confirm('Close this editor and retain the original command identity for later recovery? No retry will be sent.')) return;
    closed = true; intent++; for (const controller of controllers) controller.abort(); layer.remove(); host.onClose?.(); opener?.focus?.();
  }
  function suspend() {
    if (closed) return;
    suspended = true; intent++; for (const controller of controllers) controller.abort();
    message('The active source changed. This original draft is read-only; export or close it. No command was transferred.'); lock();
  }
  function metadata() { return { name: find('[name=cfgName]')?.value.trim() || '', description: find('[name=cfgDescription]')?.value || '', tags: (find('[name=cfgTags]')?.value || '').split(',').map(value => value.trim()).filter(Boolean), visibility: resource?.visibility || find('[name=cfgVisibility]')?.value || 'workspace' }; }
  function collect({ validate = false } = {}) {
    if (tab === 'json') { const text = find('.cfg-json').value; if (new TextEncoder().encode(text).length > 64 * 1024) throw new Error('Configuration definitions are limited to 64 KiB.'); return parseStrictJson(text); }
    if (tab === 'fields' && fields) return fields.value({ validate });
    return copy(definition);
  }
  function discard() { return !modified || confirm('Discard unsaved configuration edits?'); }
  function filteredItems() { const text = find('.cfg-search').value.toLocaleLowerCase(), archived = find('.cfg-include-archived').checked; return (catalogs[family] || []).filter(item => (archived || item.lifecycle !== 'archived') && `${item.name} ${item.description} ${(item.tags || []).join(' ')}`.toLocaleLowerCase().includes(text)); }
  function renderCatalog() {
    find('.cfg-catalog').hidden = family === 'settings';
    find('[data-cfg-action=export]').disabled = family === 'settings' || !definition;
    if (family === 'settings') return;
    const items = filteredItems();
    find('.cfg-catalog-items').innerHTML = items.map(item => `<button type="button" class="cfg-catalog-item" data-resource-id="${esc(item.id)}" aria-pressed="${item.id === resource?.id}"><strong>${esc(item.name)}</strong><span>${esc(item.visibility)} / ${item.hasDraft ? 'Draft' : `v${item.publishedVersions?.at(-1) || 1}`}${item.lifecycle === 'archived' ? ' / archived' : ''}</span></button>`).join('') || '<p class="cfg-empty">No resources</p>';
    find('.cfg-catalog-count').textContent = `${items.length} / ${(catalogs[family] || []).length} visible resources`;
    find('[data-cfg-action=new]').disabled = !creationAllowed(family, 'workspace') && !creationAllowed(family, 'personal') || pending().length > 0;
  }
  function renderActions() {
    if (family === 'settings' || !definition) { find('.cfg-actions').innerHTML = ''; lock(); return; }
    const blocked = pending().length > 0, writable = resource ? actions.includes('update') && resource.lifecycle !== 'archived' : creationAllowed(family, metadata().visibility);
    const commands = [{ action: 'validate', text: 'Validate', glyph: 'check-check', disabled: false }];
    if (writable) commands.push({ action: 'save', text: resource ? 'Save draft' : ['sources', 'groups'].includes(family) ? 'Create and publish' : 'Create draft', glyph: 'save', disabled: blocked });
    if (resource) {
      if (actions.includes('publish')) commands.push({ action: 'publish', text: 'Publish', glyph: 'upload', disabled: blocked || modified || !resource.draft });
      if (actions.includes('apply') && host.onApply && ['filters', 'views'].includes(family)) commands.push({ action: 'apply', text: 'Apply version', glyph: 'check', disabled: blocked || modified || !selectedVersion });
      for (const [action, text, glyph] of [['duplicate', 'Duplicate', 'copy'], ['archive', 'Archive', 'archive'], ['unarchive', 'Unarchive', 'archive-restore'], ['delete', 'Delete', 'trash-2']]) if (actions.includes(action)) commands.push({ action, text, glyph, disabled: blocked || (action === 'delete' && !!usage?.deletionBlocked) });
    }
    find('.cfg-actions').innerHTML = commands.map(command => `<button type="button" data-cfg-action="${command.action}" ${command.disabled ? 'disabled' : ''} class="${command.action === 'save' ? 'primary-button' : command.action === 'delete' ? 'danger' : ''}">${icon(command.glyph)}${command.text}</button>`).join('');
    host.updateIcons(); lock();
  }
  async function registryFor(value) {
    if (family !== 'filters') return undefined;
    const schemas = [];
    for (const pin of value.schemaRefs || []) {
      let schema = schemaCache.get(pin.id);
      if (!schema || !schema.versions.some(version => version.version === pin.version)) { const result = await read('getConfiguration', 'schemas', pin.id); assertCurrent(); schema = result.resource; schemaCache.set(pin.id, schema); }
      schemas.push(schema);
    }
    return filterFieldTypes({ schemas }, value.schemaRefs || []);
  }
  async function renderDefinition() {
    fields = null;
    const body = find('.cfg-definition'); if (!body) return;
    if (tab === 'json') body.innerHTML = `<textarea class="cfg-json" spellcheck="false" aria-label="Configuration definition JSON">${esc(JSON.stringify(definition, null, 2))}</textarea>`;
    else if (tab === 'fields') {
      const ticket = intent, registry = await registryFor(definition);
      if (!current() || ticket !== intent || tab !== 'fields') return;
      body.innerHTML = '<div class="cfg-fields"></div>';
      fields = new ConfigurationFields(body.firstElementChild, { family, definition, catalogs, models: host.models, settings: effective?.values || host.settings || {}, fieldTypes: registry, updateIcons: host.updateIcons, onChange: () => { modified = true; renderActions(); } });
    } else if (tab === 'history') body.innerHTML = `<table class="cfg-data-table"><thead><tr><th>Version</th><th>Published</th><th>Principal</th></tr></thead><tbody>${(resource?.versions || []).slice().reverse().map(version => `<tr><td><button type="button" data-history-version="${version.version}">v${version.version}</button></td><td>${esc(version.publishedAt)}</td><td>${esc(version.publishedBy || 'legacy')}</td></tr>`).join('')}</tbody></table>${resource?.copiedFrom ? `<p class="subtle">Copied from ${esc(JSON.stringify(resource.copiedFrom))}</p>` : ''}`;
    else if (tab === 'usage') await showUsage();
    else if (tab === 'impact') await showImpact();
    renderActions();
  }
  async function renderEditor() {
    if (family === 'settings') { await showSettings(); return; }
    const defaults = !resource && !creationAllowed(family, 'workspace') ? 'personal' : resource?.visibility || 'workspace';
    find('.cfg-editor').innerHTML = `<div class="cfg-metadata"><label>Name<input name="cfgName" maxlength="200" required value="${esc(resource?.name || '')}"></label><label>Visibility<select name="cfgVisibility" ${resource ? 'disabled' : ''}>${['workspace', ...(!['sources', 'groups'].includes(family) ? ['personal'] : [])].map(value => `<option value="${value}" ${value === defaults ? 'selected' : ''}>${value === 'workspace' ? 'Workspace' : 'Personal'}</option>`).join('')}</select></label><label class="full">Description<textarea name="cfgDescription" maxlength="4000">${esc(resource?.description || '')}</textarea></label><label class="full">Tags<input name="cfgTags" value="${esc((resource?.tags || []).join(', '))}"></label></div><div class="cfg-version-bar"><span>${resource ? `${esc(resource.id)} / revision ${resource.revision}` : 'New identity'}</span><label>Definition<select class="cfg-version" ${resource ? '' : 'disabled'}>${resource?.draft || !resource ? '<option value="draft">Draft</option>' : ''}${(resource?.versions || []).slice().reverse().map(version => `<option value="${version.version}" ${version.version === selectedVersion ? 'selected' : ''}>Version ${version.version}</option>`).join('')}</select></label></div><nav class="cfg-tabs" aria-label="Configuration detail">${['fields', 'json', ...(resource ? ['history', 'usage', ...(family === 'schemas' && typeof provider.previewSchemaImpact === 'function' ? ['impact'] : [])] : [])].map(name => `<button type="button" data-cfg-tab="${name}" aria-pressed="${name === tab}">${{ fields: 'Fields', json: 'JSON', history: 'History', usage: 'References', impact: 'Schema impact' }[name]}</button>`).join('')}</nav><div class="cfg-definition"></div><div class="cfg-errors" role="alert"></div>`;
    if (resource && selectedVersion === null && resource.draft) find('.cfg-version').value = 'draft';
    await renderDefinition();
    if (resource && !actions.includes('update')) for (const control of find('.cfg-metadata').querySelectorAll('input,textarea,select')) control.disabled = true;
  }
  async function selectResource(id, { bypass = false, version } = {}) {
    if (!bypass && !discard()) return;
    const ticket = ++intent; busy = true; lock();
    try {
      const result = await read('getConfiguration', family, id); if (!current() || ticket !== intent) return;
      resource = result.resource; actions = result.allowedActions || [];
      const publication = version === undefined ? null : resource.versions.find(item => item.version === version);
      if (version !== undefined && !publication) throw new Error('The requested published version is unavailable. No other version was selected.');
      definition = copy(publication?.definition ?? resource.draft ?? resource.versions.at(-1).definition); selectedVersion = publication?.version ?? (resource.draft ? null : resource.versions.at(-1).version);
      modified = false; tab = 'fields'; usage = null; impact = null; renderCatalog(); await renderEditor(); message('');
    } catch (error) { if (current() && ticket === intent) fail(error); }
    finally { if (current() && ticket === intent) { busy = false; renderActions(); } }
  }
  async function newResource(imported) {
    if (!discard()) return;
    if (imported) family = imported.family;
    if (!creationAllowed(family, imported?.visibility || 'workspace') && !creationAllowed(family, 'personal')) throw new Error('The active principal cannot create this resource.');
    intent++; resource = null; actions = []; selectedVersion = null; usage = null; impact = null; tab = 'fields'; modified = false;
    definition = imported ? copy(imported.definition) : defaultConfigurationDefinition(family, { settings: effective?.values || host.settings });
    renderCatalog(); await renderEditor();
    if (imported) { find('[name=cfgName]').value = imported.name; find('[name=cfgDescription]').value = imported.description; find('[name=cfgTags]').value = imported.tags.join(', '); find('[name=cfgVisibility]').value = imported.visibility; modified = true; renderActions(); }
    for (const button of layer.querySelectorAll('[data-cfg-family]')) button.setAttribute('aria-pressed', String(button.dataset.cfgFamily === family));
    find('[name=cfgName]')?.focus();
  }
  async function loadFamily(next = family, preferredId, preferredVersion) {
    if (!discard()) return;
    const ticket = ++intent; family = next; modified = false; busy = true; lock();
    for (const button of layer.querySelectorAll('[data-cfg-family]')) button.setAttribute('aria-pressed', String(button.dataset.cfgFamily === family));
    try {
      if (family === 'settings') { resource = null; renderCatalog(); await showSettings(); return; }
      const result = await read('listConfiguration', family, { includeArchived: true }); if (!current() || ticket !== intent) return;
      catalogs[family] = result.items; renderCatalog();
      const preferred = catalogs[family].find(item => item.id === preferredId);
      if (preferredVersion !== undefined && !preferred) throw new Error('The requested preset is no longer accessible. No other preset was selected.');
      const selected = preferred || filteredItems()[0];
      busy = false;
      if (selected) await selectResource(selected.id, { bypass: true, ...(preferredVersion === undefined ? {} : { version: preferredVersion }) });
      else if (creationAllowed(family, 'workspace') || creationAllowed(family, 'personal')) await newResource();
      else { resource = null; definition = null; actions = []; fields = null; find('.cfg-editor').innerHTML = '<p class="cfg-empty">No resources available to this principal.</p>'; }
    } catch (error) { if (current()) fail(error); }
    finally { if (current()) { busy = false; renderActions(); } }
  }
  async function validate(value, meta) {
    const result = await read('validateConfiguration', family, copy(value), { ...(resource ? { resourceId: resource.id } : {}), visibility: meta.visibility }); assertCurrent();
    find('.cfg-errors').replaceChildren();
    if (!result.valid) {
      for (const error of result.errors) { const node = document.createElement('p'); node.textContent = `${error.path}: ${error.message}`; find('.cfg-errors').append(node); }
      throw new Error('Definition validation failed. No command was sent.');
    }
    return result;
  }
  async function installConfirmed(command, result) {
    recovery.clear(command.clientCommandId);
    if (!current()) {
      if (host.isCurrent(provider, generation, principalId)) {
        try { await host.onMutation?.(result); }
        catch (error) { if (host.isCurrent(provider, generation, principalId) && [401, 403].includes(error.status)) host.onAuthorizationError?.(error); }
      }
      return;
    }
    if (result.effectiveSettings) effective = { ...effective, ...result.effectiveSettings };
    if (command.family !== 'settings' && command.family === family) {
      resource = result.resource; modified = false; usage = null; impact = null;
      if (resource) { definition = copy(resource.draft ?? resource.versions.at(-1).definition); selectedVersion = resource.draft ? null : resource.versions.at(-1).version; }
    }
    try {
      await host.onMutation?.(result); assertCurrent();
      if ((command.type === 'apply' || command.family === 'settings') && result.effectiveSettings) { effective = await read('getEffectiveSettings', {}); assertCurrent(); await host.onApply?.(effective, result.resetTransientKeys || []); effective = await read('getEffectiveSettings', effectiveInput()); }
      assertCurrent();
      if (family === 'settings') await showSettings();
      else await loadFamily(family, result.resource?.id);
      message(`Configuration committed / ${result.durability === 'memory' ? 'Local JSON export pending' : 'JSON files'}`);
    } catch (error) { if (current()) { if (family !== 'settings' && resource) await renderEditor(); message(`Command confirmed. Follow-up refresh failed: ${error.message}. Do not repeat this command.`); } }
  }
  async function execute(command) {
    assertCurrent();
    if (pending().length) throw new Error('Resolve the original configuration outcome before another mutation.');
    recovery.remember(command); lock();
    let result;
    try { const { family: commandFamily, ...settingsCommand } = command; result = await (commandFamily === 'settings' ? provider.mutateSettings(settingsCommand) : provider.mutateConfiguration(command)); }
    catch (error) { if (error.code !== 'write_outcome_unknown' && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) recovery.clear(command.clientCommandId); throw error; }
    if (result?.status !== 'committed' || result.generation !== generation || result.commandId !== command.clientCommandId) throw new Error('The configuration response was incomplete. Check the original command outcome; no replacement command will be sent.');
    await installConfirmed(command, result);
  }
  async function mutate(type) {
    if (busy) return;
    const ticket = intent, meta = metadata(), target = resource ? copy(resource) : null;
    const command = { family, type, generation, clientCommandId: crypto.randomUUID(), ...(target ? { resourceId: target.id, expectedRevision: target.revision } : {}) };
    const value = ['save', 'validate'].includes(type) ? copy(collect()) : null;
    if (type === 'save') { command.type = target ? 'update' : 'create'; command.payload = target ? { name: meta.name, description: meta.description, tags: meta.tags, draft: value } : { ...meta, definition: value }; }
    if (type === 'apply') { command.payload = { version: selectedVersion }; command.expectedPreferenceRevision = effective?.preferenceRevision ?? 0; }
    if (type === 'duplicate') { const name = prompt('Name for the independent copy', `${target.name} copy`); if (!name) return; command.payload = { name, ...(selectedVersion ? { version: selectedVersion } : {}), visibility: target.visibility }; }
    if (['delete', 'archive'].includes(type) && !confirm(`${type === 'delete' ? 'Delete' : 'Archive'} "${target.name}"? Existing references are checked by the provider.`)) return;
    busy = true; lock();
    try {
      if (value) await validate(value, meta);
      if (type === 'apply') await host.validateApply?.({ family: command.family, resource: target, version: command.payload.version, definition: copy(target.versions.find(version => version.version === command.payload.version).definition) });
      if (ticket !== intent) return; assertCurrent();
      if (type === 'validate') { message('Definition is valid. No changes were made.'); return; }
      await execute(copy(command));
    } catch (error) { if (current()) fail(error); }
    finally { if (current()) { busy = false; renderActions(); } }
  }
  async function checkOriginal() {
    if (busy) return;
    const original = pending()[0]; if (!original) return; busy = true; lock();
    try {
      const outcome = await read('getCommandOutcome', original.clientCommandId); assertCurrent();
      if (outcome.state !== 'committed') { message('No committed outcome is confirmed. Configuration mutations remain locked; no retry was sent.'); return; }
      const result = outcome.result;
      if (result?.generation !== generation || result.commandId !== original.clientCommandId) throw new Error('The outcome does not match this original command and generation. Recovery remains locked.');
      await installConfirmed(original, result);
    } catch (error) { if (current()) fail(error); }
    finally { if (current()) { busy = false; renderActions(); } }
  }
  async function showUsage(cursor) {
    if (!resource) return;
    const ticket = intent, target = resource.id, result = await read('configurationUsage', family, target, selectedVersion ?? undefined, { ...(cursor ? { cursor } : {}), limit: 100 });
    if (!current() || ticket !== intent || tab !== 'usage') return;
    usage = result;
    find('.cfg-definition').innerHTML = `<p>${result.total} disclosed references / ${result.deletionBlocked ? 'Deletion blocked' : 'No reference blocks disclosed deletion'}</p><pre class="cfg-reference-data"></pre>${result.nextCursor ? '<button type="button" data-cfg-usage-next>Next references</button>' : ''}`;
    find('.cfg-reference-data').textContent = JSON.stringify(result.items, null, 2);
    find('[data-cfg-usage-next]')?.addEventListener('click', () => showUsage(result.nextCursor).catch(fail));
  }
  async function showImpact(cursor) {
    if (!resource || typeof provider.previewSchemaImpact !== 'function') return;
    const ticket = intent, candidate = impact?.candidate || (selectedVersion ? { version: selectedVersion } : { definition: copy(definition) });
    const result = await read('previewSchemaImpact', resource.id, { ...candidate, ...(cursor ? { cursor } : {}), limit: 100 });
    if (!current() || ticket !== intent || tab !== 'impact') return;
    impact = { ...result, candidate };
    find('.cfg-definition').innerHTML = `<p>${result.totalAffected} affected records / ${result.totalInvalid} invalid against this candidate</p><pre class="cfg-impact-data"></pre>${result.nextCursor ? '<button type="button" data-cfg-impact-next>Next affected records</button>' : ''}`;
    find('.cfg-impact-data').textContent = JSON.stringify(result.items, null, 2);
    find('[data-cfg-impact-next]')?.addEventListener('click', () => showImpact(result.nextCursor).catch(fail));
  }
  function pointerValue(value, path) { return path.slice(1).split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], value); }
  async function showSettings() {
    const ticket = intent, result = await read('getEffectiveSettings', effectiveInput());
    if (!current() || ticket !== intent || family !== 'settings') return;
    effective = result;
    find('.cfg-editor').innerHTML = `<div class="cfg-settings-heading"><h3>Effective settings</h3><span>Principal ${esc(result.principalId || principalId)} / preferences revision ${result.preferenceRevision ?? 0}</span></div><table class="cfg-data-table cfg-settings-table"><thead><tr><th>Field</th><th>Value</th><th>Origin</th><th></th></tr></thead><tbody>${Object.entries(result.origins).map(([path, origin]) => `<tr><th scope="row">${esc(path)}</th><td><code>${esc(JSON.stringify(pointerValue(result.values, path)))}</code></td><td>${esc(origin)}</td><td>${typeof provider.mutateSettings === 'function' && host.onApply && (can('configuration.personal') || can('configuration.manage')) && origin === `personal:${principalId}` ? `<button type="button" data-reset-path="${esc(path)}" title="Reset to inherited value" aria-label="Reset ${esc(path)} to inherited value" ${pending().length ? 'disabled' : ''}>${icon('rotate-ccw')}</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
    find('.cfg-actions').innerHTML = ''; host.updateIcons(); lock();
  }
  async function resetSetting(path) {
    if (busy || pending().length) return;
    const pin = ['view', 'model', 'filter'].find(prefix => path === `/${prefix}Id` || path === `/${prefix}Version`);
    const paths = pin ? [`/${pin}Id`, `/${pin}Version`] : [path];
    const command = { family: 'settings', scope: 'personal', type: 'reset', expectedRevision: effective.preferenceRevision ?? 0, generation, clientCommandId: crypto.randomUUID(), payload: { paths } };
    busy = true; lock();
    try { await execute(command); } catch (error) { if (current()) fail(error); } finally { if (current()) { busy = false; lock(); } }
  }
  layer.addEventListener('input', event => {
    if (event.target.matches('.cfg-search')) renderCatalog();
    else if (event.target.closest('.cfg-metadata') || event.target.matches('.cfg-json')) { modified = true; renderActions(); }
  });
  layer.addEventListener('change', event => {
    if (event.target.matches('.cfg-include-archived')) renderCatalog();
    if (event.target.matches('[name=cfgVisibility]')) { modified = true; renderActions(); }
    if (event.target.matches('.cfg-version')) {
      if (!discard()) { event.target.value = selectedVersion ?? 'draft'; return; }
      selectedVersion = event.target.value === 'draft' ? null : Number(event.target.value); definition = copy(selectedVersion ? resource.versions.find(version => version.version === selectedVersion).definition : resource.draft); modified = false; impact = null; tab = 'fields'; renderEditor().catch(fail);
    }
    if (event.target.matches('[data-filter-schema]')) {
      try { definition = collect(); intent++; renderDefinition().catch(fail); } catch (error) { fail(error); }
    }
  });
  layer.addEventListener('click', event => {
    const run = async () => {
      const action = event.target.closest('[data-cfg-action]')?.dataset.cfgAction;
      if (action === 'close') { await close(); return; }
      if (suspended && action !== 'export') return;
      if (busy) return;
      const targetFamily = event.target.closest('[data-cfg-family]')?.dataset.cfgFamily;
      if (targetFamily) return loadFamily(targetFamily);
      const targetId = event.target.closest('[data-resource-id]')?.dataset.resourceId;
      if (targetId) return selectResource(targetId);
      const targetTab = event.target.closest('[data-cfg-tab]')?.dataset.cfgTab;
      if (targetTab) { definition = collect(); tab = targetTab; for (const button of layer.querySelectorAll('[data-cfg-tab]')) button.setAttribute('aria-pressed', String(button.dataset.cfgTab === tab)); return renderDefinition(); }
      const version = event.target.closest('[data-history-version]')?.dataset.historyVersion;
      if (version) { if (!discard()) return; selectedVersion = Number(version); definition = copy(resource.versions.find(item => item.version === selectedVersion).definition); modified = false; tab = 'json'; return renderEditor(); }
      const reset = event.target.closest('[data-reset-path]')?.dataset.resetPath; if (reset) return resetSetting(reset);
      if (action === 'new') return newResource();
      if (action === 'reload') return loadFamily(family, resource?.id);
      if (action === 'import') { find('.cfg-import-file').click(); return; }
      if (action === 'export') { if (!definition || family === 'settings') return; downloadJson({ format: 'timeline-configuration', formatVersion: 1, family, ...metadata(), definition: collect() }, `timeline-${family}-definition.json`); message('Definition download requested. History remains in the complete snapshot.'); return; }
      if (action) return mutate(action);
    };
    run().catch(error => { if (current()) fail(error); });
  });
  find('.cfg-outcome-check').onclick = () => checkOriginal();
  find('.cfg-import-file').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try { if (file.size > 80 * 1024) throw new Error('Configuration definition files are limited to 80 KiB.'); const imported = parseConfigurationDefinition(await file.text()); assertCurrent(); if (!creationAllowed(imported.family, imported.visibility)) throw new Error('The active principal cannot import this visibility and resource family.'); await newResource(imported); message('Imported as a new unsaved identity.'); }
    catch (error) { if (current()) fail(error); } finally { event.target.value = ''; }
  };
  layer.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') { const nodes = [...layer.querySelectorAll('button,input,textarea,select')].filter(node => !node.disabled && node.getClientRects().length); if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); } }
  });
  (async () => {
    busy = true; lock(); host.updateIcons();
    try {
      for (const target of CONFIGURATION_FAMILIES) { const result = await read('listConfiguration', target, { includeArchived: true }); assertCurrent(); catalogs[target] = result.items; }
      effective = await read('getEffectiveSettings', effectiveInput()); assertCurrent(); busy = false;
      if (host.initialImport) {
        await newResource(parseConfigurationDefinition(JSON.stringify(host.initialImport)));
        message('Current view captured as an unsaved draft. Nothing has been published or applied.');
      } else await loadFamily(host.initialFamily || 'sources', host.initialResourceId, host.initialVersion);
      if (pending().length) message('An original configuration outcome is unresolved. Mutations are locked until it is confirmed.');
    } catch (error) { if (current()) fail(error); }
    finally { if (current()) { busy = false; renderActions(); } }
  })();
  return { close, suspend, isOpen: () => !closed };
}
