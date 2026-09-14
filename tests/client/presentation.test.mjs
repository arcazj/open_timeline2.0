import test from 'node:test';
import assert from 'node:assert/strict';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { buildLayout, measureText } from '../../client/src/timeline/layout.js';
import { wrapLabel } from '../../client/src/timeline/text-metrics.js';
import { resolvePresentation, resolveRecordStyle, validatePresentation, readField, groupValue } from '../../client/src/timeline/presentation.js';
import { validateDefinition, DEFAULT_DEFINITION } from '../../client/src/data/model-catalog.js';
import { validateRecord, validateSnapshot } from '../../client/src/data/snapshot.js';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { toMs, toIso } from '../../client/src/timeline/time-scale.js';

const start = toMs('2026-09-12T10:00:00.000Z'), end = start + 3600000;
const map = { knots: [{ timeMs: start, u: '0' }, { timeMs: end, u: '1' }] };
const input = { from: start, to: end, width: 640, availableHeight: 480, rowHeight: 32, fontSize: 13, presentation: { version: 1 } };
function record(i, overrides = {}) {
  return { ...structuredClone(initial.records[0]), id: `90000000-0000-4000-8000-${String(i).padStart(12, '0')}`, title: `Record ${i}`, kind: 'session', start: toIso(start + 100000), end: toIso(end - 100000), parentSessionId: null, order: 0, sourceId: 'SOURCE1', render: {}, originalStart: null, originalEnd: null, data: {}, ...overrides };
}
function snapshot(records) {
  const value = structuredClone(initial);
  value.records = records; value.manifest.recordCount = records.length;
  value.manifest.scope.sourceIds = [...new Set(records.map(item => item.sourceId))];
  delete value.manifest.contentSha256;
  return value;
}

test('presentation is an optional strict model extension with safe pointers and exact style inheritance', () => {
  assert.equal(validateDefinition(DEFAULT_DEFINITION).valid, true);
  const presentation = { version: 1, bands: { primary: { backgroundColor: '#ffffff', textColor: '#222222', eventColor: '#334455' } }, sourceStyles: [{ sourceId: 'SOURCE1', textColor: '#ffffff', backgroundColor: '#000000', eventColor: '#445566' }], labels: { fontWeight: 700, fontStyle: 'italic', maxLines: 4, fields: ['/title', '/data/a~1b/~0'] }, grouping: { field: '/data/status', direction: 'desc' } };
  assert.equal(validateDefinition({ ...DEFAULT_DEFINITION, presentation }).valid, true);
  const resolved = resolvePresentation({ fontSize: 13, presentation });
  const style = resolveRecordStyle(record(1, { kind: 'event', render: { color: '#aabbcc', backgroundColor: null, fontSize: 18 } }), resolved);
  assert.equal(style.color, '#aabbcc'); assert.equal(style.textColor, '#ffffff'); assert.equal(style.sourceBackground, '#000000');
  assert.equal(style.fontSize, 18); assert.equal(style.fontWeight, 700); assert.equal(style.fontStyle, 'italic'); assert.equal(style.backgroundColor, null);
  presentation.labels.fields.push('/start');
  assert.deepEqual(resolved.labels.fields, ['/title', '/data/a~1b/~0']);
  assert.deepEqual(readField({ data: { 'a/b': { '~': 7 } } }, '/data/a~1b/~0'), { missing: false, value: 7 });
  for (const field of ['/data/__proto__/x', '/data/constructor', '/data/x~2y', '/data//x', '/title/nope']) assert.equal(validatePresentation({ version: 1, labels: { fields: [field] } }).valid, false, field);
  for (const value of [{ version: 2 }, { version: 1, callback: 'alert(1)' }, { version: 1, labels: { fontWeight: 500 } }, { version: 1, labels: { fontFamily: 'Internet Font' } }, { version: 1, sourceStyles: [{ sourceId: 'S' }, { sourceId: 'S' }] }]) assert.equal(validatePresentation(value).valid, false);
});

test('all four approved font profiles and per-line ink bounds drive deterministic wrapping', () => {
  const widths = new Set();
  for (const fontWeight of [400, 700]) for (const fontStyle of ['normal', 'italic']) {
    const style = { fontSize: 18, fontWeight, fontStyle };
    widths.add(measureText('jj Wide title', 18, fontWeight, fontStyle).width);
    const wrapped = wrapLabel('jj Wide title and a longunbrokentoken\nSecond paragraph', style, 105, 3);
    assert.ok(wrapped.labelLines.length <= 3); assert.equal(wrapped.overflow, true);
    wrapped.labelLines.forEach((line, index) => {
      const metric = measureText(line, 18, fontWeight, fontStyle);
      assert.ok(metric.width <= 105 + 1e-9); assert.equal(wrapped.labelInkOffsets[index], metric.inkOffset);
    });
    assert.ok(wrapped.labelLines.at(-1).endsWith('...'));
  }
  assert.ok(widths.size >= 3);
  assert.throws(() => wrapLabel('Title', { fontSize: 24, fontWeight: 700, fontStyle: 'normal' }, 2), { code: 'label_width_limit' });
  assert.throws(() => measureText('Unsupported 😀', 13), { code: 'unsupported_glyph' });
});

test('resolved icons and original baselines reserve their full horizontal and vertical footprints', () => {
  const item = record(1, { render: { icon: 'flag', fontSize: 18, fontWeight: 700, fontStyle: 'italic', barHeight: 16 }, originalStart: toIso(start + 20000), originalEnd: toIso(end - 20000) });
  const layout = buildLayout([item], map, { ...input, presentation: { version: 1, labels: { maxLines: 2 }, baseline: { enabled: true } } });
  const projected = layout.items[0];
  assert.equal(projected.iconX, projected.xStart - 20);
  assert.ok(projected.footprintStart <= Math.max(0, projected.iconX - 2));
  assert.ok(projected.footprintStart <= projected.baselineStart);
  assert.ok(projected.footprintEnd >= projected.baselineEnd);
  assert.ok(projected.baselineOffsetY + 6.5 <= layout.rowHeight);
  assert.ok(projected.geometryOffsetY + 8 + 6 <= layout.rowHeight);
  assert.throws(() => buildLayout([item], map, { ...input, availableHeight: 32, presentation: { version: 1 } }), { code: 'row_height_limit' });
  const withoutOriginal = buildLayout([record(2)], map, { ...input, presentation: { version: 1, baseline: { enabled: true } } });
  assert.equal(withoutOriginal.items[0].baselineStart, undefined);
  assert.deepEqual(item, record(1, { render: { icon: 'flag', fontSize: 18, fontWeight: 700, fontStyle: 'italic', barHeight: 16 }, originalStart: toIso(start + 20000), originalEnd: toIso(end - 20000) }));
});

test('point-only multiline layouts reserve the full label stack on every vertical page', () => {
  const records = [1, 2, 3].map(id => record(id, { kind: 'event', end: null, start: toIso(start + 1800000), title: 'Line one\nLine two\nLine three\nLine four', render: { fontSize: 24 } }));
  const presentation = { version: 1, labels: { maxLines: 4 } };
  const layout = buildLayout(records, map, { ...input, availableHeight: 288, presentation });
  assert.equal(layout.rowHeight, 144); assert.equal(layout.pageCapacity, 2);
  assert.deepEqual(layout.items.map(item => item.row), [0, 1, 2]);
  for (const item of layout.items) {
    assert.equal(item.labelLines.length, 4);
    assert.ok(item.labelOffsetY + item.labelLines.length * item.labelLineHeight + 6 <= layout.rowHeight);
  }
  assert.throws(() => buildLayout(records, map, { ...input, availableHeight: 143, presentation }), { code: 'row_height_limit' });
  for (const pointRadius of [1, 5, 7, 10]) {
    const item = record(4, { ...records[0], render: { fontSize: 24, pointRadius, icon: 'star' }, originalStart: toIso(start + 600000), originalEnd: toIso(end - 600000) });
    const withBaseline = buildLayout([item], map, { ...input, presentation: { ...presentation, baseline: { enabled: true } } });
    const projected = withBaseline.items[0];
    assert.equal(projected.xStart - pointRadius - (projected.iconX + 16), 5);
    assert.ok(projected.baselineOffsetY >= projected.labelOffsetY + projected.labelLines.length * projected.labelLineHeight + 3);
    assert.equal(withBaseline.rowHeight, 148);
  }
});

test('primitive data grouping merges NFC-equivalent values and keeps null/missing last in both directions', () => {
  const values = [2, 1, 'B', 'A', false, true, null, undefined, 'é', 'é'];
  const records = values.map((value, i) => record(i + 1, { data: value === undefined ? {} : { status: value } }));
  const presentation = { version: 1, grouping: { field: '/data/status', direction: 'desc' } };
  const layout = buildLayout(records, map, { ...input, presentation });
  assert.deepEqual(layout.rows.map(row => row.name), ['2', '1', 'é', 'B', 'A', 'true', 'false', '(null)', '(missing)']);
  assert.equal(layout.detailTotal, 10);
  assert.equal(layout.items.length, 10);
  assert.equal(groupValue(record(1, { data: { status: 1 } }), resolvePresentation({ presentation })).key, 'number:1');
  assert.throws(() => buildLayout([record(1, { data: { status: {} } })], map, { ...input, presentation }), { code: 'invalid_group_value' });
  assert.throws(() => buildLayout([record(1, { data: { status: [] } })], map, { ...input, presentation: { version: 1, labels: { fields: ['/data/status'] } } }), { code: 'invalid_label_value' });
});

test('nested rows are consecutive, stable across input order and never inject excluded parents', async () => {
  const parent = record(1), children = [2, 3, 4, 5].map(i => record(i, { title: `Child ${i}`, parentSessionId: parent.id, order: 6 - i }));
  const presentation = { version: 1, nesting: { enabled: true } };
  const layout = buildLayout([...children, parent], map, { ...input, presentation });
  assert.deepEqual(layout.items.map(item => item.record.id), [parent, ...children.toReversed()].map(item => item.id));
  assert.equal(layout.totalRows, 5); assert.equal(layout.enclosures.length, 1);
  assert.deepEqual(layout.items.map(item => item.depth), [0, 1, 1, 1, 1]);
  const withoutParent = buildLayout(children, map, { ...input, presentation });
  assert.ok(withoutParent.items.every(item => item.depth === 0)); assert.equal(withoutParent.enclosures.length, 0);
  const provider = new LocalProvider(snapshot([parent, ...children])); await provider.initialize();
  const query = await provider.createQuery({ domain: { from: toIso(start), to: toIso(end) }, filters: {}, search: '', scaleMode: 'uniform', bins: 16, ratio: 4 });
  const packed = await provider.createLayout(query.queryId, { ...input, presentation, availableHeight: layout.rowHeight * 2 });
  presentation.nesting.enabled = false;
  let cursor, count = 0, pageIndex = 0;
  const ids = [];
  do {
    const page = await provider.getRows(query.queryId, packed.layoutId, { cursor });
    assert.equal(page.loadedCount, pageIndex < 2 ? 2 : 1);
    assert.equal(page.enclosures[0].continuedBefore, pageIndex > 0);
    assert.equal(page.enclosures[0].continuedAfter, pageIndex < 2);
    assert.equal(page.enclosures[0].visibleStartRow, page.startRow);
    assert.equal(page.rowHeight, layout.rowHeight);
    assert.equal(page.presentation.nesting.enabled, true);
    ids.push(...page.items.map(item => item.record.id)); count += page.loadedCount; pageIndex++; cursor = page.nextCursor;
  } while (cursor);
  assert.equal(count, 5); assert.equal(new Set(ids).size, 5);
  provider.dispose();
});

test('1,000 seeded styled layouts preserve source records, measured widths and unrelated clearance', () => {
  let seed = 31917;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let trial = 0; trial < 1000; trial++) {
    const records = Array.from({ length: 5 }, (_, index) => {
      const t = start + 300000 + Math.floor(random() * 2600000);
      return record(index + 1, { title: `Title ${index} ${'Long words '.repeat(1 + Math.floor(random() * 4))}`, kind: index % 2 ? 'event' : 'session', start: toIso(t), end: index % 2 ? null : toIso(Math.min(end, t + 300000)), render: { fontSize: 11 + Math.floor(random() * 14), fontWeight: random() < 0.5 ? 400 : 700, fontStyle: random() < 0.5 ? 'normal' : 'italic', pointRadius: 1 + random() * 9, barHeight: 2 + random() * 18, ...(random() < 0.3 ? { icon: 'star' } : {}) } });
    });
    const before = JSON.stringify(records);
    const layout = buildLayout(records, map, { ...input, presentation: { version: 1, labels: { maxLines: 1 + Math.floor(random() * 4) } } });
    assert.equal(JSON.stringify(records), before);
    assert.equal(new Set(layout.items.map(item => item.record.id)).size, records.length);
    for (const item of layout.items) {
      assert.ok(item.footprintStart >= 0 && item.footprintEnd <= input.width);
      item.labelLines.forEach(line => assert.ok(measureText(line, item.style.fontSize, item.style.fontWeight, item.style.fontStyle).width <= item.labelWidth + 1e-9));
      for (const other of layout.items) if (item !== other && item.row === other.row) assert.ok(item.footprintEnd + 4 <= other.footprintStart + 1e-9 || other.footprintEnd + 4 <= item.footprintStart + 1e-9);
    }
  }
});

test('presentation publication/export preserve history and applying an old definition clears stale overrides', async () => {
  const provider = new LocalProvider(snapshot([record(1)])); await provider.initialize();
  const old = (await provider.listModels()).items[0];
  const invoke = (type, model, payload = {}) => provider.executeModelCommand({ type, modelId: model?.id, expectedRevision: model?.revision, payload, generation: provider.generation, clientCommandId: crypto.randomUUID() });
  const presentation = { version: 1, nesting: { enabled: true }, labels: { fontStyle: 'italic' } };
  let result = await invoke('create', null, { name: 'Nested', definition: { ...DEFAULT_DEFINITION, presentation } });
  result = await invoke('publish', result.model);
  const custom = result.model;
  result = await invoke('apply', custom, { version: 1 });
  assert.deepEqual(result.settings.presentation, presentation);
  const exported = await provider.exportSnapshot();
  const roundTrip = await validateSnapshot(exported); assert.deepEqual(roundTrip.settings.presentation, presentation);
  result = await invoke('apply', old, { version: 1 });
  assert.equal(Object.hasOwn(result.settings, 'presentation'), false);
  assert.deepEqual((await provider.getModel(custom.id)).model.versions[0].definition.presentation, presentation);
  const bad = structuredClone(exported); delete bad.manifest.contentSha256; bad.settings.presentation.grouping = { field: '/data/__proto__' };
  await assert.rejects(validateSnapshot(bad), { code: 'invalid_presentation' });
  provider.dispose();
});

test('record overrides are strict data and survive complete Local exports', async () => {
  const styled = record(1, { render: { color: '#123456', textColor: '#ffffff', backgroundColor: null, fontSize: 20, fontWeight: 700, fontStyle: 'italic', barHeight: 20, pointRadius: 10, icon: 'alert-triangle' } });
  assert.equal(validateRecord(styled), styled);
  for (const render of [{ icon: 'https://example.test/a.svg' }, { opacity: 0.5 }, { fontStyle: 'oblique' }, { pointRadius: 11 }, { fontWeight: 500 }]) assert.throws(() => validateRecord(record(2, { render })), { code: 'invalid_record' });
  const provider = new LocalProvider(snapshot([styled])); await provider.initialize();
  const exported = await validateSnapshot(await provider.exportSnapshot());
  assert.deepEqual(exported.records[0].render, styled.render); provider.dispose();
});
