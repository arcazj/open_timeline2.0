import { resolveQueryConfiguration } from './query-configuration.js';
import { fixedScaleMap } from '../timeline/fixed-scale.js';
export { foldText, parseSearch } from './filter-expression.js';
import { ViewDecimal as D, toMs, toIso, decimalString } from '../timeline/time-scale.js';
import { overlaps } from '../timeline/layout.js';
import { ProviderError, uuid } from './data-provider.js';

export function createQueryData(snapshot, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProviderError('invalid_query', 'Query input must be an object', 422);
  const from = toMs(input.domain?.from);
  const to = toMs(input.domain?.to);
  if (from >= to) throw new ProviderError('invalid_range', 'Analysis domain must be positive');
  const mode = input.scaleMode === undefined ? 'uniform' : input.scaleMode;
  if (!['uniform', 'adaptive'].includes(mode)) throw new ProviderError('invalid_scale_mode', 'Unknown scale mode');
  const ratio = input.ratio === undefined ? 4 : input.ratio;
  const requestedBins = input.bins === undefined ? 128 : input.bins;
  if (!(ratio >= 1 && ratio <= 32) || !Number.isFinite(ratio) || !Number.isInteger(requestedBins) || requestedBins < 16 || requestedBins > 256) throw new ProviderError('invalid_density', 'Invalid density parameters');
  const { predicate, search, fieldTypes } = resolveQueryConfiguration(snapshot, input);
  let universe = snapshot.records;
  if (snapshot.manifest?.legacy?.readOnly) {
    const byId = new Map(universe.map(record => [record.id, record]));
    const selected = new Set(universe.filter(record => overlaps(record, from, to)).map(record => record.id));
    for (const id of [...selected]) {
      let parent = byId.get(id).parentSessionId;
      while (parent && !selected.has(parent)) { selected.add(parent); parent = byId.get(parent)?.parentSessionId; }
    }
    universe = universe.filter(record => selected.has(record.id));
  }
  const records = universe.filter(predicate);
  const selectedSources = input.filters?.sourceIds, selectedSource = input.filters?.sourceId;
  const zones = (snapshot.zones || []).filter(zone => !zone.legacy?.sourceId ||
    ((!selectedSources || selectedSources.includes(zone.legacy.sourceId)) && (!selectedSource || selectedSource === 'all' || selectedSource === zone.legacy.sourceId)));
  const matches = new Set(records.filter(record => search.matches(record)).map(r => r.id));
  const overviewRecords = records.filter(r => overlaps(r, from, to));
  const count = Math.min(requestedBins, to - from);
  const boundaries = Array.from({ length: count + 1 }, (_, i) => from + Number(BigInt(i) * BigInt(to - from) / BigInt(count)));
  const bins = boundaries.slice(0, -1).map((start, i) => ({ from: start, to: boundaries[i + 1], points: 0, overlap: 0n, endpoints: 0, records: 0, matches: 0 }));
  for (const record of overviewRecords) {
    const start = toMs(record.start);
    const end = record.end === null ? (record.kind === 'event' ? start : to) : toMs(record.end);
    const point = record.kind === 'event' || end === start;
    const matching = matches.has(record.id);
    for (const bin of bins) {
      if (point) {
        if (start >= bin.from && start < bin.to) { bin.points++; bin.records++; if (matching) bin.matches++; }
      } else {
        const overlap = Math.max(0, Math.min(end, bin.to) - Math.max(start, bin.from));
        bin.overlap += BigInt(overlap);
        if (overlap > 0) { bin.records++; if (matching) bin.matches++; }
        if (start >= bin.from && start < bin.to) bin.endpoints++;
        if (record.end !== null && end >= bin.from && end < bin.to) bin.endpoints++;
      }
    }
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
  return { records, zones, matches, overviewRecords, overviewBins, fieldTypes, hasSearch: search.active, map: mode === 'uniform' && fixed ? fixed : { mapId, domain: { from: toIso(from), to: toIso(to) }, knots, mode, ratio }, density: { bins: densityBins, complete: true, total: overviewRecords.length } };
}
