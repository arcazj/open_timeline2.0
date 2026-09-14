import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import hazard from '../../shared/fixtures/legacy-presentation.json' with { type: 'json' };
import icons from '../../shared/legacy-hazard-icons.json' with { type: 'json' };
import { adaptLegacyPresentation } from '../../client/src/data/legacy-presentation.js';
import { buildLayout } from '../../client/src/timeline/layout.js';
import { minorTicks } from '../../client/src/timeline/minor-ticks.js';
import { APPROVED_ICONS, isHazardIcon } from '../../client/src/timeline/presentation.js';

const from = Date.parse('2026-09-12T12:00:00Z'), to = from + 4 * 3600000;
const map = { knots: [{ timeMs: from, u: '0' }, { timeMs: to, u: '1' }] };
const presentation = adaptLegacyPresentation(hazard.hazard.model).definition.presentation;
const input = { from, to, width: 2000, rowHeight: 32, fontSize: 12, availableHeight: 480, presentation };
const event = (i, time = from + (i + 0.5) * 3600000) => ({ ...structuredClone(initial.records[0]), id: `90000000-0000-4000-8000-${String(i).padStart(12, '0')}`, title: `Hazard ${i}`, kind: 'event', start: new Date(time).toISOString(), end: null, parentSessionId: null, render: { icon: 'legacy-green-flag' } });

test('hazard images use a closed approved registry with embedded PNG inputs', async () => {
  assert.equal(new Set(Object.values(icons)).size, 8);
  for (const [file, id] of Object.entries(icons)) {
    assert.ok(APPROVED_ICONS.includes(id)); assert.equal(isHazardIcon(id), true);
    const bytes = await readFile(new URL(`../../client/assets/legacy-hazards/${file}`, import.meta.url));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  assert.equal(isHazardIcon('https://example.test/icon.png'), false);
});

test('standalone hazard events pack normally even when session enclosures are enabled', () => {
  const layout = buildLayout([0, 1, 2, 3].map(i => event(i)), map, input);
  assert.equal(layout.totalRows, 1); assert.equal(layout.enclosures.length, 0);
  for (const item of layout.items) {
    assert.equal(item.iconX, item.xStart - 8);
    assert.ok(item.labelX >= item.iconX + 20);
    assert.ok(item.footprintStart <= item.iconX - 2);
    assert.ok(item.footprintEnd >= item.iconX + 18);
  }
  const simultaneous = buildLayout([0, 1, 2].map(i => event(i, from + 3600000)), map, input);
  assert.equal(simultaneous.totalRows, 3);
});

test('the hazard model creates mapped quarter-hour divisions without altering page data', () => {
  assert.equal(presentation.bands.primary.minorDivisions, 4);
  const ticks = minorTicks({ from, to, unit: 'HOUR', divisions: 4, project: time => (time - from) / 7200 });
  assert.equal(ticks.length, 12);
  assert.deepEqual(ticks.slice(0, 3).map(tick => tick.timeMs - from), [900000, 1800000, 2700000]);
  assert.ok(ticks.every(tick => tick.minor && tick.label === ''));
  assert.equal(minorTicks({ from, to, unit: 'HOUR', divisions: 4, project: time => (time - from) / 3600000 }).length, 0);
});

test('subdivisions follow elapsed time across a DST transition and use the supplied nonuniform map', () => {
  const start = Date.parse('2026-03-08T06:00:00Z'), end = start + 3 * 3600000;
  const project = time => (time - start) / 10000 * (time < start + 3600000 ? 1 : 2);
  const ticks = minorTicks({ from: start, to: end, unit: 'HOUR', divisions: 4, project, timeZone: 'America/New_York' });
  assert.equal(ticks.length, 9); assert.equal(new Set(ticks.map(tick => tick.timeMs)).size, 9);
  assert.ok(ticks.every(tick => tick.timeMs >= start && tick.timeMs < end));
});
