import { filterFieldTypes } from '../data/configuration-catalog.js';

export function mountFilterSchemaScope(parent, { provider, generation, filters, current, onChange, onBusy } = {}) {
  const container = document.createElement('details'); container.className = 'filter-schema-scope';
  container.innerHTML = '<summary>Data schema scope</summary><fieldset><legend>Published schema versions</legend><div class="filter-schema-choices"></div></fieldset><p role="status" class="subtle"></p>';
  parent.append(container);
  const fieldset = container.querySelector('fieldset'), choices = container.querySelector('.filter-schema-choices'), status = container.querySelector('[role=status]');
  let pins = structuredClone(filters.schemaRefs || []), initialPins, locked = filters.filterId != null, disposed = false, controller, ready = false, resetPending = false;
  const cache = new Map(), active = () => !disposed && current();
  const selected = () => [...choices.querySelectorAll('input:checked')].map(input => JSON.parse(input.value));
  const renderSelection = () => { for (const input of choices.querySelectorAll('input')) input.checked = pins.some(pin => JSON.stringify(pin) === input.value); fieldset.disabled = locked; };
  async function run(task) {
    if (controller) return;
    const request = new AbortController(); controller = request; onBusy?.(true); fieldset.disabled = true;
    const timer = setTimeout(() => request.abort(), 8000);
    const read = async (method, ...args) => { const result = await provider[method](...args, { signal: request.signal }); if (!active() || request.signal.aborted || result.generation !== undefined && result.generation !== generation) throw new Error('Schema scope request expired or the source changed.'); return result; };
    try { await task(read); }
    catch (error) { if (active()) status.textContent = error.message; }
    finally { clearTimeout(timer); controller = null; if (active()) { renderSelection(); onBusy?.(false); if (resetPending) { resetPending = false; resetScope(); } } }
  }
  async function registryFor(next, read) {
    for (const pin of next) if (!cache.has(pin.id)) cache.set(pin.id, (await read('getConfiguration', 'schemas', pin.id)).resource);
    return filterFieldTypes({ schemas: [...cache.values()] }, next);
  }
  function describe() { status.textContent = locked ? 'Schema versions pinned by the published filter.' : pins.length ? `${pins.length} schema version${pins.length === 1 ? '' : 's'} selected. Records outside this schema scope are excluded.` : 'All record schemas. Built-in fields only.'; }
  function resetScope() {
    if (!ready || locked) return;
    if (controller) { resetPending = true; controller.abort(); return; }
    const next = structuredClone(initialPins);
    run(async read => { await onChange({ pins: next, registry: await registryFor(next, read), reset: true }); pins = next; describe(); });
  }
  container.addEventListener('change', () => {
    if (locked || !ready) return;
    const next = selected();
    run(async read => { const registry = await registryFor(next, read); await onChange({ pins: structuredClone(next), registry }); if (!active()) return; pins = next; describe(); });
  });
  run(async read => {
    const catalog = await read('listConfiguration', 'schemas', { includeArchived: true });
    if (locked) {
      const result = await read('getConfiguration', 'filters', filters.filterId);
      const definition = result.resource.versions.find(publication => publication.version === filters.filterVersion)?.definition;
      if (!definition) throw new Error('The current published filter version is unavailable.');
      pins = structuredClone(definition.schemaRefs);
    }
    for (const schema of catalog.items) for (const version of schema.publishedVersions || []) {
      const label = document.createElement('label'); label.className = 'check-label';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = JSON.stringify({ id: schema.id, version }); input.setAttribute('aria-label', `${schema.name} / v${version}`);
      label.append(input, document.createTextNode(`${schema.name} / v${version}${schema.lifecycle === 'archived' ? ' / archived' : ''}`)); choices.append(label);
    }
    await onChange({ pins: structuredClone(pins), registry: await registryFor(pins, read), initial: true });
    initialPins = structuredClone(pins); ready = true; describe();
  });
  return {
    value() { if (!ready) throw new Error('Schema scope is not ready. Close and reopen Filters to retry.'); return { pins: structuredClone(pins), locked }; },
    reset: resetScope,
    dispose() { disposed = true; controller?.abort(); container.remove(); },
  };
}
