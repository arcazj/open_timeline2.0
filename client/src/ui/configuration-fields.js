import { parseStrictJson } from '../data/snapshot.js';
import { FilterEditor } from './filter-editor.js';
import { escapeHtml as esc, icon, dateInput, inputIso } from '../utils/dom.js';
import { TIME_UNITS } from '../timeline/time-scale.js';

const copy = value => structuredClone(value);
const option = (value, label, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
const label = (name, input, full = false) => `<label class="${full ? 'full' : ''}"><span>${name}</span>${input}</label>`;
const check = (key, title, value) => `<label class="check-label"><input type="checkbox" data-cfg="${key}" ${value ? 'checked' : ''}>${title}</label>`;
const input = (key, value, attributes = '') => `<input data-cfg="${key}" value="${esc(value ?? '')}" ${attributes}>`;
const select = (key, values, value) => `<select data-cfg="${key}">${values.map(item => option(Array.isArray(item) ? item[0] : item, Array.isArray(item) ? item[1] : item, value)).join('')}</select>`;
const pinOptions = (items, value, optional = true) => (optional ? option('', 'None', value ? JSON.stringify(value) : '') : '') + items.flatMap(item => (item.publishedVersions || item.versions?.map(version => version.version) || []).map(version => option(JSON.stringify({ id: item.id, version }), `${item.name} / v${version}${item.lifecycle === 'archived' ? ' / archived' : ''}`, value ? JSON.stringify(value) : ''))).join('');
const parsePin = node => node.value ? parseStrictJson(node.value) : null;
const scalarSettings = [
  ['theme', 'Appearance', ['light', 'dark', 'classic']], ['mode', 'View', ['timeline', 'table', 'split']],
  ['rowHeight', 'Row height', 'number', 32, 128], ['fontSize', 'Font size', 'number', 10, 24],
  ['groupBy', 'Grouping', ['none', 'sourceId', 'kind']], ['displayUnit', 'Display unit', TIME_UNITS],
  ['timeZone', 'Time zone', 'text'], ['scaleMode', 'Time scale', ['uniform', 'adaptive']],
  ['ratio', 'Maximum local ratio', 'number', 1, 32], ['bins', 'Density bins', 'number', 16, 256],
];

export class ConfigurationFields {
  constructor(element, { family, definition, catalogs, models, settings, updateIcons, onChange, fieldTypes }) {
    Object.assign(this, { element, family, catalogs, models, settings, updateIcons, onChange, fieldTypes });
    this.definition = copy(definition); this.render();
    element.addEventListener('input', () => onChange());
    element.addEventListener('change', event => { onChange(); if (event.target.matches('[data-schema-type]')) this.updateSchemaType(event.target); });
    element.addEventListener('click', event => {
      if (event.target.closest('[data-filter-command]')) { onChange(); return; }
      const command = event.target.closest('[data-cfg-command]'); if (!command) return;
      try {
        this.definition = this.value();
        const index = Number(command.closest('[data-cfg-index]')?.dataset.cfgIndex), action = command.dataset.cfgCommand;
        if (action === 'schema-add') { let n = 1; while (Object.hasOwn(this.definition.schema.properties, `field${n}`)) n++; this.definition.schema.properties[`field${n}`] = { type: 'string' }; }
        if (action === 'schema-remove') { const key = Object.keys(this.definition.schema.properties)[index]; delete this.definition.schema.properties[key]; if (this.definition.schema.required) this.definition.schema.required = this.definition.schema.required.filter(name => name !== key); }
        if (['column-add', 'sort-add'].includes(action)) { const key = action === 'column-add' ? 'columns' : 'sort'; this.definition.settings[key] ||= []; this.definition.settings[key].push(key === 'columns' ? { field: 'title', visible: true, width: 220 } : { field: 'start', direction: 'asc' }); }
        if (action.startsWith('column-') || action.startsWith('sort-')) {
          const key = action.startsWith('column-') ? 'columns' : 'sort', list = this.definition.settings[key];
          if (action.endsWith('-remove')) list.splice(index, 1);
          if (action.endsWith('-up') && index > 0) [list[index - 1], list[index]] = [list[index], list[index - 1]];
          if (action.endsWith('-down') && index < list.length - 1) [list[index + 1], list[index]] = [list[index], list[index + 1]];
        }
        this.render(); onChange();
      } catch (error) { this.error(error); }
    });
  }
  error(error) { this.element.querySelector('.cfg-fields-error')?.remove(); const node = document.createElement('p'); node.className = 'form-error cfg-fields-error'; node.setAttribute('role', 'alert'); node.textContent = error.message; this.element.append(node); }
  command(action, text, glyph) { return `<button type="button" data-cfg-command="${action}" title="${text}" aria-label="${text}">${icon(glyph)}</button>`; }
  render() {
    const value = this.definition;
    this.filterEditor = null;
    if (this.family === 'sources') this.element.innerHTML = `<div class="cfg-form-grid">${label('Storage', '<input value="JSON files" disabled>')}${check('enabled', 'Enabled for new records', value.enabled)}${check('writable', 'Allow record mutations', value.writable)}${label('Default data schema', `<select data-cfg="defaultSchema">${pinOptions(this.catalogs.schemas || [], value.defaultSchema)}</select>`, true)}</div>`;
    if (this.family === 'groups') this.element.innerHTML = `<div class="cfg-form-grid">${label('Display order', input('order', value.order, 'type="number" step="1"'))}${check('collapsed', 'Collapsed by default', value.collapsed)}${check('useColor', 'Use group color', value.color !== null)}${label('Color', input('color', value.color || '#397aa6', 'type="color"'))}</div>`;
    if (this.family === 'schemas') {
      const schema = value.schema;
      this.element.innerHTML = `<div class="cfg-form-grid">${label('Schema title', input('schemaTitle', schema.title), true)}${label('Schema description', `<textarea data-cfg="schemaDescription">${esc(schema.description || '')}</textarea>`, true)}</div><div class="cfg-subheading"><h3>Data properties</h3>${this.command('schema-add', 'Add data property', 'plus')}</div><div class="cfg-schema-properties">${Object.entries(schema.properties || {}).map(([name, property], index) => `<section class="cfg-schema-property" data-cfg-index="${index}"><div class="cfg-property-row"><input data-schema-name aria-label="Property name" value="${esc(name)}"><select data-schema-type aria-label="Property type">${['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].map(type => option(type, type, Array.isArray(property.type) ? property.type.find(type => type !== 'null') : property.type || 'object')).join('')}</select><label class="check-label"><input type="checkbox" data-schema-required ${(schema.required || []).includes(name) ? 'checked' : ''}>Required</label>${this.command('schema-remove', 'Remove data property', 'trash-2')}</div><details><summary>Constraints and nested schema</summary><textarea data-schema-json aria-label="Property schema JSON" spellcheck="false">${esc(JSON.stringify(property, null, 2))}</textarea></details></section>`).join('')}</div>`;
    }
    if (this.family === 'filters') {
      this.element.innerHTML = `<fieldset class="cfg-choice-list"><legend>Sources</legend>${check('allSources', 'All declared sources', value.sourceIds === null)}${(this.catalogs.sources || []).map(source => `<label class="check-label"><input type="checkbox" data-filter-source="${esc(source.id)}" ${(value.sourceIds || []).includes(source.id) ? 'checked' : ''}>${esc(source.name)}</label>`).join('')}</fieldset><fieldset class="cfg-choice-list"><legend>Record types</legend>${['event', 'session'].map(kind => `<label class="check-label"><input type="checkbox" data-filter-kind="${kind}" ${value.kinds.includes(kind) ? 'checked' : ''}>${kind === 'event' ? 'Events' : 'Sessions'}</label>`).join('')}</fieldset><fieldset class="cfg-choice-list"><legend>Data schema scope</legend>${(this.catalogs.schemas || []).flatMap(schema => (schema.publishedVersions || []).map(version => `<label class="check-label"><input type="checkbox" data-filter-schema="${esc(JSON.stringify({ id: schema.id, version }))}" ${value.schemaRefs.some(pin => pin.id === schema.id && pin.version === version) ? 'checked' : ''}>${esc(schema.name)} / v${version}</label>`)).join('') || '<span class="subtle">No published data schemas</span>'}</fieldset><div class="cfg-form-grid">${label('Contextual search', input('search', value.search.text, 'type="search" maxlength="512"'), true)}</div><div class="cfg-filter-builder"></div>`;
      this.filterEditor = new FilterEditor(this.element.querySelector('.cfg-filter-builder'), { expression: value.expression, definitionVersion: value.definitionVersion ?? 1, relationshipMode: value.relationshipMode ?? 'independent', searchMode: value.search.mode, searchCaseSensitive: value.search.caseSensitive, searchFields: value.search.fields, searchFlags: value.search.flags, searchMatchMode: value.search.matchMode, updateIcons: this.updateIcons, ...(this.fieldTypes ? { fieldTypes: this.fieldTypes } : {}) });
    }
    if (this.family === 'views') {
      const values = value.settings;
      this.element.innerHTML = `<div class="cfg-form-grid">${label('Visual model', `<select data-cfg="model">${pinOptions(this.models || [], value.model, false)}</select>`)}${label('Saved filter', `<select data-cfg="filter">${pinOptions(this.catalogs.filters || [], value.filter)}</select>`)}</div><h3>View overrides</h3><div class="cfg-overrides">${scalarSettings.map(([key, title, kind, min, max]) => `<div class="cfg-override"><label class="check-label"><input type="checkbox" data-override="${key}" ${Object.hasOwn(values, key) ? 'checked' : ''}>${title}</label>${Array.isArray(kind) ? select(`setting-${key}`, kind, values[key] ?? this.settings[key]) : input(`setting-${key}`, values[key] ?? this.settings[key] ?? '', `type="${kind}" ${kind === 'number' ? `min="${min}" max="${max}" step="${key === 'ratio' ? 'any' : '1'}"` : ''}`)}</div>`).join('')}</div>${['range', 'overview'].map(key => `<fieldset><legend><label class="check-label"><input type="checkbox" data-override="${key}" ${values[key] ? 'checked' : ''}>${key === 'range' ? 'Detail range' : 'Overview range'}</label></legend><div class="cfg-form-grid">${label('Start / UTC', input(`${key}-from`, dateInput(values[key]?.from || this.settings[key]?.from), 'type="datetime-local" step="0.001"'))}${label('End / UTC', input(`${key}-to`, dateInput(values[key]?.to || this.settings[key]?.to), 'type="datetime-local" step="0.001"'))}</div></fieldset>`).join('')}<fieldset class="cfg-choice-list"><legend><label class="check-label"><input type="checkbox" data-override="collapsedGroups" ${Object.hasOwn(values, 'collapsedGroups') ? 'checked' : ''}>Collapsed groups</label></legend>${(this.catalogs.groups || []).map(group => `<label class="check-label"><input type="checkbox" data-collapsed-group="${esc(group.id)}" ${(values.collapsedGroups || []).includes(group.id) ? 'checked' : ''}>${esc(group.name)}</label>`).join('')}</fieldset>${this.tableSettings(values, 'columns')}${this.tableSettings(values, 'sort')}`;
    }
    if (this.family === 'views') {
      this.timeInputs = Object.fromEntries(['range', 'overview'].flatMap(key => ['from', 'to'].map(edge => {
        const name = `${key}-${edge}`;
        return [name, { displayed: this.element.querySelector(`[data-cfg="${name}"]`).value, instant: value.settings[key]?.[edge] ?? this.settings[key]?.[edge] }];
      })));
    }
    if (this.family === 'views' && value.definitionVersion === 2) {
      const collapsed = this.element.querySelector('[data-override=collapsedGroups]').closest('fieldset');
      for (const child of [...collapsed.children]) if (child.tagName !== 'LEGEND') child.remove();
      for (const key of value.settings.collapsedGroups || []) {
        const label = document.createElement('label'); label.className = 'check-label';
        const control = document.createElement('input'); control.type = 'checkbox'; control.checked = true; control.dataset.collapsedGroup = key;
        label.append(control, document.createTextNode(key)); collapsed.append(label);
      }
    }
    this.updateIcons();
  }
  tableSettings(values, key) {
    const columns = key === 'columns', prefix = columns ? 'column' : 'sort';
    return `<fieldset><legend><label class="check-label"><input type="checkbox" data-override="${key}" ${Object.hasOwn(values, key) ? 'checked' : ''}>${columns ? 'Table columns' : 'Table sort'}</label></legend>${(values[key] || []).map((entry, index) => `<div class="cfg-table-setting" data-cfg-index="${index}" data-setting-row="${key}"><input data-entry-field aria-label="${columns ? 'Column' : 'Sort'} field" value="${esc(entry.field)}">${columns ? `<label class="check-label"><input type="checkbox" data-entry-visible ${entry.visible ? 'checked' : ''}>Visible</label><input type="number" min="44" max="2000" step="1" data-entry-width aria-label="Column width" value="${entry.width}">` : `<select data-entry-direction aria-label="Sort direction">${option('asc', 'Ascending', entry.direction)}${option('desc', 'Descending', entry.direction)}</select>`}${this.command(`${prefix}-up`, 'Move earlier', 'arrow-up')}${this.command(`${prefix}-down`, 'Move later', 'arrow-down')}${this.command(`${prefix}-remove`, 'Remove entry', 'trash-2')}</div>`).join('')}${this.command(`${prefix}-add`, columns ? 'Add column' : 'Add sort field', 'plus')}</fieldset>`;
  }
  updateSchemaType(node) {
    const textarea = node.closest('.cfg-schema-property').querySelector('[data-schema-json]');
    try { const property = parseStrictJson(textarea.value); property.type = node.value; if (node.value === 'object' && !property.properties) { property.properties = {}; property.additionalProperties = false; } if (node.value === 'array' && !property.items) property.items = { type: 'string' }; textarea.value = JSON.stringify(property, null, 2); }
    catch (error) { this.error(error); }
  }
  value({ validate = true } = {}) {
    const value = copy(this.definition), node = key => this.element.querySelector(`[data-cfg="${key}"]`), checked = key => node(key).checked;
    if (this.family === 'sources') Object.assign(value, { enabled: checked('enabled'), writable: checked('writable'), defaultSchema: parsePin(node('defaultSchema')) });
    if (this.family === 'groups') Object.assign(value, { order: Number(node('order').value), collapsed: checked('collapsed'), color: checked('useColor') ? node('color').value : null });
    if (this.family === 'schemas') {
      const properties = {}, required = [];
      for (const row of this.element.querySelectorAll('.cfg-schema-property')) {
        const name = row.querySelector('[data-schema-name]').value;
        if (!name || Object.hasOwn(properties, name)) throw new Error('Data property names must be nonempty and unique.');
        Object.defineProperty(properties, name, { value: parseStrictJson(row.querySelector('[data-schema-json]').value), enumerable: true, writable: true, configurable: true });
        if (row.querySelector('[data-schema-required]').checked) required.push(name);
      }
      value.schema.properties = properties;
      if (required.length) value.schema.required = required; else delete value.schema.required;
      for (const [key, control] of [['title', 'schemaTitle'], ['description', 'schemaDescription']]) if (node(control).value) value.schema[key] = node(control).value; else delete value.schema[key];
    }
    if (this.family === 'filters') {
      const search = this.filterEditor.value(node('search').value, { validate });
      Object.assign(value, { sourceIds: checked('allSources') ? null : [...this.element.querySelectorAll('[data-filter-source]:checked')].map(node => node.dataset.filterSource), kinds: [...this.element.querySelectorAll('[data-filter-kind]:checked')].map(node => node.dataset.filterKind), schemaRefs: [...this.element.querySelectorAll('[data-filter-schema]:checked')].map(node => parseStrictJson(node.dataset.filterSchema)), expression: search.expression || null, search: { text: search.search, mode: search.searchMode, fields: search.searchFields, ...(search.searchMode === 'regex' ? { flags: search.searchFlags, matchMode: search.searchMatchMode, dialect: search.searchDialect } : { caseSensitive: search.searchCaseSensitive }) } });
      if (search.definitionVersion === 2) Object.assign(value, { definitionVersion: 2, relationshipMode: search.relationshipMode });
      else { delete value.definitionVersion; delete value.relationshipMode; }
    }
    if (this.family === 'views') {
      value.model = parsePin(node('model')); value.filter = parsePin(node('filter'));
      for (const [key, , type] of scalarSettings) if (this.element.querySelector(`[data-override="${key}"]`).checked) value.settings[key] = type === 'number' ? Number(node(`setting-${key}`).value) : node(`setting-${key}`).value; else delete value.settings[key];
      for (const key of ['range', 'overview']) if (this.element.querySelector(`[data-override="${key}"]`).checked) value.settings[key] = Object.fromEntries(['from', 'to'].map(edge => {
        const name = `${key}-${edge}`, original = this.timeInputs[name], displayed = node(name).value;
        return [edge, original.instant !== undefined && original.displayed === displayed ? original.instant : inputIso(displayed)];
      })); else delete value.settings[key];
      if (this.element.querySelector('[data-override=collapsedGroups]').checked) value.settings.collapsedGroups = [...this.element.querySelectorAll('[data-collapsed-group]:checked')].map(node => node.dataset.collapsedGroup); else delete value.settings.collapsedGroups;
      for (const key of ['columns', 'sort']) if (this.element.querySelector(`[data-override="${key}"]`).checked) value.settings[key] = [...this.element.querySelectorAll(`[data-setting-row="${key}"]`)].map((row, index) => ({ ...(key === 'sort' ? copy(this.definition.settings.sort?.[index] || {}) : {}), field: row.querySelector('[data-entry-field]').value, ...(key === 'columns' ? { visible: row.querySelector('[data-entry-visible]').checked, width: Number(row.querySelector('[data-entry-width]').value) } : { direction: row.querySelector('[data-entry-direction]').value }) })); else delete value.settings[key];
    }
    return value;
  }
}
