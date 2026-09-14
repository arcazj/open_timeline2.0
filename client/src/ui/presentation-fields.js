import { resolvePresentation, DATE_FORMATS } from '../timeline/presentation.js';
import { escapeHtml as esc, icon } from '../utils/dom.js';
import { UNITS } from '../config.js';
import '../styles/presentation.css';

const colors = [['backgroundColor', 'Background'], ['textColor', 'Text'], ['dateColor', 'Dates'], ['sessionColor', 'Sessions'], ['eventColor', 'Events']];
const select = (path, label, value, choices) => `<label>${label}<select data-presentation-path="${path}">${choices.map(option => { const [key, text] = Array.isArray(option) ? option : [option, option]; return `<option value="${esc(key)}" ${String(value) === String(key) ? 'selected' : ''}>${esc(text)}</option>`; }).join('')}</select></label>`;
const input = (path, label, value, type = 'text', extra = '') => `<label>${label}<input data-presentation-path="${path}" type="${type}" value="${esc(value ?? '')}" ${extra}></label>`;
const checkbox = (path, label, value) => `<label class="presentation-check"><input data-presentation-path="${path}" type="checkbox" ${value ? 'checked' : ''}>${label}</label>`;
const command = (action, label, glyph, attrs = '') => `<button type="button" data-presentation-action="${action}" title="${label}" aria-label="${label}" ${attrs}>${icon(glyph)}</button>`;

export function presentationFields(definition) {
  let resolved;
  try { resolved = resolvePresentation(definition); } catch { resolved = resolvePresentation({ theme: definition.theme, fontSize: definition.fontSize, groupBy: definition.groupBy, displayUnit: definition.displayUnit }); }
  const raw = definition.presentation;
  const header = `<div class="presentation-heading"><label class="presentation-check"><input type="checkbox" data-presentation-enabled ${raw ? 'checked' : ''}>Custom presentation</label></div>`;
  if (!raw) return `<section class="presentation-fields">${header}</section>`;
  const band = name => {
    const value = resolved.bands[name], prefix = `bands.${name}`;
    return `<details class="presentation-section" ${name === 'primary' ? 'open' : ''}><summary>${name === 'primary' ? 'Primary band' : 'Overview band'}</summary><div class="presentation-section-actions">${command('reset-band', `Reset ${name} band`, 'rotate-ccw', `data-band="${name}"`)}</div><div class="presentation-color-grid">${colors.map(([key, label]) => input(`${prefix}.${key}`, label, value[key], 'color')).join('')}</div><div class="presentation-grid">${input(`${prefix}.barHeight`, 'Bar height', value.barHeight, 'number', 'min="2" max="20" step="any"')}${input(`${prefix}.pointRadius`, 'Point radius', value.pointRadius, 'number', 'min="1" max="10" step="any"')}${select(`${prefix}.axisPosition`, 'Axis', value.axisPosition, [['bottom', 'Bottom'], ['top', 'Top']])}${select(`${prefix}.intervalUnit`, 'Interval unit', value.intervalUnit, UNITS)}${select(`${prefix}.dateFormat`, 'Date format', value.dateFormat, DATE_FORMATS)}</div></details>`;
  };
  const label = resolved.labels;
  const sources = (Array.isArray(raw.sourceStyles) ? raw.sourceStyles : []).map((source, index) => `<div class="presentation-source-row"><div class="presentation-row-heading">${input(`sourceStyles.${index}.sourceId`, 'Source ID', source.sourceId)}${command('remove-source', 'Remove source style', 'trash-2', `data-index="${index}"`)}</div><div class="presentation-color-grid">${colors.map(([key, title]) => input(`sourceStyles.${index}.${key}`, title, source[key] || resolved.bands.primary[key], 'color')).join('')}</div></div>`).join('');
  const inspectors = (Array.isArray(raw.inspector?.fields) ? raw.inspector.fields : []).map((field, index) => `<div class="presentation-inspector-row">${input(`inspector.fields.${index}.label`, 'Label', field.label)}${input(`inspector.fields.${index}.field`, 'Field pointer', field.field)}${command('remove-inspector', 'Remove inspector field', 'trash-2', `data-index="${index}"`)}</div>`).join('');
  return `<section class="presentation-fields">${header}${band('primary')}${band('overview')}<details class="presentation-section"><summary>Labels and grouping</summary><div class="presentation-grid"><label class="presentation-wide">Label fields<textarea data-presentation-lines="labels.fields" rows="3" spellcheck="false">${esc(label.fields.join('\n'))}</textarea></label>${input('labels.fontSize', 'Label font size', label.fontSize, 'number', 'min="11" max="24" step="1"')}${select('labels.fontWeight', 'Weight', label.fontWeight, [[400, 'Regular'], [700, 'Bold']])}${select('labels.fontStyle', 'Style', label.fontStyle, [['normal', 'Normal'], ['italic', 'Italic']])}${input('labels.maxLines', 'Maximum lines', label.maxLines, 'number', 'min="1" max="4" step="1"')}${checkbox('labels.backgroundEnabled', 'Label background', label.backgroundColor !== null)}${input('labels.backgroundColor', 'Label background color', label.backgroundColor || '#ffffff', 'color', label.backgroundColor === null ? 'disabled' : '')}${input('grouping.field', 'Grouping field', raw.grouping?.field || '', 'text', 'placeholder="/data/status"')}${select('grouping.direction', 'Group order', resolved.grouping.direction, [['asc', 'Ascending'], ['desc', 'Descending']])}</div></details><details class="presentation-section"><summary>Source palettes</summary>${sources}<div class="presentation-add">${command('add-source', 'Add source style', 'plus')}</div></details><details class="presentation-section"><summary>Inspector fields</summary>${inspectors}<div class="presentation-add">${command('add-inspector', 'Add inspector field', 'plus')}</div></details><details class="presentation-section"><summary>Parent enclosures and original dates</summary><div class="presentation-grid">${checkbox('nesting.enabled', 'Parent enclosures', resolved.nesting.enabled)}${input('nesting.color', 'Enclosure color', resolved.nesting.color, 'color')}${input('nesting.opacity', 'Enclosure opacity', resolved.nesting.opacity, 'number', 'min="0" max="0.35" step="0.01"')}${checkbox('baseline.enabled', 'Original-date baseline', resolved.baseline.enabled)}${input('baseline.color', 'Baseline color', resolved.baseline.color, 'color')}</div></details></section>`;
}

export function bindPresentationFields(root, definition, changed, render) {
  const update = () => { changed(); };
  root.querySelector('[data-presentation-enabled]')?.addEventListener('change', event => {
    if (event.target.checked) definition.presentation = { version: 1 };
    else delete definition.presentation;
    update(); render();
  });
  function put(path, value) {
    definition.presentation ||= { version: 1 };
    const parts = path.split('.'); let object = definition.presentation;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!object[key] || typeof object[key] !== 'object') object[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      object = object[key];
    }
    object[parts.at(-1)] = value;
  }
  root.querySelectorAll('[data-presentation-path]').forEach(control => control.addEventListener('change', event => {
    const path = event.target.dataset.presentationPath;
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.type === 'number' || path === 'labels.fontWeight' ? Number(event.target.value) : event.target.value;
    if (path === 'labels.backgroundEnabled') { put('labels.backgroundColor', value ? '#ffffff' : null); update(); render(); return; }
    if (path === 'grouping.field' && !value) delete definition.presentation.grouping;
    else if (path === 'grouping.direction' && !definition.presentation.grouping?.field) return;
    else put(path, value);
    update();
  }));
  root.querySelector('[data-presentation-lines]')?.addEventListener('change', event => {
    const fields = event.target.value.replace(/\r/g, '').split('\n').filter(Boolean);
    if (fields.length) put('labels.fields', fields); else if (definition.presentation.labels) delete definition.presentation.labels.fields;
    update();
  });
  root.querySelectorAll('[data-presentation-action]').forEach(button => button.addEventListener('click', () => {
    const presentation = definition.presentation, index = Number(button.dataset.index);
    if (button.dataset.presentationAction === 'reset-band') delete presentation.bands?.[button.dataset.band];
    if (button.dataset.presentationAction === 'add-source') { presentation.sourceStyles ||= []; if (presentation.sourceStyles.length < 100) presentation.sourceStyles.push({ sourceId: '' }); }
    if (button.dataset.presentationAction === 'remove-source') presentation.sourceStyles.splice(index, 1);
    if (button.dataset.presentationAction === 'add-inspector') { presentation.inspector ||= { fields: [] }; if (presentation.inspector.fields.length < 24) presentation.inspector.fields.push({ field: '/title', label: 'Title' }); }
    if (button.dataset.presentationAction === 'remove-inspector') { presentation.inspector.fields.splice(index, 1); if (!presentation.inspector.fields.length) delete presentation.inspector; }
    update(); render();
  }));
}
