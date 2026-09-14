import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from '../../shared/fixtures/legacy-presentation.json' with { type: 'json' };
import { adaptLegacyPresentation, legacyModelFocus, legacyViewport } from '../../client/src/data/legacy-presentation.js';
import { groupStyle, groupValue, resolvePresentation, resolveRecordStyle, validatePresentation } from '../../client/src/timeline/presentation.js';
import { toMs } from '../../client/src/timeline/time-scale.js';

for (const [name, fixture] of Object.entries(fixtures)) test(`${name}: actual legacy model preserves palette, scale, namespace and source ownership`, () => {
  const before = JSON.stringify(fixture), result = adaptLegacyPresentation(fixture.model, fixture);
  assert.equal(JSON.stringify(fixture), before);
  const { definition, viewHints } = result;
  assert.equal(definition.displayUnit, 'HOUR'); assert.equal(definition.fontSize, 12);
  assert.equal(definition.presentation.bands.primary.barHeight, 10);
  assert.equal(definition.presentation.bands.primary.pointRadius, 5);
  assert.equal(definition.presentation.bands.primary.axisPosition, 'top');
  assert.equal(viewHints.bands.primary.heightFraction, 0.75);
  assert.equal(viewHints.bands.overview.heightFraction, 0.25);
  const presentation = resolvePresentation(definition), binding = fixture.sourceBindings[0];
  const record = { id: 'event', sourceId: binding.sourceId, kind: 'event', data: { namespace: binding.namespace }, render: {} };
  const style = resolveRecordStyle(record, presentation), group = groupStyle(groupValue(record, presentation), presentation);
  assert.equal(style.color, fixture.model.bands[0].eventColor);
  assert.equal(style.sourceBackground, binding.render.color);
  assert.equal(group.backgroundColor, binding.render.color);
  assert.equal(group.textColor, binding.render.textColor);
  assert.equal(resolveRecordStyle({ ...record, render: { color: '#ff0000' } }, presentation).color, '#ff0000');
  assert.equal(resolveRecordStyle(record, presentation, 'overview').color, fixture.model.bands[1].eventColor);
  const viewport = legacyViewport(viewHints, 1000, toMs('2026-09-13T12:00:00.000Z'));
  assert.equal(toMs(viewport.primary.to) - toMs(viewport.primary.from), name === 'hazard' ? 7200000 : 3600000);
  assert.equal(toMs(viewport.overview.to) - toMs(viewport.overview.from), 86400000);
  assert.equal(viewport.center, name === 'hazard' ? '2026-09-13T12:00:00.000Z' : '2024-03-18T20:00:00.000Z');
});

test('explicit grouping choice wins without changing canonical source identity', () => {
  const fixture = fixtures.namespace;
  const plain = adaptLegacyPresentation(fixture.model, { ...fixture, namespaceGrouping: false });
  assert.equal(plain.definition.presentation.grouping, undefined);
  const status = adaptLegacyPresentation(fixture.model, { sortBy: 'status' });
  assert.equal(status.definition.presentation.grouping.field, '/data/status');
  const disabled = adaptLegacyPresentation(fixture.model, { sourceBindings: [{ ...fixture.sourceBindings[0], enabled: false }] });
  assert.deepEqual(disabled.definition.presentation.sourceStyles, []);
});

test('legacy dates are explicit, strict and independent of browser-local timezone', () => {
  assert.deepEqual(legacyModelFocus('2024-03-18T15:00:00-05:00'), { mode: 'fixed', timestamp: '2024-03-18T20:00:00.000Z' });
  for (const value of ['03/18/2024', 'Tue Mar 18 2024 20:00:00 UTC', 'Mon Feb 30 2024 20:00:00 UTC', '2024-03-18T20:00:00']) assert.throws(() => legacyModelFocus(value), { code: 'invalid_legacy_presentation' });
});

test('unsupported active geometry fails and inactive authored fields are visible diagnostics', () => {
  for (const edit of [model => model.bands.push(model.bands[0]), model => model.params[0].camera = 'Perspective', model => model.bands[0].height = '74%', model => model.bands[0].model[0].sortBy = 'constructor', model => model.bands[0].intervalPixels = '1e4']) {
    const model = structuredClone(fixtures.hazard.model); edit(model);
    assert.throws(() => adaptLegacyPresentation(model), { code: 'invalid_legacy_presentation' });
  }
  const model = structuredClone(fixtures.hazard.model); model.bands[0].image = 'untrusted.svg';
  const result = adaptLegacyPresentation(model);
  assert.ok(result.diagnostics.some(item => item.path === '/bands/0/image' && item.severity === 'warning'));
  assert.ok(result.diagnostics.some(item => item.code === 'connector_not_activated'));
  for (const sourceBindings of [[null], [{ sourceId: 'A', render: null }]]) assert.throws(() => adaptLegacyPresentation(model, { sourceBindings }), { code: 'invalid_legacy_presentation' });
});

test('namespace selectors cannot be ambiguous after normalization or be blank', () => {
  for (const namespaces of [[' ', 'B'], ['e\u0301', '\u00e9']]) assert.equal(validatePresentation({ version: 1, sourceStyles: namespaces.map((namespace, index) => ({ sourceId: String(index), namespace })) }).valid, false);
});

test('calendar units use the configured timezone and actual calendar unit length', () => {
  const hints = adaptLegacyPresentation(fixtures.namespace.model).viewHints;
  hints.focus.timestamp = '2024-02-01T00:00:00.000Z'; hints.bands.primary.intervalUnit = 'MONTH';
  const viewport = legacyViewport(hints, 1000);
  assert.equal(toMs(viewport.primary.to) - toMs(viewport.primary.from), 29 * 86400000);
});
