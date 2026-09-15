import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeNavigationPreviewRows } from '../../client/src/timeline/navigation-preview-rows.js';

const item = (id, overrides = {}) => ({ record: { id, kind: 'event', start: '2026-01-01T00:00:00Z', end: null },
  row: 0, xStart: 20, xEnd: 20, labelX: 30, labelWidth: 30, displayTitle: id, footprintStart: 14, footprintEnd: 62, ...overrides });
const rows = (items = [], overrides = {}) => ({ items, rows: [], enclosures: [], rowHeight: 32, pageCapacity: 2, startRow: 0, endRow: 2,
  pageIndex: 0, pageCount: 1, pageComplete: true, totalRows: 2, loadedCount: items.length,
  layoutId: 'base-layout', mapId: 'frozen-map', previousCursor: null, nextCursor: null, ...overrides });
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

test('preview preserves all frozen base geometry and canonical pagination while translating every neighbor coordinate', () => {
  const base = freeze(rows([item('base', { row: 8 })], { startRow: 8, endRow: 10, pageIndex: 4, previousCursor: 'previous', nextCursor: 'next' }));
  const incoming = freeze(item('new', { row: 6, iconX: 2, baselineStart: -8, baselineEnd: 85, baselineOffsetY: 30 }));
  const adjacent = freeze(rows([incoming]));
  const result = mergeNavigationPreviewRows(base, [{ rows: adjacent, offsetX: 250 }]);
  assert.equal(result.rows.items[0], base.items[0]);
  const added = result.rows.items[1];
  for (const key of ['xStart', 'xEnd', 'labelX', 'iconX', 'baselineStart', 'baselineEnd', 'footprintStart', 'footprintEnd']) assert.equal(added[key], incoming[key] + 250);
  for (const [key, value] of Object.entries(base)) if (key !== 'items') assert.equal(result.rows[key], value);
  assert.equal(added.row, 8); assert.equal(added.record, incoming.record); assert.equal(result.rows.previewOnly, true);
  assert.equal(result.coverage.added, 1); assert.equal(result.coverage.partial, true);
  assert.deepEqual(result.coverage.reasons, ['base-page-partial']);
});

test('preview deduplicates adjacent records without deleting or moving existing render instances', () => {
  const first = item('base'), second = item('base', { row: 1 });
  const result = mergeNavigationPreviewRows(rows([first, second]), [
    { rows: rows([item('base'), item('new')]), offsetX: 200 },
    { rows: rows([item('new')]), offsetX: 400 },
  ]);
  assert.deepEqual(result.rows.items.map(value => value.record.id), ['base', 'base', 'new']);
  assert.equal(result.rows.items[0], first); assert.equal(result.rows.items[1], second);
  assert.equal(result.coverage.duplicates, 2); assert.equal(result.coverage.added, 1);
});

for (const [name, overrides] of [
  ['label', { xStart: 200, xEnd: 200, labelX: 40, labelWidth: 180 }],
  ['bar', { record: { id: 'new', kind: 'session', start: '2025-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' }, xStart: -200, xEnd: 500, labelX: 300 }],
  ['baseline', { xStart: 200, xEnd: 200, labelX: 210, baselineStart: 5, baselineEnd: 250, baselineOffsetY: 29 }],
  ['icon', { xStart: 200, xEnd: 200, labelX: 210, iconX: 40 }],
]) test(`preview reserves full unclipped ${name} bounds rather than clipped provider footprints`, () => {
  const base = rows([item('base')], { pageCapacity: 1, endRow: 1 });
  const result = mergeNavigationPreviewRows(base, [{ rows: rows([item('new', { ...overrides, footprintStart: 200, footprintEnd: 220 })]), offsetX: 0 }]);
  assert.equal(result.rows.items.length, 1); assert.equal(result.coverage.omitted, 1);
  assert.deepEqual(result.coverage.reasons, ['no-compatible-free-row']);
});

test('preview uses an available row instead of repacking base labels and can fill empty flat capacity', () => {
  const base = item('base'), adjacent = rows([item('new')]);
  const result = mergeNavigationPreviewRows(rows([base]), [{ rows: adjacent, offsetX: 0 }]);
  assert.equal(result.rows.items[0], base); assert.equal(result.rows.items[1].row, 1);
  const empty = rows([], { totalRows: 0, endRow: 0 });
  const filled = mergeNavigationPreviewRows(empty, [{ rows: adjacent, offsetX: 0 }]);
  assert.equal(filled.rows.items[0].row, 0); assert.equal(filled.rows.endRow, 0); assert.equal(filled.rows.totalRows, 0);
});

test('grouped additions use only visible matching typed group slots and never invent headers', () => {
  const group = (row, key) => ({ row, key, type: 'group', name: key, collapsed: false });
  const base = rows([item('one', { row: 1 }), item('two', { row: 4 })], {
    rows: [group(0, 'string:SOURCE1'), group(3, 'string:SOURCE2')], pageCapacity: 6, endRow: 6,
  });
  const adjacent = rows([item('new', { row: 1 })], { rows: [group(0, 'string:SOURCE2')] });
  const result = mergeNavigationPreviewRows(freeze(base), [{ rows: adjacent, offsetX: 200 }]);
  assert.equal(result.rows.items.at(-1).row, 4); assert.equal(result.rows.rows, base.rows);
  const unknown = rows([item('unknown', { row: 1 })], { rows: [group(0, 'number:2')] });
  assert.equal(mergeNavigationPreviewRows(base, [{ rows: unknown, offsetX: 200 }]).coverage.omitted, 1);
});

test('missing group continuation context and collapsed groups are partial, not assigned arbitrary rows', () => {
  const base = rows([item('base', { row: 5 })], { startRow: 5, endRow: 7 });
  const result = mergeNavigationPreviewRows(base, [{ rows: rows([item('new')]), offsetX: 200 }], { groupBy: 'sourceId' });
  assert.deepEqual(result.coverage.reasons, ['group-context-unavailable']);
  const collapsed = rows([], { rows: [{ row: 0, key: 'string:N', type: 'group', collapsed: true }] });
  const adjacent = rows([item('new', { row: 1 })], { rows: [{ row: 0, key: 'string:N', type: 'group' }] });
  assert.equal(mergeNavigationPreviewRows(collapsed, [{ rows: adjacent, offsetX: 0 }]).coverage.added, 0);
});

test('hierarchies and enclosures stay unchanged while unrelated flat records may occupy genuinely free rows', () => {
  const enclosure = { parentId: 'parent', startRow: 0, endRow: 2, xStart: 0, xEnd: 100 };
  const base = rows([item('parent'), item('child', { row: 1, depth: 1, ancestorIds: ['parent'] })], { enclosures: [enclosure], pageCapacity: 3, endRow: 3 });
  const result = mergeNavigationPreviewRows(freeze(base), [{ rows: rows([item('flat'), item('nested', { row: 1, depth: 1, ancestorIds: ['parent'] })]), offsetX: 200 }]);
  assert.equal(result.rows.items.at(-1).row, 2); assert.equal(result.rows.enclosures, base.enclosures);
  assert.equal(result.coverage.omittedByReason['hierarchy-requires-layout'], 1);
});

test('cross-row graphics also reserve their vertical footprint', () => {
  const style = { pointRadius: 3, fontSize: 10, barHeight: 8 };
  const styled = { style, labelLines: ['text'], labelLineHeight: 10, labelOffsetY: 0 };
  const base = rows([item('base', { ...styled, geometryOffsetY: 30, iconX: 24 })]);
  const candidate = item('new', { ...styled, geometryOffsetY: 5 });
  const result = mergeNavigationPreviewRows(base, [{ rows: rows([candidate]), offsetX: 0 }]);
  assert.equal(result.coverage.added, 0); assert.equal(result.coverage.omitted, 1);
});

test('uncertainty remains supported and neighbor pagination never implies complete row coverage', () => {
  const uncertain = item('new', { record: { ...item('new').record, extensions: { uncertainty: { lateststart: '2026-01-02T00:00:00Z' } } } });
  const result = mergeNavigationPreviewRows(rows(), [{ rows: rows([uncertain], { pageCount: 3, nextCursor: 'next' }), offsetX: 150 }]);
  assert.equal(result.coverage.added, 1); assert.equal(result.coverage.partial, true);
  assert.deepEqual(result.coverage.reasons, ['neighbor-page-partial']);
});

test('fully loaded pages remain partial when additional pages exist even without omitted records', () => {
  for (const paginated of ['base', 'neighbor']) {
    const base = rows([item('base')], paginated === 'base' ? { pageCount: 2 } : {});
    const adjacent = rows([item('neighbor')], paginated === 'neighbor' ? { pageCount: 2 } : {});
    const result = mergeNavigationPreviewRows(base, [{ rows: adjacent, offsetX: 200 }]);
    assert.equal(base.pageComplete, true); assert.equal(adjacent.pageComplete, true);
    assert.equal(result.coverage.added, 1); assert.equal(result.coverage.omitted, 0);
    assert.equal(result.coverage.partial, true);
    assert.deepEqual(result.coverage.reasons, [`${paginated}-page-partial`]);
  }
});

test('changed snapshots, row height, malformed geometry and preview budget fail closed without changing base', () => {
  const base = freeze(rows([item('base')], { snapshotId: 'original' }));
  for (const [reason, adjacent, options] of [
    ['incompatible-snapshot', rows([item('new')], { snapshotId: 'newer' }), {}],
    ['row-height-changed', rows([item('new')], { rowHeight: 40 }), {}],
    ['invalid-item-geometry', rows([item('new', { labelWidth: NaN })]), {}],
    ['preview-item-limit', rows([item('new')]), { maxItems: 1 }],
  ]) {
    const result = mergeNavigationPreviewRows(base, [{ rows: adjacent, offsetX: 200 }], options);
    assert.deepEqual(result.rows.items, base.items); assert.equal(result.coverage.omittedByReason[reason], 1);
  }
});

test('real version2 presentation geometry preserves measured multiline text, icon, baseline and namespace rows', async () => {
  const { buildLayout } = await import('../../client/src/timeline/layout.js');
  const start = Date.parse('2026-01-01T00:00:00Z'), hour = 3600000;
  const map = { knots: [{ timeMs: start, u: '0' }, { timeMs: start + 2 * hour, u: '1' }] };
  const definition = { definitionVersion: 2, width: 640, availableHeight: 400, rowHeight: 32, fontSize: 13,
    presentation: { version: 1, grouping: { field: '/sourceId' }, baseline: { enabled: true }, labels: { maxLines: 2 } } };
  const record = (id, offset) => ({ id, kind: 'session', title: 'Measured title\nSecond line', sourceId: 'SOURCE1', data: {},
    start: new Date(start + offset + 10000).toISOString(), end: new Date(start + offset + 20000).toISOString(),
    originalStart: new Date(start + offset + 5000).toISOString(), originalEnd: new Date(start + offset + 30000).toISOString(),
    render: { icon: 'flag', fontWeight: 700, fontStyle: 'italic' } });
  const page = layout => ({ ...layout, startRow: 0, endRow: layout.totalRows, pageCount: 1, pageComplete: true });
  const base = freeze(page(buildLayout([record('base', 0)], map, { ...definition, from: start, to: start + hour })));
  const adjacent = freeze(page(buildLayout([record('next', hour)], map, { ...definition, from: start + hour, to: start + 2 * hour })));
  const result = mergeNavigationPreviewRows(base, [{ rows: adjacent, offsetX: 640 }]);
  assert.equal(result.coverage.added, 1); assert.equal(result.coverage.partial, false);
  assert.equal(result.rows.items[0], base.items[0]);
  const added = result.rows.items[1];
  assert.equal(added.row, base.items[0].row);
  assert.deepEqual(added.labelLines, adjacent.items[0].labelLines);
  assert.equal(added.baselineStart, adjacent.items[0].baselineStart + 640);
  assert.equal(added.iconX, adjacent.items[0].iconX + 640);
  assert.equal(added.style, adjacent.items[0].style);
});
