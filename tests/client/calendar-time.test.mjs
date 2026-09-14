import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDate, calendarTimeOptions, calendarInstant, calendarRange, centerCalendarRange, monthDays } from '../../client/src/ui/calendar-time.js';
import { projectTime, toMs, TIME_UNITS } from '../../client/src/timeline/time-scale.js';

test('Monday-first calendar keeps six stable weeks, leap days and bounded years', () => {
  const days = monthDays('2024-02-10');
  assert.equal(days.length, 42); assert.equal(days[0].date, '2024-01-29');
  assert.equal(days.find(day => day.date === '2024-02-29').outside, false);
  assert.throws(() => calendarDate('2023-02-29'));
  assert.equal(calendarDate('0000-01-01').year, 0);
  assert.throws(() => calendarDate('-010000-01-01'));
  assert.ok(monthDays('9999-12-01').some(day => day.disabled));
  assert.ok(monthDays('0001-01-01').every(day => day.disabled || /^0001/.test(day.date)));
});

test('hour calendar centers at 04:00 UTC, independent of local time and DST', () => {
  const options = calendarTimeOptions('HOUR', toMs('2024-05-03T18:42:13.123Z'));
  assert.deepEqual(options, { value: '04:00', step: 3600, disabled: false });
  assert.equal(calendarInstant('2024-05-03', options.value, 'HOUR'), Date.parse('2024-05-03T04:00:00Z'));
  assert.equal(calendarInstant('2024-03-10', '04:00', 'HOUR'), Date.parse('2024-03-10T04:00:00Z'));
  assert.equal(calendarInstant('0001-01-01', '04:00', 'HOUR'), Date.parse('0001-01-01T04:00:00Z'));
  assert.throws(() => calendarInstant('2024-05-03', '04:15', 'HOUR'));
});

test('all eleven scales choose matching time precision without silently accepting fractional seconds', () => {
  const center = toMs('2024-05-03T18:42:13.123Z');
  for (const unit of TIME_UNITS) {
    const options = calendarTimeOptions(unit, center);
    assert.doesNotThrow(() => calendarInstant('2024-05-03', options.value, unit));
  }
  assert.equal(calendarTimeOptions('MINUTE', center).value, '18:42');
  assert.equal(calendarTimeOptions('SECOND', center).value, '18:42:13');
  assert.equal(calendarTimeOptions('MILLISECOND', center).value, '18:42:13.123');
  assert.equal(calendarInstant('2024-05-03', '04:00', 'DAY'), Date.parse('2024-05-03T00:00:00Z'));
  assert.throws(() => calendarInstant('2024-05-03', '04:00:00.000001', 'MILLISECOND'));
});

test('calendar recenter uses the new adaptive map so selected time is at the physical midpoint', () => {
  const start = toMs('2024-05-03T00:00:00Z'), end = toMs('2024-05-04T00:00:00Z'), target = start + 4 * 3600000;
  const raw = { knots: [{ timeMs: start, u: '0' }, { timeMs: target, u: '0.6' }, { timeMs: end, u: '1' }] };
  const range = calendarRange(target, 3600000);
  const centered = centerCalendarRange(raw, target, range);
  assert.ok(Math.abs(projectTime(raw, target, centered.fromMs, centered.toMs, 1600) - 800) < 1e-7);
  const min = toMs('-009999-01-01T00:00:00Z'), max = toMs('9999-12-31T23:59:59.999Z');
  assert.equal(Number(calendarRange(min, 3600000).fromMs), min);
  assert.equal(Number(calendarRange(max, 3600000).toMs), max);
});
