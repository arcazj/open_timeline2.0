import { captureFilterDefinition, captureViewDefinition, exactPublishedFilter, portableViewDraft } from './saved-view-state.js';
import { icon } from '../utils/dom.js';
import '../styles/saved-views.css';

export function mountSavedViewControls(parent, host) {
  const container = document.createElement('div'); container.className = 'saved-view-controls';
  container.innerHTML = `<select aria-label="Saved view preset"><option value="">Saved views</option></select><button type="button" data-preset-action="review" title="Review selected view" aria-label="Review selected view" disabled>${icon('folder-open')}</button><button type="button" data-preset-action="save-filter" title="Save current filter draft" aria-label="Save current filter draft">${icon('list-filter-plus')}</button><button type="button" data-preset-action="save-view" title="Save current view draft" aria-label="Save current view draft">${icon('bookmark-plus')}</button><button type="button" data-preset-action="reload" title="Refresh saved views" aria-label="Refresh saved views">${icon('refresh-cw')}</button><span class="saved-view-status" role="status" aria-live="polite" hidden></span>`;
  parent.append(container);
  const select = container.querySelector('select'), status = container.querySelector('[role=status]');
  let controller, disposed = false, busy = false, sequence = 0, presets = [];
  const current = () => !disposed && host.isCurrent();
  const tell = message => { if (current()) { status.textContent = message; status.hidden = !message; } };
  const lock = () => {
    for (const button of container.querySelectorAll('button')) button.disabled = busy || (button.dataset.presetAction === 'review' && !select.value);
    select.disabled = busy;
  };
  async function operation(task) {
    controller?.abort(); const request = new AbortController(), ticket = ++sequence; controller = request;
    const timeout = setTimeout(() => request.abort(), 8000); busy = true; lock();
    const assertCurrent = () => { if (!current() || ticket !== sequence || request.signal.aborted) throw new Error('The selected source changed or the request expired. Nothing was saved.'); };
    const read = async (method, ...args) => {
      assertCurrent(); const result = await host.provider[method](...args, { signal: request.signal }); assertCurrent();
      if (result.generation !== undefined && result.generation !== host.generation) throw new Error('The source generation changed. Refresh before saving a view.');
      return result;
    };
    try { await task(read, assertCurrent); }
    catch (error) { if (current() && ticket === sequence) tell(error.message || String(error)); }
    finally { clearTimeout(timeout); if (ticket === sequence) { busy = false; lock(); } }
  }
  const reload = () => operation(async read => {
    const result = await read('listConfiguration', 'views', { includeArchived: false });
    presets = result.items.filter(resource => resource.lifecycle !== 'archived').flatMap(resource => (resource.publishedVersions || []).map(version => ({ id: resource.id, version, name: resource.name })));
    const old = select.value; select.replaceChildren(new Option('Saved views', ''));
    presets.forEach(preset => select.add(new Option(`${preset.name} / v${preset.version}`, JSON.stringify([preset.id, preset.version]))));
    select.value = [...select.options].some(option => option.value === old) ? old : '';
    tell('');
  });
  async function save(family) {
    const capture = structuredClone(host.capture());
    await operation(async (read, assertCurrent) => {
      let saved;
      if (capture.filters?.filterId != null) {
        const result = await read('getConfiguration', 'filters', capture.filters.filterId);
        saved = result.resource.versions.find(publication => publication.version === capture.filters.filterVersion)?.definition;
        if (!saved) throw new Error('The active published filter version is unavailable.');
      }
      const definition = captureFilterDefinition(capture, saved);
      if (family === 'filters') {
        assertCurrent(); await host.openConfigurations({ initialImport: portableViewDraft('filters', definition, 'Current timeline filter', host.visibility || 'personal') }); return;
      }
      const catalog = await read('listConfiguration', 'filters', { includeArchived: false }), resources = [];
      for (const item of catalog.items) if (item.lifecycle !== 'archived' && item.publishedVersions?.length) resources.push((await read('getConfiguration', 'filters', item.id)).resource);
      const filterPin = exactPublishedFilter(resources, definition, { id: capture.filters?.filterId, version: capture.filters?.filterVersion });
      if (!filterPin) { tell('No published filter matches this view. Save current filter draft, then publish it before saving the view.'); return; }
      const model = (await read('getModel', capture.model.id)).model;
      if (model.lifecycle === 'archived' || !model.versions.some(publication => publication.version === capture.model.version)) throw new Error('The current published model version is unavailable for a new saved view.');
      assertCurrent(); await host.openConfigurations({ initialImport: portableViewDraft('views', captureViewDefinition(capture, filterPin), 'Current timeline view', filterPin.visibility === 'personal' ? 'personal' : host.visibility || 'personal') });
    });
  }
  select.onchange = () => { tell(''); lock(); };
  container.addEventListener('click', event => {
    const action = event.target.closest('[data-preset-action]')?.dataset.presetAction; if (!action || busy || !current()) return;
    if (action === 'reload') reload();
    else if (action === 'save-filter' || action === 'save-view') save(action === 'save-filter' ? 'filters' : 'views').catch(error => tell(error.message));
    else if (action === 'review') {
      const preset = presets.find(value => JSON.stringify([value.id, value.version]) === select.value); if (!preset) return;
      Promise.resolve(host.openConfigurations({ initialFamily: 'views', initialResourceId: preset.id, initialVersion: preset.version })).catch(error => tell(error.message));
    }
  });
  host.updateIcons?.(); reload();
  return { reload, dispose() { disposed = true; sequence++; controller?.abort(); container.remove(); } };
}
