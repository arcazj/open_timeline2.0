import { Temporal } from '@js-temporal/polyfill';
import { timeDecimal, toIso, toMs, createTimeMap, invertPosition, overviewBodyDrag, TIME_UNITS } from '../timeline/time-scale.js';
import { MIN_TIME, MAX_TIME } from '../timeline/navigation-domain.js';

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function calendarDate(value) {
  const date = Temporal.PlainDate.from(value);
  if (date.year < -9999 || date.year > 9999) throw new RangeError('Choose a date in astronomical years -9999 through 9999');
  return date;
}
export function monthDays(value) {
  const first = calendarDate(value).with({ day: 1 });
  const start = first.subtract({ days: first.dayOfWeek - 1 });
  return Array.from({ length: 42 }, (_, i) => {
    const date = start.add({ days: i });
    return { date: date.toString(), day: date.day, outside: date.month !== first.month,
      disabled: date.year < -9999 || date.year > 9999 };
  });
}
export function calendarTimeOptions(unit, center) {
  if (!TIME_UNITS.includes(unit)) throw new RangeError('Unsupported calendar scale');
  const time = Temporal.Instant.from(toIso(center)).toZonedDateTimeISO('UTC').toPlainTime();
  if (unit === 'HOUR') return { step: 3600, value: '04:00', disabled: false };
  if (unit === 'MINUTE') return { step: 60, value: time.toString({ smallestUnit: 'minute' }), disabled: false };
  if (unit === 'SECOND') return { step: 1, value: time.toString({ smallestUnit: 'second' }), disabled: false };
  if (unit === 'MILLISECOND') return { step: .001, value: time.toString({ smallestUnit: 'millisecond' }), disabled: false };
  return { step: 86400, value: '00:00', disabled: true };
}
export function calendarInstant(date, time, unit) {
  const day = calendarDate(date), options = calendarTimeOptions(unit, 0);
  const clock = Temporal.PlainTime.from(options.disabled ? '00:00' : time);
  const ms = ((clock.hour * 60 + clock.minute) * 60 + clock.second) * 1000 + clock.millisecond;
  if (clock.microsecond || clock.nanosecond || ms % Math.round(options.step * 1000)) throw new RangeError('Time must align with the selected scale');
  return toMs(day.toPlainDateTime(clock).toZonedDateTime('UTC').toInstant().toString({ smallestUnit: 'millisecond' }));
}
export function calendarRange(target, span) {
  const length = timeDecimal(span);
  if (!length.isFinite() || length.lt(1) || length.gt(MAX_TIME - MIN_TIME)) throw new RangeError('Invalid timeline span');
  const left = timeDecimal(target).minus(length.div(2)).clamp(MIN_TIME, timeDecimal(MAX_TIME).minus(length));
  return { fromMs: left.toFixed(), toMs: left.plus(length).toFixed() };
}
export function centerCalendarRange(rawMap, target, range) {
  const map = createTimeMap(rawMap);
  const center = invertPosition(map, .5, range.fromMs, range.toMs, 1);
  return overviewBodyDrag(map, range.fromMs, range.toMs, center, target);
}
