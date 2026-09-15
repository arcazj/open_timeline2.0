import { canonicalJson } from '../data/data-provider.js';
import { toIso, toMs } from './time-scale.js';

export const OVERVIEW_PREVIEW_LIMITS = Object.freeze({ entries: 6, itemsPerPacket: 1000, items: 4096, zones: 256 });

function bounds(domain) {
  try {
    const from = toMs(domain.from), to = toMs(domain.to);
    return from < to ? { from, to } : null;
  } catch { return null; }
}
function scopeKey(scope) {
  if (!scope || typeof scope.providerId !== 'string' || typeof scope.generation !== 'string' ||
      !Number.isSafeInteger(scope.revision) || typeof scope.querySignature !== 'string') return null;
  try { const key = canonicalJson(scope); return key.length <= 65536 ? key : null; } catch { return null; }
}
function sourcesKey(sourceIds) {
  if (sourceIds == null) return 'main';
  if (!Array.isArray(sourceIds) || sourceIds.length > 1000 || sourceIds.some(id => typeof id !== 'string')) return null;
  return canonicalJson([...new Set(sourceIds)].sort());
}
const complete = coverage => coverage === undefined || coverage?.complete === true;
const isoRange = range => ({ from: toIso(range.from), to: toIso(range.to) });

function itemBounds(item) {
  if (!item || typeof item.id !== 'string' || !['event', 'session'].includes(item.kind)) return null;
  try {
    const from = toMs(item.start), to = item.end == null ? Infinity : toMs(item.end);
    if (to < from) return null;
    return { from, to, point: item.kind === 'event' || to === from };
  } catch { return null; }
}

// Each time slice has one authoritative packet, so overlapping aggregate bins never add together.
export function mergeOverviewPreview({ domain, scope, base, entries = [], sourceIds = null, matchActive = false }) {
  const target = bounds(domain);
  if (!target) throw new TypeError('A valid overview domain is required');
  const expectedScope = scopeKey(scope), expectedSources = sourcesKey(sourceIds);
  const packets = [], diagnostics = { ignoredPackets: 0, limitedPackets: 0, invalidItems: 0 };
  for (const packet of [base, ...entries.slice(-OVERVIEW_PREVIEW_LIMITS.entries)]) {
    if (!packet) continue;
    const overview = packet.overview, range = bounds(overview?.domain);
    if (!expectedScope || !expectedSources || scopeKey(packet.scope) !== expectedScope ||
        sourcesKey(packet.sourceIds) !== expectedSources || overview?.matchActive !== matchActive || !range || !Array.isArray(overview.items)) {
      diagnostics.ignoredPackets++; continue;
    }
    const from = Math.max(target.from, range.from), to = Math.min(target.to, range.to);
    if (from >= to) continue;
    const limited = overview.items.length > OVERVIEW_PREVIEW_LIMITS.itemsPerPacket;
    if (limited) diagnostics.limitedPackets++;
    const items = [];
    let invalid = false;
    for (const item of overview.items.slice(0, OVERVIEW_PREVIEW_LIMITS.itemsPerPacket)) {
      const interval = itemBounds(item);
      if (!interval || (overview.aggregated && (!Number.isSafeInteger(item.count) || item.count <= 0 || !Number.isFinite(interval.to)))) {
        invalid = true; diagnostics.invalidItems++; continue;
      }
      items.push({ item, ...interval });
    }
    packets.push({ ...packet, overview, items, from, to,
      complete: !limited && !invalid && complete(packet.coverage) && complete(overview.coverage) });
  }
  const edges = [...new Set([target.from, target.to, ...packets.flatMap(packet => [packet.from, packet.to])])].sort((a, b) => a - b);
  const segments = [];
  for (let index = 1; index < edges.length; index++) {
    const from = edges[index - 1], to = edges[index];
    const candidates = packets.filter(packet => packet.from <= from && packet.to >= to);
    const owner = candidates.filter(packet => packet.complete).at(-1) || candidates.at(-1);
    const previous = segments.at(-1);
    if (previous && previous.owner === owner) previous.to = to;
    else segments.push({ from, to, owner });
  }
  const records = new Map(), aggregates = new Map(), zones = new Map();
  let approximate = false;
  for (const segment of segments) {
    if (!segment.owner) continue;
    for (const entry of segment.owner.items) {
      const { item, from, to, point } = entry;
      if (point ? from < segment.from || from >= segment.to : from >= segment.to || to <= segment.from) continue;
      const fragment = { from: Math.max(from, segment.from), to: point ? from : Math.min(to, segment.to) };
      if (segment.owner.overview.aggregated) {
        const clipped = fragment.from !== from || fragment.to !== to;
        approximate ||= clipped;
        const id = `overview-bin:${fragment.from}:${fragment.to}`;
        aggregates.set(id, { item: { ...item, id, countExact: !clipped, countDomain: { from: item.start, to: item.end } },
          from: fragment.from, to: fragment.to, originalFrom: from, originalTo: to });
      } else {
        const record = records.get(item.id) || { item, point, originalFrom: from, originalTo: to, fragments: [] };
        record.item = item;
        const prior = record.fragments.at(-1);
        if (prior && prior.to >= fragment.from) prior.to = Math.max(prior.to, fragment.to);
        else record.fragments.push(fragment);
        records.set(item.id, record);
      }
    }
  }
  const items = [...records.values()].flatMap(({ item, point, originalFrom, originalTo, fragments }) => fragments.map((fragment, index) => ({
    item: index ? { ...item, id: `${item.id}:overview-fragment:${index}`, recordId: item.id } : item,
    originalFrom, originalTo, from: fragment.from, to: point ? fragment.from : fragment.to })));
  items.push(...aggregates.values());
  items.sort((a, b) => a.from - b.from || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  for (const packet of packets) for (const zone of (Array.isArray(packet.zones) ? packet.zones : []).slice(0, OVERVIEW_PREVIEW_LIMITS.zones)) {
    const range = bounds({ from: zone?.start, to: zone?.end });
    if (!range || typeof zone.id !== 'string' || range.from >= target.to || range.to <= target.from) continue;
    zones.set(zone.id, { ...zone, start: toIso(Math.max(target.from, range.from)), end: toIso(Math.min(target.to, range.to)) });
  }
  const truncated = items.length > OVERVIEW_PREVIEW_LIMITS.items || zones.size > OVERVIEW_PREVIEW_LIMITS.zones ||
    packets.some(packet => packet.zones?.length > OVERVIEW_PREVIEW_LIMITS.zones);
  const intervals = segments.map(segment => ({ ...isoRange(segment), complete: !!segment.owner?.complete, loaded: !!segment.owner }));
  const coverageComplete = !truncated && intervals.every(interval => interval.complete);
  const hasAggregate = aggregates.size > 0;
  const timestamps = new Map(), stamp = value => {
    if (!timestamps.has(value)) timestamps.set(value, toIso(value));
    return timestamps.get(value);
  };
  return { domain: { ...domain }, items: items.slice(0, OVERVIEW_PREVIEW_LIMITS.items).map(({ item, from, to, originalFrom, originalTo }) => ({ ...item,
    start: from === originalFrom ? item.start : stamp(from), end: to === originalTo ? item.end : stamp(to) })), zones: [...zones.values()].slice(0, OVERVIEW_PREVIEW_LIMITS.zones),
    matchActive, aggregated: hasAggregate, coverage: { kind: 'rolling-overview', complete: coverageComplete,
      state: coverageComplete ? 'complete' : packets.length ? 'partial' : 'unavailable', intervals,
      countsExact: coverageComplete && !hasAggregate, visibleRecordCount: hasAggregate || truncated ? null : records.size,
      zonesComplete: coverageComplete && segments.every(segment => Array.isArray(segment.owner?.zones)),
      aggregateCountsApproximate: approximate, truncated, ...diagnostics } };
}
