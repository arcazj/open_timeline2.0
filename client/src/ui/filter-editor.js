import builtInFields from '../../../shared/fixtures/filter-fields.json' with { type: 'json' };
import { compileExpression, compileSearch } from '../data/filter-expression.js';
import { escapeHtml as esc, icon, dateInput, inputIso } from '../utils/dom.js';

const labels = { eq: 'Equals', ne: 'Does not equal', lt: 'Before / less than', lte: 'At most', gt: 'After / greater than', gte: 'At least', in: 'In list', contains: 'Contains', exists: 'Exists', overlaps: 'Overlaps interval' };
const defaultFields = ['/title', '/data/description', '/data/text', '/data/system', '/data/type', '/data/status'];
const fresh = () => ({ op: 'contains', field: '/title', value: '' });
const command = (action, name, glyph) => `<button type="button" data-filter-command="${action}" title="${name}" aria-label="${name}">${icon(glyph)}</button>`;
const operators = type => type === 'strings' ? ['contains', 'exists'] : type === 'boolean' ? ['eq', 'ne', 'in', 'exists'] : ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', ...(type === 'string' ? ['contains'] : []), 'in', 'exists'];

export class FilterEditor {
  constructor(element, { expression, searchMode, searchCaseSensitive, searchFields, updateIcons, fieldTypes = builtInFields }) {
    const fields = this.fieldTypes = { ...fieldTypes };
    this.element = element; this.root = structuredClone(expression?.root ?? null); this.updateIcons = updateIcons; this.drafts = new WeakMap();
    element.innerHTML = `<div class="search-options"><label>Search mode<select name="searchMode">${['any', 'all', 'phrase'].map(mode => `<option value="${mode}" ${mode === searchMode ? 'selected' : ''}>${{ any: 'Any term', all: 'All terms', phrase: 'Exact phrase' }[mode]}</option>`).join('')}</select></label><label class="check-label"><input name="searchCaseSensitive" type="checkbox" ${searchCaseSensitive ? 'checked' : ''}>Case sensitive</label></div><details class="search-fields"><summary>Search fields</summary><div>${Object.keys(fields).filter(field => fields[field] !== 'strings').map(field => `<label class="check-label"><input type="checkbox" data-search-field="${esc(field)}" ${(searchFields || defaultFields).includes(field) ? 'checked' : ''}>${esc(field)}</label>`).join('')}</div></details><div class="filter-heading"><h3>Conditions</h3>${command('add-root', 'Add condition', 'plus')}${command('wrap-root', 'Add condition group', 'list-tree')}${command('clear', 'Clear conditions', 'eraser')}</div><div class="filter-tree"></div>`;
    this.render();
    element.addEventListener('click', event => {
      const button = event.target.closest('[data-filter-command]'); if (!button) return;
      const action = button.dataset.filterCommand, path = button.closest('[data-filter-path]')?.dataset.filterPath;
      this.readTree(false);
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
      this.render(); this.element.querySelector('.filter-tree select, .filter-tree input')?.focus();
    });
    element.addEventListener('change', event => {
      if (!event.target.matches('[data-filter-field], [data-filter-op]')) return;
      this.readTree(false);
      const wrapper = event.target.closest('[data-filter-path]'), node = this.at(wrapper.dataset.filterPath);
      if (event.target.matches('[data-filter-field]')) {
        node.field = event.target.value; node.op = operators(fields[node.field])[0]; delete node.values; delete node.caseSensitive;
        node.value = fields[node.field] === 'number' ? 0 : fields[node.field] === 'boolean' ? false : fields[node.field] === 'date' ? new Date().toISOString() : '';
      } else {
        const op = event.target.value; node.op = op; delete node.values; delete node.caseSensitive;
        if (op === 'exists') node.value = true;
        else if (op === 'in') { node.values = []; delete node.value; }
        else if (op === 'overlaps') { delete node.field; delete node.value; node.from = new Date().toISOString(); node.to = new Date(Date.now() + 3600000).toISOString(); }
        else node.value = fields[node.field] === 'number' ? 0 : fields[node.field] === 'boolean' ? false : fields[node.field] === 'date' ? new Date().toISOString() : '';
      }
      this.drafts.delete(node);
      this.render();
    });
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
    const fields = this.fieldTypes;
    for (const wrapper of this.element.querySelectorAll('[data-filter-path]')) {
      const node = this.at(wrapper.dataset.filterPath), control = selector => [...wrapper.children].flatMap(child => child.matches(selector) ? [child] : [...child.querySelectorAll(selector)]).find(child => child.closest('[data-filter-path]') === wrapper);
      if (['and', 'or'].includes(node.op)) { node.op = control('[data-filter-boolean]').value; continue; }
      if (node.op === 'not') continue;
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
    this.readTree();
    const expression = this.root ? { version: 1, root: structuredClone(this.root) } : undefined;
    if (validate) compileExpression(expression, { fieldTypes: this.fieldTypes });
    const result = { search, searchMode: this.element.querySelector('[name=searchMode]').value, searchCaseSensitive: this.element.querySelector('[name=searchCaseSensitive]').checked, searchFields: [...this.element.querySelectorAll('[data-search-field]:checked')].map(input => input.dataset.searchField) };
    if (validate) compileSearch(result, { fieldTypes: this.fieldTypes });
    return { expression, ...result };
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
        const type = fields[node.field], ops = [...operators(type), 'overlaps'];
        const value = node.op === 'exists' ? `<select data-filter-value aria-label="Exists"><option value="true" ${node.value ? 'selected' : ''}>Present</option><option value="false" ${!node.value ? 'selected' : ''}>Missing</option></select>` : type === 'boolean' && node.op !== 'in' ? `<select data-filter-value aria-label="Condition value"><option value="true" ${node.value ? 'selected' : ''}>True</option><option value="false" ${!node.value ? 'selected' : ''}>False</option></select>` : `<input data-filter-value aria-label="Condition value" ${type === 'date' && node.op !== 'in' ? 'type="datetime-local" step="0.001"' : type === 'number' && node.op !== 'in' ? 'type="number" step="any"' : 'type="text"'} value="${esc(draft?.value ?? (node.op === 'in' ? JSON.stringify(node.values) : type === 'date' && node.value ? dateInput(node.value) : node.value ?? ''))}">`;
        content = `<div class="filter-rule"><select data-filter-field aria-label="Condition field">${Object.keys(fields).map(field => `<option value="${esc(field)}" ${field === node.field ? 'selected' : ''}>${esc(field)}</option>`).join('')}</select><select data-filter-op aria-label="Condition operator">${ops.map(op => `<option value="${op}" ${op === node.op ? 'selected' : ''}>${labels[op]}</option>`).join('')}</select>${value}${tools}</div>${['eq', 'ne'].includes(node.op) ? `<label class="check-label"><input type="checkbox" data-filter-null ${(draft?.null ?? node.value === null) ? 'checked' : ''}>Null value</label>` : node.op === 'contains' ? `<label class="check-label"><input type="checkbox" data-filter-case ${(draft?.caseSensitive ?? node.caseSensitive) ? 'checked' : ''}>Case sensitive</label>` : ''}`;
      }
      return `<div class="filter-node" data-filter-path="${path}">${content}</div>`;
    };
    this.element.querySelector('.filter-tree').innerHTML = this.root ? draw(this.root) : '<span class="filter-empty">No additional conditions</span>';
    this.element.querySelector('.filter-error')?.remove();
    this.updateIcons();
  }
}
