import { ViewDecimal as D, decimalString, toMs } from './time-scale.js';

export function fixedScaleMap(domain, intervals = [], mapId = 'fixed-reference') {
  if (!Array.isArray(intervals) || intervals.length > 32) throw new RangeError('At most 32 magnified intervals are supported');
  const from = toMs(domain.from), to = toMs(domain.to);
  if (from >= to) throw new RangeError('Scale domain must be positive');
  const spans = intervals.map(interval => {
    if (!interval || Object.keys(interval).some(key => !['from', 'to', 'ratio'].includes(key))) throw new RangeError('Invalid magnified interval');
    const a = toMs(interval.from), b = toMs(interval.to), ratio = interval.ratio;
    if (a >= b || !Number.isFinite(ratio) || ratio < 1 || ratio > 10000) throw new RangeError('Invalid magnified interval bounds or ratio');
    return { a, b, ratio };
  });
  const boundaries = [...new Set([from, to, ...spans.flatMap(s => [s.a, s.b]).filter(t => t > from && t < to)])].sort((a, b) => a - b);
  const mass = boundaries.slice(0, -1).map((start, i) => new D(boundaries[i + 1] - start).mul(Math.max(1, ...spans.filter(s => s.a <= start && s.b > start).map(s => s.ratio))));
  const total = mass.reduce((sum, n) => sum.plus(n), new D(0));
  let cumulative = new D(0);
  const knots = boundaries.map((timeMs, i) => {
    const u = i === mass.length ? '1' : decimalString(cumulative.div(total));
    if (i < mass.length) cumulative = cumulative.plus(mass[i]);
    return { timeMs, u };
  });
  return { mapId, domain, knots, mode: intervals.length ? 'fixed' : 'uniform', ratio: Math.max(1, ...spans.map(s => s.ratio)) };
}
