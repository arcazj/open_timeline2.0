import builtInFields from '../../../shared/fixtures/filter-fields.json' with { type: 'json' };
import { compileExpression, compileSearch } from '../data/filter-expression.js';
import { escapeHtml as esc, icon, dateInput, inputIso } from '../utils/dom.js';
import { filterFieldLabel, filterOperator, changeFilterOperator } from './filter-editor-state.js';

const labels = { eq: 'Equals', ne: 'Does not equal', lt: 'Before / less than', lte: 'At most', gt: 'After / greater than', gte: 'At least', in: 'In list', contains: 'Contains', exists: 'Present (including null)', isNull: 'Is null', isMissing: 'Is missing', hasValue: 'Has a value', regex: 'Regular expression', overlaps: 'Overlaps interval' };
const defaultFields = ['/title', '/data/description', '/data/text', '/data/system', '/data/type', '/data/status'];
const fresh = () => ({ op: 'contains', field: '/title', value: '' });
const command = (action, name, glyph) => `<button type="button" data-filter-command="${action}" title="${name}" aria-label="${name}">${icon(glyph)}</button>`;
const operators = (type, version = 1) => [...(type === 'strings' ? ['contains', 'exists', 'isMissing'] : type === 'boolean' ? ['eq', 'ne', 'in', 'exists', 'isNull', 'isMissing', 'hasValue'] : ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', ...(type === 'string' ? ['contains', ...(version === 2 ? ['regex'] : [])] : []), 'in', 'exists', 'isNull', 'isMissing', 'hasValue'])];
const regexControls = (flags = [], matchMode = 'search', prefix = 'data-regex') => `<div class="filter-regex-options"><select ${prefix}-mode aria-label="Regex match mode"><option value="search" ${matchMode === 'search' ? 'selected' : ''}>Contains match</option><option value="full" ${matchMode === 'full' ? 'selected' : ''}>Entire field</option></select>${[['i', 'Ignore case'], ['m', 'Multiline anchors'], ['s', 'Dot matches newline']].map(([flag, label]) => `<label class="check-label"><input type="checkbox" ${prefix}-flag="${flag}" ${flags.includes(flag) ? 'checked' : ''}>${label}</label>`).join('')}</div>`;

export class FilterEditor {
  constructor(element, { expression, definitionVersion = expression?.version ?? 1, relationshipMode = 'independent', searchMode = 'any', searchCaseSensitive, searchFields, searchFlags = [], searchMatchMode = 'search', updateIcons, fieldTypes = builtInFields }) {
    const fields = this.fieldTypes = { ...fieldTypes };
    this.element = element; this.root = structuredClone(expression?.root ?? null); this.version = definitionVersion; this.mode = 'simple'; this.updateIcons = updateIcons; this.drafts = new WeakMap();
    element.innerHTML = `<div class="search-options"><label>Search mode<select name="searchMode">${['any', 'all', 'phrase'].map(mode => `<option value="${mode}" ${mode === searchMode ? 'selected' : ''}>${{ any: 'Any term', all: 'All terms', phrase: 'Exact phrase' }[mode]}</option>`).join('')}</select></label><label class="check-label"><input name="searchCaseSensitive" type="checkbox" ${searchCaseSensitive ? 'checked' : ''}>Case sensitive</label></div><details class="search-fields"><summary>Search fields</summary><div>${Object.keys(fields).filter(field => fields[field] !== 'strings').map(field => `<label class="check-label"><input type="checkbox" data-search-field="${esc(field)}" ${(searchFields || defaultFields).includes(field) ? 'checked' : ''}>${esc(field)}</label>`).join('')}</div></details><div class="filter-heading"><h3>Conditions</h3>${command('add-root', 'Add condition', 'plus')}${command('wrap-root', 'Add condition group', 'list-tree')}${command('clear', 'Clear conditions', 'eraser')}</div><div class="filter-tree"></div>`;
    element.insertAdjacentHTML('afterbegin', `<div class="filter-definition-options"><label>Query definition<select name="definitionVersion"><option value="1" ${definitionVersion === 1 ? 'selected' : ''}>Version 1</option><option value="2" ${definitionVersion === 2 ? 'selected' : ''}>Version 2</option></select></label><label class="filter-relationship">Related sessions<select name="relationshipMode"><option value="independent" ${relationshipMode === 'independent' ? 'selected' : ''}>Matches + parent context</option><option value="family" ${relationshipMode === 'family' ? 'selected' : ''}>Matching families</option></select></label></div>`);
    element.querySelector('[name=searchMode]').insertAdjacentHTML('beforeend', `<option value="regex" ${searchMode === 'regex' ? 'selected' : ''}>Regular expression</option>`);
    element.querySelector('.search-options').insertAdjacentHTML('afterend', `<div class="search-regex-options">${regexControls(searchFlags, searchMatchMode, 'data-search-regex')}</div>`);
    for (const field of element.querySelectorAll('[data-search-field]')) field.parentElement.lastChild.textContent = filterFieldLabel(field.dataset.searchField);
    element.querySelector('.filter-heading').insertAdjacentHTML('beforebegin', '<div class="filter-editor-modes" role="group" aria-label="Condition editor"><button type="button" data-filter-mode="simple" aria-pressed="true">Simple</button><button type="button" data-filter-mode="advanced" aria-pressed="false">Advanced</button></div>');
    element.querySelector('.filter-tree').insertAdjacentHTML('afterend', '<label class="filter-advanced" hidden>Expression JSON<textarea aria-label="Filter expression JSON" spellcheck="false"></textarea></label>');
    this.render(); this.renderOptions();
    element.addEventListener('input', () => this.changed());
    element.addEventListener('click', event => {
      const mode = event.target.closest('[data-filter-mode]');
      if (mode) { this.switchMode(mode.dataset.filterMode); return; }
      const button = event.target.closest('[data-filter-command]'); if (!button) return;
      const action = button.dataset.filterCommand, path = button.closest('[data-filter-path]')?.dataset.filterPath;
      if (this.mode === 'advanced' && action !== 'clear') { try { this.readAdvanced(); } catch (error) { this.error(error); return; } }
      else this.readTree(false);
      const previous = this.copyTree(this.root);
      const current = path === undefined ? null : this.at(path);
      if (action === 'clear') this.root = null;
      if (action === 'add-root') this.root = this.root ? { op: 'and', args: [this.root, fresh()] } : fresh();
      if (action === 'wrap-root') this.root = { op: 'and', args: this.root ? [this.root] : [fresh()] };
      if (action === 'add') current.args.push(fresh());
      if (action === 'group') current.args.push({ op: 'and', args: [fresh()] });
      if (action === 'not') this.replace(path, current.op === 'not' ? current.arg : { op: 'not', arg: current });
      if (action === 'remove') this.remove(path);
      let count = 0;
      const bounded = (node, depth = 1) => !node || (++count <= 100 && depth <= 8 && (node.args || (node.arg ? [node.arg] : [])).every(child => bounded(child, depth + 1)));
      if (!bounded(this.root)) { this.root = previous; this.error(new Error('Conditions are limited to 100 nodes and 8 levels.')); return; }
      this.render(); this.changed(); this.element.querySelector('.filter-tree select, .filter-tree input')?.focus();
    });
    element.addEventListener('change', event => {
      if (event.target.matches('[name=definitionVersion]')) {
        const version = Number(event.target.value);
        try {
          if (this.mode === 'advanced') this.readAdvanced(); else this.readTree();
          compileExpression(this.root ? { version, root: this.root } : undefined, { fieldTypes: fields });
          if (version === 1 && this.element.querySelector('[name=searchMode]').value === 'regex') throw new Error('Switch regex search to a literal mode before choosing version 1.');
          this.version = version; this.render(); this.renderOptions();
        } catch (error) { event.target.value = String(this.version); this.error(error); return; }
        this.changed(); return;
      }
      if (event.target.matches('[name=searchMode]')) { this.renderOptions(); this.changed(); return; }
      if (!event.target.matches('[data-filter-field], [data-filter-op]')) return;
      this.readTree(false);
      const wrapper = event.target.closest('[data-filter-path]'), node = this.at(wrapper.dataset.filterPath);
      if (event.target.matches('[data-filter-field]')) {
        node.field = event.target.value; changeFilterOperator(node, operators(fields[node.field], this.version)[0], fields[node.field]);
      } else {
        changeFilterOperator(node, event.target.value, fields[node.field]);
      }
      this.drafts.delete(node);
      this.render(); this.changed();
    });
  }
  changed() { this.element.dispatchEvent(new CustomEvent('filterchange', { bubbles: true })); }
  readAdvanced() {
    let expression;
    try { expression = JSON.parse(this.element.querySelector('.filter-advanced textarea').value); }
    catch { throw new Error('Expression JSON is incomplete or invalid.'); }
    if (expression !== null && (!expression || typeof expression !== 'object' || Array.isArray(expression))) throw new Error('Use an expression object or null.');
    compileExpression(expression, { fieldTypes: this.fieldTypes });
    if (expression && expression.version !== this.version) throw new Error('Expression version must match the selected query definition.');
    this.root = structuredClone(expression?.root ?? null);
  }
  switchMode(mode) {
    if (mode === this.mode) return;
    try {
      if (this.mode === 'advanced') this.readAdvanced(); else this.readTree();
      this.mode = mode; this.render(); this.changed();
      this.element.querySelector(mode === 'advanced' ? '.filter-advanced textarea' : '.filter-tree select, .filter-tree input')?.focus();
    } catch (error) { this.error(error); }
  }
  renderOptions() {
    const regex = this.element.querySelector('[name=searchMode]').value === 'regex';
    this.element.querySelector('[name=definitionVersion]').value = String(this.version);
    this.element.querySelector('.filter-relationship').hidden = this.version !== 2;
    this.element.querySelector('[name=searchMode] option[value=regex]').disabled = this.version !== 2;
    this.element.querySelector('[name=searchCaseSensitive]').closest('label').hidden = regex;
    this.element.querySelector('.search-regex-options').hidden = !regex;
    for (const control of this.element.querySelectorAll('[data-search-field]')) {
      const incompatible = regex && this.fieldTypes[control.dataset.searchField] !== 'string';
      control.disabled = incompatible;
      if (incompatible) control.checked = false;
    }
  }
  reset(value) {
    this.root = structuredClone(value.expression?.root ?? null); this.version = value.definitionVersion ?? value.expression?.version ?? 1;
    this.drafts = new WeakMap(); this.mode = 'simple';
    this.element.querySelector('[name=relationshipMode]').value = value.relationshipMode || 'independent';
    this.element.querySelector('[name=searchMode]').value = value.searchMode || 'any';
    this.element.querySelector('[name=searchCaseSensitive]').checked = !!value.searchCaseSensitive;
    for (const control of this.element.querySelectorAll('[data-search-field]')) control.checked = (value.searchFields || defaultFields).includes(control.dataset.searchField);
    for (const control of this.element.querySelectorAll('[data-search-regex-flag]')) control.checked = (value.searchFlags || []).includes(control.dataset.searchRegexFlag);
    this.element.querySelector('[data-search-regex-mode]').value = value.searchMatchMode || 'search';
    this.render(); this.renderOptions(); this.changed();
  }
  at(path) { return path ? path.split('.').reduce((value, part) => value[part], this.root) : this.root; }
  copyTree(node) {
    if (!node) return node;
    const copy = { ...node };
    if (node.args) copy.args = node.args.map(child => this.copyTree(child));
    if (node.arg) copy.arg = this.copyTree(node.arg);
    if (this.drafts.has(node)) this.drafts.set(copy, { ...this.drafts.get(node) });
    return copy;
  }
  error(error) { this.element.querySelector('.filter-error')?.remove(); const output = document.createElement('p'); output.className = 'form-error filter-error'; output.setAttribute('role', 'alert'); output.textContent = error.message; this.element.append(output); }
  replace(path, value) { if (!path) this.root = value; else { const parts = path.split('.'), last = parts.pop(); this.at(parts.join('.'))[last] = value; } }
  remove(path) {
    if (!path) { this.root = null; return; }
    const parts = path.split('.'), last = parts.pop(), parent = this.at(parts.join('.'));
    if (Array.isArray(parent)) { parent.splice(Number(last), 1); if (!parent.length) this.replace(parts.slice(0, -1).join('.'), fresh()); }
    else this.replace(parts.join('.'), fresh());
  }
  readTree(strict = true) {
    if (this.mode === 'advanced') return;
    const fields = this.fieldTypes;
    for (const wrapper of this.element.querySelectorAll('[data-filter-path]')) {
      const node = this.at(wrapper.dataset.filterPath), control = selector => [...wrapper.children].flatMap(child => child.matches(selector) ? [child] : [...child.querySelectorAll(selector)]).find(child => child.closest('[data-filter-path]') === wrapper);
      if (['and', 'or'].includes(node.op)) { node.op = control('[data-filter-boolean]').value; continue; }
      if (node.op === 'not') continue;
      if (['isNull', 'isMissing', 'hasValue'].includes(filterOperator(node))) continue;
      if (node.op === 'regex') {
        node.pattern = control('[data-filter-value]').value;
        node.flags = [...wrapper.querySelectorAll('[data-regex-flag]:checked')].filter(child => child.closest('[data-filter-path]') === wrapper).map(child => child.dataset.regexFlag);
        node.matchMode = control('[data-regex-mode]').value;
        continue;
      }
      const raw = node.op === 'overlaps'
        ? { from: control('[data-filter-from]').value, to: control('[data-filter-to]').value }
        : { value: control('[data-filter-value]').value, null: !!control('[data-filter-null]')?.checked, caseSensitive: !!control('[data-filter-case]')?.checked };
      // Invalid text remains editor-only data through structural edits and is never sent as an AST.
      this.drafts.set(node, raw);
      try {
        if (node.op === 'overlaps') { node.from = inputIso(raw.from); node.to = inputIso(raw.to); continue; }
        if (node.op === 'exists') node.value = raw.value === 'true';
        else if (node.op === 'in') { try { node.values = JSON.parse(raw.value); } catch { throw new Error('List values must be a JSON array.'); } }
        else if (raw.null) node.value = null;
        else if (fields[node.field] === 'number') { if (!raw.value.trim()) throw new Error('Enter a numeric filter value.'); node.value = Number(raw.value); }
        else if (fields[node.field] === 'boolean') node.value = raw.value === 'true';
        else if (fields[node.field] === 'date') node.value = inputIso(raw.value);
        else node.value = raw.value;
        if (node.op === 'contains') node.caseSensitive = raw.caseSensitive;
      } catch (error) { if (strict) throw error; }
    }
  }
  value(search, { validate = true } = {}) {
    if (this.mode === 'advanced') this.readAdvanced(); else this.readTree();
    const expression = this.root ? { version: this.version, root: structuredClone(this.root) } : undefined;
    if (validate) compileExpression(expression, { fieldTypes: this.fieldTypes });
    const result = this.searchValue(search);
    if (validate) compileSearch(result, { fieldTypes: this.fieldTypes });
    return { expression, ...result, definitionVersion: this.version, ...(this.version === 2 ? { relationshipMode: this.element.querySelector('[name=relationshipMode]').value } : {}) };
  }
  searchValue(search) {
    const result = { search, searchMode: this.element.querySelector('[name=searchMode]').value, searchCaseSensitive: this.element.querySelector('[name=searchCaseSensitive]').checked, searchFields: [...this.element.querySelectorAll('[data-search-field]:checked')].map(input => input.dataset.searchField) };
    if (this.version === 2) result.definitionVersion = 2;
    if (result.searchMode === 'regex') {
      delete result.searchCaseSensitive;
      result.searchFlags = [...this.element.querySelectorAll('[data-search-regex-flag]:checked')].map(input => input.dataset.searchRegexFlag);
      result.searchMatchMode = this.element.querySelector('[data-search-regex-mode]').value; result.searchDialect = 're2-common-v1';
    }
    return result;
  }
  setFieldTypes(registry, { readDraft = true } = {}) {
    if (readDraft) { if (this.mode === 'advanced') this.readAdvanced(); else this.readTree(); }
    const selected = [...this.element.querySelectorAll('[data-search-field]:checked')].map(node => node.dataset.searchField);
    for (const key of Object.keys(this.fieldTypes)) delete this.fieldTypes[key]; Object.assign(this.fieldTypes, registry);
    this.element.querySelector('.search-fields > div').innerHTML = Object.keys(registry).filter(field => registry[field] !== 'strings').map(field => `<label class="check-label"><input type="checkbox" data-search-field="${esc(field)}" ${selected.includes(field) ? 'checked' : ''}>${esc(filterFieldLabel(field))}</label>`).join('');
    this.render(); this.renderOptions(); this.changed();
  }
  render() {
    const fields = this.fieldTypes;
    const draw = (node, path = '', depth = 1) => {
      const draft = this.drafts.get(node);
      const tools = `${command('not', 'Negate condition', 'circle-slash')}${command('remove', 'Remove condition', 'trash-2')}`;
      let content;
      if (['and', 'or'].includes(node.op)) content = `<div class="filter-group-tools"><select data-filter-boolean aria-label="Condition group"><option value="and" ${node.op === 'and' ? 'selected' : ''}>All conditions</option><option value="or" ${node.op === 'or' ? 'selected' : ''}>Any condition</option></select>${depth < 7 ? command('add', 'Add condition', 'plus') + command('group', 'Add nested group', 'list-tree') : ''}${tools}</div>${node.args.map((child, i) => draw(child, path ? `${path}.args.${i}` : `args.${i}`, depth + 1)).join('')}`;
      else if (node.op === 'not') content = `<div class="filter-group-tools"><span>Not</span>${tools}</div>${draw(node.arg, path ? `${path}.arg` : 'arg', depth + 1)}`;
      else if (node.op === 'overlaps') content = `<div class="filter-rule"><span>Overlaps interval / UTC</span><input data-filter-from type="datetime-local" step="0.001" aria-label="Interval start" value="${esc(draft?.from ?? dateInput(node.from))}"><input data-filter-to type="datetime-local" step="0.001" aria-label="Interval end" value="${esc(draft?.to ?? dateInput(node.to))}">${tools}</div>`;
      else {
        const type = fields[node.field], ops = [...operators(type, this.version), 'overlaps'], selectedOperator = filterOperator(node);
        const unary = ['isNull', 'isMissing', 'hasValue'].includes(selectedOperator);
        const value = unary ? '<span class="filter-unary-value"></span>' : node.op === 'regex' ? `<input data-filter-value aria-label="Regex pattern" spellcheck="false" value="${esc(node.pattern)}">` : node.op === 'exists' ? `<select data-filter-value aria-label="Exists"><option value="true" ${node.value ? 'selected' : ''}>Present</option><option value="false" ${!node.value ? 'selected' : ''}>Missing</option></select>` : type === 'boolean' && node.op !== 'in' ? `<select data-filter-value aria-label="Condition value"><option value="true" ${node.value ? 'selected' : ''}>True</option><option value="false" ${!node.value ? 'selected' : ''}>False</option></select>` : `<input data-filter-value aria-label="Condition value" ${type === 'date' && node.op !== 'in' ? 'type="datetime-local" step="0.001"' : type === 'number' && node.op !== 'in' ? 'type="number" step="any"' : 'type="text"'} value="${esc(draft?.value ?? (node.op === 'in' ? JSON.stringify(node.values) : type === 'date' && node.value ? dateInput(node.value) : node.value ?? ''))}">`;
        content = `<div class="filter-rule"><select data-filter-field aria-label="Condition field">${Object.keys(fields).map(field => `<option value="${esc(field)}" title="${esc(field)}" ${field === node.field ? 'selected' : ''}>${esc(filterFieldLabel(field))}</option>`).join('')}</select><select data-filter-op aria-label="Condition operator">${ops.map(op => `<option value="${op}" ${op === selectedOperator ? 'selected' : ''}>${labels[op]}</option>`).join('')}</select>${value}${tools}</div>${node.op === 'contains' ? `<label class="check-label"><input type="checkbox" data-filter-case ${(draft?.caseSensitive ?? node.caseSensitive) ? 'checked' : ''}>Case sensitive</label>` : node.op === 'regex' ? regexControls(node.flags, node.matchMode) : ''}`;
      }
      return `<div class="filter-node" data-filter-path="${path}">${content}</div>`;
    };
    this.element.querySelector('.filter-tree').innerHTML = this.root ? draw(this.root) : '<span class="filter-empty">No additional conditions</span>';
    this.element.querySelector('.filter-tree').hidden = this.mode !== 'simple';
    this.element.querySelector('.filter-advanced').hidden = this.mode !== 'advanced';
    this.element.querySelector('.filter-advanced textarea').value = JSON.stringify(this.root ? { version: this.version, root: this.root } : null, null, 2);
    for (const button of this.element.querySelectorAll('[data-filter-mode]')) button.setAttribute('aria-pressed', String(button.dataset.filterMode === this.mode));
    this.element.querySelector('.filter-error')?.remove();
    this.updateIcons();
  }
}
