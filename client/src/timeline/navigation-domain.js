import { ViewDecimal as D, createTimeMap, decimalString, panRange, projectTime, mapTime, unmapTime, toIso, toMs, zoomRange } from './time-scale.js';

import { MIN_TIME, MAX_TIME } from './time-scale.js';
export { MIN_TIME, MAX_TIME };
const cache = new WeakMap();

// Extend only the navigation map using its edge slopes. Query/layout maps stay
// immutable and bounded; fresh data and density are requested after settling.
export function navigationMap(raw) {
  if (cache.has(raw)) return cache.get(raw);
  const map = createTimeMap(raw), knots = map.decimalKnots;
  const first = knots[0], second = knots[1], last = knots.at(-1), penultimate = knots.at(-2);
  const low = first.u.plus(new D(MIN_TIME).minus(first.t).times(second.u.minus(first.u)).div(second.t.minus(first.t)));
  const high = last.u.plus(new D(MAX_TIME).minus(last.t).times(last.u.minus(penultimate.u)).div(last.t.minus(penultimate.t)));
  const extended = [{ t: new D(MIN_TIME), u: low }, ...knots.filter(k => k.t.gt(MIN_TIME) && k.t.lt(MAX_TIME)), { t: new D(MAX_TIME), u: high }];
  const result = createTimeMap({ ...raw, knots: extended.map(k => ({ timeMs: decimalString(k.t), u: decimalString(k.u.minus(low).div(high.minus(low))) })), _decimalMap: false });
  cache.set(raw, result);
  return result;
}

export function navigatePan(map, from, to, dx, width) {
  const extended = navigationMap(map), range = panRange(extended, from, to, dx, width);
  return { range, offset: projectTime(extended, from, range.fromMs, range.toMs, width) };
}

// Compile the pinned viewport once per gesture, not once per knot per frame.
export function createPanProjector(raw, from, to, width) {
  if (!Number.isFinite(width) || width <= 0) throw new RangeError('Invalid plot width');
  const map = navigationMap(raw), a = new D(mapTime(map, from)), h = new D(mapTime(map, to)).minus(a);
  if (!h.gt(0)) throw new RangeError('Empty view');
  return offset => {
    if (!Number.isFinite(offset)) throw new RangeError('Invalid pan offset');
    const left = D.max(0, D.min(new D(1).minus(h), a.minus(h.times(offset).div(width))));
    const range = { fromMs: unmapTime(map, left), toMs: unmapTime(map, left.plus(h)) };
    return { range, offset: a.minus(left).times(width).div(h).toNumber() };
  };
}

export const navigateZoom = (map, from, to, factor, anchor = 0.5) => zoomRange(navigationMap(map), from, to, factor, anchor);

export function rangeInside(domain, range) {
  return new D(range.fromMs).gte(toMs(domain.from)) && new D(range.toMs).lte(toMs(domain.to));
}

export function navigationQueryDomain(range) {
  const from = new D(range.fromMs), to = new D(range.toMs);
  if (!from.isFinite() || !to.isFinite() || from.lt(MIN_TIME) || to.gt(MAX_TIME) || !to.gt(from)) throw new RangeError('Invalid navigation query range');
  // Query timestamps use integer milliseconds; keep fractional viewport bounds inside them.
  return { from: toIso(from.floor()), to: toIso(to.ceil()) };
}

export function followingOverview(domain, range) {
  const from = new D(range.fromMs), to = new D(range.toMs), span = to.minus(from);
  const low = new D(toMs(domain.from)), high = new D(toMs(domain.to)), oldSpan = high.minus(low);
  const margin = D.min(span.div(2), oldSpan.times(0.08));
  if (from.gte(low.plus(margin)) && to.lte(high.minus(margin))) return domain;
  const nextSpan = D.min(MAX_TIME - MIN_TIME, D.max(oldSpan, span.times(4)));
  const nextLow = D.max(MIN_TIME, D.min(new D(MAX_TIME).minus(nextSpan), from.plus(to).minus(nextSpan).div(2))).floor();
  const nextHigh = D.min(MAX_TIME, nextLow.plus(nextSpan).ceil());
  const result = { from: toIso(nextLow), to: toIso(nextHigh) };
  return result.from === domain.from && result.to === domain.to ? domain : result;
}
