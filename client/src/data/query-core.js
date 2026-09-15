import { resolveQueryConfiguration } from './query-configuration.js';
import { fixedScaleMap } from '../timeline/fixed-scale.js';
export { foldText, parseSearch } from './filter-expression.js';
import { ViewDecimal as D, toMs, toIso, decimalString } from '../timeline/time-scale.js';
import { ProviderError, uuid } from './data-provider.js';
import { resolveRelationshipSteps } from './query-relationships.js';
import { drainQuerySteps, drainQueryStepsAsync } from './query-work.js';

export function createQueryData(snapshot, input, options = {}) {
  return drainQuerySteps(createQueryDataSteps(snapshot, input, options), options);
}

export function createQueryDataAsync(snapshot, input, options = {}) {
  return drainQueryStepsAsync(createQueryDataSteps(snapshot, input, options), options);
}

function bisect(edges, value, right = false) {
  let low = 0, high = edges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (edges[middle] < value || (right && edges[middle] === value)) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function* createQueryDataSteps(snapshot, input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProviderError('invalid_query', 'Query input must be an object', 422);
  const from = toMs(input.domain?.from);
  const to = toMs(input.domain?.to);
  if (from >= to) throw new ProviderError('invalid_range', 'Analysis domain must be positive');
  const mode = input.scaleMode === undefined ? 'uniform' : input.scaleMode;
  if (!['uniform', 'adaptive'].includes(mode)) throw new ProviderError('invalid_scale_mode', 'Unknown scale mode');
  const ratio = input.ratio === undefined ? 4 : input.ratio;
  const requestedBins = input.bins === undefined ? 128 : input.bins;
  if (!(ratio >= 1 && ratio <= 32) || !Number.isFinite(ratio) || !Number.isInteger(requestedBins) || requestedBins < 16 || requestedBins > 256) throw new ProviderError('invalid_density', 'Invalid density parameters');
  const configuration = resolveQueryConfiguration(snapshot, input, undefined, options);
  const { predicate, search, fieldTypes, definitionVersion, relationshipMode } = configuration;
  const bounds = new WeakMap();
  const recordBounds = record => {
    if (!bounds.has(record)) {
      const start = toMs(record.start), end = record.end === null ? null : toMs(record.end);
      bounds.set(record, { start, end, point: record.kind === 'event' || end === start });
    }
    return bounds.get(record);
  };
  const inDomain = record => {
    const { start, end, point } = recordBounds(record);
    return point ? start >= from && start < to : start < to && (end === null || end > from);
  };
  let work = 0;
  let universe = snapshot.records;
  if (definitionVersion === 1 && snapshot.manifest?.legacy?.readOnly) {
    const byId = new Map(), selected = new Set();
    for (const record of universe) {
      if (++work % 64 === 0) yield;
      byId.set(record.id, record);
      if (inDomain(record)) selected.add(record.id);
    }
    for (const id of [...selected]) {
      if (++work % 64 === 0) yield;
      let parent = byId.get(id).parentSessionId;
      while (parent && !selected.has(parent)) { selected.add(parent); parent = byId.get(parent)?.parentSessionId; }
    }
    const filtered = [];
    for (const record of universe) {
      if (++work % 64 === 0) yield;
      if (selected.has(record.id)) filtered.push(record);
    }
    universe = filtered;
  }
  const relationships = definitionVersion === 2 ? yield* resolveRelationshipSteps(universe, configuration, from, to, { inDomain }) : null;
  const records = relationships?.records ?? [];
  if (!relationships) for (const record of universe) {
    if (++work % 64 === 0) yield;
    if (predicate(record)) records.push(record);
  }
  const zones = (snapshot.zones || []).filter(zone => !zone.legacy?.sourceId || configuration.sourceSelected(zone.legacy.sourceId));
  const matches = relationships?.matches ?? new Set();
  if (!relationships) for (const record of records) {
    if (++work % 64 === 0) yield;
    if (search.matches(record)) matches.add(record.id);
  }
  const overviewRecords = [];
  for (const record of relationships?.eligibleRecords ?? records) {
    if (++work % 64 === 0) yield;
    if (inDomain(record)) overviewRecords.push(record);
  }
  if (definitionVersion === 2) overviewRecords.sort((left, right) => recordBounds(left).start - recordBounds(right).start ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const count = Math.min(requestedBins, to - from);
  const boundaries = Array.from({ length: count + 1 }, (_, i) => from + Number(BigInt(i) * BigInt(to - from) / BigInt(count)));
  const bins = boundaries.slice(0, -1).map((start, i) => ({ from: start, to: boundaries[i + 1], points: 0, overlap: 0n, endpoints: 0, records: 0, matches: 0 }));
  const fullBins = Array(count + 1).fill(0), recordCounts = Array(count + 1).fill(0), matchCounts = Array(count + 1).fill(0);
  for (const record of overviewRecords) {
    if (++work % 64 === 0) yield;
    const { start, end: authoredEnd, point } = recordBounds(record), end = authoredEnd ?? (point ? start : to);
    const matching = matches.has(record.id);
    const lower = Math.max(from, start), upper = Math.min(to, end);
    const first = Math.max(0, bisect(boundaries, lower, true) - 1);
    const last = point ? first : Math.min(count - 1, bisect(boundaries, upper) - 1);
    recordCounts[first]++; recordCounts[last + 1]--;
    if (matching) { matchCounts[first]++; matchCounts[last + 1]--; }
    if (point) bins[first].points++;
    else {
      if (start >= from && start < to) bins[bisect(boundaries, start, true) - 1].endpoints++;
      if (authoredEnd !== null && end >= from && end < to) bins[bisect(boundaries, end, true) - 1].endpoints++;
      if (first === last) bins[first].overlap += BigInt(upper - lower);
      else {
        bins[first].overlap += BigInt(boundaries[first + 1] - lower);
        bins[last].overlap += BigInt(upper - boundaries[last]);
        fullBins[first + 1]++; fullBins[last]--;
      }
    }
  }
  let active = 0, activeRecords = 0, activeMatches = 0;
  for (let index = 0; index < count; index++) {
    active += fullBins[index]; activeRecords += recordCounts[index]; activeMatches += matchCounts[index];
    bins[index].overlap += BigInt(active) * BigInt(boundaries[index + 1] - boundaries[index]);
    bins[index].records = activeRecords; bins[index].matches = activeMatches;
  }
  const densityBins = bins.map(bin => ({ from: bin.from, to: bin.to, points: bin.points, overlapMs: bin.overlap.toString(), endpoints: bin.endpoints, density: bin.points + Number(bin.overlap) / (bin.to - bin.from) + 0.5 * bin.endpoints }));
  const maximum = Math.max(0, ...densityBins.map(bin => bin.density));
  const weights = densityBins.map(bin => mode === 'uniform' || maximum === 0 ? new D(1) : new D(1).plus(new D(ratio - 1).mul(new D(String(Math.log1p(bin.density)))).div(new D(String(Math.log1p(maximum))))));
  const mass = weights.map((w, i) => w.mul(boundaries[i + 1] - boundaries[i]));
  const totalMass = mass.reduce((sum, value) => sum.plus(value), new D(0));
  let cumulative = new D(0);
  const knots = boundaries.map((timeMs, i) => {
    const u = i === count ? '1' : decimalString(cumulative.div(totalMass));
    if (i < count) cumulative = cumulative.plus(mass[i]);
    return { timeMs, u };
  });
  const mapId = uuid();
  const fixed = input.fixedScale === undefined ? null : fixedScaleMap({ from: toIso(from), to: toIso(to) }, input.fixedScale, mapId);
  const overviewBins = bins.map(bin => ({ from: bin.from, to: bin.to, total: bin.records, matched: bin.matches }));
  return { ...(relationships ?? {}), ...(definitionVersion === 2 ? { explanationDefinition: configuration.explanationDefinition } : {}), definitionVersion, relationshipMode, records, zones, matches, overviewRecords, overviewBins, fieldTypes, hasSearch: search.active, map: mode === 'uniform' && fixed ? fixed : { mapId, domain: { from: toIso(from), to: toIso(to) }, knots, mode, ratio }, density: { bins: densityBins, complete: true, total: overviewRecords.length } };
}
