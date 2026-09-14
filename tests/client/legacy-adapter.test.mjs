import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dryRunLegacyVisualModel } from '../../client/src/data/legacy-visual-adapter.js';

const production = await readFile(new URL('./fixtures/legacy-production-regular.json', import.meta.url), 'utf8');
const testing = await readFile(new URL('./fixtures/legacy-test-regular.json', import.meta.url), 'utf8');
const entry = (report, pointer) => report.dispositions.find(item => item.pointer === pointer);

test('legacy production/test templates retain distinct provenance and every pointer', async () => {
  const first = await dryRunLegacyVisualModel(production, { sourcePath: 'models/regular_timeline.json' });
  const second = await dryRunLegacyVisualModel(testing, { sourcePath: 'tests/models/regular_timeline.json' });
  assert.equal(first.source.authoredName, second.source.authoredName);
  assert.notEqual(first.source.path, second.source.path);
  assert.notEqual(first.source.sha256, second.source.sha256);
  assert.equal(first.source.sha256, createHash('sha256').update(production).digest('hex'));
  assert.equal(entry(first, '/params/0/width').value, 2000);
  assert.equal(entry(second, '/params/0/width').value, 1350);
  assert.equal(entry(first, '/bands/0/color').value, '#f3ffff');
  assert.equal(entry(second, '/bands/0/color').value, '#ffffff');
  for (const [report, text] of [[first, production], [second, testing]]) {
    assert.equal(report.status, 'blocked');
    assert.equal(report.canCreate, false);
    assert.equal(report.candidate.definition.fontSize, 12);
    assert.equal(report.candidate.definition.groupBy, 'none');
    assert.equal(report.candidate.definition.displayUnit, 'HOUR');
    assert.equal(report.validation.valid, true);
    assert.equal(entry(report, '/bands/1/intervalUnit').disposition, 'mapped');
    assert.ok(report.defaults.some(item => item.pointer === '/definition/theme'));
    const pointers = [];
    const walk = (value, pointer = '') => {
      pointers.push(pointer);
      if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) walk(child, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    };
    walk(JSON.parse(text));
    assert.deepEqual(report.dispositions.map(item => item.pointer), pointers);
    assert.equal(new Set(pointers).size, pointers.length);
  }
});

test('legacy presentation mappings preserve exact palettes, axes, markers and independent band formats', async () => {
  const report = await dryRunLegacyVisualModel(production);
  const presentation = report.candidate.definition.presentation;
  assert.equal(presentation.version, 1);
  assert.deepEqual(presentation.bands.primary, { backgroundColor: '#f3ffff', intervalUnit: 'HOUR', axisPosition: 'top', dateFormat: 'MM/dd-hh:mm', dateColor: '#000001', textColor: '#040404', sessionColor: '#f8feff', eventColor: '#0f91f9', pointRadius: 5 });
  assert.deepEqual(presentation.bands.overview, { backgroundColor: '#d9dbde', intervalUnit: 'DAY', dateFormat: 'yyyy mmm dd', sessionColor: '#a110ff', eventColor: '#238448', dateColor: '#f31733' });
  assert.equal(entry(report, '/bands/0/model/0/alternateColor').disposition, 'preserved-inactive');
  assert.equal(entry(report, '/bands/0/intervalPixels').disposition, 'unsupported');
  assert.ok(report.diagnostics.some(item => item.code === 'calendar_format_correction'));
  assert.ok(report.diagnostics.some(item => item.code === 'measured_font_profile' && item.severity === 'review-required'));
  assert.equal(report.canCreate, false);
});

test('safe font/style and data-path grouping conversions never execute expressions or collapse extra bands', async () => {
  const source = { params: [{ title: 'Approved custom profile', fontFamily: 'Noto Sans', fontSize: 18, fontWeight: 'Bold', fontStyle: 'Italic', camera: 'Orthographic' }], bands: [{ name: 'main_band', color: '#112233', sessionHeight: 12, model: [{ sortBy: 'system.status' }] }] };
  const report = await dryRunLegacyVisualModel(JSON.stringify(source));
  assert.equal(report.validation.valid, true); assert.equal(report.canCreate, true);
  assert.deepEqual(report.candidate.definition.presentation.grouping, { field: '/data/system/status', direction: 'asc' });
  assert.deepEqual(report.candidate.definition.presentation.labels, { fontWeight: 700, fontStyle: 'italic' });
  assert.equal(report.candidate.definition.rowHeight, 37);
  assert.equal(entry(report, '/params/0/camera').disposition, 'matched-default');
  source.params[0].camera = 'Perspective';
  source.bands.push({ name: 'second_detail_band', color: '#445566' }, { name: 'extra_band', color: '#778899' });
  const extra = await dryRunLegacyVisualModel(JSON.stringify(source));
  assert.equal(extra.canCreate, false); assert.equal(extra.candidate.definition.presentation.bands.overview, undefined);
  assert.equal(entry(extra, '/bands/2/color').disposition, 'unsupported');
  assert.equal(entry(extra, '/params/0/camera').disposition, 'unsupported');
  source.bands[0].model[0].sortBy = '__proto__.polluted';
  const unsafe = await dryRunLegacyVisualModel(JSON.stringify(source));
  assert.equal(unsafe.validation.valid, false); assert.equal(unsafe.canCreate, false); assert.equal({}.polluted, undefined);
});

test('legacy dry-run redacts network and credential descendants without executing code', async () => {
  const input = JSON.parse(testing);
  input.params[0].data = 'https://user:password@example.invalid/events?token=PRIVATE';
  input.params[0].token = { nested: 'PRIVATE' };
  input.bands[0].callback = 'globalThis.legacyExecuted = true';
  const report = await dryRunLegacyVisualModel(JSON.stringify(input));
  assert.equal(entry(report, '/params/0/data').disposition, 'redacted');
  assert.equal(entry(report, '/params/0/data').value, undefined);
  assert.equal(entry(report, '/params/0/data_default_port').disposition, 'redacted');
  assert.equal(entry(report, '/params/0/token/nested').value, undefined);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  assert.equal(entry(report, '/bands/0/callback').disposition, 'redacted');
  assert.equal(entry(report, '/bands/0/callback').value, undefined);
  assert.ok(entry(report, '/bands/0/callback').valueSha256);
  assert.equal(globalThis.legacyExecuted, undefined);
  assert.equal(report.canCreate, false);
});

test('shareable reports exclude executable and custom secret text regardless of field name', async () => {
  const input = JSON.parse(production);
  const hidden = {
    descriptor: 'fetch("https://user:PRIVATE_DESCRIPTOR@example.invalid")',
    customField: 'https://user:PRIVATE_URL@example.invalid?token=PRIVATE_QUERY',
    unfamiliar: 'PRIVATE_CUSTOM_VALUE',
    obscureCode: 'globalThis.PRIVATE_EXECUTABLE = true',
  };
  Object.assign(input.params[0], hidden);
  input.params[0].title = 'fetch("https://user:PRIVATE_TITLE@example.invalid")';
  input.params[0].name = 'https://user:PRIVATE_ALIAS@example.invalid';
  const report = await dryRunLegacyVisualModel(JSON.stringify(input));
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('PRIVATE'));
  assert.equal(report.source.authoredName, null);
  assert.equal(report.candidate.name, 'Imported legacy template');
  assert.equal(report.canCreate, false);
  for (const [key, value] of Object.entries(hidden)) {
    const item = entry(report, `/params/0/${key}`);
    assert.equal(item.disposition, 'redacted');
    assert.equal(item.value, undefined);
    assert.equal(item.valueSha256, createHash('sha256').update(value).digest('hex'));
  }
  assert.equal(entry(report, '/bands/0/color').value, '#f3ffff');
});

test('legacy dry-run never coerces invalid values, accepts duplicate keys or unsafe provenance', async () => {
  const input = JSON.parse(production); input.params[0].fontSize = '12';
  const report = await dryRunLegacyVisualModel(JSON.stringify(input));
  assert.equal(report.validation.valid, false);
  assert.equal(report.canCreate, false);
  await assert.rejects(dryRunLegacyVisualModel('{"params":[],"params":[],"bands":[]}'), { code: 'duplicate_property' });
  await assert.rejects(dryRunLegacyVisualModel(production, { sourcePath: '../secret.json' }), { code: 'invalid_provenance' });
  await assert.rejects(dryRunLegacyVisualModel(production, { sourcePath: 'C:\\private.json' }), { code: 'invalid_provenance' });
  await assert.rejects(dryRunLegacyVisualModel(production, { sourceCommit: 'truncated' }), { code: 'invalid_provenance' });
  await assert.rejects(dryRunLegacyVisualModel('{"params":[],"bands":[]}'), { code: 'unsupported_legacy_shape' });
  await assert.rejects(dryRunLegacyVisualModel(' '.repeat(1024 * 1024 + 1)), { code: 'legacy_template_size_limit' });
});
