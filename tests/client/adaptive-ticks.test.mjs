import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveTicks } from '../../client/src/timeline/adaptive-ticks.js';
import { projectTime } from '../../client/src/timeline/time-scale.js';

test('dense pinned map intervals receive finer calendar divisions than surrounding context', () => {
  const from = Date.parse('2026-09-12T00:00:00Z'), hour = 3600000, to = from + 12 * hour;
  const map = { knots: [{ timeMs: from, u: '0' }, { timeMs: from + 5 * hour, u: '0.2' }, { timeMs: from + 7 * hour, u: '0.8' }, { timeMs: to, u: '1' }] };
  const project = value => projectTime(map, value, from, to, 1200), input = { map, from, to, width: 1200, project };
  const ticks = adaptiveTicks(input);
  assert.ok(ticks.some(tick => tick.timeMs >= from + 5 * hour && tick.timeMs < from + 7 * hour && tick.unit === 'MINUTE'));
  assert.ok(ticks.some(tick => tick.timeMs < from + 5 * hour && tick.unit === 'HOUR'));
  assert.deepEqual(adaptiveTicks(input), ticks);
  assert.equal(new Set(ticks.map(tick => tick.timeMs)).size, ticks.length);
  assert.ok(ticks.every(tick => tick.timeMs >= from && tick.timeMs < to));
});

test('local tick choice stays bounded across millisecond and multi-millennium ranges', () => {
  for (const [from, to] of [[0, 5], [Date.parse('0001-01-01T00:00:00Z'), Date.parse('9999-12-31T00:00:00Z')]]) {
    const map = { knots: [{ timeMs: from, u: '0' }, { timeMs: to, u: '1' }] };
    const ticks = adaptiveTicks({ map, from, to, width: 1000, project: value => projectTime(map, value, from, to, 1000) });
    assert.ok(ticks.length > 0 && ticks.length < 40);
    assert.ok(ticks.every(tick => Number.isFinite(tick.timeMs)));
  }
});

test('adaptive tick placement preserves actual time through a daylight saving transition', () => {
  const from = Date.parse('2026-11-01T04:00:00Z'), to = Date.parse('2026-11-01T10:00:00Z');
  const map = { knots: [{ timeMs: from, u: '0' }, { timeMs: to, u: '1' }] };
  const ticks = adaptiveTicks({ map, from, to, width: 1000, timeZone: 'America/New_York', project: value => projectTime(map, value, from, to, 1000) });
  assert.ok(ticks.length > 5);
  assert.ok(ticks.every((tick, index) => index === 0 || tick.timeMs > ticks[index - 1].timeMs));
});
