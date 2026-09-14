import { canonicalJson } from '../data/data-provider.js';
import { escapeHtml as esc, icon } from '../utils/dom.js';
import { readField } from '../timeline/presentation.js';

const fields = [['title', 'Event / session'], ['kind', 'Type'], ['start', 'Start'], ['end', 'End'], ['sourceId', 'Source'], ['data.status', 'Status']];
const pointer = field => field.startsWith('/') ? field : `/${field.replaceAll('.', '/')}`;
const fieldName = field => fields.find(([key]) => pointer(key) === pointer(field))?.[1] || field;
const csvCell = value => {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]|^[\t\r]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

export class RecordTableView {
  constructor({ element, context, onSelect, onError, onChange, onPreferenceChange, updateIcons, dateLabel }) {
    Object.assign(this, { element, context, onSelect, onError, onChange, onPreferenceChange, updateIcons, dateLabel });
    this.scope = 'all'; this.projection = 'context'; this.sort = 'start'; this.direction = 'asc'; this.limit = 100;
    this.visible = false; this.result = null; this.intent = 0; this.key = null; this.pending = false;
    this.columns = null; this.sorts = [{ field: this.sort, direction: this.direction }];
    element.addEventListener('click', event => {
      const sort = event.target.closest('[data-table-sort]');
      if (sort && !sort.disabled) {
        const field = sort.dataset.tableSort, old = this.sorts.find(item => pointer(item.field) === pointer(field));
        const next = { field, direction: old?.direction === 'asc' ? 'desc' : 'asc' };
        this.sorts = event.shiftKey ? [...this.sorts.filter(item => pointer(item.field) !== pointer(field)), next].slice(-3) : [next];
        this.sort = this.sorts[0].field; this.direction = this.sorts[0].direction;
        this.onPreferenceChange?.('sort', structuredClone(this.sorts)); this.sync(true);
      }
      const action = event.target.closest('[data-table-action]')?.dataset.tableAction;
      if (action === 'previous' || action === 'next') this.page(action);
      if (action === 'export') this.exportCsv();
      if (action === 'cancel-export') this.exportController?.abort();
      const row = event.target.closest('tr[data-record-id]');
      if (row) this.onSelect(row.dataset.recordId, this.result?.items.find(item => item.record.id === row.dataset.recordId)?.record);
    });
    element.addEventListener('keydown', event => {
      if (['Enter', ' '].includes(event.key) && event.target.matches('tr[data-record-id]')) { event.preventDefault(); event.target.click(); }
    });
    element.addEventListener('change', event => {
      if (event.target.matches('[data-table-scope]')) this.scope = event.target.value;
      else if (event.target.matches('[data-table-projection]')) this.projection = event.target.value;
      else if (event.target.matches('[data-table-limit]')) this.limit = Number(event.target.value);
      else return;
      this.sync(true);
    });
  }
  input(context) {
    return { scope: this.scope, projection: this.projection, sort: structuredClone(this.sorts), limit: this.limit,
      ...(this.scope === 'window' ? { window: context.window } : {}) };
  }
  configure({ columns, sort } = {}) {
    this.columns = columns ? structuredClone(columns) : null;
    this.sorts = sort?.length ? structuredClone(sort) : [{ field: 'start', direction: 'asc' }];
    this.sort = this.sorts[0].field; this.direction = this.sorts[0].direction; this.key = null;
  }
  cell(record, field, match) {
    const path = pointer(field), { value, missing } = readField(record, path);
    if (path === '/title') return `<i class="table-color" style="background:${esc(record.render?.color || '#367ba4')}"></i><span class="${match ? 'table-match' : ''}">${esc(record.title)}</span>`;
    if (path === '/end' && value == null) return record.kind === 'session' ? 'Ongoing' : '-';
    if (missing || value === null) return '-';
    if (['/start', '/end', '/createdAt', '/updatedAt', '/originalStart', '/originalEnd'].includes(path)) return esc(this.dateLabel(value, true));
    return esc(typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  clear() {
    ++this.intent; this.controller?.abort(); this.exportController?.abort(); this.result = null; this.key = null; this.pending = false;
    this.render();
  }
  suspend() {
    ++this.intent; this.controller?.abort(); this.exportController?.abort(); this.pending = false;
    this.render();
  }
  current(origin) {
    const next = this.context();
    return next.provider === origin.provider && next.query?.queryId === origin.query?.queryId && !next.authRequired && !next.unavailable;
  }
  async sync(force = false, cursor = null) {
    const context = this.context();
    if (context.unavailable) { this.suspend(); return; }
    if (!context.query || context.authRequired) { this.clear(); return; }
    if (!this.visible) return;
    const input = this.input(context), key = canonicalJson({ identity: context.provider.identity, query: context.query.queryId, input });
    if (!force && key === this.key) { this.render(); return; }
    const intent = ++this.intent;
    this.controller?.abort(); this.controller = new AbortController();
    const controller = this.controller;
    if (key !== this.key) this.result = null;
    this.key = key; this.pending = true; this.render(); this.onChange();
    try {
      const result = await context.provider.queryRecords(context.query.queryId, { ...input, ...(cursor ? { cursor } : {}) }, { signal: controller.signal });
      if (intent !== this.intent || !this.current(context)) return;
      this.result = result;
    } catch (error) {
      if (intent === this.intent && this.current(context) && error.name !== 'AbortError') { this.key = null; this.onError(error); }
    } finally {
      if (intent === this.intent) { this.pending = false; this.render(); this.onChange(); }
    }
  }
  page(direction) {
    const cursor = direction === 'previous' ? this.result?.previousCursor : this.result?.nextCursor;
    if (cursor && !this.pending) return this.sync(true, cursor);
  }
  render() {
    const context = this.context(), data = this.result;
    const columns = this.columns ? this.columns.filter(column => column.visible) : fields.map(([field]) => ({ field, visible: true }));
    const header = column => {
      const selected = this.sorts.find(item => pointer(item.field) === pointer(column.field)), priority = this.sorts.indexOf(selected);
      const type = context.query?.fieldTypes?.[pointer(column.field)], sortable = type === undefined || !['strings', 'array', 'object'].includes(type);
      return `<th${column.width ? ` style="width:${column.width}px;min-width:${column.width}px"` : ''} aria-sort="${selected ? selected.direction === 'asc' ? 'ascending' : 'descending' : 'none'}"><button data-table-sort="${esc(column.field)}" title="${esc(fieldName(column.field))}" ${sortable ? '' : 'disabled'}><span class="table-header-label">${esc(fieldName(column.field))}</span>${selected ? `${icon(selected.direction === 'asc' ? 'arrow-up' : 'arrow-down')}${this.sorts.length > 1 ? `<small>${priority + 1}</small>` : ''}` : ''}</button></th>`;
    };
    const selectedId = context.selectedId, zone = context.timeZone || 'UTC';
    const focused = this.element.contains(document.activeElement) ? document.activeElement : null;
    const focusAttribute = focused && ['data-table-scope', 'data-table-projection', 'data-table-limit', 'data-table-sort', 'data-table-action', 'data-record-id'].find(name => focused.hasAttribute(name));
    const focusSelector = focusAttribute ? `[${focusAttribute}="${CSS.escape(focused.getAttribute(focusAttribute))}"]` : null;
    const previousScroll = this.element.querySelector('.table-scroll');
    const pageKey = data ? `${data.queryId}:${data.tableId}:${data.startIndex}` : null;
    const scroll = previousScroll && pageKey === this.renderPageKey ? { left: previousScroll.scrollLeft, top: previousScroll.scrollTop } : null;
    this.renderPageKey = pageKey;
    this.element.setAttribute('aria-busy', String(this.pending));
    this.element.innerHTML = `<div class="table-toolbar"><select data-table-scope aria-label="Table scope"><option value="all" ${this.scope === 'all' ? 'selected' : ''}>All filtered records</option><option value="window" ${this.scope === 'window' ? 'selected' : ''}>Current time range</option></select><select data-table-projection aria-label="Table search projection"><option value="context" ${this.projection === 'context' ? 'selected' : ''}>Context and highlights</option><option value="matches" ${this.projection === 'matches' ? 'selected' : ''}>Search findings only</option></select><select data-table-limit aria-label="Table page size">${[25, 50, 100, 250, 1000].map(size => `<option value="${size}" ${size === this.limit ? 'selected' : ''}>${size} / page</option>`).join('')}</select><button data-table-action="export" title="Export all records in this table scope as CSV" aria-label="Export table scope as CSV" ${!data || this.exporting ? 'disabled' : ''}>${icon('download')}</button>${this.exporting ? '<button data-table-action="cancel-export" aria-label="Cancel CSV export" title="Cancel CSV export">' + icon('x') + '</button>' : ''}</div>
      <div class="table-caption"><span role="status">${this.pending ? 'Loading records...' : data ? `${data.total} records${data.matchActive ? ` / ${data.matchTotal} search findings` : ''}` : 'No table result'}</span><span>${esc(zone)}${data ? ` / Snapshot ${data.revision}` : ''}</span></div>
      <div class="table-scroll"><table class="data-table"${this.columns ? ` style="table-layout:fixed;width:${columns.reduce((sum, column) => sum + column.width, 0)}px"` : ''}><thead><tr>${columns.map(header).join('')}</tr></thead><tbody>${(data?.items || []).map(({ record, match }) => `<tr tabindex="0" data-record-id="${esc(record.id)}" class="${record.id === selectedId ? 'selected' : ''}" aria-selected="${record.id === selectedId}">${columns.map(column => `<td class="${pointer(column.field) === '/title' ? 'title-cell' : ''}"${column.width ? ` style="width:${column.width}px;min-width:${column.width}px;max-width:${column.width}px"` : ''}>${this.cell(record, column.field, data.matchActive && match)}</td>`).join('')}</tr>`).join('')}</tbody></table>${columns.length ? '' : '<p class="subtle">No visible columns in this saved view.</p>'}</div>
      <div class="table-pagination"><button data-table-action="previous" title="Previous table page" aria-label="Previous table page" ${!data?.previousCursor || this.pending ? 'disabled' : ''}>${icon('chevron-left')}</button><span>${data ? `Records ${data.total ? data.startIndex + 1 : 0}-${data.endIndex} of ${data.total} / Page ${data.pageIndex + 1} of ${data.pageCount}` : 'Records 0-0'}</span><button data-table-action="next" title="Next table page" aria-label="Next table page" ${!data?.nextCursor || this.pending ? 'disabled' : ''}>${icon('chevron-right')}</button></div>`;
    this.updateIcons();
    if (context.unavailable) for (const control of this.element.querySelectorAll('button, select')) control.disabled = true;
    if (scroll) { const nextScroll = this.element.querySelector('.table-scroll'); nextScroll.scrollLeft = scroll.left; nextScroll.scrollTop = scroll.top; }
    if (focusSelector) {
      let next = this.element.querySelector(focusSelector);
      if (!next || next.disabled) { next = this.element.querySelector('.table-pagination span'); next.tabIndex = -1; }
      next.focus({ preventScroll: true });
    }
  }
  async exportCsv() {
    if (this.exporting) return;
    const context = this.context();
    if (!context.query || context.unavailable || context.authRequired) return;
    const input = { ...this.input(context), limit: 1000 }, controller = new AbortController();
    this.exportController = controller; this.exporting = true; this.render();
    try {
      const lines = [['ID', 'Title', 'Kind', 'Start (UTC)', 'End (UTC)', 'Source', 'Status'].map(csvCell).join(',')];
      let cursor = null, count = 0, bytes = lines[0].length;
      do {
        const result = await context.provider.queryRecords(context.query.queryId, { ...input, ...(cursor ? { cursor } : {}) }, { signal: controller.signal });
        if (!this.current(context) || controller.signal.aborted) throw new DOMException('Export canceled', 'AbortError');
        for (const { record } of result.items) {
          const line = [record.id, record.title, record.kind, record.start, record.end, record.sourceId, typeof record.data?.status === 'string' ? record.data.status : ''].map(csvCell).join(',');
          bytes += new TextEncoder().encode(line).length + 2; count++;
          if (bytes > 64 * 1024 * 1024 || count > 100000) throw new Error('CSV export exceeds 100,000 records or 64 MiB. Narrow the filter and try again.');
          lines.push(line);
        }
        cursor = result.nextCursor;
      } while (cursor);
      const url = URL.createObjectURL(new Blob(['\uFEFF', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `openbexi-${input.scope}-snapshot-${context.query.revision}.csv`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { if (this.current(context) && error.name !== 'AbortError') this.onError(error); }
    finally { if (this.exportController === controller) { this.exporting = false; this.exportController = null; this.render(); } }
  }
}
