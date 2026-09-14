import { parseStrictJson } from '../data/snapshot.js';
import { createModelCommandRecovery } from '../data/command-recovery.js';
import { escapeHtml as esc, icon, button, downloadJson } from '../utils/dom.js';
import { UNITS } from '../config.js';
import { presentationFields, bindPresentationFields } from './presentation-fields.js';

const copy = value => JSON.parse(JSON.stringify(value));
const standard = { theme: 'light', rowHeight: 32, fontSize: 13, groupBy: 'none', displayUnit: 'HOUR', timeZone: 'UTC', scaleMode: 'uniform', ratio: 4, bins: 128 };
const lastVersion = model => model?.versions?.at(-1);
const selectedDefinition = (model, version) => version === 'draft' ? model.draft : model.versions.find(item => item.version === Number(version))?.definition;

export function openModelManager(host) {
  const { provider, generation } = host;
  const readOnly = host.readOnly === true;
  const mutationActions = new Set(['model-new', 'model-import', 'model-duplicate', 'model-save', 'model-publish', 'model-apply', 'model-archive', 'model-unarchive', 'model-delete']);
  const assertWritable = () => { if (readOnly) throw new Error('Legacy model catalogs are read-only.'); };
  const opener = document.activeElement;
  let catalog = [], active = null, selected = null, version = null, definition = null, baseline = null;
  let metadata = { name: '', description: '', tags: [] }, jsonText = '', tab = 'fields', modified = false, busy = false, closed = false;
  const recovery = createModelCommandRecovery({ provider, generation, local: host.local, logicalKey: host.recoveryKey || provider.identity });
  let search = '', includeArchived = false, selectionIntent = 0, previewIntent = 0, preview = null, uncertain = recovery.read()[0] || null, executing = false;
  const layer = document.createElement('div'); layer.className = 'model-layer';
  layer.innerHTML = `<section class="model-manager" role="dialog" aria-modal="true" aria-labelledby="model-manager-title">
    <header class="model-manager-header"><div><h2 id="model-manager-title">Model library</h2><span class="model-source">${esc(host.sourceName)} / ${host.local ? 'Local memory' : 'Server'}</span></div><div class="model-header-actions">${button('model-import', 'upload', 'Import definition', true)}${button('model-new', 'plus', 'New model', true, 'class="primary-button"')}${button('model-close', 'x', 'Close model library')}</div></header>
    <div class="model-workspace"><aside class="model-catalog"><div class="model-catalog-controls"><input type="search" class="model-search" aria-label="Search models" placeholder="Search models"><label><input type="checkbox" class="model-archived">Include archived</label></div><div class="model-list" role="listbox" aria-label="Visual models"></div><div class="model-catalog-footer"><span class="model-catalog-count"></span>${button('model-reload', 'refresh-cw', 'Reload catalog')}</div></aside>
    <main class="model-editor"><div class="model-editor-empty">Loading models...</div></main></div>
    <footer class="model-manager-footer"><span class="model-message" role="status" aria-live="polite"></span><span class="model-recovery-warning subtle" role="status" hidden></span><div class="model-footer-actions"></div></footer>
    <input type="file" class="model-file" accept=".json,application/json" hidden>
  </section>`;
  document.body.append(layer);
  const find = selector => layer.querySelector(selector);
  const current = () => !closed && host.isCurrent(provider, generation);
  const assertCurrent = () => { if (!current()) throw new Error('This editor is closed or belongs to another source or generation. No command was sent to the active source.'); };
  function message(text, error = false) { if (closed) return; find('.model-message').textContent = text; find('.model-message').classList.toggle('error', error); }
  function fail(error) {
    if (!current() || error.name === 'AbortError') return;
    message(error.message || String(error), true);
    if ([401, 403].includes(error.status) && current()) host.onAuthorizationError?.(error);
  }
  function refreshIcons() { host.updateIcons(); }
  function refreshRecoveryWarning() { const warning = recovery.warning(); find('.model-recovery-warning').textContent = warning; find('.model-recovery-warning').hidden = !warning; }
  async function stopPreview() { ++previewIntent; if (preview) { const old = preview; preview = null; await old.dispose(); } }
  async function close(force = false) {
    if (closed) return;
    if (!force && executing) { message('A model write is awaiting its reply. Closing is available when it returns or times out.', true); return; }
    if (!force && uncertain && !window.confirm(`Leave with an unconfirmed model write? Reopen Model library on this source to check its original outcome; no command will be retried.${recovery.warning() ? ` ${recovery.warning()}` : host.local ? ' Its identity is retained only while this page remains open.' : ' Only its recovery identity is saved in this browser; browser storage can be cleared.'}`)) return;
    if (!force && !uncertain && modified && !window.confirm('Discard unsaved changes in the model editor? Saved drafts and published versions are retained.')) return;
    closed = true; ++selectionIntent; window.removeEventListener('storage', storageChanged); layer.remove(); await stopPreview(); host.onClose?.(); opener?.focus?.();
  }
  function setBusy(value) {
    busy = value;
    layer.classList.toggle('model-busy', value);
    layer.querySelectorAll('fieldset,.model-json,[data-model-id],[data-model-tab],[data-action=model-new],[data-action=model-import]').forEach(node => { node.disabled = value || !!uncertain; });
    renderActions();
    applyReadOnlyControls();
  }
  function applyReadOnlyControls() {
    if (!readOnly) return;
    layer.querySelectorAll('[name=modelName],[name=modelDescription],[name=modelTags],.model-json').forEach(node => { node.readOnly = true; });
    layer.querySelectorAll('.model-tab-panel fieldset').forEach(node => { node.disabled = true; });
    layer.querySelectorAll('[data-action]').forEach(node => { if (mutationActions.has(node.dataset.action)) node.disabled = true; });
  }
  function changed() { ++selectionIntent; modified = true; message('Unsaved editor changes'); renderActions(); }
  function renderCatalog() {
    if (closed) return;
    const needle = search.toLowerCase();
    const items = catalog.filter(m => (includeArchived || m.lifecycle !== 'archived') && `${m.name} ${m.description} ${m.tags.join(' ')}`.toLowerCase().includes(needle));
    find('.model-list').innerHTML = items.map(m => `<button class="model-catalog-item ${m.id === selected?.id ? 'selected' : ''}" data-model-id="${esc(m.id)}" role="option" aria-selected="${m.id === selected?.id}"><span class="model-theme-chip ${esc((m.draft || lastVersion(m)?.definition || standard).theme)}"></span><span><strong>${esc(m.name)}</strong><small>${m.lifecycle === 'archived' ? 'Archived' : m.draft ? 'Draft available' : `Published v${lastVersion(m)?.version || '-'}`}${active?.modelId === m.id ? ` / Active v${active.version}` : ''}</small></span></button>`).join('') || '<p class="model-list-empty">No matching models</p>';
    find('.model-catalog-count').textContent = `${items.length} of ${catalog.length} models`;
    layer.querySelectorAll('[data-model-id]').forEach(node => { node.disabled = busy || !!uncertain; });
  }
  function metadataMarkup() {
    return `<div class="model-name-row"><label>Name<input name="modelName" maxlength="100" value="${esc(metadata.name)}" required aria-label="Model name"></label><div class="model-version-field"><label>Definition<select class="model-version" aria-label="Model version">${selected?.draft || !selected ? `<option value="draft" ${version === 'draft' ? 'selected' : ''}>Draft</option>` : ''}${(selected?.versions || []).slice().reverse().map(v => `<option value="${v.version}" ${String(version) === String(v.version) ? 'selected' : ''}>Published v${v.version}${active?.modelId === selected.id && active.version === v.version ? ' / Active' : ''}</option>`).join('')}</select></label></div></div><details class="model-metadata"><summary>Description and tags</summary><label>Description<textarea name="modelDescription" rows="2" maxlength="2000">${esc(metadata.description)}</textarea></label><label>Tags<input name="modelTags" value="${esc(metadata.tags.join(', '))}" placeholder="Comma-separated tags"></label></details>`;
  }
  function fieldsMarkup() {
    const select = (name, label, values) => `<label>${label}<select data-definition-field="${name}">${values.map(v => { const [key, title] = Array.isArray(v) ? v : [v, v[0] + v.slice(1).toLowerCase()]; return `<option value="${key}" ${definition[name] === key ? 'selected' : ''}>${title}</option>`; }).join('')}</select></label>`;
    let zones = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Australia/Sydney'];
    if (typeof Intl.supportedValuesOf === 'function') zones = ['UTC', ...Intl.supportedValuesOf('timeZone')];
    return `<div class="model-definition-grid">${select('theme', 'Appearance', ['light', 'classic', 'dark'])}${select('groupBy', 'Grouping', [['none', 'None'], ['sourceId', 'Source'], ['kind', 'Record type']])}<label>Row height<input type="number" min="32" max="128" step="1" data-definition-field="rowHeight" value="${esc(definition.rowHeight)}"></label><label>Font size<input type="number" min="11" max="24" step="1" data-definition-field="fontSize" value="${esc(definition.fontSize)}"></label>${select('displayUnit', 'Display unit', UNITS)}<label>Display time zone<input list="model-time-zones" data-definition-field="timeZone" value="${esc(definition.timeZone)}" autocomplete="off"><datalist id="model-time-zones">${zones.map(z => `<option value="${esc(z)}"></option>`).join('')}</datalist></label>${select('scaleMode', 'Time scale', [['uniform', 'Uniform'], ['adaptive', 'Automatic']])}<label>Maximum local ratio<input type="number" min="1" max="32" step="any" data-definition-field="ratio" value="${esc(definition.ratio)}"></label><label>Density bins<input type="number" min="16" max="256" step="1" data-definition-field="bins" value="${esc(definition.bins)}"></label></div>${presentationFields(definition)}`;
  }
  function diffMarkup() {
    const keys = [...new Set([...Object.keys(baseline || {}), ...Object.keys(definition || {})])];
    const changes = keys.filter(key => JSON.stringify(baseline?.[key]) !== JSON.stringify(definition?.[key]));
    return changes.length ? `<table class="model-diff"><thead><tr><th>Field</th><th>Published baseline</th><th>Editor definition</th></tr></thead><tbody>${changes.map(key => `<tr><th>${esc(key)}</th><td>${esc(JSON.stringify(baseline?.[key]) ?? '(absent)')}</td><td>${esc(JSON.stringify(definition?.[key]) ?? '(absent)')}</td></tr>`).join('')}</tbody></table>` : '<div class="model-no-changes">No definition changes from the selected baseline.</div>';
  }
  function renderEditor() {
    if (closed || !definition) return;
    const archived = selected?.lifecycle === 'archived';
    find('.model-editor').innerHTML = `<fieldset class="model-fields" ${busy ? 'disabled' : ''}>${metadataMarkup()}</fieldset><div class="model-editor-toolbar"><div class="model-editor-tabs" role="tablist" aria-label="Model editor views">${[['fields', 'Definition'], ['json', 'JSON'], ['diff', 'Changes'], ['preview', 'Preview']].map(([id, label]) => `<button role="tab" data-model-tab="${id}" aria-selected="${tab === id}" class="${tab === id ? 'active' : ''}">${label}</button>`).join('')}</div><span class="model-revision">${selected ? `${archived ? 'Archived / ' : ''}Revision ${selected.revision}` : 'New model'}</span></div><div class="model-tab-panel" role="tabpanel">${tab === 'fields' ? `<fieldset class="model-fields" ${busy ? 'disabled' : ''}>${fieldsMarkup()}</fieldset>` : tab === 'json' ? `<textarea class="model-json" spellcheck="false" aria-label="Model definition JSON">${esc(jsonText)}</textarea>` : tab === 'diff' ? diffMarkup() : '<div class="model-preview-heading"><span>Read-only preview</span><span class="model-preview-summary"></span></div><div class="model-preview-canvas"></div><div class="model-preview-axis"></div>'}</div>`;
    if (archived) find('.model-editor').classList.add('model-is-archived'); else find('.model-editor').classList.remove('model-is-archived');
    bindEditor(); renderActions(); refreshIcons();
    layer.querySelectorAll('fieldset,.model-json,[data-model-tab]').forEach(node => { node.disabled = busy || !!uncertain; });
    applyReadOnlyControls();
    if (tab === 'preview') showPreview();
  }
  function renderActions() {
    if (closed) return;
    const exists = !!selected, archived = selected?.lifecycle === 'archived', hasDraft = !!selected?.draft;
    const canApply = exists && version !== 'draft' && !modified && !archived;
    const blocked = busy || !!uncertain;
    layer.querySelectorAll('[data-action=model-new],[data-action=model-import]').forEach(node => { node.disabled = blocked; });
    find('.model-footer-actions').innerHTML = `${button('model-export', 'download', 'Export definition', false, blocked || !definition ? 'disabled' : '')}${button('model-duplicate', 'copy', 'Duplicate model', false, blocked || !definition ? 'disabled' : '')}${exists ? button(archived ? 'model-unarchive' : 'model-archive', archived ? 'archive-restore' : 'archive', archived ? 'Unarchive model' : 'Archive model', false, blocked ? 'disabled' : '') : ''}${exists ? button('model-delete', 'trash-2', 'Delete model', false, blocked || active?.modelId === selected.id || catalog.length <= 1 ? 'disabled' : 'class="danger"') : ''}<span class="model-action-divider"></span>${button('model-validate', 'check-check', 'Validate', true, blocked || !definition ? 'disabled' : '')}${button('model-save', 'save', 'Save draft', true, blocked || archived || !definition ? 'disabled' : '')}${button('model-publish', 'upload', 'Publish', true, blocked || archived || !hasDraft || modified ? 'disabled' : '')}${button('model-apply', 'check', `Apply${canApply ? ` v${version}` : ''}`, true, `class="primary-button" ${blocked || !canApply ? 'disabled' : ''}`)}${uncertain ? '<button class="model-outcome-check" data-action="model-outcome">Check original outcome</button>' : ''}`;
    applyReadOnlyControls();
    refreshIcons();
  }
  function bindEditor() {
    if (!readOnly) bindPresentationFields(find('.model-editor'), definition, () => { jsonText = JSON.stringify(definition, null, 2); changed(); }, () => {
      const open = new Set([...layer.querySelectorAll('.presentation-section[open]')].map(node => node.querySelector('summary').textContent));
      const scroll = find('.model-tab-panel')?.scrollTop || 0, focused = document.activeElement;
      const selector = focused?.dataset.presentationPath ? `[data-presentation-path="${focused.dataset.presentationPath}"]` : focused?.hasAttribute('data-presentation-enabled') ? '[data-presentation-enabled]' : focused?.dataset.presentationAction ? `[data-presentation-action="${focused.dataset.presentationAction}"]` : null;
      renderEditor();
      for (const node of layer.querySelectorAll('.presentation-section')) if (open.has(node.querySelector('summary').textContent)) node.open = true;
      if (find('.model-tab-panel')) find('.model-tab-panel').scrollTop = scroll;
      if (selector) find(selector)?.focus({ preventScroll: true });
    });
    if (!readOnly) {
      find('[name=modelName]')?.addEventListener('input', e => { metadata.name = e.target.value; changed(); });
      find('[name=modelDescription]')?.addEventListener('input', e => { metadata.description = e.target.value; changed(); });
      find('[name=modelTags]')?.addEventListener('input', e => { metadata.tags = e.target.value.split(',').map(t => t.trim()).filter(Boolean); changed(); });
    }
    find('.model-version')?.addEventListener('change', async e => {
      if (modified && !window.confirm('Discard unsaved editor changes and open this version?')) { e.target.value = version; return; }
      await stopPreview(); loadDefinition(selected, e.target.value);
    });
    if (!readOnly) layer.querySelectorAll('[data-definition-field]').forEach(input => input.addEventListener('input', e => {
      const key = e.target.dataset.definitionField;
      definition[key] = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
      jsonText = JSON.stringify(definition, null, 2); changed();
    }));
    if (!readOnly) find('.model-json')?.addEventListener('input', e => { jsonText = e.target.value; changed(); });
  }
  function parseEditor() {
    if (tab === 'json') definition = parseStrictJson(jsonText);
    if (!definition || Array.isArray(definition) || typeof definition !== 'object') throw new Error('A model definition must be a JSON object.');
    return definition;
  }
  async function validated() {
    assertCurrent(); parseEditor();
    const candidate = copy(definition), intent = selectionIntent;
    const result = await provider.validateModel(candidate);
    assertCurrent();
    if (intent !== selectionIntent) throw new DOMException('Editor changed during validation', 'AbortError');
    if (!result.valid) throw new Error(result.errors.map(error => `${error.path || 'definition'}: ${error.message}`).join(' / '));
    return candidate;
  }
  async function prepare(work) {
    if (busy) return;
    assertCurrent(); setBusy(true);
    try { return await work(); } finally { setBusy(false); }
  }
  function loadDefinition(model, targetVersion = null) {
    ++selectionIntent;
    selected = model;
    version = targetVersion ?? (model?.draft ? 'draft' : lastVersion(model)?.version ?? 'draft');
    definition = copy(model ? selectedDefinition(model, version) || standard : host.defaultDefinition || standard);
    baseline = copy(model ? (version === 'draft' ? lastVersion(model)?.definition : selectedDefinition(model, version)) || {} : {});
    metadata = { name: model?.name || 'Untitled model', description: model?.description || '', tags: copy(model?.tags || []) };
    jsonText = JSON.stringify(definition, null, 2); modified = false;
    renderCatalog(); renderEditor(); message(uncertain ? 'An original model write still needs an outcome check. No new command will be sent.' : model ? `Model ${model.name}${model.draft ? ' / Draft available' : ''}` : 'New unsaved model');
  }
  async function selectModel(id) {
    if (busy || uncertain) return;
    if (modified && !window.confirm('Discard unsaved editor changes and open another model?')) return;
    const intent = ++selectionIntent; await stopPreview();
    try { const result = await provider.getModel(id); if (!current() || intent !== selectionIntent) return; loadDefinition(result.model); } catch (error) { fail(error); }
  }
  async function reloadCatalog(selectId = null, keepEditor = false) {
    assertCurrent(); const result = await provider.listModels({ includeArchived: true }); assertCurrent();
    catalog = result.items; active = result.active; renderCatalog();
    if (!keepEditor) {
      const model = catalog.find(m => m.id === (selectId || selected?.id || active?.modelId)) || catalog.find(m => m.lifecycle === 'active') || catalog[0];
      if (model) loadDefinition(model);
      else loadDefinition(null);
    }
  }
  async function showPreview() {
    const intent = ++previewIntent;
    const old = preview; preview = null; if (old) await old.dispose();
    try {
      const candidate = await validated(); if (!current() || intent !== previewIntent || tab !== 'preview') return;
      message('Preparing read-only preview...');
      const result = host.createPreview(find('.model-preview-canvas'), find('.model-preview-axis'), candidate);
      preview = result;
      result.subscribe?.(status => {
        if (!current() || intent !== previewIntent || tab !== 'preview') return;
        if (status.error) fail(status.error);
        else if (status.summary) { find('.model-preview-summary').textContent = status.summary; message('Preview only / Active model unchanged'); }
      });
      const summary = await result.ready;
      if (!current() || intent !== previewIntent || tab !== 'preview') { await result.dispose(); return; }
      find('.model-preview-summary').textContent = summary; message('Preview only / Active model unchanged');
    } catch (error) { if (intent === previewIntent) fail(error); }
  }
  async function handleResult(command, result) {
    recovery.clear(command.clientCommandId); uncertain = recovery.read()[0] || null; refreshRecoveryWarning(); modified = false;
    if (tab === 'preview') tab = 'fields';
    if (result.model) loadDefinition(result.model, command.type === 'publish' ? lastVersion(result.model).version : command.type === 'apply' ? command.payload?.version ?? result.settings.modelVersion : null);
    else loadDefinition(null);
    if (!host.isCurrent(provider, generation)) { message('Command confirmed on its original source. The active source was not changed.'); return; }
    await host.onMutation(result, command.type, command.modelId);
    if (command.type === 'apply') await host.onApply(result.settings);
    if (closed) return;
    await stopPreview();
    await reloadCatalog(result.model?.id);
    if (command.type === 'publish' && result.model) loadDefinition(result.model, lastVersion(result.model).version);
    message(`${command.type === 'apply' ? 'Pinned version applied' : command.type === 'publish' ? 'Immutable version published' : command.type === 'delete' ? 'Model deleted' : 'Model saved'} / ${result.durability === 'memory-only' ? 'Local JSON export pending' : 'Server committed'}`);
  }
  async function command(type, payload = {}, prepared = false) {
    assertWritable();
    uncertain = recovery.read()[0] || uncertain; refreshRecoveryWarning();
    if (uncertain) { setBusy(busy); message('Check the original model-write outcome before sending a new command.'); return; }
    if (busy && !prepared) return;
    assertCurrent();
    const operation = { type, modelId: type === 'create' ? undefined : selected?.id, expectedRevision: type === 'create' ? undefined : selected?.revision, generation, clientCommandId: crypto.randomUUID(), payload: copy(payload) };
    setBusy(true); await stopPreview();
    let result;
    try {
      assertCurrent(); executing = true; recovery.remember(operation); refreshRecoveryWarning();
      try { result = await provider.executeModelCommand(operation); }
      catch (error) { if (error.code === 'write_outcome_unknown') uncertain = recovery.read()[0]; else recovery.clear(operation.clientCommandId); refreshRecoveryWarning(); fail(error); return; }
      try { await handleResult(operation, result); }
      catch (error) { message(`Command confirmed. Follow-up refresh failed: ${error.message}`, true); if ([401, 403].includes(error.status) && current()) host.onAuthorizationError?.(error); }
    }
    finally { executing = false; setBusy(false); }
  }
  async function importDefinition(file) {
    assertWritable();
    if (!file || busy || uncertain) return;
    return prepare(async () => {
    if (file.size > 1024 * 1024) throw new Error('A portable model definition must be at most 1 MiB.');
    const portable = parseStrictJson(await file.text());
    assertCurrent();
    const allowed = ['format', 'formatVersion', 'name', 'description', 'tags', 'definition'];
    if (!portable || typeof portable !== 'object' || Array.isArray(portable) || Object.keys(portable).some(key => !allowed.includes(key)) || portable.format !== 'timeline-visual-model' || portable.formatVersion !== 1) throw new Error('Expected a timeline-visual-model version 1 document with no unknown fields.');
    if (modified && !window.confirm('Discard unsaved editor changes and import this definition as a new model?')) return;
    const validation = await provider.validateModel(portable.definition); if (!validation.valid) throw new Error(validation.errors.map(e => `${e.path}: ${e.message}`).join(' / '));
    assertCurrent();
    await command('create', { name: portable.name, description: portable.description ?? '', tags: portable.tags ?? [], definition: portable.definition }, true);
    });
  }
  async function action(name) {
    if (name === 'model-close') return close();
    if (mutationActions.has(name)) assertWritable();
    if (uncertain && !['model-outcome', 'model-export'].includes(name)) throw new Error('Resolve the original write outcome before starting another model operation.');
    if (busy && name !== 'model-close') return;
    if (name === 'model-new') { if (modified && !window.confirm('Discard unsaved editor changes?')) return; await stopPreview(); assertCurrent(); tab = 'fields'; loadDefinition(null); return; }
    if (name === 'model-reload') { if (modified && !window.confirm('Discard unsaved editor changes and reload the catalog?')) return; await stopPreview(); return reloadCatalog(); }
    if (name === 'model-import') { find('.model-file').click(); return; }
    if (name === 'model-validate') return prepare(async () => { await validated(); message('Valid definition / No catalog changes'); });
    if (name === 'model-save') {
      return prepare(async () => {
      const editorMetadata = copy(metadata);
      const candidate = await validated();
      if (!editorMetadata.name.trim()) throw new Error('Model name is required.');
      const payload = { ...editorMetadata, name: editorMetadata.name.trim() };
      return selected ? command('update', { ...payload, draft: candidate }, true) : command('create', { ...payload, definition: candidate }, true);
      });
    }
    if (name === 'model-publish') return command('publish');
    if (name === 'model-apply') return command('apply', { version: Number(version) });
    if (name === 'model-archive' || name === 'model-unarchive') { if (modified && !window.confirm('Discard unsaved editor changes before changing model lifecycle?')) return; return command(name === 'model-archive' ? 'archive' : 'unarchive'); }
    if (name === 'model-delete') { if (window.confirm(`Permanently delete the unreferenced model "${selected.name}" and its version history?`)) return command('delete'); return; }
    if (name === 'model-duplicate') return prepare(async () => { const originalMetadata = copy(metadata), candidate = await validated(); await stopPreview(); assertCurrent(); loadDefinition(null); definition = candidate; jsonText = JSON.stringify(candidate, null, 2); metadata = { ...originalMetadata, name: `${originalMetadata.name || 'Model'} copy` }; modified = true; renderEditor(); message('New duplicate / Save draft to create a separate model'); });
    if (name === 'model-export') {
      return prepare(async () => {
      const editorMetadata = copy(metadata), exportVersion = version === 'draft' || modified ? 'draft' : `v${version}`;
      const candidate = await validated();
      downloadJson({ format: 'timeline-visual-model', formatVersion: 1, ...editorMetadata, definition: candidate }, `openbexi-model-${(editorMetadata.name || 'definition').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 70)}-${exportVersion}.json`);
      message('Definition download requested / Full catalog history remains in snapshot export');
      });
    }
    if (name === 'model-outcome') {
      if (!uncertain) return;
      return prepare(async () => {
      const original = uncertain;
      const outcome = await provider.getCommandOutcome(original.clientCommandId); assertCurrent();
      if (outcome.state === 'committed') return handleResult(original, outcome.result);
      message('No committed outcome is confirmed. The command has not been retried.', true);
      });
    }
  }
  layer.addEventListener('click', async e => {
    const target = e.target.closest('[data-action]'); if (target) { try { await action(target.dataset.action); } catch (error) { fail(error); } return; }
    const item = e.target.closest('[data-model-id]'); if (item) return selectModel(item.dataset.modelId);
    const targetTab = e.target.closest('[data-model-tab]');
    if (targetTab && !busy && !uncertain) { try { parseEditor(); await stopPreview(); assertCurrent(); tab = targetTab.dataset.modelTab; jsonText = JSON.stringify(definition, null, 2); renderEditor(); } catch (error) { fail(error); } }
  });
  find('.model-search').addEventListener('input', e => { search = e.target.value; renderCatalog(); });
  find('.model-archived').addEventListener('change', e => { includeArchived = e.target.checked; renderCatalog(); });
  find('.model-file').addEventListener('change', e => { importDefinition(e.target.files[0]).catch(fail); e.target.value = ''; });
  layer.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
  layer.addEventListener('drop', e => { if (e.dataTransfer?.files.length) { e.preventDefault(); e.stopPropagation(); importDefinition(e.dataTransfer.files[0]).catch(fail); } });
  layer.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') { const controls = [...layer.querySelectorAll('button,input,select,textarea,summary')].filter(node => !node.disabled && node.getClientRects().length); const first = controls[0], last = controls.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
  });
  function storageChanged() {
    if (!current() || executing) return;
    uncertain = recovery.read()[0] || uncertain; refreshRecoveryWarning(); setBusy(busy);
    if (uncertain) message('An original model write still needs an outcome check. No new command will be sent.');
  }
  window.addEventListener('storage', storageChanged);
  refreshIcons(); refreshRecoveryWarning(); reloadCatalog().catch(fail); find('.model-search').focus();
  return {
    close, isOpen: () => !closed,
    async suspendPreview() {
      if (!preview) return;
      await stopPreview();
      if (current() && tab === 'preview') { tab = 'fields'; renderEditor(); message('Preview closed for source refresh.'); }
    },
  };
}
