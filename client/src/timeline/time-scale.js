import Decimal from 'decimal.js';
import { Temporal } from '@js-temporal/polyfill';

const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_EVEN });
export const TIME_UNITS = ['MILLISECOND', 'SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR', 'DECADE', 'CENTURY', 'MILLENNIUM'];
const STAMP = /^(\d{4}|-\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
export const MIN_TIME = -377705116800000; // Astronomical year -9999 (10000 BC).
export const MAX_TIME = 253402300799999;
export function instantFormat(value) { try { toMs(value); return typeof value === 'string'; } catch { return false; } }
export const eraYear = year => year <= 0 ? `${1 - year} BC` : String(year);
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function toMs(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    if (value < MIN_TIME || value > MAX_TIME) throw new RangeError('Date outside astronomical years -9999 through 9999');
    return value;
  }
  if (typeof value !== 'string' || !STAMP.test(value) || value.startsWith('-000000')) throw new RangeError('Expected an offset ISO timestamp with millisecond precision');
  const m = STAMP.exec(value);
  if (+m[6] > 59) throw new RangeError('Leap seconds are unsupported');
  const instant = Temporal.Instant.from(value);
  return toMs(instant.epochMilliseconds);
}

export function timeDecimal(value) {
  if (value instanceof D) return value;
  if (typeof value === 'string' && value.includes('T')) return new D(toMs(value));
  if (typeof value === 'string' && !DECIMAL.test(value)) throw new RangeError('Invalid decimal-view-v1 value');
  const number = new D(value);
  if (!number.isFinite() || number.sd() > 34) throw new RangeError('Invalid decimal precision');
  return number;
}

export function decimalString(value) {
  return new D(value).toSignificantDigits(34).toFixed();
}

export function toIso(value) {
  const ms = timeDecimal(value).floor().toNumber();
  toMs(ms);
  return Temporal.Instant.fromEpochMilliseconds(ms).toString({ smallestUnit: 'millisecond' });
}

export function createTimeMap(raw) {
  if (raw?._decimalMap) return raw;
  if (!raw || !Array.isArray(raw.knots) || raw.knots.length < 2) throw new RangeError('Map requires at least two knots');
  const knots = raw.knots.map(k => ({ t: timeDecimal(k.timeMs), u: timeDecimal(k.u) }));
  for (let i = 0; i < knots.length; i++) {
    if (i && (!knots[i].t.gt(knots[i - 1].t) || !knots[i].u.gt(knots[i - 1].u))) throw new RangeError('Map knots must increase strictly');
  }
  if (!knots[0].u.eq(0) || !knots.at(-1).u.eq(1)) throw new RangeError('Map must span zero to one');
  return { ...raw, _decimalMap: true, decimalKnots: knots };
}

function segment(knots, value, key) {
  if (value.lt(knots[0][key]) || value.gt(knots.at(-1)[key])) throw new RangeError('Coordinate outside analysis domain');
  let low = 0;
  let high = knots.length - 2;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (value.gte(knots[mid][key])) low = mid;
    else high = mid - 1;
  }
  return [knots[low], knots[low + 1]];
}

function forward(raw, time) {
  const map = createTimeMap(raw);
  const t = timeDecimal(time);
  const [a, b] = segment(map.decimalKnots, t, 't');
  return a.u.plus(b.u.minus(a.u).mul(t.minus(a.t)).div(b.t.minus(a.t)));
}

function inverse(raw, position) {
  const map = createTimeMap(raw);
  const u = timeDecimal(position);
  const [a, b] = segment(map.decimalKnots, u, 'u');
  return a.t.plus(b.t.minus(a.t).mul(u.minus(a.u)).div(b.u.minus(a.u)));
}

export const mapTime = (map, time) => decimalString(forward(map, time));
export const unmapTime = (map, position) => decimalString(inverse(map, position));

export function projectTime(map, time, from, to, width) {
  if (!(width > 0) || !Number.isFinite(width)) throw new RangeError('Invalid plot width');
  const left = forward(map, from);
  const right = forward(map, to);
  if (!right.gt(left)) throw new RangeError('Empty view');
  return forward(map, time).minus(left).div(right.minus(left)).mul(width).toNumber();
}

export function invertPosition(map, x, from, to, width) {
  if (!(width > 0) || !Number.isFinite(x)) throw new RangeError('Invalid plot coordinate');
  const a = forward(map, from);
  const b = forward(map, to);
  const u = a.plus(b.minus(a).mul(x).div(width));
  return decimalString(inverse(map, D.max(0, D.min(1, u))));
}

function clampedView(map, left, span, enforceMinimum = true) {
  const h = D.min(1, span);
  const a = D.max(0, D.min(new D(1).minus(h), left));
  const b = a.plus(h);
  const from = inverse(map, a);
  const to = inverse(map, b);
  if (enforceMinimum && to.minus(from).lt(1)) throw new RangeError('Minimum visible interval is one millisecond');
  return { fromMs: decimalString(from), toMs: decimalString(to), a: decimalString(a), b: decimalString(b) };
}

export function panRange(map, from, to, dx, width) {
  const a = forward(map, from);
  const h = forward(map, to).minus(a);
  return clampedView(map, a.minus(h.mul(dx).div(width)), h);
}

export function zoomRange(map, from, to, factor, anchorFraction = 0.5) {
  if (!(factor > 0) || !Number.isFinite(factor)) throw new RangeError('Invalid zoom factor');
  if (!(anchorFraction >= 0 && anchorFraction <= 1)) throw new RangeError('Invalid zoom anchor');
  const a = forward(map, from);
  const h = forward(map, to).minus(a);
  let next = D.min(1, h.div(factor));
  const anchor = a.plus(h.mul(anchorFraction));
  const candidate = clampedView(map, anchor.minus(next.mul(anchorFraction)), next, false);
  if (timeDecimal(candidate.toMs).minus(candidate.fromMs).lt(1)) {
    let low = next;
    let high = new D(1);
    for (let i = 0; i < 100; i++) {
      const mid = low.plus(high).div(2);
      const view = clampedView(map, anchor.minus(mid.mul(anchorFraction)), mid, false);
      if (timeDecimal(view.toMs).minus(view.fromMs).gte(1)) high = mid;
      else low = mid;
    }
    next = high;
  }
  return clampedView(map, anchor.minus(next.mul(anchorFraction)), next);
}

export function overviewBodyDrag(map, from, to, grabbedTime, pointerTime) {
  const a = forward(map, from);
  const h = forward(map, to).minus(a);
  const p = forward(map, grabbedTime).minus(a).div(h);
  const knots = createTimeMap(map).decimalKnots;
  const target = D.max(knots[0].t, D.min(knots.at(-1).t, timeDecimal(pointerTime)));
  return clampedView(map, forward(map, target).minus(p.mul(h)), h);
}

export function resizeOverview(map, from, to, edge, pointerTime) {
  const knots = createTimeMap(map).decimalKnots;
  let start = timeDecimal(from);
  let end = timeDecimal(to);
  if (edge === 'left') start = D.max(knots[0].t, D.min(end.minus(1), timeDecimal(pointerTime)));
  else if (edge === 'right') end = D.min(knots.at(-1).t, D.max(start.plus(1), timeDecimal(pointerTime)));
  else throw new RangeError('Unknown edge');
  return { fromMs: decimalString(start), toMs: decimalString(end), a: mapTime(map, start), b: mapTime(map, end) };
}

export const overviewResize = (map, from, to, edge, pointerTime) => resizeOverview(map, from, to, edge === 'start' ? 'left' : edge === 'end' ? 'right' : edge, pointerTime);

export function generateTicks(from, to, unit = 'HOUR', options = {}) {
  unit = unit.toUpperCase();
  if (!TIME_UNITS.includes(unit)) throw new RangeError('Unsupported time unit');
  const { multiple = 1, timeZone = 'UTC', maxTicks = 100 } = options;
  if (!Number.isSafeInteger(multiple) || multiple < 1 || multiple > 1000) throw new RangeError('Invalid interval multiple');
  const fromMs = timeDecimal(from).ceil().toNumber();
  const toMsValue = timeDecimal(to).ceil().toNumber();
  let tick = Temporal.Instant.fromEpochMilliseconds(fromMs).toZonedDateTimeISO(timeZone);
  const large = { DECADE: 10, CENTURY: 100, MILLENNIUM: 1000 };
  let step;
  if (unit === 'MILLISECOND') {
    tick = tick.with({ millisecond: Math.floor(tick.millisecond / multiple) * multiple, microsecond: 0, nanosecond: 0 });
    step = { milliseconds: multiple };
  } else if (unit === 'SECOND') {
    tick = tick.with({ second: Math.floor(tick.second / multiple) * multiple, millisecond: 0, microsecond: 0, nanosecond: 0 });
    step = { seconds: multiple };
  } else if (unit === 'MINUTE') {
    tick = tick.with({ minute: Math.floor(tick.minute / multiple) * multiple, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
    step = { minutes: multiple };
  } else if (unit === 'HOUR') {
    tick = tick.with({ hour: Math.floor(tick.hour / multiple) * multiple, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
    step = { hours: multiple };
  } else {
    tick = tick.startOfDay();
    if (unit === 'DAY') step = { days: multiple };
    if (unit === 'WEEK') {
      tick = tick.subtract({ days: tick.dayOfWeek - 1 });
      step = { weeks: multiple };
    }
    if (unit === 'MONTH') {
      tick = tick.with({ day: 1, month: Math.floor((tick.month - 1) / multiple) * multiple + 1 });
      step = { months: multiple };
    }
    if (unit === 'YEAR' || large[unit]) {
      const years = (large[unit] || 1) * multiple;
      const year = Math.max(-9999, Math.floor(tick.year / years) * years);
      tick = tick.with({ year, month: 1, day: 1 });
      step = { years };
    }
  }
  const ticks = [];
  while (tick.epochMilliseconds < toMsValue && ticks.length < maxTicks) {
    if (tick.epochMilliseconds >= fromMs && tick.year >= -9999 && tick.year <= 9999) {
      const pad = n => String(n).padStart(2, '0');
      const date = `${eraYear(tick.year)}-${pad(tick.month)}-${pad(tick.day)}`;
      let label = `${pad(tick.hour)}:${pad(tick.minute)}`;
      if (unit === 'SECOND') label += `:${pad(tick.second)}`;
      if (unit === 'MILLISECOND') label += `:${pad(tick.second)}.${String(tick.millisecond).padStart(3, '0')}`;
      if (['DAY', 'WEEK'].includes(unit)) label = date;
      if (unit === 'MONTH') label = date.slice(0, 7);
      if (['YEAR', 'DECADE', 'CENTURY', 'MILLENNIUM'].includes(unit)) label = eraYear(tick.year);
      ticks.push({ timeMs: tick.epochMilliseconds, label });
    }
    const next = step.years > 1 && tick.year === 1 ? tick.with({ year: step.years }) : tick.add(step);
    if (next.epochMilliseconds <= tick.epochMilliseconds) throw new RangeError('Tick generation made no progress');
    tick = next;
    if (tick.year > 9999) break;
  }
  return ticks;
}

export { D as ViewDecimal };
